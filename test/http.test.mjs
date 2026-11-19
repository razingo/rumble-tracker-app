// The HTTP server and API handlers, through real requests to a server on a free port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHttpServer } from '../server/http/server.mjs';
import { cleanArmy, cleanTags } from '../server/http/handlers.mjs';
import { flushWrites } from '../server/store.mjs';
import { testContext, hexId } from './helpers.mjs';

const ACC = hexId(1, 1), UNIT = hexId(0xa, 0xb), OTHER = hexId(0xc, 0xd);
let ctx, cleanup, server, base;
const calls = { scan: 0, quit: [], update: 0, autostart: false };

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const api = async (method, p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  ({ ctx, cleanup } = await testContext({ standalone: true }));
  ctx.port = await freePort();
  ctx.accounts.set(ACC, { snapshot: { units: [{ id: UNIT, level: 1 }], currencies: [] }, events: [] });
  ctx.user.pvpHistory[ACC] = [{ t: 'T1', season: 's', honor: 5, vp: 50, dh: 5, dv: 50, unexplained: true }];
  server = createHttpServer(ctx, {
    scan: async () => { calls.scan++; },
    shutdown: (reason) => calls.quit.push(reason),
    startUpdate: async () => { calls.update++; return [200, { ok: true }]; },
    notifier: { test: async () => true },
    gameRunning: async () => false,
    autostart: { get: async () => calls.autostart, set: async (on) => { calls.autostart = on; return true; } },
  });
  await new Promise((r) => server.listen(ctx.port, '127.0.0.1', r));
  base = `http://localhost:${ctx.port}`;
});
after(async () => { server.close(); await flushWrites(); await cleanup(); });

test('state, and "unchanged" for a revision the page already has', async () => {
  const s = (await api('GET', '/api/state')).body;
  assert.equal(s.account, ACC);
  assert.equal(s.units[0].slug, 'kobold-miner');
  assert.equal(s.pvpLog.length, 0); // no PvP reading in the snapshot yet
  const u = (await api('GET', `/api/state?rev=${s.rev}&for=${ACC}`)).body;
  assert.equal(u.unchanged, true);
  assert.deepEqual(Object.keys(u).sort(), ['gameRunning', 'lastError', 'lastScan', 'problems', 'rev', 'unchanged', 'update']);
  // another account, or an old revision: the full state
  assert.equal((await api('GET', `/api/state?rev=${s.rev - 1}&for=${ACC}`)).body.unchanged, undefined);
});

