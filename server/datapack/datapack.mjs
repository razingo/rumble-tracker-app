// Data packs: signed game-data updates installed into <data>/gamedata/, which takes precedence over gamedata/.
// A pack is manifest.json { format, gameBuild, dataVersion, files: { path: { sha256, size } } }, manifest.sig (Ed25519
// over manifest.json; accepted keys in pack_keys.mjs) and the listed files. Packs with an invalid signature or an
// older dataVersion are rejected.
import { mkdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { PACK_PUBLIC_KEYS } from './pack_keys.mjs';

const MAX_FILE = 8 * 1024 * 1024;   // per file
const MAX_TOTAL = 64 * 1024 * 1024; // per pack
const PARALLEL = 8; // concurrent downloads
const SAFE_PATH = /^[A-Za-z0-9_][\w./ '-]*\.(json|webp|png)$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Allowed pack addresses: https, or http on localhost. */
export function allowedUrl(base) {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}

async function fetchBuf(url, limit) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > limit) throw new Error(`too large: ${url}`);
  return buf;
}

/**
 * Installs the pack at `base` into `dir` if it is newer than `current`. Only changed files are downloaded, and every
 * file is verified before the switch. onProgress(done, total) is called after each file.
 * Returns { updated, manifest, downloaded, reason }.
 */
export async function updateDataPack({ base, current, dir, staticDir, publicKeys = PACK_PUBLIC_KEYS, onProgress }) {
  const keys = publicKeys.map((pem) => { try { return createPublicKey(pem); } catch { return null; } }).filter(Boolean);
  if (!base) return { updated: false, reason: 'no data pack address configured' };
  if (!allowedUrl(base)) return { updated: false, reason: 'data pack address must be https' };
  const root = base.endsWith('/') ? base : `${base}/`;
  if (!keys.length) return { updated: false, reason: 'this build has no data pack key, so packs are not accepted' };
  const body = await fetchBuf(new URL('manifest.json', root), 1024 * 1024);
  // verify the signature over the manifest's exact bytes before trusting its contents; its checksums cover the files
  const sig = Buffer.from((await fetchBuf(new URL('manifest.sig', root), 4096)).toString('utf8').trim(), 'base64');
  if (!keys.some((k) => { try { return verify(null, body, k, sig); } catch { return false; } })) {
    throw Object.assign(new Error('data pack signature is not valid: pack ignored'), { code: 'BAD_SIGNATURE' });
  }
  const remote = JSON.parse(body.toString('utf8'));
  if (remote.format !== 1 || !remote.files || !remote.dataVersion) throw new Error('not a data pack manifest');
  if (current?.dataVersion && remote.dataVersion <= current.dataVersion) return { updated: false, manifest: current, reason: 'up to date' };

  const entries = Object.entries(remote.files);
  let total = 0;
  for (const [rel, f] of entries) {
    if (!SAFE_PATH.test(rel) || rel.includes('..') || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw new Error(`bad entry in manifest: ${rel}`);
    total += f.size || 0;
  }
  if (total > MAX_TOTAL) throw new Error('data pack too large');

  const staging = `${dir}.new`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let downloaded = 0;
  let done = 0;
  let next = 0;
  let failed = null;
  const installOne = async ([rel, f]) => {
    const target = path.join(staging, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    // reuse an identical local file instead of downloading it
    let buf = null;
    for (const have of [path.join(dir, ...rel.split('/')), path.join(staticDir, ...rel.split('/'))]) {
      try { const b = await readFile(have); if (sha256(b) === f.sha256) { buf = b; break; } } catch { /* not there */ }
    }
    if (!buf) {
      buf = await fetchBuf(new URL(rel.split('/').map(encodeURIComponent).join('/'), root), MAX_FILE);
      if (sha256(buf) !== f.sha256) throw new Error(`checksum mismatch: ${rel}`);
      downloaded++;
    }
    await writeFile(target, buf);
    onProgress?.(++done, entries.length);
  };
  // PARALLEL workers take files in turn; the first error stops them all
  const worker = async () => {
    while (!failed && next < entries.length) {
      try { await installOne(entries[next++]); } catch (e) { failed ??= e; }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (failed) throw failed;
  await writeFile(path.join(staging, 'gamedata.json'), JSON.stringify(remote, null, 1));
  // swap directories; remove the old pack only once the new one is in place
  const old = `${dir}.old`;
  await rm(old, { recursive: true, force: true });
  try { await stat(dir); await rename(dir, old); } catch { /* no pack installed yet */ }
  await rename(staging, dir);
  await rm(old, { recursive: true, force: true });
  return { updated: true, manifest: remote, downloaded, reason: `installed data for game build ${remote.gameBuild}` };
}
