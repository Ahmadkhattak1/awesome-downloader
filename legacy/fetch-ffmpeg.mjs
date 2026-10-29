// Puts a verified 32-bit (i386) ffmpeg.exe at node_modules/ffmpeg-static/ffmpeg.exe.
// ffmpeg-static 5.x publishes no win32-ia32 binary, so the ia32 build cannot use its installer.
// Override the source with the FFMPEG_IA32_URL environment variable (.exe, .gz or .zip).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const urls = process.env.FFMPEG_IA32_URL ? [process.env.FFMPEG_IA32_URL] : [
  'https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4/ffmpeg-win32-ia32.gz',
  'https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4/ffmpeg-win32-ia32',
  'https://github.com/sudo-nautilus/FFmpeg-Builds-Win32/releases/download/latest/ffmpeg-master-latest-win32-gpl.zip',
];
export function machineOf(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 6 > buffer.length || buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
  return buffer.readUInt16LE(pe + 4);
}
async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = await findFile(full, name); if (found) return found; }
    else if (entry.name.toLowerCase() === name) return full;
  }
  return null;
}
export async function toExecutable(data) {
  if (data[0] === 0x1f && data[1] === 0x8b) return zlib.gunzipSync(data);
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-ia32-'));
    await fs.writeFile(path.join(dir, 'a.zip'), data);
    execFileSync('tar', ['-xf', path.join(dir, 'a.zip'), '-C', dir]);
    const exe = await findFile(dir, 'ffmpeg.exe');
    if (!exe) throw new Error('ffmpeg.exe not found inside the archive.');
    return fs.readFile(exe);
  }
  return data;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let ok = false;
  for (const url of urls) {
    try {
      console.log('Trying', url);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const exe = await toExecutable(Buffer.from(await response.arrayBuffer()));
      const machine = machineOf(exe);
      if (machine !== 0x14c) throw new Error(`not a 32-bit (i386) Windows executable (machine=${machine === null ? 'invalid' : '0x' + machine.toString(16)})`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, exe);
      if (process.platform === 'win32') execFileSync(target, ['-version'], { stdio: 'inherit' });
      console.log(`Installed 32-bit ffmpeg.exe (${exe.length} bytes) from ${url}`);
      ok = true; break;
    } catch (error) { console.log(`  failed: ${error.message}`); }
  }
  if (!ok) { console.error('Could not obtain a working 32-bit ffmpeg.exe. Set the FFMPEG_IA32_URL repository variable to a direct link to a 32-bit ffmpeg.exe, .gz or .zip.'); process.exit(1); }
}
