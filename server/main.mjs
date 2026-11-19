// Local server: scans the game's save, records changes and serves the page (web/) on 127.0.0.1.
// Usage: npm start, then open http://localhost:8765
//
// The parts: context.mjs (shared state), tables.mjs (game data), userdata.mjs (the user's files), scan/ (reading the
// save), state.mjs (what the page gets), http/ (server and API), datapack/ (game-data updates), update/ (app updates),
// notifications/, backup.mjs. This file starts them and runs the timers.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './context.mjs';
import { createTables } from './tables.mjs';
import { loadUserData } from './userdata.mjs';
import { readJson, flushWrites } from './store.mjs';
import { readRumblePrefs } from './game/prefs.mjs';
import { watchGame, watchGameFromTray, gameRunningOnce } from './game/watch.mjs';
import { createScanner } from './scan/scanner.mjs';
import { allowedUrl } from './datapack/datapack.mjs';
import { createPackChecker } from './datapack/checker.mjs';
import { firstRunDownload } from './datapack/firstrun.mjs';
import { createUpdater } from './update/updater.mjs';
import { cleanUpdates } from './update/appupdate.mjs';
import { createNotifier } from './notifications/runner.mjs';
import { writeDailyBackup } from './backup.mjs';
import { readAutostart, setAutostart, refreshAutostart, autostartCommand } from './autostart.mjs';
import { createHttpServer } from './http/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_MS = 5000;           // while the game runs
const SCANS_AFTER_EXIT = 6;     // the game may still write its save while closing
const NOTIFY_MS = 30000;
const PACK_CHECK_MS = 6 * 60 * 60 * 1000;
const BACKUP_MS = 24 * 60 * 60 * 1000;
const STANDALONE = !!process.env.RUMBLE_STANDALONE; // set by desktop/launcher.cjs

const ctx = createContext({
  root: ROOT,
  // user data: data/ from source, %APPDATA%\RumbleTracker in the exe (RUMBLE_DATA_DIR)
  data: path.resolve(process.env.RUMBLE_DATA_DIR || path.join(ROOT, 'data')),
  port: Number(process.env.PORT || 8765),
  standalone: STANDALONE,
  appVersion: await readJson(path.join(ROOT, 'package.json'), {}).then((p) => p.version || null, () => null),
});
process.on('unhandledRejection', (e) => { console.log(`Unexpected error: ${e?.message || e}`); ctx.errorLog.add('server', e?.stack || String(e)); });
await mkdir(ctx.paths.STATE, { recursive: true });

// ---- game data ----------------------------------------------------------------------------------------------------
ctx.tables = createTables(ctx.paths);
// data packs: config.json "dataPackUrl" or RUMBLE_DATA_PACK_URL (the exe sets RUMBLE_DEFAULT_DATA_PACK_URL)
const config = await ctx.readUserJson(path.join(ctx.paths.DATA, 'config.json'), {});
ctx.dataPack.url = process.env.RUMBLE_DATA_PACK_URL || config.dataPackUrl || process.env.RUMBLE_DEFAULT_DATA_PACK_URL || '';
if (ctx.dataPack.url && !allowedUrl(ctx.dataPack.url)) { console.log('Data pack address ignored: it must be https.'); ctx.dataPack.url = ''; }
const canDownload = !!ctx.dataPack.url;

// Game data isn't bundled: from source, npm run fetch-gamedata fills gamedata/; the exe's first start installs the
// signed data pack.
if (!(await ctx.tables.hasGameData())) {
  if (!canDownload) {
    console.error(`No game data in ${ctx.paths.STATIC}. Run  npm run fetch-gamedata  once (it downloads the signed data pack), then start again.`);
    process.exit(1);
  }
  await firstRunDownload(ctx);
}
try {
  await ctx.tables.load();
} catch (e) {
  // a damaged installed pack: set it aside, then use the bundled tables or download the pack again
  if (!(await ctx.tables.packInstalled())) throw e;
  const moved = await ctx.tables.setPackAside();
  const msg = `The installed game data could not be read (${e.message}); it was moved to ${moved}.`;
  console.log(msg);
  ctx.errorLog.add('data pack', msg);
  if (!(await ctx.tables.hasGameData())) {
    if (!canDownload) throw e;
    await firstRunDownload(ctx);
  }
  await ctx.tables.load();
}

