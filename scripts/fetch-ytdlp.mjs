// Downloads yt-dlp.exe from the official GitHub release and verifies it against the release's SHA2-256SUMS file.
// Usage: node scripts/fetch-ytdlp.mjs <destination directory> [x64|ia32]
// The packaged app uses it to find the video on any supported web page (see core/extract.mjs).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [dest = 'vendor', arch = 'x64'] = process.argv.slice(2);
const version = process.env.YTDLP_VERSION || '2026.08.19';
const asset = arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
async function get(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await get(`${base}/SHA2-256SUMS`)).toString('utf8');
const expected = sums.split(/\r?\n/).map(l => l.trim().split(/\s+\*?/)).find(([, name]) => name === asset)?.[0];
if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) throw new Error(`No checksum for ${asset} in release ${version}.`);
const data = await get(`${base}/${asset}`);
const actual = createHash('sha256').update(data).digest('hex');
if (actual !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}.`);
await fs.mkdir(dest, { recursive: true });
await fs.writeFile(path.join(dest, 'yt-dlp.exe'), data);
console.log(`yt-dlp ${version} (${asset}) verified and saved to ${path.join(dest, 'yt-dlp.exe')} (${data.length} bytes).`);
