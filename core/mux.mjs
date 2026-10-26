import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Allow Linux users and packagers to point at a distribution FFmpeg when the
// bundled static build is missing or incompatible with the host system.
export function ffmpegExecutable() {
  return String(process.env.AWESOME_FFMPEG_PATH || ffmpegPath).replace('app.asar', 'app.asar.unpacked');
}

function mediaProcessError(action, code, stderr) {
  const detail = stderr || `media process exited ${code}`;
  // A signal (null exit code) usually means the bundled static build cannot run
  // on this distribution. Point users at the supported override.
  const hint = code === null && process.platform !== 'win32'
    ? ' The bundled FFmpeg crashed; install your distribution FFmpeg and set AWESOME_FFMPEG_PATH=/usr/bin/ffmpeg.'
    : '';
  return new Error(`Could not ${action}: ${detail}${hint}`);
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
  const executable = ffmpegExecutable();
  await new Promise((resolve,reject) => {
    const child = spawn(executable, ['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',path.join(directory,'video.track'),'-protocol_whitelist','file,pipe','-i',path.join(directory,'audio.track'),'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',output], {windowsHide:true,signal,stdio:['ignore','ignore','pipe']});
    let error=''; child.stderr.on('data', chunk => { error=(error+chunk).slice(-4096); });
    child.on('error',reject); child.on('close',code => code===0?resolve():reject(mediaProcessError('combine video and audio', code, error)));
  });
  return output;
}

export async function convertMedia(directory, files, format, signal) {
  if(!['mp4','mp3'].includes(format))throw new Error('Unsupported output format.');
  const source=path.join(directory,'conversion-source.track');
  const out=await fs.open(source,'w');
  try {for(const file of files){const input=await fs.open(file,'r');try{for await(const chunk of input.createReadStream()){signal.throwIfAborted();await out.writeFile(chunk);}}finally{await input.close();}}}finally{await out.close();}
  const output=path.join(directory,'converted.'+format);
  await new Promise((resolve,reject)=>{
    const args=['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',source];
    args.push(...(format==='mp3'?['-map','0:a:0','-vn','-c:a','libmp3lame','-q:a','2']:['-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart']),output);
    const child=spawn(ffmpegExecutable(),args,{windowsHide:true,signal,stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4096);});
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(mediaProcessError(`create ${format.toUpperCase()}`, code, error)));
  });
  return output;
}
