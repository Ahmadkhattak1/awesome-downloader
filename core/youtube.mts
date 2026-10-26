import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ffmpegExecutable } from './mux.mjs';
import type { DownloadStatus, OutputFormat } from './types.mjs';

// The subset of yt-dlp's --dump-single-json output this module reads.
interface YtDlpFormat {
  format_id: string | number;
  url?: string;
  protocol: string;
  has_drm?: boolean;
  vcodec: string;
  acodec: string;
  ext: string;
  height?: number;
  fps?: number;
  abr?: number;
  filesize?: number;
  filesize_approx?: number;
}
interface YtDlpInfo {
  is_live?: boolean;
  live_status?: string;
  formats?: YtDlpFormat[];
  title?: string;
  duration?: number;
}
export interface YoutubeChoice {
  url: string;
  provider: 'youtube';
  youtubeFormat: string;
  format: 'MP4' | 'MP3';
  quality: string;
  fps?: number;
  audioState: string;
  title: string;
  outputFormat: OutputFormat;
  estimatedSize?: number;
  duration: number;
}
export interface YoutubeProgress {
  downloaded: number;
  total: number | null;
  speed: number;
  status: DownloadStatus;
  estimated: boolean;
}
type YoutubeError = Error & { code?: string; statusCode?: number };

// The video ID in a youtu.be, watch, shorts or embed address.
function videoIdFrom(url: URL) {
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    return url.pathname.slice(1);
  }

  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    return null;
  }

  if (url.pathname === '/watch') {
    return url.searchParams.get('v');
  }

  return /^\/(shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[2];
}

