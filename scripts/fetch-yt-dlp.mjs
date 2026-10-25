// Downloads the pinned yt-dlp release into vendor/ so the app can bundle it.
// Usage: yarn fetch:yt-dlp [win32|darwin]   (defaults to this machine's platform)
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keep in step with THIRD-PARTY.md. Hashes come from the release's SHA2-256SUMS.
export const YT_DLP_RELEASE = {
  version: '2026.08.19',
  win32: {
    asset: 'yt-dlp.exe',
    target: 'yt-dlp.exe',
    sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
  },
  // A universal binary: one file serves Apple Silicon and Intel Macs.
  darwin: {
    asset: 'yt-dlp_macos',
    target: 'yt-dlp',
    sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
  },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function existingMatches(filePath, expected) {
  try {
    return sha256(await fs.readFile(filePath)) === expected;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export default async function fetchYtDlp({
  platform = process.platform,
  vendorDirectory = path.join(projectRoot, 'vendor'),
  release = YT_DLP_RELEASE,
  download = fetch,
} = {}) {
  const pin = release[platform];

  if (!pin) {
    throw new Error(`No yt-dlp build is pinned for ${platform}.`);
  }

  const target = path.join(vendorDirectory, pin.target);

  if (await existingMatches(target, pin.sha256)) {
    return { target, downloaded: false };
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${release.version}/${pin.asset}`;
  const response = await download(url);

  if (!response.ok) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);

  // Never place a binary the app will run unless it is exactly the pinned release.
  if (actual !== pin.sha256) {
    throw new Error(`${pin.asset} has SHA-256 ${actual}, expected ${pin.sha256}.`);
  }

  await fs.mkdir(vendorDirectory, { recursive: true });
  const partial = `${target}.download`;
  await fs.writeFile(partial, bytes, { mode: 0o755 });
  await fs.rename(partial, target);

  return { target, downloaded: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { target, downloaded } = await fetchYtDlp({ platform: process.argv[2] });

  // eslint-disable-next-line no-console -- command-line output.
  console.log(
    `${downloaded ? 'Downloaded' : 'Already present'}: yt-dlp ${YT_DLP_RELEASE.version} → ${path.relative(projectRoot, target)}`,
  );
}
