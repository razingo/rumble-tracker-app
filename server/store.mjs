// JSON files on disk: writes are queued per file and go through a unique temporary file, so overlapping saves of the
// same file can't collide; a damaged file is moved aside instead of stopping the tracker.
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map(); // path -> promise of the last queued write
let tmpCounter = 0;

/**
 * Reads a JSON file. Missing: returns `fallback` (throws if none is given). Not valid JSON: with `onCorrupt`, the file
 * is renamed to <name>.corrupt-<time>, onCorrupt(file, movedTo) is called and `fallback` is returned; otherwise throws.
 */
export async function readJson(p, fallback, { onCorrupt } = {}) {
  let text;
  try {
    text = await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
  try {
    // strip a byte-order mark: JSON.parse rejects it
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    if (!onCorrupt || fallback === undefined) throw Object.assign(new Error(`${path.basename(p)} is not valid JSON: ${e.message}`), { code: 'BAD_JSON' });
    const moved = `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(p, moved);
    onCorrupt(p, moved);
    return fallback;
  }
}

/** Writes a JSON file atomically. Writes to the same file run one at a time, in call order. */
export function writeJson(p, value) {
  const body = JSON.stringify(value, null, 2) + '\n'; // the value as it is now, even if the write waits
  const run = async () => {
    const tmp = `${p}.${process.pid}-${++tmpCounter}.tmp`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  };
  const prev = queues.get(p) || Promise.resolve();
  const next = prev.then(run, run);
  queues.set(p, next);
  next.finally(() => { if (queues.get(p) === next) queues.delete(p); }).catch(() => {});
  return next;
}

/** Resolves once every queued write has finished (successfully or not). */
export async function flushWrites() {
  while (queues.size) await Promise.allSettled([...queues.values()]);
}
