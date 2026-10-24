import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import ffmpeg from 'ffmpeg-static';

export function youtubeUrl(value) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password)return null;
    const host=u.hostname.toLowerCase();
    const id=host==='youtu.be'?u.pathname.slice(1):['youtube.com','www.youtube.com','m.youtube.com'].includes(host)?(u.pathname==='/watch'?u.searchParams.get('v'):/^\/(shorts|embed)\/([^/]+)$/.exec(u.pathname)?.[2]):null;
    return /^[\w-]{11}$/.test(id||'')?'https://www.youtube.com/watch?v='+id:null;
  }catch{return null;}
}
export function choicesFromInfo(info,url) {
  if(info.is_live||info.live_status==='is_live')throw new Error('Live YouTube streams are not supported yet.');
  const formats=(info.formats||[]).filter(f=>!f.has_drm&&f.url&&['https','http','m3u8_native','m3u8'].includes(f.protocol));
  const audios=formats.filter(f=>f.vcodec==='none'&&f.acodec!=='none'&&f.ext==='m4a'&&!String(f.format_id).includes('drc')).sort((a,b)=>(b.abr||0)-(a.abr||0));
  const audio=audios[0];
  const groups=new Map();
  for(const f of formats.filter(f=>f.vcodec&&f.vcodec!=='none'&&f.ext==='mp4'&&f.height)) {
    if(f.acodec==='none'&&!audio)continue;
    const old=groups.get(f.height);
    // Prefer a direct H.264 stream at each height for Windows compatibility.
    const score=v=>(v.protocol==='https'?100:0)+(/^avc/.test(v.vcodec)?50:0)+(v.fps||0)/100;
    if(!old||score(f)>score(old))groups.set(f.height,f);
  }
  const title=String(info.title||'YouTube video').slice(0,180);
  const result=[...groups.values()].sort((a,b)=>b.height-a.height).map(f=>{
    const paired=f.acodec==='none';
    return {url,provider:'youtube',youtubeFormat:String(f.format_id)+(paired?'+'+audio.format_id:''),format:'MP4',quality:f.height+'p',fps:f.fps||0,audioState:'Video + audio',title,outputFormat:'mp4',estimatedSize:(f.filesize||f.filesize_approx||0)+(paired?(audio.filesize||audio.filesize_approx||0):0),duration:info.duration||0};
  });
  if(audio)result.push({url,provider:'youtube',youtubeFormat:'audio:'+audio.format_id,format:'MP3',quality:'',audioState:'Audio only',title,outputFormat:'mp3',duration:info.duration||0});
  if(!result.length)throw new Error('No downloadable video/audio formats were found. This video may require sign-in or may be unavailable.');
  return result;
}
function executable() {
  return process.versions.electron&&process.resourcesPath&&!process.defaultApp?path.join(process.resourcesPath,'tools','yt-dlp.exe'):fileURLToPath(new URL('../vendor/yt-dlp.exe',import.meta.url));
}
export function youtubeError(raw) {
  const message=String(raw);
  if(/HTTP Error 429|Too Many Requests/i.test(message))return Object.assign(new Error('YouTube is temporarily refusing requests (too many requests). Wait before trying again. Repeated clicks will not help; this app does not currently support YouTube sign-in verification.'),{code:'YOUTUBE_RATE_LIMIT',statusCode:429});
  if(/confirm.{0,20}not a bot|Sign in|login required|cookies-from-browser/i.test(message))return Object.assign(new Error('YouTube requires sign-in or browser verification for this request. The downloader cannot currently complete that verification.'),{code:'YOUTUBE_VERIFICATION',statusCode:422});
  const errorLine=message.split(/\r?\n/).findLast(line=>line.startsWith('ERROR:'))||message;
  return new Error(errorLine.replace(/https?:\/\/\S+/g,'[URL]').trim().slice(0,700)||'YouTube download failed.');
}
function run(args,{signal,onLine,timeout=120000}={}) {
  return new Promise((resolve,reject)=>{
    const env={...process.env};if(process.versions.electron)env.ELECTRON_RUN_AS_NODE='1';
    const child=spawn(executable(),['--ignore-config','--no-playlist','--no-colors','--js-runtimes','node:'+process.execPath,...args],{windowsHide:true,env,signal,stdio:['ignore','pipe','pipe']});
    let output='',error='',pending='',overflow=false;
    const timer=timeout?setTimeout(()=>{error='YouTube request timed out.';child.kill();},timeout):null;
    child.stdout.on('data',chunk=>{
      if(onLine){pending+=chunk;let at;while((at=pending.indexOf('\n'))>=0){onLine(pending.slice(0,at));pending=pending.slice(at+1);}if(pending.length>1048576){overflow=true;child.kill();}}
      else {output+=chunk;if(output.length>32*1024*1024){overflow=true;child.kill();}}
    });
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(signal?.aborted)return reject(signal.reason);if(code===0&&!overflow)resolve(output);else reject(youtubeError(overflow?'YouTube response exceeded its size limit.':error));});
  });
}
const cache=new Map();
let active=0;
let rateLimitUntil=0;
export async function youtubeFormats(input) {
  const url=youtubeUrl(input);if(!url)throw new Error('A valid YouTube video URL is required.');
  const existing=cache.get(url);if(existing&&existing.expires>Date.now())return existing.promise;
  if(Date.now()<rateLimitUntil)throw youtubeError('HTTP Error 429');
  if(active>=2)throw new Error('Already checking two videos. Try again shortly.');
  active++;
  const promise=run(['--skip-download','--dump-single-json',url],{timeout:45000}).then(raw=>choicesFromInfo(JSON.parse(raw),url)).finally(()=>{active--;});
  cache.set(url,{promise,expires:Date.now()+120000});if(cache.size>20)cache.delete(cache.keys().next().value);
  try{return await promise;}catch(e){
    if(e.code==='YOUTUBE_RATE_LIMIT')rateLimitUntil=Date.now()+120000;
    // Retain short-lived failures as well as successes to avoid repeated menu
    // clicks hammering the same video. This promise already has a rejection handler.
    const entry=cache.get(url);if(entry?.promise===promise)entry.expires=Date.now()+120000;
    throw e;
  }
}
export async function downloadYoutube({url,formatKey,directory,signal,onProgress,onMetadata,speedLimitKbps=0}) {
  const formats=await youtubeFormats(url);signal.throwIfAborted();
  const choice=formatKey?formats.find(f=>f.youtubeFormat===formatKey):formats.find(f=>f.format==='MP4');
  if(!choice)throw new Error('This YouTube format is no longer available. Refresh the video menu.');
  onMetadata?.(choice);
  const audio=choice.youtubeFormat.startsWith('audio:');
  const args=['--newline','--progress','--progress-delta','0.5','--progress-template','download:ADPROGRESS:%(progress)j','--ffmpeg-location',ffmpeg.replace('app.asar','app.asar.unpacked'),'-f',audio?choice.youtubeFormat.slice(6):choice.youtubeFormat,'-o',path.join(directory,'media.%(ext)s')];
  if(speedLimitKbps)args.push('--limit-rate',String(speedLimitKbps*1024));
  args.push(...(audio?['--extract-audio','--audio-format','mp3']:['--merge-output-format','mp4']),youtubeUrl(url));
  const finished=new Map();let completedBytes=0;
  await run(args,{signal,timeout:0,onLine:line=>{
    if(!line.startsWith('ADPROGRESS:'))return;
    try {
      const p=JSON.parse(line.slice(11));const key=p.filename||p.tmpfilename||'media';
      const downloaded=Number(p.downloaded_bytes)||0;
      if(p.status==='finished'&&!finished.has(key)){finished.set(key,downloaded);completedBytes+=downloaded;}
      const current=finished.has(key)?0:downloaded;
      onProgress?.({downloaded:completedBytes+current,total:choice.estimatedSize||null,speed:Number(p.speed)||0,status:p.status==='finished'?'assembling':'downloading',estimated:true});
    }catch{}
  }});
  const output=path.join(directory,'media.'+(audio?'mp3':'mp4'));
  const stat=await fs.stat(output);if(!stat.size)throw new Error('YouTube returned an empty file.');
  return {output,size:stat.size,choice};
}
