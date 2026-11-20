import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowWatch } from '../server/window.mjs';
import { cleanAppSettings } from '../server/userdata.mjs';

const settle = () => new Promise((r) => setTimeout(r, 40));

/** A window watch with a quick wait, recording what it asks, saves and quits. */
function watch(closeWindow, answer = 'quit') {
  const log = { asked: 0, saved: 0, quit: [] };
  const ctx = {
    user: { appSettings: { closeWindow }, save: async () => { log.saved++; } },
    bump() {},
    errorLog: { add: (where, message) => { throw new Error(message); } },
  };
  const w = createWindowWatch(ctx, {
    ask: async () => {
      log.asked++;
      return answer;
    },
    quit: (reason) => log.quit.push(reason),
    wait: 10,
  });
  return { w, ctx, log };
}

test('asks once when the window closes, then keeps the answer', async () => {
  const { w, ctx, log } = watch('ask', 'quit');
  w.seen('a');
  w.closed('a');
  await settle();
  assert.deepEqual(log, { asked: 1, saved: 1, quit: ['Window closed'] });
  assert.equal(ctx.user.appSettings.closeWindow, 'quit');
});

test('a dismissed question is asked again next time', async () => {
  const { w, ctx, log } = watch('ask', null);
  w.closed('a');
  await settle();
  assert.deepEqual(log, { asked: 1, saved: 0, quit: [] });
  assert.equal(ctx.user.appSettings.closeWindow, 'ask');
});

test('a reload or another open window is not a closed window', async () => {
  const reload = watch('quit');
  reload.w.seen('a');
  reload.w.closed('a');
  reload.w.seen('b'); // the reloaded page
  await settle();
  assert.deepEqual(reload.log.quit, []);
  const two = watch('quit');
  two.w.seen('a');
  two.w.seen('b');
  two.w.closed('a');
  await settle();
  assert.deepEqual(two.log.quit, []);
});

test('the saved choice is used without asking', async () => {
  const tray = watch('tray');
  tray.w.closed('a');
  await settle();
  assert.deepEqual(tray.log, { asked: 0, saved: 0, quit: [] });
  const quit = watch('quit');
  quit.w.closed('a');
  await settle();
  assert.deepEqual(quit.log, { asked: 0, saved: 0, quit: ['Window closed'] });
});

test('unknown close choices fall back to asking', () => {
  assert.deepEqual(cleanAppSettings({ closeWindow: 'tray' }), { closeWindow: 'tray' });
  assert.deepEqual(cleanAppSettings({ closeWindow: 'later' }), { closeWindow: 'ask' });
  assert.deepEqual(cleanAppSettings(undefined), { closeWindow: 'ask' });
});

/** A watch whose question stays open until the test answers it. */
function openQuestion() {
  const log = { asked: 0, quit: [] };
  let answer;
  const ctx = { user: { appSettings: { closeWindow: 'ask' }, save: async () => {} }, bump() {}, errorLog: { add() {} } };
  const w = createWindowWatch(ctx, {
    ask: () => {
      log.asked++;
      return new Promise((r) => { answer = r; });
    },
    quit: (reason) => log.quit.push(reason),
    wait: 10,
  });
  return { w, ctx, log, answer: (choice) => answer(choice) };
}

test('a window reopened while the question is open keeps the tracker running; the answer is still kept', async () => {
  const q = openQuestion();
  q.w.closed('a');
  await settle();
  q.w.seen('b'); // opened again from the tray
  q.answer('quit');
  await settle();
  assert.equal(q.ctx.user.appSettings.closeWindow, 'quit');
  assert.deepEqual(q.log.quit, []);
});

test('only one question is open at a time', async () => {
  const q = openQuestion();
  q.w.closed('a');
  await settle();
  q.w.closed('b');
  await settle();
  assert.equal(q.log.asked, 1);
  q.answer('tray');
  await settle();
  assert.deepEqual(q.log.quit, []);
});
