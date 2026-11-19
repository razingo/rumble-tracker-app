// The HTTP server on 127.0.0.1: the page (web/), game data (/static/) and the API. Only the tracker's own page may
// use it (guard.mjs).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGuard, requestPath } from '../guard.mjs';
import { buildBackup, replaceContents, listDailyBackups, readDailyBackup } from '../backup.mjs';
import { NOTIFY_TYPES, cleanSettings } from '../notifications/notify.mjs';
import { ISSUES_REPO, diagnostics } from '../report.mjs';
import { buildState, liveState, resolveAccount, dataStale } from '../state.mjs';
import { createHandlers } from './handlers.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// Content security policy: own scripts only (no inline script, handlers or eval), connections and images only to
// this server, fonts bundled. Inline style attributes are allowed; the page sets colours through them.
export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

// outside links the exe's window may open in the default browser
const EXTERNAL_LINKS = [`https://github.com/${ISSUES_REPO}`, 'https://buymeacoffee.com/razingo'];

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function serveFile(res, base, rel) {
  const file = path.resolve(base, `.${rel}`);
  if (!file.startsWith(base + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('request body is not valid JSON'), { status: 400 }); }
}

// page error reports: at most 20 per minute
const rateLimit = (n, ms) => ({ n: 0, since: Date.now(), allow() { if (Date.now() - this.since > ms) { this.n = 0; this.since = Date.now(); } return ++this.n <= n; } });

/**
 * deps: { scan, shutdown(reason), startUpdate(), notifier: { save, test }, gameRunning(), autostart: { get(), set(on) } | null }.
 * Returns the http.Server (not listening yet).
 */
export function createHttpServer(ctx, deps) {
  const refusal = createGuard(ctx.port);
  const h = createHandlers(ctx);
  const clientErrors = rateLimit(20, 60000);
  const { PUBLIC, STATIC, GAMEDATA } = ctx.paths;
  const json = (handler, limit) => async (req) => handler(await readBody(req, limit));

  // [method, path, handler(req, url) -> [status, body] | undefined (the handler answered itself)]
  const routes = new Map(Object.entries({
    'POST /api/name': json(h.name),
    'POST /api/talents': json(h.talents),
    'POST /api/army': json(h.army),
    'POST /api/plans': json(h.plan),
    'POST /api/draft': json(h.draft),
    'POST /api/armies': json(h.armies),
    'POST /api/pvp/result': json(h.pvpResult),
    'POST /api/restore': json(h.restore, 20 * 1024 * 1024),
    // automatic backups (backup.mjs): the list, and restoring one of them
    'GET /api/backups': async () => [200, { backups: await listDailyBackups(ctx.paths.BACKUPS) }],
    'POST /api/backups/restore': async (req) => {
      const backup = await readDailyBackup(ctx.paths.BACKUPS, (await readBody(req)).day);
      if (!backup) return [404, { error: 'That backup is not there any more.' }];
      return h.restore({ backup });
    },
    'POST /api/scan': async () => { await deps.scan(); return [200, { ok: true }]; },
    'GET /api/notifications': async () => {
      const { notifySettings, sentLog } = ctx.user;
      return [200, { settings: notifySettings, types: NOTIFY_TYPES, log: sentLog.log.slice(-20).reverse(), pending: sentLog.pending.length, playing: await deps.gameRunning() }];
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
    // general settings: Start with Windows (exe only; null when not available)
    'GET /api/settings': async () => [200, { startWithWindows: deps.autostart ? await deps.autostart.get() : null }],
    'POST /api/settings': async (req) => {
      const b = await readBody(req);
      if (typeof b.startWithWindows === 'boolean') {
        if (!deps.autostart) return [400, { error: 'Only the RumbleTracker.exe version can start with Windows.' }];
        if (!(await deps.autostart.set(b.startWithWindows))) return [500, { error: 'Windows did not accept the change.' }];
      }
      return [200, { ok: true, startWithWindows: deps.autostart ? await deps.autostart.get() : null }];
    },
    // script errors reported by the page, for "Report a problem"
    'POST /api/client-error': async (req) => {
      const b = await readBody(req, 8 * 1024);
      if (clientErrors.allow()) ctx.errorLog.add(`page${b.where ? ` ${String(b.where).slice(0, 20)}` : ''}`, `${b.message || ''}${b.stack ? `\n${b.stack}` : ''}`);
      return [200, { ok: true }];
    },
    // diagnostics shown before opening an issue (already cleaned)
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
    'POST /api/report/clear': async () => { ctx.errorLog.clear(); ctx.bump(); return [200, { ok: true }]; },
    // "Later" in the update pop-up: hidden until the tracker restarts
    'POST /api/update/later': async () => { ctx.appUpdate.later = ctx.dataPack.newVersion; ctx.bump(); return [200, { ok: true }]; },
  }));
  if (ctx.standalone) {
    // the app window has its own browser profile, so allowed outside links open in the default browser
    routes.set('POST /api/open-external', async (req) => {
      const target = String((await readBody(req, 16 * 1024)).url || '');
      if (!/^[^\s"<>^`|]+$/.test(target) || !EXTERNAL_LINKS.some((ok) => target === ok || target.startsWith(`${ok}/`))) return [400, { error: 'not an allowed link' }];
      process.emit('rumble:open-external', target);
      return [200, { ok: true }];
    });
    // "Take a screenshot" in Report a problem: Windows' snipping overlay (the capture goes to the clipboard)
    routes.set('POST /api/screenshot', async () => { process.emit('rumble:screenshot'); return [200, { ok: true }]; });
    routes.set('POST /api/quit', async () => { setTimeout(() => deps.shutdown('Quit from the page'), 200); return [200, { ok: true }]; });
    routes.set('POST /api/update', async () => deps.startUpdate());
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = requestPath(req.url);
      if (p === null) return send(res, 400, { error: 'bad address' }); // a malformed % escape: not a server error
      const refused = refusal(req, p);
      if (refused) return send(res, 403, { error: refused });
      if (req.method === 'GET' && p === '/api/state') {
        // the page sends the revision it has: an unchanged state is answered with the values that change on their own
        const account = resolveAccount(ctx, url.searchParams.get('account'));
        if (url.searchParams.get('rev') === String(ctx.rev) && url.searchParams.get('for') === String(account)) {
          return send(res, 200, { unchanged: true, rev: ctx.rev, ...liveState(ctx) });
        }
        return send(res, 200, buildState(ctx, account));
      }
      if (req.method === 'GET' && p === '/api/backup') {
        const day = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="rumble-tracker-backup-${day}.json"`,
        });
        return res.end(JSON.stringify(buildBackup(ctx.user.backupFiles()), null, 2));
      }
      const route = routes.get(`${req.method} ${p}`);
      if (route) return send(res, ...(await route(req, url)));
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      if (p.startsWith('/static/')) {
        // an installed data pack takes precedence
        const rel = p.slice('/static'.length);
        const inPack = path.resolve(GAMEDATA, `.${rel}`);
        if (inPack.startsWith(GAMEDATA + path.sep)) { try { await stat(inPack); return serveFile(res, GAMEDATA, rel); } catch { /* not in the pack */ } }
        return serveFile(res, STATIC, rel);
      }
      return serveFile(res, PUBLIC, p === '/' ? '/index.html' : p);
    } catch (e) {
      if (!e.status || e.status >= 500) ctx.errorLog.add('server', `${req.method} ${req.url?.split('?')[0]}: ${e.message}`);
      send(res, e.status || 500, { error: e.message });
    }
  });
}
