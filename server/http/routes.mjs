// The API: one handler per "METHOD /path", each returning [status, body] and optionally extra headers. The routes
// that act on the exe (quitting, updates, links, screenshots) exist only when the server runs inside it.
import { buildBackup, replaceContents, listDailyBackups, readDailyBackup, backupFileName } from '../backup.mjs';
import { NOTIFY_TYPES, cleanSettings } from '../notifications/notify.mjs';
import { ISSUES_REPO, diagnostics } from '../report.mjs';
import { buildState, liveState, resolveAccount, dataStale } from '../state.mjs';
import { createHandlers } from './handlers.mjs';
import { host } from '../host.mjs';
import { MINUTE, MB, CLOSE_CHOICES } from '../../web/scripts/lib/constants.js';
import { localDay } from '../../web/scripts/lib/format.js';

// Links the exe's window may open in the default browser.
const EXTERNAL_LINKS = [`https://github.com/${ISSUES_REPO}`, 'https://buymeacoffee.com/razingo'];

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('The request is too large for the tracker to accept.'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('The request is not valid JSON.'), { status: 400 });
  }
}

/** The page ID a request names (window.mjs). */
const pageOf = async (req) => String((await readBody(req)).page || '');

/** Allows `n` calls per `ms` milliseconds; allow() is false for the rest of that time. */
const rateLimit = (n, ms) => ({
  n: 0,
  since: Date.now(),
  allow() {
    if (Date.now() - this.since > ms) {
      this.n = 0;
      this.since = Date.now();
    }
    return ++this.n <= n;
  },
});

/**
 * deps: { shutdown(reason), startUpdate(), notifier: { save, test }, gameRunning(),
 *   autostart: { get(), set(on) } | null, window: { seen(page), closed(page) } | null }.
 * Returns a Map of "METHOD /path" to handler(req, url).
 */
