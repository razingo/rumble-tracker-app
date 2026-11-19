// Scans: reads the save, updates each account's snapshot (state/<id>.json) and the history kept from it.
import path from 'node:path';
import { writeJson } from '../store.mjs';
import { parsePvp } from '../game/pvp.mjs';
import { parseUnits, parseCurrencies, parseActiveEvents, parseIncomeBonuses, parseOwnedAvatars, parseStore, parseGameBuild, storeFieldsForLog, diffSnapshots, updateLearned } from '../game/model.mjs';
import { recordProgress, logGrid, recordPvp, createStoreLog } from './history.mjs';
import { accountLabel } from '../state.mjs';

export const MAX_EVENTS = 500;
// Reads can collide with the game saving; only failures that persist are reported.
export const FAILS_BEFORE_ERROR = 3;

/** readPrefs(): { [account]: { units, currencies, store, profile, commerce, pvp: Buffer } } (game/prefs.mjs). */
export function createScanner(ctx, { readPrefs }) {
  const failures = new Map(); // 'read' or account id -> consecutive failures
  const status = ctx.scan;
  const storeLog = ctx.user.storeChanges ? createStoreLog(ctx.user.storeChanges) : null;

  // logMessage omits user-given names, for problem reports and tracker.log
  function noteFailure(key, message, logMessage = message) {
    const n = (failures.get(key) || 0) + 1;
    failures.set(key, n);
    if (n >= FAILS_BEFORE_ERROR) {
      status.lastError = message;
      status.lastErrorLog = logMessage;
      ctx.errorLog.add(key === 'read' ? 'reading the save' : 'decoding the save', logMessage);
    }
  }
  function noteSuccess(key) {
    failures.delete(key);
    if (![...failures.values()].some((n) => n >= FAILS_BEFORE_ERROR)) { status.lastError = null; status.lastErrorLog = null; }
  }

  /** The account's state, loaded from state/<id>.json on first use (and moved from older formats). */
  async function account(id, dirty) {
    let acc = ctx.accounts.get(id);
    if (acc) return acc;
    acc = await ctx.readUserJson(path.join(ctx.paths.STATE, `${id}.json`), { snapshot: null, events: [] });
    ctx.accounts.set(id, acc);
    if (acc.pvpLog) { // versions before 0.4.0 kept the PvP log here
      if (!ctx.user.pvpHistory[id]) { ctx.user.pvpHistory[id] = acc.pvpLog; dirty.add('pvpHistory'); }
      delete acc.pvpLog;
    }
    return acc;
  }

  /** Applies one account's entries. Returns whether its state changed. */
  async function scanAccount(id, entries, now, dirty) {
    const { rules, pvp: pvpTable, store: storeTable } = ctx.tables;
    const u = ctx.user;
    let cur;
    try {
      cur = { units: parseUnits(entries.units), currencies: parseCurrencies(entries.currencies) };
      noteSuccess(id);
    } catch (e) {
      // usually a value caught mid-save: keep the last snapshot and retry
      noteFailure(id, `Could not decode ${accountLabel(ctx, id)}: ${e.message}`, `Could not decode an account: ${e.message}`);
      return false;
    }
    const acc = await account(id, dirty);
    let changed = !acc.snapshot;
    const events = acc.snapshot ? diffSnapshots(acc.snapshot, cur, rules, now) : [];
    if (events.length) {
      acc.events = [...acc.events, ...events].slice(-MAX_EVENTS);
      acc.lastChange = now;
      changed = true;
    }
    if (updateLearned(u.learned, cur, events, rules, now)) dirty.add('learned');
    acc.snapshot = cur;
    if (recordProgress(u.progress, id, cur, Date.parse(now), rules)) dirty.add('progress');
    // running events, avatars, shop; a value caught mid-save keeps the previous one until the next scan
    try {
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const active = parseActiveEvents(entries.store);
      if (entries.store && !same(active, acc.activeEvents || [])) { acc.activeEvents = active; acc.activeEventsAt = now; changed = true; }
      const avatars = parseOwnedAvatars(entries.profile);
      if (entries.profile && !same(avatars, acc.ownedAvatars || [])) { acc.ownedAvatars = avatars; changed = true; }
      if (storeLog && storeLog(id, storeFieldsForLog(entries.store), now, (offer) => storeTable?.offers?.[offer]?.name)) dirty.add('storeChanges');
      const shop = parseStore(entries.store);
      if (shop && !same(shop, acc.shop || null)) {
        acc.shop = shop;
        changed = true;
        if (logGrid(u.gridHistory, id, shop.grid, now)) dirty.add('gridHistory');
      }
      const bonuses = parseIncomeBonuses(entries.store);
      if (entries.store && !same(bonuses, acc.incomeBonuses || [])) { acc.incomeBonuses = bonuses; changed = true; }
    } catch { /* caught mid-save */ }
    try {
      if (recordPvp(u.pvpHistory, id, acc, parsePvp(entries.pvp), now, pvpTable?.victoryPoints)) { changed = true; dirty.add('pvpHistory'); }
    } catch { /* caught mid-save */ }
    if (changed) await writeJson(path.join(ctx.paths.STATE, `${id}.json`), acc);
    return changed;
  }

  /** One scan; does nothing while another is running. */
  async function scan() {
    if (status.scanning) return;
    status.scanning = true;
    try {
      let prefs;
      try {
        prefs = await readPrefs();
        noteSuccess('read');
      } catch (e) {
        noteFailure('read', e.message);
        return;
      }
      const now = new Date().toISOString();
      status.lastScan = now;
      for (const entries of Object.values(prefs)) {
        try { const b = parseGameBuild(entries.commerce); if (b) status.gameBuild = b; } catch { /* caught mid-save */ }
      }
      const dirty = new Set(); // user-data files to save
      let changed = false;
      for (const [id, entries] of Object.entries(prefs)) {
        if (entries.units && await scanAccount(id, entries, now, dirty)) changed = true;
      }
      for (const key of dirty) await ctx.user.save(key);
      // the page shows these; the research log and G.R.I.D. history change nothing it shows on their own
      if (changed || dirty.has('learned') || dirty.has('progress') || dirty.has('pvpHistory')) ctx.bump();
    } finally {
      status.scanning = false;
    }
  }

  return { scan };
}
