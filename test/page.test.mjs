// The page's calculations (web/scripts): schedules, mini and army rules, PvP records and win rates. These modules
// have no DOM, so they run here as they do in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, rotationAt, rotationName, DAY } from '../web/scripts/lib/schedule.js';
import { seasonAt, rankOf, nextRank, setAt, record, streak, matchesWithMods, modifierStats, withModifiers, winRateSeries } from '../web/scripts/lib/pvp.js';
import { setTables, setState } from '../web/scripts/core.js';
import { nextUpgrade, xpToMax, armyOf, totalLevel, armyTotals, remainingToLegendary, effectivePicks, unitName } from '../web/scripts/units.js';

test('schedules: monthly n-th weekday, fixed days and one-off events', () => {
  // 2nd Wednesday of every month, 18:00 UTC, 7 days
  const ev = { schedule: { kind: 'nthWeekday', every: 'month', nth: 2, weekday: 3, hourUtc: 18, days: 7, fromYear: 2026, month: 1 } };
  const runs = occurrences(ev, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31));
  assert.deepEqual(runs.map((r) => new Date(r.start).toISOString()), ['2026-11-11T18:00:00.000Z', '2026-12-09T18:00:00.000Z']);
  assert.equal(runs[0].end - runs[0].start, 7 * DAY);
  const yearly = { schedule: { kind: 'day', every: 'year', month: 12, day: 15, hourUtc: 10, days: 3, fromYear: 2025 } };
  assert.equal(occurrences(yearly, Date.UTC(2026, 11, 16), Date.UTC(2026, 11, 17)).length, 1); // still running
  const once = { schedule: { kind: 'once', start: '2026-05-01T00:00:00Z', end: '2026-05-03T00:00:00Z' } };
  assert.equal(occurrences(once, Date.UTC(2026, 4, 2), Date.UTC(2026, 4, 2, 1)).length, 1);
  assert.equal(occurrences(once, Date.UTC(2026, 4, 4), Date.UTC(2026, 4, 5)).length, 0);
  const until = { schedule: { ...ev.schedule, until: '2026-11-30' } };
  assert.equal(occurrences(until, Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 31)).length, 0);
});

test('rotations wrap around and work before their start', () => {
  const rot = { start: '2026-01-01T00:00:00Z', periodDays: 7, list: ['A', { name: 'B', type: 'Siege' }, 'C'] };
  assert.equal(rotationAt(rot, Date.UTC(2026, 0, 3)).item, 'A');
  assert.equal(rotationName(rotationAt(rot, Date.UTC(2026, 0, 9)).item), 'B Siege');
  assert.equal(rotationAt(rot, Date.UTC(2026, 0, 22)).item, 'A');
  assert.equal(rotationAt(rot, Date.UTC(2025, 11, 30)).item, 'C');
});

