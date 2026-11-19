// Local server: scans the game's save, records changes and serves the page (web/) on 127.0.0.1.
// Usage: npm start, then open http://localhost:8765
import http from 'node:http';
import { readFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRumblePrefs } from './game/prefs.mjs';
import { currencyInfo as gameCurrencyInfo } from './game/currencies.mjs';
import { parsePvp, pvpReading, manualResult } from './game/pvp.mjs';
import { watchGame, gameRunningOnce } from './game/watch.mjs';
import { parseUnits, parseCurrencies, parseActiveEvents, parseIncomeBonuses, parseOwnedAvatars, parseStore, parseGameBuild, compareBuilds, storeFieldsForLog, diffSnapshots, updateLearned } from './game/model.mjs';
import { updateDataPack, allowedUrl, newerVersion } from './datapack/datapack.mjs';
import { latestAppOf, downloadUpdate, cleanUpdates } from './update/appupdate.mjs';
import { NOTIFY_TYPES, cleanSettings, dueNotifications, inQuietHours } from './notifications/notify.mjs';
import { showToast } from './notifications/toast.mjs';
import { ISSUES_REPO, createErrorLog, diagnostics } from './report.mjs';
import { readJson as readJsonFile, writeJson, flushWrites } from './store.mjs';
import { createGuard, requestPath } from './guard.mjs';
import { buildBackup, restoreBackup, replaceContents } from './backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// User data: data/ from source, %APPDATA%\RumbleTracker in the exe (RUMBLE_DATA_DIR).
const DATA = path.resolve(process.env.RUMBLE_DATA_DIR || path.join(ROOT, 'data'));
const STATE = path.join(DATA, 'state');
const PUBLIC = path.join(ROOT, 'web');
const STATIC = path.join(ROOT, 'gamedata'); // served as /static/
const PORT = Number(process.env.PORT || 8765);
const SCAN_MS = 5000; // while the game runs
const SCANS_AFTER_EXIT = 6; // the game may still write its save while closing
const MAX_EVENTS = 500;
const MAX_PVP_LOG = 2000; // PvP readings kept per account (about a season of play)

await mkdir(STATE, { recursive: true });

// Recent errors for "Report a problem": cleaned of personal details, in memory only.
const errorLog = createErrorLog();
// Game tables throw on damaged JSON; the user's own files are moved aside and start empty (see store.mjs).
const readJson = (p, fallback) => readJsonFile(p, fallback);
const readUserJson = (p, fallback) => readJsonFile(p, fallback, {
  onCorrupt: (file, moved) => {
    const msg = `${path.basename(file)} was damaged and could not be read. It was moved to ${path.basename(moved)} and the tracker started without it; restore a backup to get the data back.`;
    console.log(msg);
    errorLog.add('data file', msg);
  },
});
const APP_VERSION = await readJson(path.join(ROOT, 'package.json'), {}).then((p) => p.version || null, () => null);
process.on('unhandledRejection', (e) => { console.log(`Unexpected error: ${e?.message || e}`); errorLog.add('server', e?.stack || String(e)); });
// Game data: an installed data pack (DATA/gamedata) takes precedence over the bundled gamedata/ files.
const GAMEDATA = path.join(DATA, 'gamedata');
async function staticPath(rel) {
  const p = path.join(GAMEDATA, rel);
  try { await stat(p); return p; } catch { return path.join(STATIC, rel); }
}
let rules, minis, slugs, builtinUnits, gameData, eventsTable, storeTable, pvpTable;
async function loadTables() {
  eventsTable = await readJson(await staticPath('events.json'), null);
  storeTable = await readJson(await staticPath('store.json'), null);
  pvpTable = await readJson(await staticPath('pvp.json'), null);
  rules = await readJson(await staticPath('rules.json'));
  minis = (await readJson(await staticPath('minis.json'))).minis;
  slugs = new Set(minis.map((m) => m.slug));
  // unit ID -> mini slug; names.json overrides
  builtinUnits = (await readJson(await staticPath('unit_ids.json'), { units: {} })).units;
  gameData = await readJson(await staticPath('gamedata.json'), null); // game build of the tables
}
// Data packs: from config.json "dataPackUrl" or RUMBLE_DATA_PACK_URL (the exe sets RUMBLE_DEFAULT_DATA_PACK_URL).
const config = await readUserJson(path.join(DATA, 'config.json'), {});
const dataPackUrl = process.env.RUMBLE_DATA_PACK_URL || config.dataPackUrl || process.env.RUMBLE_DEFAULT_DATA_PACK_URL || '';
// pack check state (also read by notifications, which can run before the first check)
const dataPack = { url: dataPackUrl, lastCheck: null, result: null, error: null, badSignatures: 0, needsAppUpdate: false, newVersion: null, latestApp: null };

