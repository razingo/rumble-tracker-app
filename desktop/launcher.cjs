// Entry point of RumbleTracker.exe (Node.js single executable application), built by tools/build_release.mjs.
//
// The app's files are embedded as one asset and unpacked per version to %LOCALAPPDATA%\RumbleTracker\app; a CommonJS
// helper imports the server from there (a single executable cannot import ES modules from disk). User data is in
// %APPDATA%\RumbleTracker.
//
// The exe has no console. The page opens in a Chromium browser's app mode (default browser if supported, else Edge,
// Chrome, Brave or Vivaldi; otherwise a normal tab) with its own profile. A tray icon (PowerShell, Windows Forms)
// reopens the window or quits. Output goes to tracker.log; start-up errors are shown in a message box.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');

const TITLE = 'Rumble Collection Tracker';
// First free port from 8765 to 8784; PORT forces one port, RUMBLE_FIRST_PORT moves the range (for testing).
const FIRST_PORT = Number(process.env.RUMBLE_FIRST_PORT || 8765);
const PORTS = process.env.PORT ? [Number(process.env.PORT)] : Array.from({ length: 20 }, (_, i) => FIRST_PORT + i);
let PORT = PORTS[0];
let PAGE = `http://localhost:${PORT}/`;
const usePort = (p) => { PORT = p; PAGE = `http://localhost:${p}/`; };
const DATA_PACK_URL = 'https://razingo.github.io/rumble-tracker-data/';
const args = new Set(process.argv.slice(2));
// --after-update=<pid>:<port>: started by an app update; waits for the old instance (pid) to stop
const afterUpdate = (() => {
  const m = /^--after-update=(\d+):(\d+)$/.exec(process.argv.slice(2).find((a) => a.startsWith('--after-update=')) || '');
  return m ? { pid: Number(m[1]), port: Number(m[2]) } : null;
})();
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA = path.resolve(process.env.RUMBLE_DATA_DIR || path.join(ROAMING, 'RumbleTracker'));
const HOME = path.join(LOCAL, 'RumbleTracker'); // unpacked app and browser profile

process.title = TITLE;

// ---- logging ----------------------------------------------------------------------------------------------------
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'tracker.log');
// called only by the instance that runs (not when handing over to a running one)
const rotateLog = () => { try { fs.renameSync(LOG, path.join(DATA, 'tracker.previous.log')); } catch { /* first start */ } logBytes = 0; };
// size cap while running (the tracker can run for weeks in the tray): past MAX_LOG the log is rotated, so at most
// two files of about MAX_LOG each are kept
const MAX_LOG = Number(process.env.RUMBLE_MAX_LOG) || 2 * 1024 * 1024; // env override for testing
const MAX_LINE = 4000;
let logBytes = null; // bytes in the current log; read from disk on the first write
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...a) => {
    let line = a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' ');
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}… (${line.length - MAX_LINE} more characters)`;
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (logBytes === null) { try { logBytes = fs.statSync(LOG).size; } catch { logBytes = 0; } }
      if (logBytes + text.length > MAX_LOG) rotateLog();
      fs.appendFileSync(LOG, text);
      logBytes += Buffer.byteLength(text);
    } catch { /* nowhere to write */ }
  };
}

// ---- PowerShell helpers (message box, tray) -------------------------------------------------------------------
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

/** Shows a start-up error in a message box, then exits. */
function fatal(message) {
  console.log(`Stopped: ${message}`);
  const script = "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:RT_MSG, $env:RT_TITLE, 'OK', 'Warning')";
  execFile(POWERSHELL, psArgs(script), { windowsHide: true, env: { ...process.env, RT_MSG: message, RT_TITLE: TITLE } }, () => process.exit(1));
}

// ---- app window --------------------------------------------------------------------------------------------------
function regValue(key, name) {
  return new Promise((resolve) => {
    execFile(path.join(SYSTEM32, 'reg.exe'), ['query', key, ...(name ? ['/v', name] : ['/ve'])], { windowsHide: true, timeout: 5000 }, (err, out) => {
      const m = !err && /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out || '');
      resolve(m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (s, v) => process.env[v] ?? s) : null);
    });
  });
}

// Chromium browsers with a usable --app mode (Firefox has none; Opera's is unreliable).
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const BROWSERS = [
  { id: 'edge', exe: 'msedge.exe', progId: /^MSEdgeHTM/i, dirs: [`${PF86}\\Microsoft\\Edge\\Application`, `${PF}\\Microsoft\\Edge\\Application`, `${LOCAL}\\Microsoft\\Edge\\Application`] },
  { id: 'chrome', exe: 'chrome.exe', progId: /^ChromeHTML/i, dirs: [`${PF}\\Google\\Chrome\\Application`, `${PF86}\\Google\\Chrome\\Application`, `${LOCAL}\\Google\\Chrome\\Application`] },
  { id: 'brave', exe: 'brave.exe', progId: /^BraveHTML/i, dirs: [`${PF}\\BraveSoftware\\Brave-Browser\\Application`, `${LOCAL}\\BraveSoftware\\Brave-Browser\\Application`] },
  { id: 'vivaldi', exe: 'vivaldi.exe', progId: /^VivaldiHTM/i, dirs: [`${LOCAL}\\Vivaldi\\Application`, `${PF}\\Vivaldi\\Application`] },
];

async function defaultProgId() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations';
  for (const key of [`${base}\\https\\UserChoiceLatest\\ProgId`, `${base}\\https\\UserChoice`, `${base}\\http\\UserChoiceLatest\\ProgId`, `${base}\\http\\UserChoice`]) {
    const v = await regValue(key, 'ProgId');
    if (v) return v;
  }
  return null;
}

async function browserPath(b) {
  for (const hive of ['HKCU', 'HKLM']) {
    const p = await regValue(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${b.exe}`);
    if (p && fs.existsSync(p)) return p;
  }
  for (const d of b.dirs) { const p = path.join(d, b.exe); if (fs.existsSync(p)) return p; }
  return null;
}

