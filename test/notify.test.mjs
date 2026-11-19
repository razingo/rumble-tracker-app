// Notifications and problem-report cleaning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueNotifications, defaultSettings, cleanSettings, inQuietHours } from '../server/notifications/notify.mjs';
import { clean, createErrorLog } from '../server/report.mjs';

const ctx = (extra = {}) => ({ now: Date.UTC(2026, 4, 6, 12), accounts: [], events: null, store: null, rules: null, plans: {}, settings: defaultSettings(), multi: false, ...extra });
const keys = (c) => dueNotifications(c).map((n) => n.key);

test('new tracker version: one notification per version', () => {
  assert.deepEqual(keys(ctx({ newVersion: '0.2.0' })), ['app-version-0.2.0']);
});

test('"update needed" replaces "version available"', () => {
  assert.deepEqual(keys(ctx({ newVersion: '0.2.0', appUpdateNeeded: true })), ['app-update-needed']);
});

test('no update notifications when the type or all notifications are off', () => {
  const s = defaultSettings();
  s.types.appUpdate.on = false;
  assert.deepEqual(keys(ctx({ newVersion: '0.2.0', settings: s })), []);
  const all = defaultSettings();
  all.enabled = false;
  assert.deepEqual(keys(ctx({ appUpdateNeeded: true, settings: all })), []);
});

test('settings: unknown types dropped, missing ones defaulted', () => {
  const s = cleanSettings({ types: { bogus: { on: true }, appUpdate: { on: false } } });
  assert.equal(s.types.bogus, undefined);
  assert.equal(s.types.appUpdate.on, false);
  assert.ok(s.types.freeGift);
});

test('quiet hours wrap past midnight', () => {
  const q = { on: true, from: '22:00', to: '07:00' };
  assert.ok(inQuietHours(q, new Date(2026, 0, 1, 23, 30)));
  assert.ok(inQuietHours(q, new Date(2026, 0, 1, 6, 59)));
  assert.ok(!inQuietHours(q, new Date(2026, 0, 1, 12, 0)));
  assert.ok(!inQuietHours({ ...q, on: false }, new Date(2026, 0, 1, 23, 30)));
});

test('reports: personal details removed', () => {
  const s = clean('mail me at someone@example.com, save 0123456789abcdef0123456789abcdef, token eyJhbGciOiJI.eyJzdWIiOiIx.sig');
  assert.ok(!s.includes('someone@example.com'));
  assert.ok(!s.includes('0123456789abcdef0123456789abcdef'));
  assert.ok(!s.includes('eyJhbGciOiJI'));
  assert.match(s, /<email>.*<id>.*<token>/);
});

test('error log: repeats counted, cleaned', () => {
  const log = createErrorLog();
  log.add('scan', 'failed for a@b.co');
  log.add('scan', 'failed for a@b.co');
  const [e] = log.list();
  assert.equal(e.count, 2);
  assert.equal(e.message, 'failed for <email>');
  log.clear();
  assert.equal(log.list().length, 0);
});

test('PvP: season ending soon (with ranks) and new modifiers', () => {
  const pvp = {
    seasons: [{ id: 's1', saveId: 'x', name: 'Season 1', start: '2026-04-01T00:00:00Z', end: '2026-05-07T12:00:00Z', rotation: { start: '2026-04-01T00:00:00Z', periodDays: 3, sets: [['m1'], ['m2']] } }],
    ranks: [{ id: 'r0', name: 'Bronze', from: 0 }, { id: 'r1', name: 'Silver', from: 1000 }],
    modifiers: { m1: { name: 'One' }, m2: { name: 'Two' } },
  };
  const accounts = [{ id: 'a', label: 'Main', pvp: { season: 'x', honor: 1200 } }];
  // 24 h before the end: within the default 48 h
  const end = dueNotifications(ctx({ pvp, accounts })).find((n) => n.type === 'pvpSeasonEnd');
  assert.equal(end.key, 'pvpEnd:s1');
  assert.match(end.title, /Season 1 ends in 24 h/);
  assert.match(end.body, /Silver/);
  // modifiers are off by default; on, announced in the first hours of a set
  const s = defaultSettings();
  s.types.pvpModifiers.on = true;
  const mods = dueNotifications(ctx({ pvp, accounts, settings: s, now: Date.UTC(2026, 3, 4, 1) })).find((n) => n.type === 'pvpModifiers');
  assert.match(mods.body, /^Two, until /);
  assert.equal(dueNotifications(ctx({ pvp, accounts, settings: s, now: Date.UTC(2026, 3, 5, 1) })).filter((n) => n.type === 'pvpModifiers').length, 0);
  assert.equal(dueNotifications(ctx({ pvp, accounts })).filter((n) => n.type === 'pvpModifiers').length, 0);
});