// ---- the user's data (the research log of shop changes only from source) -----------------------------------------
ctx.user = await loadUserData(ctx, { storeLog: !STANDALONE });

// ---- the game: read the save only while it runs ------------------------------------------------------------------
// The save only changes while Warcraft Rumble runs, so it is read every SCAN_MS then, a few more times after the game
// closes, and not at all otherwise. Unknown (no watcher yet, or it failed): read all the time.
const { scan } = createScanner(ctx, { readPrefs: readRumblePrefs });
let scansLeft = 0;
let stopping = false;
const onGame = (running) => {
  console.log(running ? 'Warcraft Rumble started: reading the save' : 'Warcraft Rumble closed: reading paused');
  if (running) scan();
  else scansLeft = SCANS_AFTER_EXIT;
  ctx.bump();
};
const onGameWatchFailed = (message) => { console.log(`Game check: ${message}; reading the save all the time`); ctx.errorLog.add('game check', message); };
// in the exe the tray icon's process reports it (desktop/launcher.cjs)
ctx.game = STANDALONE ? watchGameFromTray(onGame, onGameWatchFailed) : watchGame(onGame, onGameWatchFailed);
const gameRunning = async () => ctx.game.running() ?? gameRunningOnce();

// ---- automatic backups: at start, every 24 hours and when the tracker stops (backup.mjs) --------------------------
// Not while a data file was found damaged at start: its backup would replace the last good one of the day.
const backupsPaused = ctx.errorLog.list().some((e) => e.source === 'data file');
if (backupsPaused) console.log('Automatic backups paused: a data file was damaged at start');
async function autoBackup() {
  if (backupsPaused) return null;
  try {
    const file = await writeDailyBackup(ctx.paths.BACKUPS, ctx.user.backupFiles());
    console.log(`Backup: ${path.basename(file)}`);
    return file;
  } catch (e) {
    console.log(`Backup failed: ${e.message}`);
    ctx.errorLog.add('backup', e.message);
    return null;
  }
}

// ---- stopping: page Quit, tray Quit, Windows shutting down, an app update -----------------------------------------
/** Stops once a running scan and every queued write are done, after writing today's backup (at most 15 s). */
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(reason);
  const deadline = Date.now() + 15000;
  const left = () => new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
  while (ctx.scan.scanning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await Promise.race([autoBackup(), left()]);
  await Promise.race([flushWrites(), left()]);
  process.exit(code);
}
process.on('rumble:quit', (reason) => shutdown(reason || 'Quit from the tray')); // desktop/launcher.cjs
if (!STANDALONE) for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(`Stopped (${sig})`));

// ---- notifications, data packs, app updates ------------------------------------------------------------------------
const notifier = createNotifier(ctx, { gameRunning });
const notify = () => notifier.tick().catch((e) => { console.log(`Notifications: ${e.message}`); ctx.errorLog.add('notifications', e.message); });
const checkDataPack = createPackChecker(ctx, { onNews: notify });
const startUpdate = createUpdater(ctx, { shutdown });
cleanUpdates(ctx.paths.UPDATE); // a download the launcher already copied into place

// Start with Windows (exe only): the Run key names this exe
const autostart = STANDALONE ? {
  get: async () => (await readAutostart()) === autostartCommand(process.execPath),
  set: (on) => setAutostart(on, process.execPath),
} : null;
if (STANDALONE) refreshAutostart(process.execPath).catch(() => {});

// ---- start ----------------------------------------------------------------------------------------------------------
await scan();
autoBackup();
setInterval(autoBackup, BACKUP_MS);
setInterval(() => {
  if (stopping) return;
  if (ctx.game.running() === false) {
    if (scansLeft <= 0) return;
    scansLeft--;
  }
  scan();
}, SCAN_MS);
setInterval(notify, NOTIFY_MS);
notify();
checkDataPack();
setInterval(checkDataPack, PACK_CHECK_MS);

const server = createHttpServer(ctx, { scan, shutdown, startUpdate, notifier, gameRunning, autostart });
server.listen(ctx.port, '127.0.0.1', () => {
  console.log(`Rumble tracker running at http://localhost:${ctx.port}`);
  console.log(`Data folder: ${ctx.paths.DATA}`);
  // count only: account names are user-given and the log may be attached to bug reports
  console.log(`Accounts found: ${ctx.accounts.size}${ctx.scan.lastErrorLog ? `  (error: ${ctx.scan.lastErrorLog})` : ''}`);
});
