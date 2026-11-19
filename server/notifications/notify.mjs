// Determines which notifications are due, from the scanned save and the event schedules. Each has a unique key so
// it is sent once; the server tracks sent keys, applies quiet hours and delivers them (toast.mjs).
import { occurrences, rotationAt, rotationName, DAY } from '../game/schedule.mjs';
import { seasonAt, setAt, rankOf } from '../../web/scripts/lib/pvp.js';

const HOUR = 3600000;
const GRACE = 3 * HOUR; // older occurrences (tracker not running) are not announced

/** Notification types: id, label, default state, and whether sent while the game is running. */
export const NOTIFY_TYPES = [
  { id: 'freeGift', label: 'Free gift ready', on: true, whenPlaying: false },
  { id: 'dailyReset', label: 'Daily shop offers reset', on: false, whenPlaying: false },
  { id: 'gridRefresh', label: 'New G.R.I.D.', on: true, whenPlaying: false },
  { id: 'eventStart', label: 'An event starts', on: true, whenPlaying: true },
  { id: 'eventEnding', label: 'An event ends soon', on: true, whenPlaying: true, hoursBefore: 3 },
  { id: 'rotation', label: 'Dungeon faction, dungeon or raid/siege changes', on: false, whenPlaying: false },
  { id: 'upgradeReady', label: 'A mini is ready to upgrade', on: true, whenPlaying: false },
  { id: 'planAffordable', label: 'Enough tickets for a reward goal', on: true, whenPlaying: true },
  { id: 'pvpSeasonEnd', label: 'The PvP season ends soon', on: true, whenPlaying: true, hoursBefore: 48 },
  { id: 'pvpModifiers', label: 'PvP modifiers change', on: false, whenPlaying: false },
  { id: 'appUpdate', label: 'A new tracker version is available', on: true, whenPlaying: true },
];

export function defaultSettings() {
  return {
    enabled: true,
    account: null, // null: all accounts
    types: Object.fromEntries(NOTIFY_TYPES.map((t) => [t.id, { on: t.on, whenPlaying: t.whenPlaying, ...(t.hoursBefore ? { hoursBefore: t.hoursBefore } : {}) }])),
    quiet: { on: false, from: '23:00', to: '08:00' },
  };
}

/** Validated settings merged over the defaults. */
export function cleanSettings(s) {
  const d = defaultSettings();
  const time = (v, fb) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fb);
  const out = {
    enabled: typeof s?.enabled === 'boolean' ? s.enabled : d.enabled,
    account: typeof s?.account === 'string' && /^[0-9a-f]{32}$/.test(s.account) ? s.account : null,
    types: {},
    quiet: { on: !!s?.quiet?.on, from: time(s?.quiet?.from, d.quiet.from), to: time(s?.quiet?.to, d.quiet.to) },
  };
  for (const t of NOTIFY_TYPES) {
    const v = s?.types?.[t.id] || {};
    out.types[t.id] = { on: typeof v.on === 'boolean' ? v.on : d.types[t.id].on, whenPlaying: typeof v.whenPlaying === 'boolean' ? v.whenPlaying : d.types[t.id].whenPlaying };
    if (t.hoursBefore) out.types[t.id].hoursBefore = Math.min(72, Math.max(1, Number.isFinite(+v.hoursBefore) ? Math.round(+v.hoursBefore) : t.hoursBefore));
  }
  return out;
}

/** Whether `now` falls within quiet hours (which may span midnight). */
export function inQuietHours(quiet, now = new Date()) {
  if (!quiet?.on) return false;
  const mins = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const n = now.getHours() * 60 + now.getMinutes(), a = mins(quiet.from), b = mins(quiet.to);
  return a <= b ? n >= a && n < b : n >= a || n < b;
}