// Game data is not bundled: from source, npm run fetch-gamedata fills gamedata/; otherwise (the exe) the first start
// installs the signed data pack into DATA/gamedata.
async function hasGameData() {
  for (const dir of [GAMEDATA, STATIC]) { try { await stat(path.join(dir, 'rules.json')); return true; } catch { /* next */ } }
  return false;
}
if (!(await hasGameData())) {
  if (!dataPackUrl || !allowedUrl(dataPackUrl)) {
    console.error(`No game data in ${STATIC}. Run  npm run fetch-gamedata  once (it downloads the signed data pack), then start again.`);
    process.exit(1);
  }
  await firstRunDownload();
}
try {
  await loadTables();
} catch (e) {
  // a damaged installed pack: set it aside, then use the bundled tables or download the pack again
  if (!(await stat(path.join(GAMEDATA, 'gamedata.json')).catch(() => null))) throw e;
  const moved = `${GAMEDATA}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(GAMEDATA, moved);
  const msg = `The installed game data could not be read (${e.message}); it was moved to ${path.basename(moved)}.`;
  console.log(msg);
  errorLog.add('data pack', msg);
  if (!(await hasGameData())) {
    if (!dataPackUrl || !allowedUrl(dataPackUrl)) throw e;
    await firstRunDownload();
  }
  await loadTables();
}

/** Installs the data pack, serving a self-refreshing progress page on PORT meanwhile; retries every 30 s. */
async function firstRunDownload() {
  const status = { done: 0, total: 0, error: null };
  const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Rumble Collection Tracker</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#14162a;color:#f3e3c4;font:16px/1.5 system-ui,'Segoe UI',sans-serif">
<main style="max-width:560px;padding:24px;text-align:center"><h1 style="color:#ffd166;font-size:24px">Rumble Collection Tracker</h1>
<p>${status.error ? html(status.error)
    : `Downloading the game data (first start only)… ${status.total ? `${status.done} of ${status.total} files` : 'connecting'}`}</p></main></body></html>`;
  const hosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  const boot = http.createServer((req, res) => {
    if (!hosts.has(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/api/report') { // answers the launcher's "is it running" check
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ repo: ISSUES_REPO, starting: true }));
      return;
    }
    res.writeHead(p === '/' ? 200 : 503, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(page());
  });
  await new Promise((resolve, reject) => { boot.once('error', reject); boot.listen(PORT, '127.0.0.1', resolve); });
  console.log(`First start: downloading game data from ${dataPackUrl}`);
  for (;;) {
    try {
      const r = await updateDataPack({ base: dataPackUrl, current: null, dir: GAMEDATA, staticDir: STATIC,
        onProgress: (done, total) => { status.done = done; status.total = total; } });
      if (!r.updated) throw new Error(r.reason);
      console.log(`Game data installed: ${r.reason} (${r.downloaded} files downloaded)`);
      break;
    } catch (e) {
      console.log(`Game data download failed: ${e.message}`);
      errorLog.add('data pack', e.message);
      status.error = e.code === 'BAD_SIGNATURE'
        ? 'This version of the tracker cannot verify the current game data. Download the latest version from https://github.com/razingo/rumble-tracker-app/releases/latest'
        : `Could not download the game data (${e.message}). Check your internet connection; retrying in 30 seconds.`;
      await new Promise((r) => setTimeout(r, 30000));
      Object.assign(status, { done: 0, total: 0, error: null });
    }
  }
  await new Promise((resolve) => { boot.close(resolve); boot.closeAllConnections(); });
}
const names = await readUserJson(path.join(DATA, 'names.json'), { accounts: {}, units: {} });
const unitSlug = (id) => names.units[id] || builtinUnits[id] || null;
const talents = await readUserJson(path.join(DATA, 'talents.json'), {});
// Army slots, entered by the user: { [account]: { [unitId]: [{ type, tier } x7] } }
const army = await readUserJson(path.join(DATA, 'army.json'), {});
// Saved armies: { [account]: [{ id, name, leader, minis: [slug|null x6], talents: { slug: index } }] }
const savedArmies = await readUserJson(path.join(DATA, 'armies.json'), {});
// Army being edited, per account (auto-saved by the page).
const drafts = await readUserJson(path.join(DATA, 'drafts.json'), {});
const learned = await readUserJson(path.join(DATA, 'learned.json'), { xpToNext: {}, xpConflicts: [], spending: [] });
// Observed G.R.I.D.s: { [account]: [{ seen, refresh, items: [{ mini|xpBoost, rarity }] }] }.
// Used to derive offer cooldowns.
const gridHistory = await readUserJson(path.join(DATA, 'grid_history.json'), {});
const GRID_HISTORY_MAX = 400;
// PvP readings and the matches inferred from them: { [account]: [entry] } (pvpReading in game/pvp.mjs). Not in the
// save, so it is backed up. Older versions kept it in state/<account>.json as pvpLog (moved here on first read).
const pvpHistoryFile = path.join(DATA, 'pvp_history.json');
const pvpHistory = await readUserJson(pvpHistoryFile, {});
// Notifications: settings, reward goals ({ [account]: { [eventId]: { cost, label } } }) and delivery state
// ({ sent: { key: time }, log, pending }; pending holds notifications deferred by quiet hours).
// Progress history: the first sample and the latest sample of each local day,
// { [account]: { first, days: [{ day, t, cur: { id: [balance, lifetime] }, lv, xp, stars, rar, n }] } }.
// Income is derived from lifetime totals, so gaps in tracking don't affect it.
const progress = await readUserJson(path.join(DATA, 'progress.json'), {});
const PROGRESS_DAYS = 400;
let progressDirty = false;
function recordProgress(account, snap, now) {
  const starsBefore = (r) => (rules.rarityUpgrade || []).slice(0, r).reduce((s, x) => s + x.stars, 0);
  const u = snap.units;
  const point = {
    day: new Date(now).toLocaleDateString('sv-SE'), // local YYYY-MM-DD
    t: now,
    cur: Object.fromEntries(snap.currencies.map((c) => [c.id, [c.balance, c.lifetime]])),
    lv: u.reduce((s, x) => s + x.level, 0),
    xp: u.reduce((s, x) => s + x.xpLevel, 0),
    stars: u.reduce((s, x) => s + starsBefore(x.rarity) + x.stars, 0), // all stars invested
    rar: [0, 1, 2, 3, 4].map((r) => u.filter((x) => x.rarity === r).length),
    n: u.length,
  };
  const p = (progress[account] ??= { first: point, days: [] });
  const last = p.days[p.days.length - 1];
  if (last && last.day === point.day) {
    if (JSON.stringify({ ...last, t: 0 }) === JSON.stringify({ ...point, t: 0 })) return;
    p.days[p.days.length - 1] = point;
  } else p.days.push(point);
  if (p.days.length > PROGRESS_DAYS) p.days.splice(0, p.days.length - PROGRESS_DAYS);
  progressDirty = true;
}
// Diagnostic log of store record changes (G.R.I.D. excluded), last 300: data/store_changes.json.
// Not shown in the app.
const storeChangesFile = path.join(DATA, 'store_changes.json');
const storeChanges = await readUserJson(storeChangesFile, []);
const lastStoreFields = new Map(); // account -> fields
let storeChangesDirty = false;
function logStoreChanges(account, fields, now) {
  const prev = lastStoreFields.get(account);
  lastStoreFields.set(account, fields);
  if (!prev) return;
  for (const key of new Set([...Object.keys(prev), ...Object.keys(fields)])) {
    const a = JSON.stringify(prev[key] ?? null), b = JSON.stringify(fields[key] ?? null);
    if (a === b) continue;
    const offerId = key.split(':')[1];
    storeChanges.push({ t: now, account, key, offer: (offerId && storeTable?.offers?.[offerId]?.name) || null, before: prev[key] ?? null, after: fields[key] ?? null });
    storeChangesDirty = true;
  }
  if (storeChanges.length > 300) storeChanges.splice(0, storeChanges.length - 300);
}
const notifySettings = cleanSettings(await readUserJson(path.join(DATA, 'notifications.json'), {}));
const plans = await readUserJson(path.join(DATA, 'plans.json'), {});
const notifiedFile = path.join(DATA, 'notified.json');
const notified = await readUserJson(notifiedFile, null);
let notifyBaseline = !notified; // first run: record what is already due without notifying
const sentLog = notified || { sent: {}, log: [], pending: [] };

