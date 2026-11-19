// API handlers that change the user's data. Each takes the parsed JSON body and returns [status, body].
import { restoreBackup } from '../backup.mjs';
import { BACKUP_KEYS } from '../userdata.mjs';
import { manualResult } from '../game/pvp.mjs';
import { unitSlug } from '../state.mjs';

export const isId = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

/** Normalises tags: trimmed, at most 30 characters and 20 per army, case-insensitively unique. */
export function cleanTags(tags) {
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

/** A saved army with only known minis, valid talents and bounded text. */
export function cleanArmy(a, slugs, { keepEmptyId = false } = {}) {
  const okSlug = (s) => typeof s === 'string' && slugs.has(s);
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

export function createHandlers(ctx) {
  const u = () => ctx.user;
  const ok = async (key, body = { ok: true }, bump = true) => { await u().save(key); if (bump) ctx.bump(); return [200, body]; };

  return {
    /** Names an account or assigns a mini to a unit ID: { kind: 'account'|'unit', id, value }. */
    async name({ kind, id, value }) {
      const v = typeof value === 'string' ? value.trim() : '';
      const names = u().names;
      if (!isId(id)) return [400, { error: 'bad id' }];
      if (kind === 'unit') {
        if (v && !ctx.tables.slugs.has(v)) return [400, { error: 'unknown mini' }];
        const allIds = new Set([...Object.keys(ctx.tables.builtinUnits), ...Object.keys(names.units)]);
        const takenBy = [...allIds].find((other) => other !== id && unitSlug(ctx, other) === v);
        if (v && takenBy) return [409, { error: 'That mini is already assigned to another unit.', takenBy }];
        if (v) names.units[id] = v; else delete names.units[id];
      } else if (kind === 'account') {
        if (v.length > 40) return [400, { error: 'name too long' }];
        if (v) names.accounts[id] = v; else delete names.accounts[id];
      } else {
        return [400, { error: 'bad kind' }];
      }
      return ok('names');
    },

    /** Talents the user picked for a unit: { account, unitId, picks: [0..2] }. */
    async talents({ account, unitId, picks }) {
      if (!isId(account) || !isId(unitId) || !Array.isArray(picks)) return [400, { error: 'bad request' }];
      const clean = [...new Set(picks.filter((p) => Number.isInteger(p) && p >= 0 && p < 3))].sort();
      (u().talents[account] ??= {})[unitId] = clean;
      return ok('talents', { ok: true, picks: clean });
    },

    /** A leader's army slots: { account, unitId, slots: [{ type, tier, boost? }] }. */
    async army({ account, unitId, slots }) {
      const A = ctx.tables.rules.armySlots;
      const maxTier = A.tiers.length - 1;
      if (!isId(account) || !isId(unitId) || !Array.isArray(slots) || slots.length !== A.count) return [400, { error: 'bad request' }];
      const clean = slots.map((s, i) => ({
        type: i === A.leaderSlot ? 'Leader' : String(s?.type || '').slice(0, 40),
        tier: Math.max(0, Math.min(maxTier, Number.isInteger(s?.tier) ? s.tier : 0)),
        // only the bottom-right slot can be a Boost slot
        ...(i === A.boostSlot && s?.boost === true ? { boost: true } : {}),
      }));
      (u().army[account] ??= {})[unitId] = clean;
      return ok('army', { ok: true, slots: clean });
    },

    /** Sets or clears a reward goal: { account, eventId, plan: { cost, label } | null }. */
    async plan({ account, eventId, plan }) {
      if (!isId(account) || typeof eventId !== 'string' || eventId.length > 80) return [400, { error: 'bad request' }];
      const mine = (u().plans[account] ??= {});
      if (plan && Number.isInteger(plan.cost) && plan.cost > 0) mine[eventId] = { cost: plan.cost, label: String(plan.label || 'your picks').slice(0, 120), set: new Date().toISOString() };
      else delete mine[eventId];
      return ok('plans');
    },

    /** The army being edited: { account, draft }. No new revision: the sending page already shows it. */
    async draft({ account, draft }) {
      if (!isId(account) || !draft || typeof draft !== 'object') return [400, { error: 'bad request' }];
      u().drafts[account] = { ...cleanArmy(draft, ctx.tables.slugs, { keepEmptyId: true }), updated: new Date().toISOString() };
      return ok('drafts', { ok: true }, false);
    },

    /** All saved armies of an account: { account, armies } (at most 50). */
    async armies({ account, armies }) {
      if (!isId(account) || !Array.isArray(armies) || armies.length > 50) return [400, { error: 'bad request' }];
      const clean = armies.map((a) => cleanArmy(a, ctx.tables.slugs));
      u().armies[account] = clean;
      return ok('armies', { ok: true, armies: clean });
    },

    /** The player's own result for an unexplained PvP change: { account, t, result: 'win' | 'loss' | null }. */
    async pvpResult({ account, t, result }) {
      if (!isId(account) || typeof t !== 'string') return [400, { error: 'bad request' }];
      const entry = (u().pvpHistory[account] || []).find((e) => e.t === t);
      if (!manualResult(entry, result ?? null)) return [400, { error: 'This change can\'t be set by hand.' }];
      return ok('pvpHistory');
    },

    /** Restores a backup file: { backup }. */
    async restore({ backup }) {
      const restored = restoreBackup(u().backupFiles(), backup);
      if (!restored) return [400, { error: 'This is not a Rumble Tracker backup file.' }];
      u().repair();
      for (const key of restored) await u().save(BACKUP_KEYS[key]);
      ctx.bump();
      return [200, { ok: true, restored, created: backup.created }];
    },
  };
}
