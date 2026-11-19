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