// ---- PvP ---------------------------------------------------------------------------------------------------------
const PVP = {
  seasons: [{ id: 's1', saveId: 'x', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', rotation: { start: '2026-01-01T00:00:00Z', periodDays: 3, sets: [['m1', 'm2'], ['m2', 'm3']] } }],
  ranks: [{ id: 'r0', from: 0 }, { id: 'r1', from: 1000 }, { id: 'r2', from: 2000 }],
};
const at = (day) => new Date(Date.UTC(2026, 0, day, 12)).toISOString();

test('PvP: season, rank and modifier set at a time', () => {
  assert.equal(seasonAt(PVP, Date.UTC(2026, 0, 5)).id, 's1');
  assert.equal(seasonAt(PVP, Date.UTC(2026, 1, 5)), null);
  assert.equal(rankOf(PVP, 1500).id, 'r1');
  assert.equal(nextRank(PVP, rankOf(PVP, 1500)).id, 'r2');
  assert.equal(nextRank(PVP, rankOf(PVP, 2500)), null);
  assert.deepEqual(setAt(PVP, Date.UTC(2026, 0, 2)).mods, ['m1', 'm2']);
  assert.deepEqual(setAt(PVP, Date.UTC(2026, 0, 5)).mods, ['m2', 'm3']);
  assert.deepEqual(setAt(PVP, Date.UTC(2026, 0, 8)).mods, ['m1', 'm2']);
  assert.equal(setAt(PVP, Date.UTC(2026, 1, 5)), null);
});

test('PvP: records, streaks and win rates by modifier', () => {
  const log = [
    { t: at(1), start: true },
    { t: at(2), wins: 1, losses: 0 },               // m1 m2
    { t: at(2), wins: 0, losses: 1, estimated: true },
    { t: at(5), wins: 1, losses: 0 },               // m2 m3
    { t: at(5), unexplained: true },                 // not a match until marked
    { t: at(6), wins: 2, losses: 0 },
  ];
  assert.deepEqual(record(log), { wins: 4, losses: 1, estimated: true, honorOnly: false });
  assert.deepEqual(record(log, Date.UTC(2026, 0, 4)).wins, 3);
  assert.deepEqual(streak(log), { kind: 'win', n: 3 });
  const matches = matchesWithMods(PVP, log);
  assert.equal(matches.length, 4);
  assert.deepEqual(modifierStats(matches), { m1: { wins: 1, losses: 1 }, m2: { wins: 4, losses: 1 }, m3: { wins: 3, losses: 0 } });
  assert.equal(withModifiers(matches, ['m1']).length, 2);
  assert.equal(withModifiers(matches, ['m1', 'm3']).length, 0);
  assert.equal(withModifiers(matches, []).length, 4);
  const series = winRateSeries(withModifiers(matches, ['m2']));
  assert.deepEqual(series.map((p) => p.rate), [1, 0.5, 2 / 3, 0.8]);
});

// ---- minis and armies --------------------------------------------------------------------------------------------
const RULES = {
  rarities: [{ name: 'Common' }, { name: 'Rare' }, { name: 'Epic' }],
  rarityUpgrade: [{ stars: 5, arcEnergy: 100 }, { stars: 10, arcEnergy: 300, core: 'epicCore' }],
  talentSlotsByRarity: [1, 2, 3],
  xpToNext: { 1: 10, 2: 20, 3: 40 }, maxXpLevel: 4,
  currencyIds: { arcEnergy: 'arc', epicCore: 'core' },
  armySlots: { count: 7, leaderSlot: 0, boostSlot: 6, diamondValorCost: 50, tiers: [{ bonus: 0 }, { bonus: 1 }, { bonus: 2 }, { bonus: 3 }] },
};
const MINIS = { minis: [
  { slug: 'boss', name: 'Boss', category: 'Leader', talents: [{}, {}, {}], fixedArmySlots: ['Melee', 'Ranged', 'Wildcard'], armySlotUpgrades: ['Tank', 'Flying', 'Spell'] },
  { slug: 'grunt', name: 'Grunt', category: 'Unit', talents: [{}, {}, {}] },
] };
setTables(RULES, MINIS);
const unit = (o) => ({ id: 'abcdef0123456789', slug: 'grunt', level: 5, rarity: 0, stars: 0, talents: 0, talentPicks: [], xp: 0, xpNeeded: 10, xpLevel: 1, ...o });

test('rarity upgrades: stars, Arc Energy and cores', () => {
  setState({ currencies: [{ id: 'arc', balance: 150 }] });
  assert.equal(nextUpgrade(unit({ stars: 5 })).ready, true);
  assert.equal(nextUpgrade(unit({ stars: 4 })).starsOk, false);
  const rare = nextUpgrade(unit({ rarity: 1, stars: 10 }));
  assert.deepEqual([rare.arcOk, rare.coreOk, rare.ready], [false, false, false]);
  assert.equal(nextUpgrade(unit({ rarity: 2 })), null);
  assert.equal(nextUpgrade(unit({ synthetic: true })), null);
  assert.deepEqual(remainingToLegendary(unit({ stars: 3 })), { arcEnergy: 400, stars: 12, cores: { epicCore: 1 } });
});

test('XP to the top level, talents, names', () => {
  assert.equal(xpToMax(unit({ xpLevel: 1, xp: 4, xpNeeded: 10 })), 6 + 20 + 40);
  assert.equal(xpToMax(unit({ xpLevel: 4 })), 0);
  assert.deepEqual(effectivePicks(unit({ talents: 3, talentPicks: [1] })), [0, 1, 2]); // all unlocked: all count
  assert.deepEqual(effectivePicks(unit({ talents: 1, talentPicks: [1] })), [1]);
  assert.equal(unitName(unit({ slug: null })), 'New mini abcdef01');
});

test('leader army slots: fixed slots, bottom-row rules, Boost and level bonus', () => {
  const leader = unit({ slug: 'boss', level: 10, army: [
    { type: 'Leader', tier: 2 }, { type: 'Spell', tier: 3 }, { type: 'x', tier: 1 }, { type: 'Spell' },
    { type: 'Wildcard', tier: 1 }, { type: 'Tank', tier: 3 }, { type: 'Tank', tier: 3, boost: true },
  ] });
  const slots = armyOf(leader);
  assert.deepEqual(slots.map((s) => s.type), ['Leader', 'Melee', 'Ranged', 'Wildcard', '', 'Tank', '']);
  assert.equal(slots[1].tier, 3); // the tier is kept, the locked type wins
  assert.equal(slots[6].boost, true);
  assert.equal(totalLevel(leader), 12); // Leader slot at tier 2: +2
  assert.equal(totalLevel(unit({ level: 10 })), 10);
  const t = armyTotals([leader, unit()]);
  assert.deepEqual([t.leaders, t.slots, t.diamonds, t.goldReady], [1, 7, 3, 1]);
});
