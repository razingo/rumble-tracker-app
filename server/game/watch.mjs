// Whether Warcraft Rumble is running, without starting a process per check: one PowerShell process looks every
// 2 seconds and writes "1" or "0" when it changes. It exits with the tracker.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
export const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');
const GAME = 'WarcraftRumble';

const SCRIPT = `
$parent = [int]$env:RT_PARENT
$last = $null
while ($true) {
  try { [void][System.Diagnostics.Process]::GetProcessById($parent) } catch { exit 0 }
  $now = if ([System.Diagnostics.Process]::GetProcessesByName($env:RT_GAME).Length) { '1' } else { '0' }
  if ($now -ne $last) { [Console]::Out.WriteLine($now); [Console]::Out.Flush(); $last = $now }
  Start-Sleep -Seconds 2
}
`;

/** One check with tasklist (used before the watcher has reported, and if it can't run). */
export function gameRunningOnce() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(TASKLIST, ['/FI', `IMAGENAME eq ${GAME}.exe`, '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      resolve(!err && new RegExp(`${GAME}\\.exe`, 'i').test(out || ''));
    });
  });
}

/**
 * Starts watching. onChange(running) is called on the first report and on every change. Returns { running() }:
 * the last known state (null before the first report, or when the watcher failed and checks fall back to tasklist).
 * The watcher is restarted if it stops; after 3 failures in a row it gives up (onFail(message)).
 */
export function watchGame(onChange, onFail = () => {}) {
  let state = null;
  let failures = 0;
  const start = () => {
    if (process.platform !== 'win32') return;
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, RT_PARENT: String(process.pid), RT_GAME: GAME },
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const v = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (v !== '0' && v !== '1') continue;
        failures = 0;
        const running = v === '1';
        if (running !== state) { state = running; onChange(running); }
      }
    });
    let done = false;
    const stopped = (why) => {
      if (done) return; // 'error' and 'exit' can both fire
      done = true;
      state = null;
      if (++failures >= 3) return onFail(`the game watcher stopped (${why})`);
      setTimeout(start, 5000);
    };
    child.on('error', (e) => stopped(e.message));
    child.on('exit', (code) => stopped(`exit ${code}`));
    child.unref();
  };
  start();
  return { running: () => state };
}

/**
 * In the exe the tray icon's PowerShell process reports whether the game runs (desktop/launcher.cjs emits
 * 'rumble:game' with true/false), so no second process is needed. If the tray can't report ('rumble:game-failed'),
 * the tracker starts its own watcher. Same interface as watchGame.
 */
export function watchGameFromTray(onChange, onFail = () => {}) {
  let state = null;
  let own = null;
  process.on('rumble:game', (running) => {
    if (own || typeof running !== 'boolean' || running === state) return;
    state = running;
    onChange(running);
  });
  process.on('rumble:game-failed', () => {
    if (own) return;
    state = null;
    own = watchGame(onChange, onFail);
  });
  return { running: () => (own ? own.running() : state) };
}
