import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ffmpeg-static is CommonJS (module.exports = path) but its typings declare an ES default export.
const ffmpegPath = ffmpegStatic as unknown as string | null;

export function ffmpegExecutable() {
  if (!ffmpegPath) {
    throw new Error('FFmpeg is not available for this platform.');
  }

  return ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

export async function muxTracks(
  directory: string,
  videoCount: number,
  count: number,
  signal: AbortSignal,
) {
  for (const [name, start, end] of [
    ['video', 0, videoCount],
    ['audio', videoCount, count],
  ] as const) {
    const output = await fs.open(path.join(directory, `${name}.track`), 'w');

    try {
      for (let partIndex = start; partIndex < end; partIndex += 1) {
        const input = await fs.open(path.join(directory, `${partIndex}.part`), 'r');

        try {
          for await (const chunk of input.createReadStream()) {
            signal.throwIfAborted();
            await output.writeFile(chunk);
          }
        } finally {
          await input.close();
        }
      }
    } finally {
      await output.close();
    }
  }

  const output = path.join(directory, 'combined.mp4');
  const executable = ffmpegExecutable();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        path.join(directory, 'video.track'),
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        path.join(directory, 'audio.track'),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        output,
      ],
      { windowsHide: true, signal, stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let error = '';

    child.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-4096);
    });

    child.on('error', reject);

    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Could not combine video and audio: ${error || `media process exited ${code}`}`,
            ),
          ),
    );
  });

  return output;
}

export async function convertMedia(
  directory: string,
  files: string[],
  format: string,
  signal: AbortSignal,
) {
  if (!['mp4', 'mp3'].includes(format)) {
    throw new Error('Unsupported output format.');
  }

  const source = path.join(directory, 'conversion-source.track');
  const out = await fs.open(source, 'w');

  try {
    for (const file of files) {
      const input = await fs.open(file, 'r');

      try {
        for await (const chunk of input.createReadStream()) {
          signal.throwIfAborted();
          await out.writeFile(chunk);
        }
      } finally {
        await input.close();
      }
    }
  } finally {
    await out.close();
  }

  const output = path.join(directory, `converted.${format}`);

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      source,
    ];

    args.push(
      ...(format === 'mp3'
        ? ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2']
        : ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart']),
      output,
    );

    const child = spawn(ffmpegExecutable(), args, {
      windowsHide: true,
      signal,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let error = '';

    child.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-4096);
    });

    child.on('error', reject);

    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Could not create ${format.toUpperCase()}: ${error || `media process exited ${code}`}`,
            ),
          ),
    );
  });

  return output;
}

// Runs FFmpeg and resolves with its diagnostic output (FFmpeg reports on stderr).
function runFfmpeg(args: string[], signal: AbortSignal, { allowFailure = false } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, {
      windowsHide: true,
      signal,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let report = '';

    child.stderr.on('data', (chunk) => {
      report = (report + chunk).slice(-65536);
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve(report);
      } else {
        reject(new Error(`Media process exited ${code}: ${report.slice(-4096)}`));
      }
    });
  });
}

// The codec of a file's first video stream as FFmpeg names it, e.g. 'h264' or 'av1'.
export async function videoCodec(file: string, signal: AbortSignal) {
  // Without an output FFmpeg exits with an error, but it has printed the stream list.
  const report = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file], signal, {
    allowFailure: true,
  });

  return /Stream #\d+:\d+\S*: Video: (\w+)/.exec(report)?.[1] ?? null;
}

// Re-encodes the video track to H.264, which QuickTime and Windows players play
// everywhere, and copies the audio unchanged.
// `bitsPerSecond` is the chosen H.264 format's bitrate, so the result is about the size of
// a direct H.264 download; without it a fixed quality is used.
export async function convertVideoToH264(
  directory: string,
  input: string,
  signal: AbortSignal,
  bitsPerSecond?: number,
) {
  const output = path.join(directory, 'converted-h264.mp4');
  const codec = process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264';

  const rate = bitsPerSecond
    ? [
        '-b:v',
        String(bitsPerSecond),
        '-maxrate',
        String(bitsPerSecond * 2),
        '-bufsize',
        String(bitsPerSecond * 4),
      ]
    : ['-crf', '21'];

  const encoder =
    codec === 'libx264'
      ? ['-c:v', codec, '-preset', 'veryfast', ...rate]
      : ['-c:v', codec, ...rate];

  await runFfmpeg(
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      ...encoder,
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'avc1',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ],
    signal,
  );

  return output;
}