export function youtubeUrl(value: string) {
  try {
    const url = new URL(value);

    if (url.protocol !== 'https:' || url.username || url.password) {
      return null;
    }

    const id = videoIdFrom(url);
    return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch {
    return null;
  }
}

export function choicesFromInfo(info: YtDlpInfo, url: string): YoutubeChoice[] {
  if (info.is_live || info.live_status === 'is_live') {
    throw new Error('Live YouTube streams are not supported yet.');
  }

  const formats = (info.formats || []).filter(
    (format) =>
      !format.has_drm &&
      format.url &&
      ['https', 'http', 'm3u8_native', 'm3u8'].includes(format.protocol),
  );

  const audios = formats
    .filter(
      (format) =>
        format.vcodec === 'none' &&
        format.acodec !== 'none' &&
        format.ext === 'm4a' &&
        !String(format.format_id).includes('drc'),
    )
    .sort((first, second) => (second.abr || 0) - (first.abr || 0));

  const audio = audios[0];
  const groups = new Map<number | undefined, YtDlpFormat>();

  const videos = formats.filter(
    (format) =>
      format.vcodec &&
      format.vcodec !== 'none' &&
      format.ext === 'mp4' &&
      format.height &&
      // A video-only format is usable only with a separate audio track.
      (format.acodec !== 'none' || audio),
  );

  for (const format of videos) {
    const old = groups.get(format.height);

    // Prefer a direct H.264 stream at each height for Windows compatibility.
    const score = (candidate: YtDlpFormat) =>
      (candidate.protocol === 'https' ? 100 : 0) +
      (/^avc/.test(candidate.vcodec) ? 50 : 0) +
      (candidate.fps || 0) / 100;

    if (!old || score(format) > score(old)) {
      groups.set(format.height, format);
    }
  }

  const title = String(info.title || 'YouTube video').slice(0, 180);

  const result: YoutubeChoice[] = [...groups.values()]
    .sort((first, second) => second.height! - first.height!)
    .map((format) => {
      // Video-only formats are skipped above unless an audio track exists.
      const paired = format.acodec === 'none';
      return {
        url,
        provider: 'youtube',
        youtubeFormat: String(format.format_id) + (paired ? `+${audio!.format_id}` : ''),
        format: 'MP4',
        quality: `${format.height}p`,
        fps: format.fps || 0,
        audioState: 'Video + audio',
        title,
        outputFormat: 'mp4',
        estimatedSize:
          (format.filesize || format.filesize_approx || 0) +
          (paired ? audio!.filesize || audio!.filesize_approx || 0 : 0),
        duration: info.duration || 0,
      };
    });

  if (audio) {
    result.push({
      url,
      provider: 'youtube',
      youtubeFormat: `audio:${audio.format_id}`,
      format: 'MP3',
      quality: '',
      audioState: 'Audio only',
      title,
      outputFormat: 'mp3',
      duration: info.duration || 0,
    });
  }

  if (!result.length) {
    throw new Error(
      'No downloadable video/audio formats were found. This video may require sign-in or may be unavailable.',
    );
  }

  return result;
}

function executable() {
  // Packaged Electron sets these; plain Node and unpackaged `electron .` runs use vendor/.
  const electron = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  return process.versions.electron && electron.resourcesPath && !electron.defaultApp
    ? path.join(electron.resourcesPath, 'tools', 'yt-dlp.exe')
    : fileURLToPath(new URL('../../vendor/yt-dlp.exe', import.meta.url));
}

export function youtubeError(raw: unknown): YoutubeError {
  const message = String(raw);

  if (/HTTP Error 429|Too Many Requests/i.test(message)) {
    return Object.assign(
      new Error(
        'YouTube is temporarily refusing requests (too many requests). Wait before trying again. Repeated clicks will not help; this app does not currently support YouTube sign-in verification.',
      ),
      { code: 'YOUTUBE_RATE_LIMIT', statusCode: 429 },
    );
  }

  if (/confirm.{0,20}not a bot|Sign in|login required|cookies-from-browser/i.test(message)) {
    return Object.assign(
      new Error(
        'YouTube requires sign-in or browser verification for this request. The downloader cannot currently complete that verification.',
      ),
      { code: 'YOUTUBE_VERIFICATION', statusCode: 422 },
    );
  }

  const errorLine = message.split(/\r?\n/).findLast((line) => line.startsWith('ERROR:')) || message;
  return new Error(
    errorLine
      .replace(/https?:\/\/\S+/g, '[URL]')
      .trim()
      .slice(0, 700) || 'YouTube download failed.',
  );
}

function run(
  args: string[],
  {
    signal,
    onLine,
    timeout = 120000,
  }: { signal?: AbortSignal; onLine?: (line: string) => void; timeout?: number } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const env = { ...process.env };

    if (process.versions.electron) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    const child = spawn(
      executable(),
      [
        '--ignore-config',
        '--no-playlist',
        '--no-colors',
        '--js-runtimes',
        `node:${process.execPath}`,
        ...args,
      ],
      { windowsHide: true, env, signal, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    let error = '';
    let pending = '';
    let overflow = false;

    const timer = timeout
      ? setTimeout(() => {
          error = 'YouTube request timed out.';
          child.kill();
        }, timeout)
      : undefined;

    child.stdout.on('data', (chunk) => {
      if (onLine) {
        pending += chunk;
        let at = pending.indexOf('\n');

        while (at >= 0) {
          onLine(pending.slice(0, at));
          pending = pending.slice(at + 1);
          at = pending.indexOf('\n');
        }

        if (pending.length > 1048576) {
          overflow = true;
          child.kill();
        }
      } else {
        output += chunk;

        if (output.length > 32 * 1024 * 1024) {
          overflow = true;
          child.kill();
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-4000);
    });

    child.on('error', (spawnError) => {
      clearTimeout(timer);
      reject(spawnError);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      if (code === 0 && !overflow) {
        resolve(output);
      } else {
        reject(youtubeError(overflow ? 'YouTube response exceeded its size limit.' : error));
      }
    });
  });
}

const cache = new Map<string, { promise: Promise<YoutubeChoice[]>; expires: number }>();
let active = 0;
let rateLimitUntil = 0;

export async function youtubeFormats(input: string) {
  const url = youtubeUrl(input);

  if (!url) {
    throw new Error('A valid YouTube video URL is required.');
  }

  const existing = cache.get(url);

  if (existing && existing.expires > Date.now()) {
    return existing.promise;
  }

  if (Date.now() < rateLimitUntil) {
    throw youtubeError('HTTP Error 429');
  }

  if (active >= 2) {
    throw new Error('Already checking two videos. Try again shortly.');
  }

  active += 1;

  const promise = run(['--skip-download', '--dump-single-json', url], { timeout: 45000 })
    .then((raw) => choicesFromInfo(JSON.parse(raw), url))
    .finally(() => {
      active -= 1;
    });

  cache.set(url, { promise, expires: Date.now() + 120000 });

  if (cache.size > 20) {
    cache.delete(cache.keys().next().value!);
  }

  try {
    return await promise;
  } catch (error) {
    if ((error as YoutubeError).code === 'YOUTUBE_RATE_LIMIT') {
      rateLimitUntil = Date.now() + 120000;
    }

    // Retain short-lived failures as well as successes to avoid repeated menu
    // clicks hammering the same video. This promise already has a rejection handler.
    const entry = cache.get(url);

    if (entry?.promise === promise) {
      entry.expires = Date.now() + 120000;
    }

    throw error;
  }
}

export async function downloadYoutube({
  url,
  formatKey,
  directory,
  signal,
  onProgress,
  onMetadata,
  speedLimitKbps = 0,
}: {
  url: string;
  formatKey?: string;
  directory: string;
  signal: AbortSignal;
  onProgress?: (progress: YoutubeProgress) => void;
  onMetadata?: (choice: YoutubeChoice) => void;
  speedLimitKbps?: number;
}) {
  const formats = await youtubeFormats(url);
  signal.throwIfAborted();

  const choice = formatKey
    ? formats.find((option) => option.youtubeFormat === formatKey)
    : formats.find((option) => option.format === 'MP4');

  if (!choice) {
    throw new Error('This YouTube format is no longer available. Refresh the video menu.');
  }

  onMetadata?.(choice);
  const audio = choice.youtubeFormat.startsWith('audio:');

  const args = [
    '--newline',
    '--progress',
    '--progress-delta',
    '0.5',
    '--progress-template',
    'download:ADPROGRESS:%(progress)j',
    '--ffmpeg-location',
    ffmpegExecutable(),
    '-f',
    audio ? choice.youtubeFormat.slice(6) : choice.youtubeFormat,
    '-o',
    path.join(directory, 'media.%(ext)s'),
  ];

  if (speedLimitKbps) {
    args.push('--limit-rate', String(speedLimitKbps * 1024));
  }

  args.push(
    ...(audio ? ['--extract-audio', '--audio-format', 'mp3'] : ['--merge-output-format', 'mp4']),
    // youtubeFormats() above has already rejected anything that is not a YouTube URL.
    youtubeUrl(url)!,
  );

  const finished = new Map<string, number>();
  let completedBytes = 0;

  await run(args, {
    signal,
    timeout: 0,
    onLine: (line) => {
      if (!line.startsWith('ADPROGRESS:')) {
        return;
      }

      try {
        const progress = JSON.parse(line.slice(11));
        const key = progress.filename || progress.tmpfilename || 'media';
        const downloaded = Number(progress.downloaded_bytes) || 0;

        if (progress.status === 'finished' && !finished.has(key)) {
          finished.set(key, downloaded);
          completedBytes += downloaded;
        }

        const current = finished.has(key) ? 0 : downloaded;

        onProgress?.({
          downloaded: completedBytes + current,
          total: choice.estimatedSize || null,
          speed: Number(progress.speed) || 0,
          status: progress.status === 'finished' ? 'assembling' : 'downloading',
          estimated: true,
        });
      } catch {
        // Ignore output lines that are not progress JSON.
      }
    },
  });

  const output = path.join(directory, `media.${audio ? 'mp3' : 'mp4'}`);
  const stat = await fs.stat(output);

  if (!stat.size) {
    throw new Error('YouTube returned an empty file.');
  }

  return { output, size: stat.size, choice };
}
