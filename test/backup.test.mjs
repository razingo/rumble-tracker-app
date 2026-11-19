// Backups: what is saved and how a restore replaces the data in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, restoreBackup, BACKUP_FORMAT } from '../server/backup.mjs';

test('backup round trip replaces contents in place and skips missing or bad keys', () => {
  const names = { accounts: { a: 'Main' }, units: {} };
  const pvp = { a: [{ t: '1', wins: 1 }] };
  const plans = { keep: true };
  const files = { names, pvp_history: pvp, plans };
  const b = JSON.parse(JSON.stringify(buildBackup(files, new Date('2026-11-19T00:00:00Z'))));
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.created, '2026-11-19T00:00:00.000Z');
  names.accounts.a = 'Changed';
  pvp.b = [];
  delete b.data.plans;          // older backup without this key
  b.data.extra = { x: 1 };     // unknown keys are ignored
  const restored = restoreBackup(files, b);
  assert.deepEqual(restored.sort(), ['names', 'pvp_history']);
  assert.equal(files.names, names); // same objects: other code holds references
  assert.equal(names.accounts.a, 'Main');
  assert.deepEqual(Object.keys(pvp), ['a']);
  assert.deepEqual(plans, { keep: true });
  assert.equal(files.extra, undefined);
});

test('not a backup', () => {
  assert.equal(restoreBackup({}, null), null);
  assert.equal(restoreBackup({}, { format: 'other', data: {} }), null);
  assert.equal(restoreBackup({}, { format: BACKUP_FORMAT }), null);
  // arrays and non-objects are never restored over an object
  const files = { names: { accounts: {} } };
  assert.deepEqual(restoreBackup(files, { format: BACKUP_FORMAT, data: { names: [1, 2] } }), []);
  assert.deepEqual(files.names, { accounts: {} });
});

test('daily backups: one per day, none older than 7 days', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdtemp, readdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { writeDailyBackup } = await import('../server/backup.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-daily-'));
  await writeFile(path.join(dir, 'keep-me.txt'), 'other files are left alone');
  const files = { names: { accounts: { a: 'Main' } } };
  for (let d = 1; d <= 9; d++) await writeDailyBackup(dir, files, { now: new Date(2026, 0, d, 12) });
  // the same day again: replaced, not added
  files.names.accounts.a = 'Renamed';
  const last = await writeDailyBackup(dir, files, { now: new Date(2026, 0, 9, 18) });
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ['keep-me.txt', ...[3, 4, 5, 6, 7, 8, 9].map((d) => `rumble-tracker-backup-2026-01-0${d}.json`)]);
  const b = JSON.parse(await readFile(last, 'utf8'));
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.data.names.accounts.a, 'Renamed');
  await rm(dir, { recursive: true });
});
