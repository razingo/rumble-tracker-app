// App updates: the signed data-pack manifest names the latest release and the SHA-256 of its zip and exe
// (latestApp). The zip is downloaded from the release on GitHub, both checksums are verified, and the exe is written to
// <data>/update/; the launcher then swaps it in and restarts.
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const RELEASE_REPO = 'razingo/rumble-tracker-app';
export const EXE = 'RumbleTracker.exe';
const MAX_ZIP = 300 * 1024 * 1024;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The latestApp entry of a manifest if it is well-formed: { version, zip, zipSha256, exeSha256 }, else null. */
export function latestAppOf(manifest) {
  const a = manifest?.latestApp;
  if (!a || !/^\d+\.\d+\.\d+$/.test(a.version || '')) return null;
  if (a.zip !== `RumbleTracker-${a.version}-win-x64.zip`) return null;
  if (!/^[0-9a-f]{64}$/.test(a.zipSha256 || '') || !/^[0-9a-f]{64}$/.test(a.exeSha256 || '')) return null;
  return { version: a.version, zip: a.zip, zipSha256: a.zipSha256, exeSha256: a.exeSha256 };
}

export const zipUrl = (app) => `https://github.com/${RELEASE_REPO}/releases/download/v${app.version}/${app.zip}`;

/** Returns the bytes of the zip entry whose name ends with `/${name}` (or equals it). Deflate and stored only. */
export function zipEntry(zip, name) {
  // end of central directory: the last 22+ bytes
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let k = 0; k < count; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (entry !== name && !entry.endsWith(`/${name}`)) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`unsupported zip compression (${method})`);
  }
  throw new Error(`${name} is not in the zip`);
}

/**
 * Downloads and verifies the release named by `app` (from latestAppOf); writes the exe into `dir`. Earlier downloads
 * there are removed. Returns the exe's path. `fetchImpl` and `url` are for tests.
 */
export async function downloadUpdate(app, dir, { fetchImpl = fetch, url = zipUrl(app) } = {}) {
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const zip = Buffer.from(await r.arrayBuffer());
  if (zip.length > MAX_ZIP) throw new Error('download too large');
  if (sha256(zip) !== app.zipSha256) throw new Error('the downloaded file does not match its checksum');
  const exe = zipEntry(zip, EXE);
  if (sha256(exe) !== app.exeSha256) throw new Error('the program in the download does not match its checksum');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `RumbleTracker-${app.version}.exe`);
  await writeFile(file, exe);
  return file;
}

/** Removes downloaded updates (after they were applied). */
export async function cleanUpdates(dir) {
  try { if ((await readdir(dir)).length) await rm(dir, { recursive: true, force: true }); } catch { /* none */ }
}
