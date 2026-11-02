import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ffmpeg from 'ffmpeg-static';
import { DownloadEngine } from '../core/engine.mjs';

test('direct adaptive tracks download separately and complete as audible MP4',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-direct-pair-'));
  const run=promisify(execFile);
  await run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','1','-an','-c:v','libx264',path.join(root,'video.mp4')],{windowsHide:true});
  await run(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1','-c:a','aac',path.join(root,'audio.m4a')],{windowsHide:true});
  const server=http.createServer(async(req,res)=>{try{const bytes=await fs.readFile(path.join(root,path.basename(req.url)));res.setHeader('content-length',bytes.length);res.end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const engine=await new DownloadEngine({dataDirectory:path.join(root,'state'),downloadDirectory:path.join(root,'out'),tickMs:20}).init();
  t.after(async()=>{await engine.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  await engine.add({url:base+'/video.mp4',audioUrl:base+'/audio.m4a',filename:'Captured.mp4',outputFormat:'mp4'});
  const d=engine.downloads[0],end=Date.now()+15000;
  while(!['complete','error'].includes(d.status)&&Date.now()<end)await delay(25);
  assert.equal(d.status,'complete',d.error);assert.equal(d.kind,'paired');assert.equal(d.total,(await fs.stat(d.path)).size);
  await run(ffmpeg,['-v','error','-i',d.path,'-map','0:v:0','-map','0:a:0','-f','null','-'],{windowsHide:true});
});

test('separate HLS video and audio produce an MP4 with both decodable tracks', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-mux-'));
  const run=promisify(execFile);
  const engine=await new DownloadEngine({dataDirectory:path.join(root,'state'),downloadDirectory:path.join(root,'out'),tickMs:20}).init();
  const server=http.createServer(async (req,res)=>{
    if(req.url==='/master.m3u8') return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="audio"\nvideo.m3u8');
    if(req.url.endsWith('.m3u8')) return res.end(`#EXTM3U\n#EXTINF:1,\n${req.url.startsWith('/audio')?'audio.aac':'video.ts'}\n#EXT-X-ENDLIST`);
    try { res.end(await fs.readFile(path.join(root,path.basename(req.url)))); }catch{res.writeHead(404);res.end();}
  });
  t.after(async()=>{await engine.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
  await run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','1','-an','-c:v','libx264','-f','mpegts',path.join(root,'video.ts')],{windowsHide:true});
  await run(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1','-c:a','aac','-f','adts',path.join(root,'audio.aac')],{windowsHide:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await engine.add({url:`http://127.0.0.1:${server.address().port}/master.m3u8`});
  const d=engine.downloads[0]; const end=Date.now()+15000;
  while(!['complete','error'].includes(d.status)&&Date.now()<end)await delay(25);
  assert.equal(d.status,'complete',d.error);assert.match(d.filename,/\.mp4$/);
  await run(ffmpeg,['-v','error','-i',d.path,'-map','0:v:0','-map','0:a:0','-f','null','-'],{windowsHide:true});
  await engine.add({url:`http://127.0.0.1:${server.address().port}/audio.m3u8`,outputFormat:'mp3'});
  const audio=engine.downloads[1];const audioEnd=Date.now()+10000;
  while(!['complete','error'].includes(audio.status)&&Date.now()<audioEnd)await delay(25);
  assert.equal(audio.status,'complete',audio.error);assert.match(audio.filename,/\.mp3$/);
  await run(ffmpeg,['-v','error','-i',audio.path,'-map','0:a:0','-f','null','-'],{windowsHide:true});
});