test('the page, game data and refused requests', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/static/rules.json`)).status, 200);
  assert.equal((await fetch(`${base}/static/../../data/names.json`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await api('POST', '/api/name', { kind: 'account', id: ACC, value: 'x' }, { origin: 'https://evil.example' })).status, 403);
  const form = await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403);
  assert.equal(ctx.errorLog.list().length, 0); // none of these is a server error
});

test('names: accounts and unit assignments', async () => {
  const rev = ctx.rev;
  assert.equal((await api('POST', '/api/name', { kind: 'account', id: ACC, value: ' Main ' })).status, 200);
  assert.equal(ctx.user.names.accounts[ACC], 'Main');
  assert.ok(ctx.rev > rev);
  assert.equal((await api('POST', '/api/name', { kind: 'unit', id: OTHER, value: 'kobold-miner' })).status, 409); // taken by UNIT
  assert.equal((await api('POST', '/api/name', { kind: 'unit', id: OTHER, value: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/name', { kind: 'unit', id: OTHER, value: 'footmen' })).status, 200);
  assert.equal((await api('POST', '/api/name', { kind: 'x', id: ACC, value: 'a' })).status, 400);
  await flushWrites();
  assert.equal(JSON.parse(await readFile(path.join(ctx.paths.DATA, 'names.json'), 'utf8')).units[OTHER], 'footmen');
});

test('talents, army slots, plans, drafts and saved armies are cleaned', async () => {
  assert.deepEqual((await api('POST', '/api/talents', { account: ACC, unitId: UNIT, picks: [2, 2, 7, 0] })).body.picks, [0, 2]);
  const slots = (await api('POST', '/api/army', { account: ACC, unitId: UNIT, slots: Array.from({ length: 7 }, (_, i) => ({ type: 'Melee', tier: 9, boost: true })) })).body.slots;
  assert.equal(slots[0].type, 'Leader');
  assert.equal(slots[1].tier, 2);
  assert.deepEqual(slots.map((s) => !!s.boost), [false, false, false, false, false, false, true]);
  assert.equal((await api('POST', '/api/army', { account: ACC, unitId: UNIT, slots: [] })).status, 400);
  assert.equal((await api('POST', '/api/plans', { account: ACC, eventId: 'ev', plan: { cost: 50, label: 'x' } })).status, 200);
  assert.equal(ctx.user.plans[ACC].ev.cost, 50);
  await api('POST', '/api/plans', { account: ACC, eventId: 'ev', plan: null });
  assert.equal(ctx.user.plans[ACC].ev, undefined);
  const rev = ctx.rev;
  assert.equal((await api('POST', '/api/draft', { account: ACC, draft: { name: 'D', leader: 'kobold-miner', minis: ['footmen', 'bogus'] } })).status, 200);
  assert.equal(ctx.rev, rev); // drafts don't bump the revision
  assert.deepEqual(ctx.user.drafts[ACC].minis.slice(0, 2), ['footmen', null]);
  const armies = (await api('POST', '/api/armies', { account: ACC, armies: [{ name: '', tags: ['a', 'A', ' b '] }] })).body.armies;
  assert.deepEqual([armies[0].name, armies[0].tags], ['Army', ['a', 'b']]);
  assert.equal((await api('POST', '/api/armies', { account: ACC, armies: Array(51).fill({}) })).status, 400);
});

test('PvP: marking an unexplained change', async () => {
  assert.equal((await api('POST', '/api/pvp/result', { account: ACC, t: 'T1', result: 'win' })).status, 200);
  assert.equal(ctx.user.pvpHistory[ACC][0].wins, 1);
  assert.equal((await api('POST', '/api/pvp/result', { account: ACC, t: 'nope', result: 'win' })).status, 400);
  assert.equal((await api('POST', '/api/pvp/result', { account: ACC, t: 'T1', result: null })).status, 200);
  assert.equal(ctx.user.pvpHistory[ACC][0].wins, undefined);
});

test('backup and restore', async () => {
  const r = await fetch(`${base}/api/backup`);
  assert.match(r.headers.get('content-disposition'), /rumble-tracker-backup-\d{4}-\d{2}-\d{2}\.json/);
  const backup = await r.json();
  assert.ok(backup.data.pvp_history[ACC]);
  ctx.user.names.accounts[ACC] = 'Changed';
  const res = await api('POST', '/api/restore', { backup });
  assert.equal(res.status, 200);
  assert.ok(res.body.restored.includes('pvp_history'));
  assert.equal(ctx.user.names.accounts[ACC], 'Main');
  assert.equal((await api('POST', '/api/restore', { backup: { format: 'x' } })).status, 400);
});

test('settings: Start with Windows', async () => {
  assert.equal((await api('GET', '/api/settings')).body.startWithWindows, false);
  assert.equal((await api('POST', '/api/settings', { startWithWindows: true })).body.startWithWindows, true);
  assert.equal(calls.autostart, true);
});

test('exe-only actions: quit, update, Later', async () => {
  await api('POST', '/api/update', {});
  assert.equal(calls.update, 1);
  ctx.dataPack.newVersion = '9.9.9';
  await api('POST', '/api/update/later', {});
  assert.equal((await api('GET', '/api/state')).body.update.later, true);
  ctx.dataPack.newVersion = null;
  assert.equal((await api('POST', '/api/quit', {})).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(calls.quit, ['Quit from the page']);
});

test('army and tag cleaning', () => {
  const slugs = new Set(['a']);
  assert.deepEqual(cleanArmy({ id: '', leader: 'x', minis: ['a'], talents: { a: 1, b: 2, c: 9 } }, slugs, { keepEmptyId: true }),
    { id: null, name: 'Army', leader: null, minis: ['a', null, null, null, null, null], talents: { a: 1 }, description: '', tags: [] });
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
  assert.equal(cleanTags(['x'.repeat(50)])[0].length, 30);
});