/** Records a grid when it is new: a different refresh time or a new item (a reset). */
function logGrid(account, grid, now) {
  const items = grid.rows.flat().filter((s) => !s.bought).map((s) => (s.mini ? { mini: s.mini, rarity: s.rarity } : { xpBoost: s.xpBoost }));
  const list = (gridHistory[account] ??= []);
  const last = list[list.length - 1];
  const idOf = (x) => x.mini || x.xpBoost;
  const known = new Set((last?.items || []).map(idOf));
  const isNew = !last || last.refresh !== grid.refresh || items.some((x) => !known.has(idOf(x)));
  if (!isNew || !items.length) return false;
  list.push({ seen: now, refresh: grid.refresh, items });
  if (list.length > GRID_HISTORY_MAX) list.splice(0, list.length - GRID_HISTORY_MAX);
  return true;
}

const accounts = new Map(); // account -> { snapshot, events, lastChange }
let gameBuildSeen = null; // build that wrote the save, for the outdated-data banner
// starts from the clock so a restarted server never repeats a revision the page has seen
let rev = Date.now();
let lastScan = null;
let lastError = null;
let scanning = false;
// Reads can collide with the game saving; report only failures that persist.
const FAILS_BEFORE_ERROR = 3;
const failures = new Map(); // 'read' or account id -> consecutive failures

// logMessage omits user-given names, for problem reports.
let lastErrorLog = null; // lastError without user-given names, for tracker.log
function noteFailure(key, message, logMessage = message) {
  const n = (failures.get(key) || 0) + 1;
  failures.set(key, n);
  if (n >= FAILS_BEFORE_ERROR) { lastError = message; lastErrorLog = logMessage; errorLog.add(key === 'read' ? 'reading the save' : 'decoding the save', logMessage); }
}
function noteSuccess(key) {
  failures.delete(key);
  if (![...failures.values()].some((n) => n >= FAILS_BEFORE_ERROR)) { lastError = null; lastErrorLog = null; }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    let prefs;
    try {
      prefs = await readRumblePrefs();
      noteSuccess('read');
    } catch (e) {
      noteFailure('read', e.message);
      return;
    }
    const now = new Date().toISOString();
    lastScan = now;
    let learnedChanged = false;
    let gridHistoryChanged = false;
    let pvpChanged = false;
    for (const entries of Object.values(prefs)) {
      try { const b = parseGameBuild(entries.commerce); if (b) gameBuildSeen = b; } catch { /* caught mid-save */ }
    }
    for (const [id, entries] of Object.entries(prefs)) {
      if (!entries.units) continue;
      let cur;
      try {
        cur = { units: parseUnits(entries.units), currencies: parseCurrencies(entries.currencies) };
        noteSuccess(id);
      } catch (e) {
        // usually a value caught mid-save: keep the last snapshot and retry
        noteFailure(id, `Could not decode ${accountLabel(id)}: ${e.message}`, `Could not decode an account: ${e.message}`);
        continue;
      }
      let acc = accounts.get(id);
      if (!acc) {
        acc = await readUserJson(path.join(STATE, `${id}.json`), { snapshot: null, events: [] });
        accounts.set(id, acc);
        if (acc.pvpLog) { // from an older version
          if (!pvpHistory[id]) { pvpHistory[id] = acc.pvpLog; pvpChanged = true; }
          delete acc.pvpLog;
        }
      }
      let changed = !acc.snapshot;
      const events = acc.snapshot ? diffSnapshots(acc.snapshot, cur, rules, now) : [];
      if (events.length) {
        acc.events = [...acc.events, ...events].slice(-MAX_EVENTS);
        acc.lastChange = now;
        changed = true;
      }
      if (updateLearned(learned, cur, events, rules, now)) learnedChanged = true;
      acc.snapshot = cur;
      recordProgress(id, cur, Date.parse(now));
      // running events; a failed read keeps the previous list
      try {
        const active = parseActiveEvents(entries.store);
        if (entries.store && JSON.stringify(active) !== JSON.stringify(acc.activeEvents || [])) {
          acc.activeEvents = active;
          acc.activeEventsAt = now;
          changed = true;
        }
        const avatars = parseOwnedAvatars(entries.profile);
        if (entries.profile && JSON.stringify(avatars) !== JSON.stringify(acc.ownedAvatars || [])) {
          acc.ownedAvatars = avatars;
          changed = true;
        }
        logStoreChanges(id, storeFieldsForLog(entries.store), now);
        const shop = parseStore(entries.store);
        if (shop && JSON.stringify(shop) !== JSON.stringify(acc.shop || null)) {
          acc.shop = shop;
          changed = true;
          if (logGrid(id, shop.grid, now)) gridHistoryChanged = true;
        }
        const bonuses = parseIncomeBonuses(entries.store);
        if (entries.store && JSON.stringify(bonuses) !== JSON.stringify(acc.incomeBonuses || [])) {
          acc.incomeBonuses = bonuses;
          changed = true;
        }
      } catch { /* caught mid-save: try again next scan */ }
      try { if (recordPvp(id, acc, parsePvp(entries.pvp), now)) { changed = true; pvpChanged = true; } } catch { /* caught mid-save */ }
      if (changed) {
        rev++;
        await writeJson(path.join(STATE, `${id}.json`), acc);
      }
    }
    if (learnedChanged) {
      rev++;
      await writeJson(path.join(DATA, 'learned.json'), learned);
    }
    if (gridHistoryChanged) await writeJson(path.join(DATA, 'grid_history.json'), gridHistory);
    if (pvpChanged) await writeJson(pvpHistoryFile, pvpHistory);
    if (storeChangesDirty) { storeChangesDirty = false; await writeJson(storeChangesFile, storeChanges); }
    if (progressDirty) { progressDirty = false; rev++; await writeJson(path.join(DATA, 'progress.json'), progress); }
  } finally {
    scanning = false;
  }
}