export function createRoutes(ctx, deps) {
  const h = createHandlers(ctx);
  // at most 20 page error reports a minute
  const clientErrors = rateLimit(20, MINUTE);
  const json = (handler, limit) => async (req) => handler(await readBody(req, limit));
  // Start with Windows and what closing the window does; null where they don't apply (running from source)
  const settings = async () => ({
    startWithWindows: deps.autostart ? await deps.autostart.get() : null,
    closeWindow: ctx.standalone ? ctx.user.appSettings.closeWindow : null,
  });

  // "METHOD /path" to a handler(req, url) that returns [status, body]
  const routes = new Map(Object.entries({
    // The page sends the revision it has. If nothing changed, only the values that change on their own are sent.
    'GET /api/state': async (req, url) => {
      deps.window?.seen(url.searchParams.get('page'));
      const account = resolveAccount(ctx, url.searchParams.get('account'));
      if (url.searchParams.get('rev') === String(ctx.rev) && url.searchParams.get('for') === String(account)) {
        return [200, { unchanged: true, rev: ctx.rev, ...liveState(ctx) }];
      }
      return [200, buildState(ctx, account)];
    },
    'GET /api/backup': async () => [200, JSON.stringify(buildBackup(ctx.user.backupFiles()), null, 2),
      { 'content-disposition': `attachment; filename="${backupFileName(localDay())}"` }],
    'POST /api/name': json(h.name),
    'POST /api/talents': json(h.talents),
    'POST /api/army': json(h.army),
    'POST /api/plans': json(h.plan),
    'POST /api/draft': json(h.draft),
    'POST /api/armies': json(h.armies),
    'POST /api/pvp/result': json(h.pvpResult),
    'POST /api/restore': json(h.restore, 20 * MB),
    // A page reports itself as soon as it opens, so a reload isn't taken for a closed window (window.mjs).
    'POST /api/page-opened': async (req) => {
      deps.window?.seen(await pageOf(req));
      return [200, { ok: true }];
    },
    // The automatic backups, and restoring one of them.
    'GET /api/backups': async () => [200, { backups: await listDailyBackups(ctx.paths.BACKUPS) }],
    'POST /api/backups/restore': async (req) => {
      const backup = await readDailyBackup(ctx.paths.BACKUPS, (await readBody(req)).day);
      if (!backup) return [404, { error: 'That backup is not there any more.' }];
      return h.restore({ backup });
    },
    'GET /api/notifications': async () => {
      const { notifySettings, sentLog } = ctx.user;
      return [200, { settings: notifySettings, types: NOTIFY_TYPES, log: sentLog.log.slice(-20).reverse(),
        pending: sentLog.pending.length, playing: await deps.gameRunning() }];
    },
    'POST /api/notifications': async (req) => {
      replaceContents(ctx.user.notifySettings, cleanSettings((await readBody(req)).settings));
      await ctx.user.save('notifySettings');
      return [200, { ok: true, settings: ctx.user.notifySettings }];
    },
    'POST /api/notifications/test': async () => {
      const ok = await deps.notifier.test();
      return ok ? [200, { ok: true }] : [500, { error: 'Windows did not accept the notification.' }];
    },
    // Start with Windows, null where it isn't available.
    'GET /api/settings': async () => [200, await settings()],
    'POST /api/settings': async (req) => {
      const b = await readBody(req);
      if (typeof b.startWithWindows === 'boolean') {
        if (!deps.autostart) return [400, { error: 'Only the RumbleTracker.exe version can start with Windows.' }];
        if (!(await deps.autostart.set(b.startWithWindows))) return [500, { error: 'Windows did not accept the change.' }];
      }
      if (b.closeWindow !== undefined) {
        if (!ctx.standalone) return [400, { error: 'Closing the window only matters in the RumbleTracker.exe version.' }];
        if (!Object.hasOwn(CLOSE_CHOICES, b.closeWindow)) return [400, { error: 'That is not a choice for closing the window.' }];
        ctx.user.appSettings.closeWindow = b.closeWindow;
        await ctx.user.save('appSettings');
      }
      return [200, { ok: true, ...(await settings()) }];
    },
    // Script errors reported by the page, for "Report a problem".
    'POST /api/client-error': async (req) => {
      const b = await readBody(req, 8 * 1024);
      if (clientErrors.allow()) ctx.errorLog.add(`page${b.where ? ` ${String(b.where).slice(0, 20)}` : ''}`,
        `${b.message || ''}${b.stack ? `\n${b.stack}` : ''}`);
      return [200, { ok: true }];
    },
    // Diagnostics shown before opening an issue (already cleaned).
    'GET /api/report': async (req, url) => {
      const t = ctx.tables, dp = ctx.dataPack;
      const text = diagnostics({
        appVersion: ctx.appVersion, gameBuild: ctx.scan.gameBuild, accounts: ctx.accounts.size, errors: ctx.errorLog.list(),
        data: {
          dataBuild: t.gameData?.gameBuild, dataVersion: t.gameData?.dataVersion, pack: await t.fromPack(), stale: dataStale(ctx),
          packResult: dp.url ? dp.result : null, packError: dp.url ? dp.error : null,
        },
        page: url.searchParams.get('page'),
      });
      return [200, { repo: ISSUES_REPO, appVersion: ctx.appVersion, diagnostics: text, errors: ctx.errorLog.list().length }];
    },
    'POST /api/report/clear': async () => {
      ctx.errorLog.clear();
      ctx.bump();
      return [200, { ok: true }];
    },
    // Later in the update pop-up hides it until the tracker restarts.
    'POST /api/update/later': async () => {
      ctx.appUpdate.later = ctx.dataPack.newVersion;
      ctx.bump();
      return [200, { ok: true }];
    },
  }));
  if (ctx.standalone) {
    // The app window has its own browser profile, so allowed outside links open in the default browser.
    routes.set('POST /api/open-external', async (req) => {
      const target = String((await readBody(req, 16 * 1024)).url || '');
      if (!/^[^\s"<>^`|]+$/.test(target) || !EXTERNAL_LINKS.some((ok) => target === ok
        || target.startsWith(`${ok}/`))) return [400, { error: 'The tracker only opens its own GitHub and support pages.' }];
      host.openLink(target);
      return [200, { ok: true }];
    });
    // Take a screenshot in Report a problem opens Windows' snipping overlay, which copies the capture.
    routes.set('POST /api/screenshot', async () => {
      host.takeScreenshot();
      return [200, { ok: true }];
    });
    routes.set('POST /api/quit', async () => {
      setTimeout(() => deps.shutdown('Quit from the page'), 200);
      return [200, { ok: true }];
    });
    routes.set('POST /api/update', async () => deps.startUpdate());
    // the page's window is closing (or reloading); window.mjs works out which
    routes.set('POST /api/window-closed', async (req) => {
      deps.window?.closed(await pageOf(req));
      return [200, { ok: true }];
    });
  }
  return routes;
}
