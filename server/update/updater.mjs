// "Download now" in the update pop-up (exe only): downloads and verifies the release named by the signed data pack
// (appupdate.mjs), then asks the launcher to swap the exe in (desktop/launcher.cjs, 'rumble:apply-update') and stops.
import { downloadUpdate } from './appupdate.mjs';

/** shutdown(reason): stops the tracker cleanly (main.mjs). Returns start() -> [status, body]. */
export function createUpdater(ctx, { shutdown, download = downloadUpdate, applyDelay = 1500 }) {
  const u = ctx.appUpdate;
  const fail = (message) => {
    console.log(`App update failed: ${message}`);
    ctx.errorLog.add('app update', message);
    Object.assign(u, { state: 'failed', error: message });
    ctx.bump();
  };

  return async function start() {
    const app = ctx.dataPack.latestApp;
    if (!app || app.version !== ctx.dataPack.newVersion) return [409, { error: 'No update to install.' }];
    if (u.state === 'downloading' || u.state === 'restarting') return [200, { ok: true }];
    Object.assign(u, { state: 'downloading', error: null, done: 0, total: 0 });
    ctx.bump();
    (async () => {
      try {
        console.log(`App update: downloading ${app.version}`);
        const exe = await download(app, ctx.paths.UPDATE, { onProgress: (done, total) => { u.done = done; u.total = total; } });
        u.state = 'restarting';
        ctx.bump();
        // a moment for the page to show it, then the launcher swaps the exe and this instance stops cleanly
        await new Promise((r) => setTimeout(r, applyDelay));
        if (!process.listenerCount('rumble:apply-update')) return fail('This copy of the tracker can\'t install updates by itself.');
        process.emit('rumble:apply-update', {
          exe, version: app.version,
          done: (err) => (err ? fail(err) : shutdown(`App update: restarting as ${app.version}`)),
        });
      } catch (e) {
        fail(e.message);
      }
    })();
    return [200, { ok: true }];
  };
}