/** Logs a PvP reading when honor or Victory Points change (pvpReading). acc.pvp is the last reading. */
function recordPvp(id, acc, cur, now) {
  const entry = pvpReading(acc.pvp, cur, now, pvpTable?.victoryPoints);
  if (!entry) return false;
  pvpHistory[id] = [...(pvpHistory[id] || []), entry].slice(-MAX_PVP_LOG);
  acc.pvp = cur;
  return true;
}

/** The player's own result for an unexplained PvP change: { account, t, result: 'win' | 'loss' | null }. */
async function handlePvpResult(body) {
  const { account, t, result } = body;
  if (!isId(account) || typeof t !== 'string') return [400, { error: 'bad request' }];
  const entry = (pvpHistory[account] || []).find((e) => e.t === t);
  if (!manualResult(entry, result ?? null)) return [400, { error: 'This change can\'t be set by hand.' }];
  await writeJson(pvpHistoryFile, pvpHistory);
  rev++;
  return [200, { ok: true }];
}

function accountLabel(id) {
  return names.accounts[id] || `Account …${id.slice(16, 24)}`;
}

function withSlugs(shop) {
  return {
    ...shop,
    grid: { ...shop.grid, rows: shop.grid.rows.map((row) => row.map((s) => (s.mini ? { ...s, slug: unitSlug(s.mini) } : s))) },
    offers: shop.offers.map((o) => ({ ...o, slugs: o.minis.map((m) => unitSlug(m)) })),
  };
}

const currencyInfo = (id, acc) => gameCurrencyInfo(id, { events: eventsTable, rules, activeEvents: acc?.activeEvents || [] });

/** The requested account if the tracker knows it, else the first one (null: none yet). */
function resolveAccount(requested) {
  const ids = [...accounts.keys()];
  return ids.includes(requested) ? requested : ids[0] || null;
}

/** State that changes without a new revision (sent with "unchanged" answers too). */
function liveState() {
  return { lastScan, lastError, problems: errorLog.list().length, gameRunning: game.running(), update: updateState() };
}

/** App update for the page: { version, auto, state, error, later } or null when this is the latest version. */
function updateState() {
  if (!dataPack.newVersion) return null;
  return {
    version: dataPack.newVersion,
    auto: STANDALONE && !!dataPack.latestApp, // can download and install itself
    state: appUpdate.state, error: appUpdate.error,
    later: appUpdate.later === dataPack.newVersion,
  };
}

function buildState(account) {
  const ids = [...accounts.keys()];
  const acc = account && accounts.get(account);
  const picks = (account && talents[account]) || {};
  const slots = (account && army[account]) || {};
  return {
    rev,
    ...liveState(),
    account,
    accounts: ids.map((id) => ({ id, label: accountLabel(id), units: accounts.get(id).snapshot?.units.length || 0 })),
    units: acc ? acc.snapshot.units.map((u) => ({ ...u, slug: unitSlug(u.id), talentPicks: picks[u.id] || [], army: slots[u.id] || null })) : [],
    currencies: acc ? acc.snapshot.currencies.map((c) => ({ ...c, ...currencyInfo(c.id, acc) })) : [],
    currencyNames: Object.fromEntries(Object.values(rules.currencyIds || {}).map((id) => [id, currencyInfo(id, acc).name])),
    events: acc ? acc.events.slice(-200) : [],
    activeEvents: (acc && acc.activeEvents) || [],
    pvp: acc?.pvp || null,
    pvpLog: acc?.pvp ? (pvpHistory[account] || []).filter((e) => e.season === acc.pvp.season) : [],
    activeEventsAt: (acc && acc.activeEventsAt) || null,
    incomeBonuses: (acc && acc.incomeBonuses) || [],
    ownedAvatars: (acc && acc.ownedAvatars) || [],
    plans: (account && plans[account]) || {},
    progress: (account && progress[account]) || null,
    // game build of the tables vs. the build that wrote the save
    dataStatus: {
      dataBuild: gameData?.gameBuild || null,
      dataVersion: gameData?.dataVersion || null,
      gameBuild: gameBuildSeen,
      stale: !!(gameBuildSeen && gameData?.gameBuild && compareBuilds(gameBuildSeen, gameData.gameBuild) > 0),
      pack: typeof dataPack === 'undefined' ? null : { configured: !!dataPack.url, lastCheck: dataPack.lastCheck, result: dataPack.result, error: dataPack.error, needsAppUpdate: dataPack.needsAppUpdate, newVersion: dataPack.newVersion },
    },
    // shop with unit IDs resolved to slugs (null if unknown), plus G.R.I.D. history
    shop: acc && acc.shop ? withSlugs(acc.shop) : null,
    gridHistory: ((account && gridHistory[account]) || []).slice(-120).map((g) => ({ ...g, items: g.items.map((x) => ({ ...x, slug: x.mini ? unitSlug(x.mini) : null })) })),
    savedArmies: (account && savedArmies[account]) || [],
    armyTags: tagList((account && savedArmies[account]) || []),
    draft: (account && drafts[account]) || null,
    learned,
    standalone: STANDALONE,
    appVersion: APP_VERSION,
  };
}

