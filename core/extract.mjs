import './compat.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Generic media extraction for any website / any container:
//  - yt-dlp understands page URLs of ~1800 sites and picks the best streams (HLS, DASH, progressive, split audio/video);
//  - ffmpeg copies any manifest or stream it can read (DASH .mpd, encrypted-with-key HLS, flv, ts, ...) into a file.
// DRM-protected streams (Widevine/PlayReady/FairPlay) are detected and refused; nothing here circumvents DRM.
export const EXTRACT_FORMATS = ['mp4', 'mkv', 'webm', 'mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'];
const AUDIO_ONLY = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus']);
export const isAudioFormat = format => AUDIO_ONLY.has(format);

export function validFormatSelector(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[\w\s\-+*/[\]<>=!.,:()|&^$~]+$/.test(value) && !value.startsWith('-'); }

export function ytdlpCommand() {
  if (process.env.AWESOME_YTDLP) return process.env.AWESOME_YTDLP;
  return process.versions.electron && process.resourcesPath && !process.defaultApp ? path.join(process.resourcesPath, 'tools', 'yt-dlp.exe') : fileURLToPath(new URL('../vendor/yt-dlp.exe', import.meta.url));
}
let ffmpegPath;
async function ffmpegCommand() {
  if (process.env.AWESOME_FFMPEG) return process.env.AWESOME_FFMPEG;
  if (!ffmpegPath) ffmpegPath = (await import('ffmpeg-static')).default;
  return String(ffmpegPath).replace('app.asar', 'app.asar.unpacked');
}
export async function available() {
  try { await fs.access(ytdlpCommand()); return true; } catch { return false; }
}

export function extractError(raw) {
  const text = String(raw);
  if (/DRM|Widevine|PlayReady|FairPlay|encrypted.{0,20}(CENC|cenc)/i.test(text)) return Object.assign(new Error('This video is DRM-protected (Widevine/PlayReady/FairPlay). DRM cannot be removed, so it cannot be downloaded.'), { code: 'DRM' });
  if (/Unsupported URL/i.test(text)) return Object.assign(new Error('No video could be found at this address. Open the video page and use the download button over the player, or play it so its stream can be detected.'), { code: 'UNSUPPORTED' });
  if (/HTTP Error 429|Too Many Requests/i.test(text)) return Object.assign(new Error('The site is rate limiting requests (HTTP 429). Wait a few minutes and retry.'), { code: 'THROTTLED', statusCode: 429 });
  if (/Sign in|login required|confirm.{0,20}not a bot|cookies-from-browser|members.only|private video/i.test(text)) return Object.assign(new Error('The site requires you to be signed in for this video. Browser cookies were not accepted for it.'), { code: 'LOGIN' });
  const line = text.split(/\r?\n/).findLast(l => /^ERROR:/.test(l)) || text.trim().split(/\r?\n/).pop() || 'Extraction failed.';
  return new Error(line.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 600));
}

function spawnLines(command, args, { signal, onLine, onStderr, env }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { windowsHide: true, env: { ...process.env, ...env }, signal, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { return reject(error); }
    let pending = '', err = '';
    child.stdout.on('data', chunk => { pending += chunk; let at; while ((at = pending.indexOf('\n')) >= 0) { onLine?.(pending.slice(0, at).replace(/\r$/, '')); pending = pending.slice(at + 1); } if (pending.length > 1048576) child.kill(); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-6000); onStderr?.(String(chunk)); });
    child.on('error', error => reject(error.code === 'ENOENT' ? Object.assign(new Error(`${path.basename(command)} was not found. Reinstall Awesome Downloader.`), { code: 'TOOL_MISSING' }) : error));
    child.on('close', code => { if (pending) onLine?.(pending); if (signal?.aborted) return reject(signal.reason || Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); code === 0 ? resolve() : reject(extractError(err)); });
  });
}
const headerArgs = (headers = {}) => Object.entries(headers).filter(([k, v]) => k !== 'referer' && typeof v === 'string' && !/[\r\n]/.test(v)).flatMap(([k, v]) => ['--add-header', `${k}:${v}`]);

async function findOutput(directory, stem) {
  const files = (await fs.readdir(directory)).filter(f => f.startsWith(stem + '.') && !/\.(part|ytdl|temp|tmp)$|\.f\d+\.[a-z0-9]+$/i.test(f));
  let best = null;
  for (const name of files) { const size = (await fs.stat(path.join(directory, name))).size; if (size > 0 && (!best || size > best.size)) best = { name, size }; }
  if (!best) throw new Error('The extractor finished but produced no file.');
  return { output: path.join(directory, best.name), size: best.size, extension: path.extname(best.name).slice(1).toLowerCase() };
}

