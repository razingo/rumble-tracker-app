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
