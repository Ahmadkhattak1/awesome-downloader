import { promises as fs } from 'node:fs';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';

const googleVideoSabr=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||!(url.hostname==='googlevideo.com'||url.hostname.endsWith('.googlevideo.com'))||url.pathname!=='/videoplayback'||url.searchParams.get('sabr')!=='1'||url.username||url.password)throw new Error('Invalid YouTube SABR URL.');
  return url.href;
};
export function normalizeSabrSession(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||!/^[\w-]{11}$/.test(value.videoId||''))throw new Error('Invalid YouTube SABR session.');
  const serverAbrStreamingUrl=googleVideoSabr(value.serverAbrStreamingUrl);
  if(typeof value.videoPlaybackUstreamerConfig!=='string'||!value.videoPlaybackUstreamerConfig||value.videoPlaybackUstreamerConfig.length>131072)throw new Error('Missing YouTube streaming configuration.');
  if(!Array.isArray(value.formats)||!value.formats.length||value.formats.length>150)throw new Error('Missing YouTube SABR formats.');
  const audioItag=Number(value.audioItag), videoItag=value.videoItag===undefined?undefined:Number(value.videoItag);
  // An itag is shared by dubbed languages, DRC and voice-boost variants.
  // Keep precisely the chosen default audio and video, not every matching itag.
  const audioCandidates=value.formats.filter(f=>f.itag===audioItag&&/^audio\/mp4/i.test(f.mimeType)&&!f.isDrc&&!f.isVb);
  const audioRaw=audioCandidates.find(f=>f.audioTrack?.audioIsDefault)||audioCandidates.find(f=>!f.audioTrack)||audioCandidates[0];
  const videoRaw=videoItag===undefined?undefined:value.formats.find(f=>f.itag===videoItag&&/^video\/mp4/i.test(f.mimeType));
  const formats=[videoRaw,audioRaw].filter(Boolean).map(f=>({...f,...buildSabrFormat(f),audioTrack:f.audioTrack}));
  if(!Number.isSafeInteger(audioItag)||!formats.some(f=>f.itag===audioItag&&f.hasAudio))throw new Error('The selected YouTube audio track is unavailable.');
  if(videoItag!==undefined&&(!Number.isSafeInteger(videoItag)||!formats.some(f=>f.itag===videoItag&&f.hasVideo)))throw new Error('The selected YouTube video track is unavailable.');
  let seed,requestBody;
  if(value.requestBody!==undefined){
    if(typeof value.requestBody!=='string'||value.requestBody.length>350000||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.requestBody))throw new Error('Invalid YouTube SABR request context.');
    requestBody=Buffer.from(value.requestBody,'base64');if(!requestBody.length||requestBody.length>262144)throw new Error('Invalid YouTube SABR request context.');
    try{seed=VideoPlaybackAbrRequest.decode(requestBody);}catch{throw new Error('The captured YouTube SABR request context is unreadable.');}
  }
  const capturedClient=seed?.streamerContext?.clientInfo;
  const clientInfo={clientName:Number(capturedClient?.clientName||value.clientInfo?.clientName)||1,clientVersion:String(capturedClient?.clientVersion||value.clientInfo?.clientVersion||''),hl:capturedClient?.hl,deviceMake:capturedClient?.deviceMake,deviceModel:capturedClient?.deviceModel,osName:capturedClient?.osName,osVersion:capturedClient?.osVersion};
  const poToken=seed?.streamerContext?.poToken?.length?Buffer.from(seed.streamerContext.poToken).toString('base64'):undefined;
  return {videoId:value.videoId,serverAbrStreamingUrl,videoPlaybackUstreamerConfig:value.videoPlaybackUstreamerConfig,clientInfo,formats,videoItag,audioItag,requestBody:value.requestBody,poToken};
}
async function writeReadable(readable,file,signal,onChunk) {
  const output=await fs.open(file,'w');
  const reader=readable.getReader();
  try {
    for(;;){
      signal.throwIfAborted();
      const {done,value}=await reader.read();
      if(done)break;
      const chunk=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
      await output.writeFile(chunk);onChunk(chunk.length);
    }
    await output.sync();
  } finally {reader.releaseLock();await output.close();}
}
export async function downloadSabr({session,headers={},videoPath,audioPath,signal,onProgress=()=>{}}) {
  const selected=normalizeSabrSession(session);
  let networkDownloaded=0,downloaded=0;
  const tracks={};
  let total=null;
  const report=()=>onProgress({downloaded,total,networkDownloaded,tracks:{...tracks}});
  const commonHeaders={};
  for(const [name,value] of Object.entries(headers||{}))if(typeof value==='string'&&value)commonHeaders[name]=value;
  const fetchFunction=async(input,init={})=>{
    const merged=new Headers(init.headers||{});
    for(const [name,value] of Object.entries(commonHeaders))if(!merged.has(name))merged.set(name,value);
    const response=await fetch(input,{...init,headers:merged,redirect:'follow'});
    if(!response.body||!response.ok)return response;
    const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){networkDownloaded+=chunk.byteLength;report();controller.enqueue(chunk);}}));
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  const sabr=new SabrStream({
    videoId:selected.videoId,serverAbrStreamingUrl:selected.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig:selected.videoPlaybackUstreamerConfig,clientInfo:selected.clientInfo,
    formats:selected.formats,fetchFunction,poToken:selected.poToken
  });
  const audioFormat=selected.formats.find(f=>f.itag===selected.audioItag);
  const videoFormat=selected.videoItag===undefined?undefined:selected.formats.find(f=>f.itag===selected.videoItag);
  const selectedTracks=[videoFormat,audioFormat].filter(Boolean);
  total=selectedTracks.every(f=>Number(f.contentLength)>0)?selectedTracks.reduce((sum,f)=>sum+Number(f.contentLength),0):null;
  const progress=itag=>bytes=>{downloaded+=bytes;tracks[itag]=(tracks[itag]||0)+bytes;report();};
  const abort=()=>{void sabr.abort().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    const streams=sabr.start({audioFormat:selected.audioItag,videoFormat:selected.videoItag,enabledTrackTypes:selected.videoItag===undefined?EnabledTrackTypes.AUDIO_ONLY:EnabledTrackTypes.VIDEO_AND_AUDIO,isPostLiveDvr:false});
    const writes=[writeReadable(streams.audioStream,audioPath,signal,progress(selected.audioItag))];
    if(selected.videoItag!==undefined)writes.push(writeReadable(streams.videoStream,videoPath,signal,progress(selected.videoItag)));
    try {await Promise.all(writes);} catch(error){await sabr.abort().catch(()=>{});throw error;}
    return {downloaded,total,audioPath,videoPath:selected.videoItag===undefined?undefined:videoPath,duration:Math.max(Number(audioFormat.approxDurationMs)||0,Number(videoFormat?.approxDurationMs)||0)/1000};
  } finally {signal.removeEventListener('abort',abort);}
}
