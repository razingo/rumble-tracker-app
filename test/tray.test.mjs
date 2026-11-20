// The exe's PowerShell scripts, on Windows only. The tray icon starts, compiles its shutdown hook and reports whether
// the game runs, and the integration script compiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from '../server/system.mjs';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const windows = process.platform === 'win32';

test('the tray icon reports ready, then the game state', { skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded(readFileSync(path.join(DESKTOP, 'tray.ps1'), 'utf8'))], {
    windowsHide: true,
    // A game name that never runs, so the answer is known.
    env: { ...process.env, RT_TITLE: 'Tray test', RT_DATA: process.cwd(), RT_EXE: process.execPath,
      RT_PARENT: String(process.pid), RT_GAME: 'NoSuchGameForTrayTest' },
  });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  try {
    for (let i = 0; i < 400 && !/game [01]/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(out.split(/\r?\n/).filter(Boolean), ['ready', 'game 0'], `stderr: ${err}`);
    assert.equal(err.replace(/^#< CLIXML\s*/, '').trim(), '', 'no errors (the shutdown hook compiled)');
  } finally {
    child.kill();
  }
});

test('the close dialog builds', { skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      encoded(readFileSync(path.join(DESKTOP, 'close-dialog.ps1'), 'utf8'))],
    { windowsHide: true, env: { ...process.env, RT_TITLE: 'Test', RT_EXE: process.execPath, RT_CHECK: '1' } },
    (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout)));
  });
  assert.match(out, /built/);
});

test('integration script compiles', { skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  // Only the type definition, as running it would create a shortcut and register a link type.
  const script = readFileSync(path.join(DESKTOP, 'integration.ps1'), 'utf8');
  const typeOnly = script.slice(0, script.indexOf("\n'@") + 4) + "\n'compiled'";
  const out = await new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      encoded(typeOnly)], { windowsHide: true }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout)));
  });
  assert.match(out, /compiled/);
});
