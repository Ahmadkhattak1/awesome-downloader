import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { promises as fs, accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

function executableOnPath(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; }
    catch { /* Try the next directory. */ }
  }
  return null;
}

const unpacked = value => String(value).replace('app.asar', 'app.asar.unpacked');

// Ordered FFmpeg candidates. A user override always wins; otherwise the
// bundled binary is preferred, with the distribution's FFmpeg as a fallback on
// Linux because some fully static builds crash while demuxing MPEG-TS (HLS).
// Windows keeps using the bundled executable only.
function ffmpegCandidates() {
  const candidates = [];
  if (process.env.AWESOME_FFMPEG_PATH) candidates.push(process.env.AWESOME_FFMPEG_PATH);
  candidates.push(ffmpegPath);
  if (process.platform !== 'win32') {
    const system = executableOnPath('ffmpeg');
    if (system) candidates.push(system);
  }
  return [...new Set(candidates.filter(Boolean).map(unpacked))];
}

let workingExecutable = null;
export function ffmpegExecutable() {
  return workingExecutable || ffmpegCandidates()[0];
}

function mediaProcessError(action, code, stderr) {
  const detail = stderr || `media process exited ${code}`;
  // A null exit code means the process died from a signal (it crashed), which
  // on Linux usually points at an incompatible bundled static build.
  const hint = code === null && process.platform !== 'win32'
    ? ' The media process failed to run or crashed; install your distribution FFmpeg (it is used automatically as a fallback) or set AWESOME_FFMPEG_PATH to a working ffmpeg executable.'
    : '';
  return new Error(`Could not ${action}: ${detail}${hint}`);
}

function runMedia(executable, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal, stdio: ['ignore','ignore','pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code, terminatedBy) => resolve({ code, terminatedBy, stderr }));
  });
}

async function transcode(args, signal, action) {
  const candidates = ffmpegCandidates();
  const current = candidates.indexOf(workingExecutable);
  // Keep using the build that worked last, then try the rest.
  if (current > 0) candidates.unshift(...candidates.splice(current, 1));
  let last = null;
  for (const executable of candidates) {
    let result;
    try { result = await runMedia(executable, args, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      // A missing or non-executable candidate must not block the others.
      last = { code: null, stderr: error.message };
      continue;
    }
    if (result.code === 0) { workingExecutable = executable; return; }
    last = result;
    // Retry another build only when the process crashed (a signal). Ordinary
    // failures would repeat with the same input on any build.
    if (result.code !== null || signal?.aborted) break;
  }
  throw mediaProcessError(action, last?.code ?? null, last?.stderr);
}

export async function muxTracks(directory, videoCount, count, signal) {
  for (const [name, start, end] of [['video',0,videoCount],['audio',videoCount,count]]) {
    const output = await fs.open(path.join(directory, name+'.track'), 'w');
    try {
      for (let i=start;i<end;i++) {
        const input = await fs.open(path.join(directory, `${i}.part`), 'r');
        try { for await (const chunk of input.createReadStream()) { signal.throwIfAborted(); await output.writeFile(chunk); } }
        finally { await input.close(); }
      }
    } finally { await output.close(); }
  }
  const output = path.join(directory,'combined.mp4');
  await transcode(['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',path.join(directory,'video.track'),'-protocol_whitelist','file,pipe','-i',path.join(directory,'audio.track'),'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',output], signal, 'combine video and audio');
  return output;
}

export async function convertMedia(directory, files, format, signal) {
  if(!['mp4','mp3'].includes(format))throw new Error('Unsupported output format.');
  const source=path.join(directory,'conversion-source.track');
  const out=await fs.open(source,'w');
  try {for(const file of files){const input=await fs.open(file,'r');try{for await(const chunk of input.createReadStream()){signal.throwIfAborted();await out.writeFile(chunk);}}finally{await input.close();}}}finally{await out.close();}
  const output=path.join(directory,'converted.'+format);
  const args=['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',source];
  args.push(...(format==='mp3'?['-map','0:a:0','-vn','-c:a','libmp3lame','-q:a','2']:['-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart']),output);
  await transcode(args, signal, `create ${format.toUpperCase()}`);
  return output;
}