let browserChoice; // cached promise of { id, exe } | null (null: use a normal tab)
function chooseBrowser() {
  browserChoice ??= (async () => {
    const prog = await defaultProgId();
    const order = [...BROWSERS].sort((a, b) => (b.progId.test(prog || '') ? 1 : 0) - (a.progId.test(prog || '') ? 1 : 0));
    let choice = null;
    for (const b of order) { const exe = await browserPath(b); if (exe) { choice = { id: b.id, exe }; break; } }
    console.log(`Window: ${choice ? `${choice.id} app mode (${choice.exe})` : 'no app-mode browser found, using a browser tab'}; default browser ${prog || 'unknown'}`);
    return choice;
  })();
  return browserChoice;
}

/** Opens a link in the default browser. */
function openInDefaultBrowser(url) {
  execFile(path.join(SYSTEM32, 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
}

async function openWindow() {
  if (args.has('--no-browser')) return;
  const b = args.has('--tab') ? null : await chooseBrowser();
  if (!b) return openInDefaultBrowser(PAGE);
  const profile = path.join(HOME, 'window', b.id);
  const child = spawn(b.exe, [
    `--app=${PAGE}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900',
  ], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => { console.log(`Could not start ${b.id}: ${e.message}`); openInDefaultBrowser(PAGE); });
  child.unref();
}

// ---- tray icon -----------------------------------------------------------------------------------------------------
const TRAY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Say($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() }
# fallback icon, drawn in code
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 180, 50))), 1, 1, 30, 30)
$g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 110, 60, 10)), 2), 2, 2, 28, 28)
$font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$g.DrawString('R', $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 70, 35, 5))), (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $sf)
$g.Dispose()
$tray = New-Object System.Windows.Forms.NotifyIcon
# the exe's icon; the fallback if it can't be read
try { $tray.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:RT_EXE) } catch { $tray.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) }
$tray.Text = $env:RT_TITLE
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open tracker')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$folder = $menu.Items.Add('Open data folder')
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Quit tracker')
$open.add_Click({ Say 'open' })
$folder.add_Click({ Start-Process explorer.exe -ArgumentList ('"' + $env:RT_DATA + '"') })
$quit.add_Click({ $tray.Visible = $false; Say 'quit'; [System.Windows.Forms.Application]::Exit() })
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Say 'open' } })
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
# exit when the tracker process ends
$parent = [int]$env:RT_PARENT
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ try { [void][System.Diagnostics.Process]::GetProcessById($parent) } catch { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
if ($env:RT_HINT) { $tray.ShowBalloonTip(8000, $env:RT_TITLE, $env:RT_HINT, 'Info') }
Say 'ready'
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
`;

function startTray(onQuit) {
  const hintFile = path.join(DATA, '.tray-hint-shown');
  const hint = fs.existsSync(hintFile) ? '' : 'The tracker keeps running here when you close its window, so notifications still arrive. Right-click this icon to quit.';
  const tray = spawn(POWERSHELL, psArgs(TRAY_SCRIPT), {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RT_TITLE: TITLE, RT_DATA: DATA, RT_EXE: process.execPath, RT_PARENT: String(process.pid), RT_HINT: hint },
  });
  let buf = '';
  let err = '';
  tray.stdout.setEncoding('utf8');
  tray.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (cmd === 'open') openWindow();
      else if (cmd === 'quit') onQuit();
      else if (cmd === 'ready' && hint) { try { fs.writeFileSync(hintFile, ''); } catch { /* shown again next time */ } }
    }
  });
  tray.stderr.setEncoding('utf8');
  tray.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
  tray.on('error', (e) => console.log(`Tray icon could not start: ${e.message}`));
  tray.on('exit', (code) => { if (code) console.log(`Tray icon stopped (${code}): ${err.trim().slice(0, 1000)}`); });
}

// ---- starting up ---------------------------------------------------------------------------------------------------
/** Port state: 'tracker' (already running), 'free' or 'other'. */
function probe(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/report', headers: { host: `localhost:${port}` }, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).repo ? 'tracker' : 'other'); } catch { resolve('other'); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

/** Whether the port can be bound (Windows may reserve ranges, e.g. for Hyper-V). */
function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** A running tracker's port, else the first usable port: { running, port }. */
async function findPort() {
  const states = await Promise.all(PORTS.map((p) => probe(p)));
  const running = PORTS.find((p, i) => states[i] === 'tracker');
  if (running) return { running: true, port: running };
  for (const [i, p] of PORTS.entries()) if (states[i] === 'free' && await canListen(p)) return { running: false, port: p };
  return { running: false, port: null };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    if (await probe() === 'tracker') return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Opens the running instance's window and exits. */
async function handOver() {
  console.log('Already running: opening its window');
  await openWindow();
  setTimeout(() => process.exit(0), 3000);
}

/** Unpacks the embedded app (once per version) and returns its folder. */
function unpack() {
  const blob = Buffer.from(sea.getAsset('app.bin'));
  const indexLen = blob.readUInt32LE(0);
  const index = JSON.parse(blob.subarray(4, 4 + indexLen).toString('utf8'));
  const data = blob.subarray(4 + indexLen);
  const base = path.join(HOME, 'app');
  const dir = path.join(base, `${index.version}-${index.hash.slice(0, 12)}`);
  if (fs.existsSync(path.join(dir, '.complete'))) return { dir, index };

  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, offset, size, sha] of index.files) {
    const buf = data.subarray(offset, offset + size);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) throw new Error(`The program file is damaged (${rel}). Please download it again.`);
    const target = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  fs.writeFileSync(path.join(tmp, '.complete'), `${index.version} ${index.hash}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  // remove older versions (best effort: one may still be running)
  for (const name of fs.readdirSync(base)) {
    if (name !== path.basename(dir)) { try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch { /* in use */ } }
  }
  return { dir, index };
}

/** Waits up to 30 s for a process to stop. */
async function waitForExit(pid) {
  for (let i = 0; i < 150; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- app updates ----------------------------------------------------------------------------------------------------
// The server downloads and verifies the new exe (server/update/appupdate.mjs). It is swapped in here: a running exe
// can be renamed but not overwritten, so this one becomes RumbleTracker.exe.old (removed at the next start), the new
// one is copied to its place and started; it waits for this instance to stop.
const OLD_EXE = `${process.execPath}.old`;
function applyUpdate({ exe, version, done }) {
  const target = process.execPath;
  try {
    fs.rmSync(OLD_EXE, { force: true });
    fs.renameSync(target, OLD_EXE);
    try { fs.copyFileSync(exe, target); } catch (e) { fs.renameSync(OLD_EXE, target); throw e; }
  } catch (e) {
    console.log(`App update: could not replace ${target}: ${e.message}`);
    return done(`Could not replace the program file (${e.code || e.message}). Download version ${version} from GitHub Releases instead.`);
  }
  const child = spawn(target, [`--after-update=${process.pid}:${PORT}`], { detached: true, stdio: 'ignore' });
  child.once('spawn', () => { child.unref(); console.log(`App update: started ${version}`); done(null); });
  child.once('error', (e) => {
    console.log(`App update: could not start the new version: ${e.message}`);
    try { fs.rmSync(target, { force: true }); fs.renameSync(OLD_EXE, target); } catch { /* keep what is there */ }
    done(`The new version could not be started (${e.message}). Download it from GitHub Releases instead.`);
  });
}
process.on('rumble:apply-update', applyUpdate);

/** Tray Quit: the server stops once its scan and writes are done (same as Quit on the page). */
function quitFromTray() {
  if (!process.listenerCount('rumble:quit')) { console.log('Quit from the tray'); process.exit(0); }
  process.emit('rumble:quit');
  setTimeout(() => process.exit(0), 20000).unref(); // in case the server can't finish
}

async function main() {
  if (process.platform !== 'win32') return fatal(`${TITLE} runs on Windows only.`);
  if (afterUpdate) await waitForExit(afterUpdate.pid);
  try { fs.rmSync(OLD_EXE, { force: true }); } catch { /* still in use: removed next time */ }
  const found = await findPort();
  if (found.running) { usePort(found.port); return handOver(); }
  if (!found.port) {
    return fatal(PORTS.length === 1
      ? `Port ${PORTS[0]} (set with PORT) is already in use, so the tracker can't start.`
      : `Ports ${PORTS[0]}-${PORTS[PORTS.length - 1]} are all in use by other programs, so the tracker can't start.`);
  }
  usePort(found.port);
  process.env.PORT = String(PORT);

  rotateLog();
  let app;
  try { app = unpack(); } catch (e) { return fatal(`Could not unpack the tracker's files: ${e.message}`); }

  process.env.RUMBLE_DATA_DIR = DATA;
  process.env.RUMBLE_DEFAULT_DATA_PACK_URL ||= DATA_PACK_URL;
  process.env.RUMBLE_STANDALONE = '1'; // enables the Quit button and external-link handling

  console.log(`${TITLE} ${app.index.version}, unpacked in ${app.dir}`);

  process.on('uncaughtException', async (e) => {
    if (e && e.code === 'EADDRINUSE') {
      // another instance started at the same time and won the port
      const again = await findPort();
      if (again.running) { usePort(again.port); return handOver(); }
      return fatal(`Port ${PORT} is already in use, so the tracker can't start.`);
    }
    console.log(`Unexpected error: ${e && e.stack || e}`);
  });

  // resolve the browser while the server starts
  if (!args.has('--no-browser') && !args.has('--tab')) chooseBrowser().catch(() => {});

  const load = createRequire(path.join(app.dir, 'launcher-helper.cjs'))(path.join(app.dir, 'import.cjs'));
  // not awaited: on first start the server downloads the game data before it finishes loading, serving a progress
  // page meanwhile, so the window opens as soon as the port answers
  let failed = false;
  load(pathToFileURL(path.join(app.dir, 'server', 'main.mjs')).href)
    .catch((e) => { failed = true; fatal(`The tracker could not start: ${e && e.message || e}`); });
  if (!await waitForServer() || failed) {
    if (!failed) fatal(`The tracker started but its page at ${PAGE} doesn't answer. See ${LOG}.`);
    return;
  }
  startTray(quitFromTray);
  // after an update on the same port, the open window reconnects and reloads by itself
  if (afterUpdate && afterUpdate.port === PORT) return;
  await openWindow();
}

// emitted by the server for allowed external links (see server/main.mjs)
process.on('rumble:open-external', openInDefaultBrowser);

main().catch((e) => fatal(`The tracker could not start: ${e && e.stack || e}`));
