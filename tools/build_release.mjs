// Builds the Windows release: npm run build-release (Windows, Node.js 25.5+ for --build-sea).
//
// Output in dist/release/:
//   RumbleTracker.exe                     Node.js runtime, launcher and app files
//   RumbleTracker-<version>-win-x64.zip   exe, README, LICENSE, NOTICE and the Node.js license
//   SHA256SUMS.txt                        checksums of the zip and the exe
//
// Only the folders listed in APP_FILES are bundled.
import { readFile, writeFile, mkdir, rm, readdir, stat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const OUT = path.resolve(ROOT, process.env.RUMBLE_RELEASE_OUT || path.join('dist', 'release'));
const BUILD = path.join(OUT, 'build');
const ISSUES_REPO = 'razingo/rumble-tracker-app';
const EXE = 'RumbleTracker.exe';

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fail = (msg) => { console.error(`build-release: ${msg}`); process.exit(1); };

// ---- checks before building -----------------------------------------------------------------------------------
if (process.platform !== 'win32') fail('build on Windows (the exe is made from this Node.js binary).');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) fail(`needs Node.js 25.5 or newer for --build-sea (this is ${process.versions.node}).`);
const keys = await readFile(path.join(ROOT, 'server', 'datapack', 'pack_keys.mjs'), 'utf8');
if (!/BEGIN PUBLIC KEY/.test(keys)) fail('server/datapack/pack_keys.mjs has no data pack key: the release would never accept a data pack.');
const report = await readFile(path.join(ROOT, 'server', 'report.mjs'), 'utf8');
if (!report.includes(`'${ISSUES_REPO}'`)) fail(`ISSUES_REPO in server/report.mjs isn't ${ISSUES_REPO}.`);
const nodeLicense = path.join(DESKTOP, 'node-LICENSE.txt');
try { await stat(nodeLicense); } catch { fail('desktop/node-LICENSE.txt is missing (Node.js license, must ship with the exe).'); }

// ---- the app's files ---------------------------------------------------------------------------------------------
// [folder, allowed extensions]. Game data is not bundled: the exe downloads it on first start.
const APP_FILES = [
  ['server', ['.mjs']],
  ['web', ['.html', '.js', '.css', '.ico']],
];
async function walk(rel, exts) {
  const abs = path.join(ROOT, rel);
  if (!(await stat(abs)).isDirectory()) return [rel];
  const out = [];
  for (const e of await readdir(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...await walk(r, exts));
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(r);
    else console.log(`  left out: ${r}`);
  }
  return out;
}
const files = [];
for (const [rel, exts] of APP_FILES) for (const r of await walk(rel, exts)) files.push([r, await readFile(path.join(ROOT, r))]);
files.sort((a, b) => a[0].localeCompare(b[0]));
// minimal package.json (version) and the launcher's import helper
files.push(['package.json', Buffer.from(JSON.stringify({ name: pkg.name, version, private: true, type: 'module' }, null, 2) + '\n')]);
files.push(['import.cjs', Buffer.from("// Loaded by the exe's launcher: a single executable can only import ES modules through a file on disk.\nmodule.exports = (url) => import(url);\n")]);

// one blob: [u32 index length][index JSON][file bytes]
let offset = 0;
const index = { version, hash: '', files: [] };
for (const [rel, buf] of files) { index.files.push([rel, offset, buf.length, sha256(buf)]); offset += buf.length; }
const data = Buffer.concat(files.map((f) => f[1]));
index.hash = sha256(Buffer.concat([Buffer.from(JSON.stringify(index.files)), data]));
const indexBuf = Buffer.from(JSON.stringify(index));
const head = Buffer.alloc(4); head.writeUInt32LE(indexBuf.length);

try { await rm(OUT, { recursive: true, force: true }); } catch (e) {
  fail(e.code === 'EBUSY' || e.code === 'EPERM' ? 'dist/release is in use: quit RumbleTracker.exe (tray icon → Quit tracker) and build again.' : e.message);
}
await mkdir(BUILD, { recursive: true });
await writeFile(path.join(BUILD, 'app.bin'), Buffer.concat([head, indexBuf, data]));
console.log(`App files: ${files.length} (${(data.length / 1048576).toFixed(1)} MB), version ${version}`);