const fmtTime = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const span = (ms) => { const h = Math.round(ms / HOUR); return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 60000))} min`; };

/**
 * Notifications due now: [{ type, key, title, body }].
 * ctx = { now, accounts: [{ id, label, shop, currencies, units, pvp }], events, store, rules, pvp, plans, settings, multi }.
 */
export function dueNotifications(ctx) {
  const { now, settings, events, store, rules } = ctx;
  const on = (id) => settings.enabled && settings.types[id]?.on;
  const out = [];
  const add = (type, key, title, body) => out.push({ type, key, title, body });
  const who = (a) => (ctx.multi ? ` (${a.label})` : '');
  const balanceOf = (a, id) => a.currencies?.find((c) => c.id === id)?.balance ?? 0;

  // game-data updates need a newer version of the tracker (sent once; keys expire after 30 days)
  if (ctx.appUpdateNeeded && on('appUpdate')) {
    add('appUpdate', 'app-update-needed', 'Tracker update needed',
      'New game data needs a newer version of Rumble Collection Tracker. Download it from GitHub Releases.');
  } else if (ctx.newVersion && on('appUpdate')) {
    add('appUpdate', `app-version-${ctx.newVersion}`, 'Tracker update available',
      `Rumble Collection Tracker ${ctx.newVersion} is available. Open the tracker to install it.`);
  }

  // shop: free gift, daily reset, new G.R.I.D.
  for (const a of ctx.accounts) {
    const shop = a.shop;
    if (on('freeGift') && shop) {
      for (const o of shop.offers || []) {
        if (!/^FreeGift_/.test(store?.offers?.[o.offer]?.name || '') || !o.expires) continue;
        const t = Date.parse(o.expires);
        if (now >= t && now - t < GRACE) add('freeGift', `freeGift:${a.id}:${o.expires}`, `Free gift ready${who(a)}`, 'A new free gift is waiting in the shop.');
      }
    }
    if (on('gridRefresh') && shop?.grid?.refresh) {
      const t = Date.parse(shop.grid.refresh);
      if (now >= t && now - t < GRACE) add('gridRefresh', `grid:${a.id}:${shop.grid.refresh}`, `New G.R.I.D.${who(a)}`, 'The G.R.I.D. has new minis.');
    }
  }
  if (on('dailyReset')) {
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18);
    if (t > now) t -= DAY;
    if (now - t < GRACE) add('dailyReset', `daily:${new Date(t).toISOString().slice(0, 10)}`, 'Daily offers reset', 'New daily offers are in the shop.');
  }

  // events starting or ending
  const runs = (events?.events || []).flatMap((ev) => occurrences(ev, now - 2 * DAY, now + 4 * DAY).map((o) => ({ ev, ...o })));
  const seenName = new Set();
  for (const r of runs.sort((x, y) => x.start - y.start)) {
    const name = r.ev.name || r.ev.id;
    if (on('eventStart') && now >= r.start && now - r.start < GRACE && !seenName.has(`s:${name}`)) {
      seenName.add(`s:${name}`);
      add('eventStart', `evStart:${r.ev.id}:${r.start}`, `${name} has started`, `Runs until ${fmtTime(r.end)}.`);
    }
    const lead = (settings.types.eventEnding?.hoursBefore || 3) * HOUR;
    if (on('eventEnding') && now < r.end && r.end - now <= lead && !seenName.has(`e:${name}`)) {
      seenName.add(`e:${name}`);
      const tickets = r.ev.currency && events.currencies?.[r.ev.currency]
        ? ctx.accounts.map((a) => balanceOf(a, events.currencies[r.ev.currency])).reduce((x, y) => Math.max(x, y), 0) : 0;
      add('eventEnding', `evEnd:${r.ev.id}:${r.end}`, `${name} ends in ${span(r.end - now)}`,
        tickets > 0 ? `You still have ${tickets.toLocaleString('en-US')} tickets to spend.` : `It ends ${fmtTime(r.end)}.`);
    }
  }

  // dungeon and raid rotations
  if (on('rotation')) {
    for (const rot of events?.rotations || []) {
      const cur = rotationAt(rot, now);
      if (now - cur.start < GRACE) add('rotation', `rot:${rot.id}:${cur.start}`, `${rot.label}: ${rotationName(cur.item)}`, `Until ${fmtTime(cur.end)}.`);
    }
  }

  // PvP: the season ends soon (Victory Road resets; season-end rewards by rank), the modifier set changes
  if (ctx.pvp?.seasons) {
    const season = seasonAt(ctx.pvp, now);
    const end = season && Date.parse(season.end);
    const lead = (settings.types.pvpSeasonEnd?.hoursBefore || 48) * HOUR;
    if (season && on('pvpSeasonEnd') && end - now <= lead) {
      const ranks = ctx.accounts.filter((a) => a.pvp?.season === season.saveId).map((a) => `${rankOf(ctx.pvp, a.pvp.honor).name}${who(a)}`);
      add('pvpSeasonEnd', `pvpEnd:${season.id}`, `${season.name} ends in ${span(end - now)}`,
        `Claim your Victory Road rewards before it resets.${ranks.length ? ` Season-end rewards at your rank: ${ranks.join(', ')}.` : ''}`);
    }
    const set = on('pvpModifiers') ? setAt(ctx.pvp, now) : null;
    if (set && now - set.start < GRACE) {
      add('pvpModifiers', `pvpMods:${set.start}`, 'New PvP modifiers',
        `${set.mods.map((id) => ctx.pvp.modifiers?.[id]?.name || id).join(', ')}, until ${fmtTime(set.end)}.`);
    }
  }

  // minis newly ready to upgrade (stars, Arc Energy and cores available)
  if (on('upgradeReady') && rules) {
    for (const a of ctx.accounts) {
      for (const u of a.units || []) {
        const step = rules.rarityUpgrade?.[u.rarity];
        if (!step || !u.slug) continue;
        const ready = u.stars >= step.stars && balanceOf(a, rules.currencyIds.arcEnergy) >= step.arcEnergy
          && (!step.core || balanceOf(a, rules.currencyIds[step.core]) >= 1);
        if (ready) add('upgradeReady', `up:${a.id}:${u.id}:${u.rarity}`, `Ready to upgrade${who(a)}`, `${u.name || u.slug} can be upgraded to ${rules.rarities[u.rarity + 1]?.name || 'the next rarity'}.`);
      }
    }
  }

  // reward goals: enough tickets while the event runs
  if (on('planAffordable')) {
    for (const a of ctx.accounts) {
      for (const [evId, plan] of Object.entries(ctx.plans?.[a.id] || {})) {
        const ev = (events?.events || []).find((e) => e.id === evId);
        if (!ev || !ev.currency || !plan.cost) continue;
        if (!occurrences(ev, now, now + 1).length) continue; // event not running
        const have = balanceOf(a, events.currencies[ev.currency]);
        if (have >= plan.cost) add('planAffordable', `plan:${a.id}:${evId}:${plan.cost}`, `Enough tickets${who(a)}`, `You have ${have.toLocaleString('en-US')} tickets: enough for ${plan.label} (${plan.cost.toLocaleString('en-US')}).`);
      }
    }
  }
  return out;
}