// ---- HTTP -------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// Content security policy: own scripts only (no inline script, handlers or eval), connections and images only to
// this server, fonts bundled. Inline style attributes are allowed; the page sets colours through them.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function serveFile(res, base, rel) {
  const file = path.resolve(base, `.${rel}`);
  if (!file.startsWith(base + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('request body is not valid JSON'), { status: 400 }); }
}

const isId = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

async function handleName(body) {
  const { kind, id, value } = body;
  const v = typeof value === 'string' ? value.trim() : '';
  if (!isId(id)) return [400, { error: 'bad id' }];
  if (kind === 'unit') {
    if (v && !slugs.has(v)) return [400, { error: 'unknown mini' }];
    const allIds = new Set([...Object.keys(builtinUnits), ...Object.keys(names.units)]);
    const takenBy = [...allIds].map((other) => [other, unitSlug(other)]).find(([other, s]) => s === v && other !== id);
    if (v && takenBy) return [409, { error: 'That mini is already assigned to another unit.', takenBy: takenBy[0] }];
    if (v) names.units[id] = v;
    else delete names.units[id];
  } else if (kind === 'account') {
    if (v.length > 40) return [400, { error: 'name too long' }];
    if (v) names.accounts[id] = v;
    else delete names.accounts[id];
  } else {
    return [400, { error: 'bad kind' }];
  }
  await writeJson(path.join(DATA, 'names.json'), names);
  rev++;
  return [200, { ok: true }];
}

async function handleTalents(body) {
  const { account, unitId, picks } = body;
  if (!isId(account) || !isId(unitId) || !Array.isArray(picks)) return [400, { error: 'bad request' }];
  const clean = [...new Set(picks.filter((p) => Number.isInteger(p) && p >= 0 && p < 3))].sort();
  (talents[account] ??= {})[unitId] = clean;
  await writeJson(path.join(DATA, 'talents.json'), talents);
  rev++;
  return [200, { ok: true, picks: clean }];
}

async function handleArmy(body) {
  const { account, unitId, slots } = body;
  const count = rules.armySlots.count;
  const maxTier = rules.armySlots.tiers.length - 1;
  if (!isId(account) || !isId(unitId) || !Array.isArray(slots) || slots.length !== count) return [400, { error: 'bad request' }];
  const clean = slots.map((s, i) => ({
    type: i === rules.armySlots.leaderSlot ? 'Leader' : String(s?.type || '').slice(0, 40),
    tier: Math.max(0, Math.min(maxTier, Number.isInteger(s?.tier) ? s.tier : 0)),
    // only the bottom-right slot can be a Boost slot
    ...(i === rules.armySlots.boostSlot && s?.boost === true ? { boost: true } : {}),
  }));
  (army[account] ??= {})[unitId] = clean;
  await writeJson(path.join(DATA, 'army.json'), army);
  rev++;
  return [200, { ok: true, slots: clean }];
}

const okSlug = (s) => typeof s === 'string' && slugs.has(s);
function cleanArmy(a, { keepEmptyId = false } = {}) {
  return {
    id: String(a?.id || '').slice(0, 40) || (keepEmptyId ? null : `a${Date.now().toString(36)}`),
    name: String(a?.name || 'Army').trim().slice(0, 40) || 'Army',
    leader: okSlug(a?.leader) ? a.leader : null,
    minis: Array.from({ length: 6 }, (_, i) => (okSlug(a?.minis?.[i]) ? a.minis[i] : null)),
    talents: Object.fromEntries(Object.entries(a?.talents || {}).filter(([k, v]) => okSlug(k) && Number.isInteger(v) && v >= 0 && v < 3)),
    description: String(a?.description || '').slice(0, 1000),
    tags: cleanTags(a?.tags),
  };
}

