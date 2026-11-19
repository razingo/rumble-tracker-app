// Requests are accepted only from the tracker's own page. Other sites in the same browser can reach localhost, so
// (using headers the browser sets and pages cannot forge):
//  - Host must be this server's address (blocks DNS rebinding);
//  - Origin, when present, must be ours; Sec-Fetch-Site on API calls must be same-origin or none;
//  - API writes must be JSON, which a cross-site form cannot send.

/** Returns refusal(req, pathname): the reason a request is refused, or null if it is allowed. */
export function createGuard(port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return function refusal(req, p) {
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return 'unknown host';
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return 'cross-site request';
    if (p.startsWith('/api/')) {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
      if (req.method !== 'GET' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return 'JSON requests only';
    }
    return null;
  };
}

/** The decoded path of a request URL, or null if it is malformed (a bad % escape). */
export function requestPath(rawUrl) {
  try { return decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname); } catch { return null; }
}
