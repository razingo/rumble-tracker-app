// The user's own files in the data folder: what they entered, and history the save can't give back.
import path from 'node:path';
import { writeJson } from './store.mjs';
import { cleanSettings } from './notifications/notify.mjs';

// property -> file name
const FILES = {
  names: 'names.json',              // { accounts: { id: name }, units: { unitId: slug } }
  talents: 'talents.json',          // { [account]: { [unitId]: [talent index] } }
  army: 'army.json',                // army slots: { [account]: { [unitId]: [{ type, tier, boost? } x7] } }
  armies: 'armies.json',            // saved armies: { [account]: [{ id, name, leader, minis, talents, description, tags }] }
  drafts: 'drafts.json',            // army being edited, per account (auto-saved by the page)
  learned: 'learned.json',          // XP per level and costs seen in the save
  gridHistory: 'grid_history.json', // G.R.I.D.s seen: { [account]: [{ seen, refresh, items }] } (offer cooldowns)
  pvpHistory: 'pvp_history.json',   // PvP readings and inferred matches: { [account]: [entry] } (game/pvp.mjs)
  progress: 'progress.json',        // daily samples: { [account]: { first, days: [...] } }
  notifySettings: 'notifications.json',
  plans: 'plans.json',              // reward goals: { [account]: { [eventId]: { cost, label, set } } }
  sentLog: 'notified.json',         // { sent: { key: time }, log, pending }; pending ones wait for quiet hours to end
  storeChanges: 'store_changes.json', // research log of shop record changes (from source only)
};

// Backup key to property. Backups hold everything the player entered and the history the save can't give back; the
// scan snapshots in state/ are left out, as the next scan rebuilds them.
export const BACKUP_KEYS = {
  names: 'names', talents: 'talents', army: 'army', armies: 'armies', drafts: 'drafts', learned: 'learned',
  grid_history: 'gridHistory', pvp_history: 'pvpHistory', notifications: 'notifySettings', plans: 'plans', progress: 'progress',
};

/** The name the user gave an account, else a short form of its ID. */
export const accountLabel = (ctx, id) => ctx.user.names.accounts[id] || `Account …${id.slice(16, 24)}`;

/** The mini a unit ID stands for: the user's assignment, else the game data's, else null. */
export const unitSlug = (ctx, id) => ctx.user.names.units[id] || ctx.tables.builtinUnits[id] || null;

/** Loads every file (missing ones start empty). storeLog: whether the research log is kept. */
export async function loadUserData(ctx, { storeLog = true } = {}) {
  const dir = ctx.paths.DATA;
  const read = (key, fallback) => ctx.readUserJson(path.join(dir, FILES[key]), fallback);
  const notified = await read('sentLog', null);
  const u = {
    names: await read('names', { accounts: {}, units: {} }),
    talents: await read('talents', {}),
    army: await read('army', {}),
    armies: await read('armies', {}),
    drafts: await read('drafts', {}),
    learned: await read('learned', { xpToNext: {}, xpConflicts: [], spending: [] }),
    gridHistory: await read('gridHistory', {}),
    pvpHistory: await read('pvpHistory', {}),
    progress: await read('progress', {}),
    notifySettings: cleanSettings(await read('notifySettings', {})),
    plans: await read('plans', {}),
    sentLog: notified || { sent: {}, log: [], pending: [] },
    notifyBaseline: !notified, // first run: record what is already due without notifying
    storeChanges: storeLog ? await read('storeChanges', []) : null,
    /** Saves one file. Writes to the same file are queued. */
    save: (key) => writeJson(path.join(dir, FILES[key]), u[key]),
    /** The files a backup holds, by backup key. */
    backupFiles: () => Object.fromEntries(Object.entries(BACKUP_KEYS).map(([k, prop]) => [k, u[prop]])),
    /** After a restore, fills in keys that older or partial backups may lack. */
    repair() {
      u.names.accounts ??= {}; u.names.units ??= {};
      u.learned.xpToNext ??= {}; u.learned.xpConflicts ??= []; u.learned.spending ??= [];
    },
  };
  u.repair();
  return u;
}