/** Tags used in the given armies, most frequent first: [{ tag, count }]. */
function tagList(armies) {
  const m = new Map();
  for (const a of armies) for (const t of a.tags || []) {
    const e = m.get(t.toLowerCase()) || { tag: t, count: 0 };
    e.count++;
    m.set(t.toLowerCase(), e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Normalises tags: trimmed, at most 30 characters and 20 per army, case-insensitively unique. */
function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const v = String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

/** Sets or clears a reward goal: { account, eventId, plan: { cost, label } | null }. */
async function handlePlan(body) {
  const { account, eventId, plan } = body;
  if (!isId(account) || typeof eventId !== 'string' || eventId.length > 80) return [400, { error: 'bad request' }];
  const mine = (plans[account] ??= {});
  if (plan && Number.isInteger(plan.cost) && plan.cost > 0) mine[eventId] = { cost: plan.cost, label: String(plan.label || 'your picks').slice(0, 120), set: new Date().toISOString() };
  else delete mine[eventId];
  await writeJson(path.join(DATA, 'plans.json'), plans);
  rev++;
  return [200, { ok: true }];
}

async function handleDraft(body) {
  const { account, draft } = body;
  if (!isId(account) || !draft || typeof draft !== 'object') return [400, { error: 'bad request' }];
  drafts[account] = { ...cleanArmy(draft, { keepEmptyId: true }), updated: new Date().toISOString() };
  await writeJson(path.join(DATA, 'drafts.json'), drafts);
  // no rev bump: the sending page already shows this draft
  return [200, { ok: true }];
}

async function handleSavedArmies(body) {
  const { account, armies } = body;
  if (!isId(account) || !Array.isArray(armies) || armies.length > 50) return [400, { error: 'bad request' }];
  const clean = armies.map((a) => cleanArmy(a));
  savedArmies[account] = clean;
  await writeJson(path.join(DATA, 'armies.json'), savedArmies);
  rev++;
  return [200, { ok: true, armies: clean }];
}

// ---- backup: all user-entered data in one JSON file (backup.mjs) ----------------------------------------
// Scan snapshots (data/state) are excluded: the next scan rebuilds them. grid_history and pvp_history are included
// because they cannot be rebuilt from the save.
const BACKUP_FILES = { names, talents, army, armies: savedArmies, drafts, learned, grid_history: gridHistory, pvp_history: pvpHistory, notifications: notifySettings, plans, progress };

async function handleRestore(body) {
  const b = body?.backup;
  const restored = restoreBackup(BACKUP_FILES, b);
  if (!restored) return [400, { error: 'This is not a Rumble Tracker backup file.' }];
  // older or partial backups may lack required keys
  names.accounts ??= {}; names.units ??= {};
  learned.xpToNext ??= {}; learned.xpConflicts ??= []; learned.spending ??= [];
  for (const key of restored) await writeJson(path.join(DATA, `${key}.json`), BACKUP_FILES[key]);
  rev++;
  return [200, { ok: true, restored, created: b.created }];
}

const STANDALONE = !!process.env.RUMBLE_STANDALONE; // set by desktop/launcher.cjs
const EXTERNAL_LINKS = [`https://github.com/${ISSUES_REPO}`, 'https://buymeacoffee.com/razingo'];
const refusal = createGuard(PORT); // see guard.mjs

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = requestPath(req.url);
    if (p === null) return send(res, 400, { error: 'bad address' }); // a malformed % escape: not a server error
    const refused = refusal(req, p);
    if (refused) return send(res, 403, { error: refused });
    if (req.method === 'GET' && p === '/api/state') {
      // the page sends the revision it has: unchanged state is answered with the few values that change on their own
      const account = resolveAccount(url.searchParams.get('account'));
      if (url.searchParams.get('rev') === String(rev) && url.searchParams.get('for') === String(account)) {
        return send(res, 200, { unchanged: true, rev, ...liveState() });
      }
      return send(res, 200, buildState(account));
    }
    if (req.method === 'POST' && p === '/api/pvp/result') return send(res, ...(await handlePvpResult(await readBody(req))).slice(0, 2));
    if (req.method === 'POST' && p === '/api/name') return send(res, ...(await handleName(await readBody(req))).slice(0, 2));
    if (req.method === 'POST' && p === '/api/talents') return send(res, ...(await handleTalents(await readBody(req))).slice(0, 2));
    if (req.method === 'GET' && p === '/api/backup') {
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="rumble-tracker-backup-${day}.json"`,
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify(buildBackup(), null, 2));
    }
    if (req.method === 'POST' && p === '/api/restore') return send(res, ...(await handleRestore(await readBody(req, 20 * 1024 * 1024))).slice(0, 2));
    if (req.method === 'POST' && p === '/api/draft') return send(res, ...(await handleDraft(await readBody(req))).slice(0, 2));
    if (req.method === 'POST' && p === '/api/armies') return send(res, ...(await handleSavedArmies(await readBody(req))).slice(0, 2));
    if (req.method === 'POST' && p === '/api/army') return send(res, ...(await handleArmy(await readBody(req))).slice(0, 2));
    if (req.method === 'POST' && p === '/api/scan') { await scan(); return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/api/notifications') {
      return send(res, 200, { settings: notifySettings, types: NOTIFY_TYPES, log: sentLog.log.slice(-20).reverse(), pending: sentLog.pending.length, playing: await gameRunning() });
    }
    if (req.method === 'POST' && p === '/api/notifications') {
      replaceContents(notifySettings, cleanSettings((await readBody(req)).settings));
      await writeJson(path.join(DATA, 'notifications.json'), notifySettings);
      return send(res, 200, { ok: true, settings: notifySettings });
    }
    if (req.method === 'POST' && p === '/api/notifications/test') {
      const ok = await showToast('Test notification', 'Notifications from the tracker are working.');
      sentLog.log.push({ t: new Date().toISOString(), type: 'test', title: 'Test notification', body: 'Notifications from the tracker are working.', delivered: ok });
      await saveNotified();
      return send(res, ok ? 200 : 500, ok ? { ok: true } : { error: 'Windows did not accept the notification.' });
    }
    if (req.method === 'POST' && p === '/api/plans') return send(res, ...(await handlePlan(await readBody(req))).slice(0, 2));
    // script errors reported by the page, for "Report a problem"
    if (req.method === 'POST' && p === '/api/client-error') {
      const b = await readBody(req, 8 * 1024);
      if (clientErrors.allow()) errorLog.add(`page${b.where ? ` ${String(b.where).slice(0, 20)}` : ''}`, `${b.message || ''}${b.stack ? `\n${b.stack}` : ''}`);
      return send(res, 200, { ok: true });
    }
    // diagnostics shown before opening an issue (already cleaned)
    if (req.method === 'GET' && p === '/api/report') {
      const fromPack = (await staticPath('gamedata.json')).startsWith(GAMEDATA);
      const text = diagnostics({
        appVersion: APP_VERSION, gameBuild: gameBuildSeen, accounts: accounts.size, errors: errorLog.list(),
        data: {
          dataBuild: gameData?.gameBuild, dataVersion: gameData?.dataVersion, pack: fromPack,
          stale: !!(gameBuildSeen && gameData?.gameBuild && compareBuilds(gameBuildSeen, gameData.gameBuild) > 0),
          packResult: dataPack.url ? dataPack.result : null, packError: dataPack.url ? dataPack.error : null,
        },
        page: url.searchParams.get('page'),
      });
      return send(res, 200, { repo: ISSUES_REPO, appVersion: APP_VERSION, diagnostics: text, errors: errorLog.list().length });
    }
    if (req.method === 'POST' && p === '/api/report/clear') { errorLog.clear(); rev++; return send(res, 200, { ok: true }); }
    // Exe only: the app window has its own browser profile, so allowed outside links open in the default browser.
    if (req.method === 'POST' && p === '/api/open-external' && STANDALONE) {
      const target = String((await readBody(req, 16 * 1024)).url || '');
      if (!/^[^\s"<>^`|]+$/.test(target) || !EXTERNAL_LINKS.some((ok) => target === ok || target.startsWith(`${ok}/`))) return send(res, 400, { error: 'not an allowed link' });
      process.emit('rumble:open-external', target);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/quit' && STANDALONE) {
      send(res, 200, { ok: true });
      setTimeout(() => shutdown('Quit from the page'), 200);
      return;
    }
    // app update: "Download now" (exe only) and "Later" (hides the pop-up until the tracker restarts)
    if (req.method === 'POST' && p === '/api/update' && STANDALONE) return send(res, ...(await startAppUpdate()));
    if (req.method === 'POST' && p === '/api/update/later') { appUpdate.later = dataPack.newVersion; rev++; return send(res, 200, { ok: true }); }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (p.startsWith('/static/')) {
      // an installed data pack takes precedence
      const rel = p.slice('/static'.length);
      const inPack = path.resolve(GAMEDATA, `.${rel}`);
      if (inPack.startsWith(GAMEDATA + path.sep)) { try { await stat(inPack); return serveFile(res, GAMEDATA, rel); } catch { /* not in the pack */ } }
      return serveFile(res, STATIC, rel);
    }
    return serveFile(res, PUBLIC, p === '/' ? '/index.html' : p);
  } catch (e) {
    if (!e.status || e.status >= 500) errorLog.add('server', `${req.method} ${req.url?.split('?')[0]}: ${e.message}`);
    send(res, e.status || 500, { error: e.message });
  }
});
// page error reports: at most 20 per minute
const clientErrors = { n: 0, since: Date.now(), allow() { if (Date.now() - this.since > 60000) { this.n = 0; this.since = Date.now(); } return ++this.n <= 20; } };

