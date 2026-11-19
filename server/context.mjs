// The server's shared state, passed to every module. One object so modules stay small and can be tested with a
// context built from temporary folders (see test/helpers.mjs).
import path from 'node:path';
import { createErrorLog } from './report.mjs';
import { readJson } from './store.mjs';

/**
 * root: the app folder (server/, web/, gamedata/); data: the user's data folder. Returns the context; tables and
 * user data are attached by tables.mjs and userdata.mjs.
 */
export function createContext({ root, data, port = 8765, standalone = false, appVersion = null }) {
  const errorLog = createErrorLog();
  const ctx = {
    paths: {
      ROOT: root,
      DATA: data,
      STATE: path.join(data, 'state'),         // scan snapshots per account
      PUBLIC: path.join(root, 'web'),
      STATIC: path.join(root, 'gamedata'),     // bundled game data, served as /static/
      GAMEDATA: path.join(data, 'gamedata'),   // an installed data pack (takes precedence)
      UPDATE: path.join(data, 'update'),       // a downloaded app update
      BACKUPS: path.join(data, 'backups'),     // daily backups
    },
    port, standalone, appVersion,
    // recent errors for "Report a problem": cleaned of personal details, in memory only
    errorLog,
    // revision of the state the page shows; starts from the clock so a restarted server never repeats one
    rev: Date.now(),
    bump() { ctx.rev++; },
    tables: null,
    user: null,
    accounts: new Map(), // account id -> { snapshot, events, lastChange, activeEvents, shop, pvp, … } (state/<id>.json)
    scan: { lastScan: null, lastError: null, lastErrorLog: null, gameBuild: null, scanning: false },
    // data pack checks (datapack/checker.mjs); newVersion: a newer app release, latestApp: its download checksums
    dataPack: { url: '', lastCheck: null, result: null, error: null, badSignatures: 0, needsAppUpdate: false, newVersion: null, latestApp: null },
    // app update (update/updater.mjs): state null | 'downloading' | 'restarting' | 'failed'
    appUpdate: { state: null, error: null, later: null, done: 0, total: 0 },
    // whether Warcraft Rumble runs: true, false or null (unknown); set by main.mjs
    game: { running: () => null },
    /** Reads one of the user's JSON files; a damaged one is moved aside and reported (store.mjs). */
    readUserJson: (p, fallback) => readJson(p, fallback, {
      onCorrupt: (file, moved) => {
        const msg = `${path.basename(file)} was damaged and could not be read. It was moved to ${path.basename(moved)} and the tracker started without it; restore a backup to get the data back.`;
        console.log(msg);
        errorLog.add('data file', msg);
      },
    }),
  };
  return ctx;
}
