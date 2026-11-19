// First start of the exe: game data isn't bundled, so the signed data pack is installed before the tracker starts,
// with a self-refreshing progress page on the tracker's port meanwhile (retries every 30 s).
import http from 'node:http';
import { updateDataPack } from './datapack.mjs';
import { ISSUES_REPO } from '../report.mjs';

export async function firstRunDownload(ctx) {
  const { port, paths, dataPack, errorLog } = ctx;
  const status = { done: 0, total: 0, error: null };
  const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Rumble Collection Tracker</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#14162a;color:#f3e3c4;font:16px/1.5 system-ui,'Segoe UI',sans-serif">
<main style="max-width:560px;padding:24px;text-align:center"><h1 style="color:#ffd166;font-size:24px">Rumble Collection Tracker</h1>
<p>${status.error ? html(status.error)
    : `Downloading the game data (first start only)… ${status.total ? `${status.done} of ${status.total} files` : 'connecting'}`}</p></main></body></html>`;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const boot = http.createServer((req, res) => {
    if (!hosts.has(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/api/report') { // answers the launcher's "is it running" check
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ repo: ISSUES_REPO, starting: true }));
      return;
    }
    res.writeHead(p === '/' ? 200 : 503, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(page());
  });
  await new Promise((resolve, reject) => { boot.once('error', reject); boot.listen(port, '127.0.0.1', resolve); });
  console.log(`First start: downloading game data from ${dataPack.url}`);
  for (;;) {
    try {
      const r = await updateDataPack({ base: dataPack.url, current: null, dir: paths.GAMEDATA, staticDir: paths.STATIC,
        onProgress: (done, total) => { status.done = done; status.total = total; } });
      if (!r.updated) throw new Error(r.reason);
      console.log(`Game data installed: ${r.reason} (${r.downloaded} files downloaded)`);
      break;
    } catch (e) {
      console.log(`Game data download failed: ${e.message}`);
      errorLog.add('data pack', e.message);
      status.error = e.code === 'BAD_SIGNATURE'
        ? 'This version of the tracker cannot verify the current game data. Download the latest version from https://github.com/razingo/rumble-tracker-app/releases/latest'
        : `Could not download the game data (${e.message}). Check your internet connection; retrying in 30 seconds.`;
      await new Promise((r) => setTimeout(r, 30000));
      Object.assign(status, { done: 0, total: 0, error: null });
    }
  }
  await new Promise((resolve) => { boot.close(resolve); boot.closeAllConnections(); });
}