// ---- the exe -----------------------------------------------------------------------------------------------------
/** Replaces Node's icon with desktop/icon.ico via the Windows resource API. */
function setExeIcon(exePath, icoPath) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.IO; using System.Runtime.InteropServices;
public static class ExeIcon {
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr h);
  delegate bool EnumName(IntPtr m, IntPtr type, IntPtr name, IntPtr p);
  delegate bool EnumLang(IntPtr m, IntPtr type, IntPtr name, ushort lang, IntPtr p);
  [DllImport("kernel32")] static extern bool EnumResourceNames(IntPtr m, IntPtr type, EnumName cb, IntPtr p);
  [DllImport("kernel32")] static extern bool EnumResourceLanguages(IntPtr m, IntPtr type, IntPtr name, EnumLang cb, IntPtr p);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string f, bool del);
  [DllImport("kernel32", SetLastError=true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool EndUpdateResource(IntPtr h, bool discard);
  static bool IsId(IntPtr p) { return ((long)p >> 16) == 0; }
  public static void Set(string exe, string ico) {
    // enumerate existing icon resources for deletion
    var old = new List<Tuple<int,int,ushort>>();
    IntPtr m = LoadLibraryEx(exe, IntPtr.Zero, 0x2 | 0x20);
    if (m == IntPtr.Zero) throw new Exception("cannot read " + exe);
    foreach (int type in new[] { 14, 3 }) {
      EnumResourceNames(m, (IntPtr)type, (mm, t, n, p) => {
        if (IsId(n)) EnumResourceLanguages(mm, t, n, (m2, t2, n2, lang, p2) => { old.Add(Tuple.Create(type, (int)n2, lang)); return true; }, IntPtr.Zero);
        return true; }, IntPtr.Zero);
    }
    FreeLibrary(m);
    byte[] f = File.ReadAllBytes(ico);
    int count = BitConverter.ToUInt16(f, 4);
    IntPtr h = BeginUpdateResource(exe, false);
    if (h == IntPtr.Zero) throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
    foreach (var o in old) UpdateResource(h, (IntPtr)o.Item1, (IntPtr)o.Item2, o.Item3, null, 0);
    var group = new MemoryStream(); var w = new BinaryWriter(group);
    w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)count);
    for (int i = 0; i < count; i++) {
      int e = 6 + 16 * i; int len = BitConverter.ToInt32(f, e + 8); int off = BitConverter.ToInt32(f, e + 12);
      byte[] img = new byte[len]; Array.Copy(f, off, img, 0, len);
      if (!UpdateResource(h, (IntPtr)3, (IntPtr)(i + 1), 1033, img, (uint)len)) throw new Exception("icon " + i + ": " + Marshal.GetLastWin32Error());
      w.Write(f, e, 12); w.Write((ushort)(i + 1)); // GRPICONDIRENTRY: first 12 bytes of ICONDIRENTRY + resource id
    }
    byte[] g = group.ToArray();
    if (!UpdateResource(h, (IntPtr)14, (IntPtr)1, 1033, g, (uint)g.Length)) throw new Exception("icon group: " + Marshal.GetLastWin32Error());
    if (!EndUpdateResource(h, false)) throw new Exception("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
  }
}
'@
[ExeIcon]::Set($env:RT_EXE, $env:RT_ICO)
`;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    // no inherited stdin: a nested PowerShell can block on it
    { env: { ...process.env, RT_EXE: exePath, RT_ICO: icoPath }, stdio: ['ignore', 'pipe', 'pipe'] });
}

await copyFile(path.join(DESKTOP, 'launcher.cjs'), path.join(BUILD, 'launcher.cjs'));
await writeFile(path.join(BUILD, 'sea-config.json'), JSON.stringify({
  main: 'launcher.cjs',
  output: path.join(OUT, EXE),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: { 'app.bin': 'app.bin' },
}, null, 2));
execFileSync(process.execPath, ['--build-sea', 'sea-config.json'], { cwd: BUILD, stdio: 'inherit' });
setExeIcon(path.join(OUT, EXE), path.join(DESKTOP, 'icon.ico'));
const exe = await readFile(path.join(OUT, EXE));
// Mark the exe as a GUI program (no console window). Subsystem is at e_lfanew + 4 + 20 + 68.
const pe = exe.readUInt32LE(0x3c);
if (exe.readUInt32LE(pe) !== 0x4550 || exe.readUInt16LE(pe + 24) !== 0x20b) fail('unexpected exe header: cannot set the GUI subsystem.');
exe.writeUInt16LE(2, pe + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
await writeFile(path.join(OUT, EXE), exe);
console.log(`Built ${EXE} (${(exe.length / 1048576).toFixed(1)} MB, Node.js ${process.versions.node})`);

// ---- the zip players download ----------------------------------------------------------------------------------
/** Minimal zip writer (deflate, no zip64). */
function zip(entries) {
  const local = [], central = [];
  let pos = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const [name, buf] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(buf, { level: 9 });
    const crc = crc32(buf);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime(now), 10); lh.writeUInt16LE(dosDate(now), 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(buf.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime(now), 12); ch.writeUInt16LE(dosDate(now), 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(buf.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(pos, 42);
    local.push(lh, nameBuf, comp);
    central.push(ch, nameBuf);
    pos += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);
  return Buffer.concat([...local, cd, end]);
}
const folder = `RumbleTracker-${version}-win-x64`;
const zipName = `${folder}.zip`;
const zipBuf = zip([
  [`${folder}/${EXE}`, exe],
  [`${folder}/README.md`, await readFile(path.join(ROOT, 'README.md'))],
  [`${folder}/LICENSE.txt`, await readFile(path.join(ROOT, 'LICENSE'))],
  [`${folder}/NOTICE.md`, await readFile(path.join(ROOT, 'NOTICE.md'))],
  [`${folder}/THIRD-PARTY-NOTICES/Node.js-LICENSE.txt`, await readFile(nodeLicense)],
]);
await writeFile(path.join(OUT, zipName), zipBuf);
await writeFile(path.join(OUT, 'SHA256SUMS.txt'), `${sha256(zipBuf)}  ${zipName}\n${sha256(exe)}  ${EXE}\n`);
console.log(`Built ${zipName} (${(zipBuf.length / 1048576).toFixed(1)} MB)`);

await rm(BUILD, { recursive: true, force: true });
console.log(`\nDone: ${path.relative(ROOT, OUT)}\\ (next: attach the zip to a GitHub Release)`);
