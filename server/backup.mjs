import { mkdir, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Backups: all user-entered data, and history that can't be rebuilt from the save, in one JSON file.
export const BACKUP_FORMAT = 'rumble-tracker-backup';

/** files: { key: object } (each saved as <key>.json). */
export function buildBackup(files, now = new Date()) {
  return { format: BACKUP_FORMAT, version: 1, created: now.toISOString(), data: files };
}

/** Replaces an object's contents in place (other code holds references to it). */
export function replaceContents(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

/**
 * Restores a backup into `files` in place. Keys missing from the backup (older or partial backups) are left as they
 * are. Returns the restored keys, or null if this isn't a backup.
 */
export function restoreBackup(files, backup) {
  if (!backup || backup.format !== BACKUP_FORMAT || !backup.data || typeof backup.data !== 'object') return null;
  const restored = [];
  for (const [key, obj] of Object.entries(files)) {
    const incoming = backup.data[key];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    replaceContents(obj, incoming);
    restored.push(key);
  }
  return restored;
}

// ---- daily backups: written when the tracker stops (Quit, the tray, an update, Windows shutting down) -------------
const DAILY = /^rumble-tracker-backup-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Writes today's backup into `dir` (one file per local day, replaced if it exists) and keeps the newest `keep`.
 * Returns the file's path.
 */
export async function writeDailyBackup(dir, files, { now = new Date(), keep = 7 } = {}) {
  await mkdir(dir, { recursive: true });
  const day = now.toLocaleDateString('sv-SE'); // local YYYY-MM-DD
  const file = path.join(dir, `rumble-tracker-backup-${day}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(buildBackup(files, now)));
  await rename(tmp, file);
  const old = (await readdir(dir)).filter((n) => DAILY.test(n)).sort().reverse().slice(keep);
  for (const n of old) await rm(path.join(dir, n), { force: true });
  return file;
}