// ---- scanning: only while the game runs ----------------------------------------------------------------------
// The save only changes while Warcraft Rumble runs, so it is read every SCAN_MS then, a few more times after the game
// closes, and not at all otherwise. If the watcher can't run, the save is read all the time as before.
let scansLeft = 0; // scans still due after the game closed
let stopping = false;
const game = watchGame((running) => {
  console.log(running ? 'Warcraft Rumble started: reading the save' : 'Warcraft Rumble closed: reading paused');
  if (running) scan();
  else scansLeft = SCANS_AFTER_EXIT;
  rev++;
}, (message) => { console.log(`Game check: ${message}; reading the save all the time`); errorLog.add('game check', message); });
const gameRunning = async () => game.running() ?? gameRunningOnce();
await scan();
setInterval(() => {
  if (stopping) return;
  if (game.running() === false) {
    if (scansLeft <= 0) return;
    scansLeft--;
  }
  scan();
}, SCAN_MS);

/** Stops after a running scan and every queued write have finished (page Quit, tray Quit, app update). */
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(reason);
  const deadline = Date.now() + 15000;
  while (scanning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await Promise.race([flushWrites(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
  process.exit(code);
}
// the launcher's tray Quit (desktop/launcher.cjs)
process.on('rumble:quit', () => shutdown('Quit from the tray'));

// ---- notifications ------------------------------------------------------------------------------------
async function notifyTick() {
  if (!notifySettings.enabled) return;
  const now = Date.now();
  const nameOf = new Map(minis.map((m) => [m.slug, m.name]));
  const list = [...accounts.entries()]
    .filter(([id, acc]) => acc.snapshot && (!notifySettings.account || id === notifySettings.account))
    .map(([id, acc]) => ({
      id, label: accountLabel(id), shop: acc.shop, currencies: acc.snapshot.currencies,
      units: acc.snapshot.units.map((u) => ({ ...u, slug: unitSlug(u.id), name: nameOf.get(unitSlug(u.id)) })),
    }));
  const due = dueNotifications({ now, accounts: list, events: eventsTable, store: storeTable, rules, plans, settings: notifySettings, multi: list.length > 1, appUpdateNeeded: dataPack.needsAppUpdate, newVersion: dataPack.newVersion })
    .filter((n) => !sentLog.sent[n.key]);
  if (!due.length && !(sentLog.pending.length && !inQuietHours(notifySettings.quiet))) return;
  const stamp = new Date(now).toISOString();
  for (const n of due) sentLog.sent[n.key] = stamp;
  if (notifyBaseline) { notifyBaseline = false; await saveNotified(); return; }
  const playing = due.length ? await gameRunning() : false;
  const deliver = due.filter((n) => !playing || notifySettings.types[n.type]?.whenPlaying);
  if (inQuietHours(notifySettings.quiet)) {
    sentLog.pending = [...sentLog.pending, ...deliver].slice(-20);
    await saveNotified();
    return;
  }
  const batch = [...sentLog.pending, ...deliver];
  sentLog.pending = [];
  // more than two of one kind: combine into one notification
  const byType = new Map();
  for (const n of batch) (byType.get(n.type) || byType.set(n.type, []).get(n.type)).push(n);
  for (const [type, items] of byType) {
    const toSend = items.length > 2
      ? [{ type, title: `${items.length}× ${NOTIFY_TYPES.find((t) => t.id === type)?.label || type}`, body: items.map((n) => n.body.replace(/\.$/, '')).join(' · ') }]
      : items;
    for (const n of toSend) {
      const ok = await showToast(n.title, n.body);
      sentLog.log.push({ t: stamp, type: n.type, title: n.title, body: n.body, delivered: ok });
    }
  }
  await saveNotified();
}
async function saveNotified() {
  const cutoff = Date.now() - 30 * 86400000; // keys expire after 30 days
  for (const [k, t] of Object.entries(sentLog.sent)) if (Date.parse(t) < cutoff) delete sentLog.sent[k];
  sentLog.log = sentLog.log.slice(-50);
  await writeJson(notifiedFile, sentLog);
}
const notifyFailed = (e) => { console.log(`Notifications: ${e.message}`); errorLog.add('notifications', e.message); };
setInterval(() => notifyTick().catch(notifyFailed), 30000);
notifyTick().catch(notifyFailed);

// ---- data packs (address: see dataPackUrl above) ------------------------------------------------------------
// Two signature failures in a row (rechecked after 15 minutes) mean packs are signed with a key this version doesn't
// know: ask the user to download the current version. A verified pack clears it.
const RECHECK_MS = Number(process.env.RUMBLE_PACK_RECHECK_MS) || 15 * 60 * 1000; // env override for testing
// one check at a time (start-up, recheck and the 6-hour timer share the staging folder)
let packCheck = null;
function checkDataPack() {
  packCheck ??= runPackCheck().finally(() => { packCheck = null; });
  return packCheck;
}
async function runPackCheck() {
  if (!dataPackUrl) return;
  dataPack.lastCheck = new Date().toISOString();
  try {
    const r = await updateDataPack({ base: dataPackUrl, current: gameData, dir: GAMEDATA, staticDir: STATIC });
    dataPack.result = r.reason;
    dataPack.error = null;
    dataPack.badSignatures = 0;
    if (dataPack.needsAppUpdate) { dataPack.needsAppUpdate = false; rev++; }
    const newVersion = r.latestAppVersion && APP_VERSION && newerVersion(r.latestAppVersion, APP_VERSION) ? r.latestAppVersion : null;
    if (newVersion !== dataPack.newVersion) { dataPack.newVersion = newVersion; rev++; if (newVersion) notifyTick().catch(notifyFailed); }
    const latestApp = newVersion ? latestAppOf({ latestApp: r.latestApp }) : null;
    if (JSON.stringify(latestApp) !== JSON.stringify(dataPack.latestApp)) { dataPack.latestApp = latestApp; rev++; }
    if (r.updated) {
      await loadTables();
      rev++;
      console.log(`Data pack: ${r.reason} (${r.downloaded} files downloaded)`);
    }
  } catch (e) {
    dataPack.error = e.message;
    console.log(`Data pack check failed: ${e.message}`);
    errorLog.add('data pack', e.message);
    if (e.code === 'BAD_SIGNATURE') {
      dataPack.badSignatures++;
      if (dataPack.badSignatures === 1) setTimeout(checkDataPack, RECHECK_MS);
      else if (!dataPack.needsAppUpdate) { dataPack.needsAppUpdate = true; rev++; notifyTick().catch(notifyFailed); }
    }
  }
}
if (dataPackUrl && !allowedUrl(dataPackUrl)) console.log('Data pack address ignored: it must be https.');

// ---- app updates (update/appupdate.mjs) -----------------------------------------------------------------------
// state: null | 'downloading' | 'restarting' | 'failed'. The launcher swaps the exe in and restarts the tracker.
const UPDATE_DIR = path.join(DATA, 'update');
const appUpdate = { state: null, error: null, later: null };
cleanUpdates(UPDATE_DIR); // a download already copied into place by the launcher
async function startAppUpdate() {
  const app = dataPack.latestApp;
  if (!app || app.version !== dataPack.newVersion) return [409, { error: 'No update to install.' }];
  if (appUpdate.state === 'downloading' || appUpdate.state === 'restarting') return [200, { ok: true }];
  Object.assign(appUpdate, { state: 'downloading', error: null });
  rev++;
  (async () => {
    try {
      console.log(`App update: downloading ${app.version}`);
      const exe = await downloadUpdate(app, UPDATE_DIR);
      appUpdate.state = 'restarting';
      rev++;
      // give the page a moment to show it, then stop cleanly and let the launcher swap the exe
      await new Promise((r) => setTimeout(r, 1500));
      process.emit('rumble:apply-update', { exe, version: app.version, done: (err) => {
        if (!err) return shutdown(`App update: restarting as ${app.version}`);
        Object.assign(appUpdate, { state: 'failed', error: err });
        errorLog.add('app update', err);
        rev++;
      } });
    } catch (e) {
      console.log(`App update failed: ${e.message}`);
      errorLog.add('app update', e.message);
      Object.assign(appUpdate, { state: 'failed', error: e.message });
      rev++;
    }
  })();
  return [200, { ok: true }];
}
checkDataPack();
setInterval(checkDataPack, 6 * 60 * 60 * 1000);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Rumble tracker running at http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA}`);
  // count only: account names are user-given and the log may be attached to bug reports
  console.log(`Accounts found: ${accounts.size}${lastErrorLog ? `  (error: ${lastErrorLog})` : ''}`);
});