// Page URL -> file, via yt-dlp. Returns { output, size, extension, title }.
export async function downloadWithYtdlp({ url, headers = {}, directory, signal, onProgress, onMetadata, format, outputFormat, speedLimitKbps = 0 }) {
  const audio = isAudioFormat(outputFormat);
  const args = ['--ignore-config', '--no-playlist', '--no-colors', '--newline', '--no-simulate', '--progress-delta', '0.5',
    '--print', 'before_dl:ADTITLE:%(title)s', '--print', 'before_dl:ADDURATION:%(duration)s', '--progress-template', 'download:ADPROGRESS:%(progress)j',
    '--ffmpeg-location', await ffmpegCommand(), '--concurrent-fragments', '8', '-o', path.join(directory, 'media.%(ext)s')];
  if (headers.referer) args.push('--referer', headers.referer);
  if (headers['user-agent']) args.push('--user-agent', headers['user-agent']);
  args.push(...headerArgs({ ...headers, 'user-agent': undefined }));
  if (speedLimitKbps) args.push('--limit-rate', `${speedLimitKbps}K`);
  if (audio) args.push('-f', format || 'ba/b', '--extract-audio', '--audio-format', outputFormat);
  else args.push('-f', format || 'bv*+ba/b', '--merge-output-format', outputFormat && !audio ? outputFormat : 'mp4/mkv');
  args.push(url);
  let title = '', duration = 0, completed = 0; const finished = new Map();
  await spawnLines(ytdlpCommand(), args, { signal, onLine: line => {
    if (line.startsWith('ADTITLE:')) { title = line.slice(8).trim(); onMetadata?.({ title, duration }); return; }
    if (line.startsWith('ADDURATION:')) { duration = Number(line.slice(11)) || 0; return; }
    if (!line.startsWith('ADPROGRESS:')) return;
    try {
      const p = JSON.parse(line.slice(11)), key = p.filename || p.tmpfilename || 'media', got = Number(p.downloaded_bytes) || 0;
      if (p.status === 'finished' && !finished.has(key)) { finished.set(key, got); completed += got; }
      const total = Number(p.total_bytes || p.total_bytes_estimate) || 0;
      onProgress?.({ downloaded: completed + (finished.has(key) ? 0 : got), total: total ? completed + total : null, speed: Number(p.speed) || 0, status: p.status === 'finished' ? 'assembling' : 'downloading', estimated: true });
    } catch { /* ignore malformed progress */ }
  } });
  return { ...(await findOutput(directory, 'media')), title, duration };
}

// Any stream ffmpeg can read (DASH .mpd, HLS with keys, flv, ts, rtmp-less http streams) copied into one file.
export async function downloadWithFfmpeg({ url, headers = {}, directory, signal, onProgress, outputFormat }) {
  const extension = EXTRACT_FORMATS.includes(outputFormat) ? outputFormat : 'mkv';
  const out = path.join(directory, `media.${extension}`);
  const lines = Object.entries(headers).filter(([k, v]) => ['user-agent', 'referer'].indexOf(k) < 0 && typeof v === 'string' && !/[\r\n]/.test(v)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', ...(headers['user-agent'] ? ['-user_agent', headers['user-agent']] : []), ...(headers.referer ? ['-referer', headers.referer] : []),
    ...(lines ? ['-headers', lines] : []), '-i', url, '-map', '0:v?', '-map', '0:a?', ...(isAudioFormat(extension) ? ['-vn'] : ['-c', 'copy']), '-progress', 'pipe:1', out];
  if (isAudioFormat(extension) && extension === 'mp3') args.splice(args.length - 1, 0, '-c:a', 'libmp3lame', '-q:a', '2');
  let size = 0, speedAt = Date.now(), speedBytes = 0, speed = 0;
  await spawnLines(await ffmpegCommand(), args, { signal, onLine: line => {
    const m = /^total_size=(\d+)/.exec(line); if (!m) return;
    size = Number(m[1]); const now = Date.now();
    if (now - speedAt >= 500) { speed = (size - speedBytes) * 1000 / (now - speedAt); speedAt = now; speedBytes = size; }
    onProgress?.({ downloaded: size, total: null, speed, status: 'downloading', estimated: true });
  } });
  const stat = await fs.stat(out);
  if (!stat.size) throw new Error('ffmpeg produced an empty file.');
  return { output: out, size: stat.size, extension };
}
