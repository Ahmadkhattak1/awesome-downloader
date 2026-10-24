const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const http=require('node:http');
const {MessageDecoder,encodeMessage,sanitizeRequest,submitDownload,readBridge}=require('./native-host.cjs');
test('format discovery is restricted to YouTube video pages and format IDs are not commands',()=>{
  assert.equal(sanitizeRequest({action:'formats',url:'https://www.youtube.com/watch?v=wLdZWyLOJCI'}).action,'formats');
  assert.throws(()=>sanitizeRequest({action:'formats',url:'https://example.com'}));
  assert.throws(()=>sanitizeRequest({action:'download',url:'https://www.youtube.com/watch?v=wLdZWyLOJCI',youtubeFormat:'--exec evil'}));
});
test('default bridge location is shared with browsers outside AppData virtualization',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'shared-bridge-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  t.mock.method(os,'homedir',()=>root);
  await fs.mkdir(path.join(root,'.awesome-downloader'));
  const config={port:17843,token:'test-token-with-at-least-twenty-characters'};
  await fs.writeFile(path.join(root,'.awesome-downloader','bridge.json'),JSON.stringify(config));
  assert.deepEqual(readBridge(),config);
});
test('one-click intent is preserved only for an explicit boolean',()=>{
  const request={action:'download',url:'https://example.com/video.mp4'};
  assert.equal(sanitizeRequest({...request,startNow:true}).startNow,true);
  for(const value of [undefined,false,'true',1]) assert.equal(sanitizeRequest({...request,startNow:value}).startNow,undefined);
});
test('native framing accepts fragmentation and multiple messages',async()=>{
  const decoder=new MessageDecoder(), messages=[]; decoder.on('data',v=>messages.push(v));
  const data=Buffer.concat([encodeMessage({text:'héllo'}),encodeMessage({second:true})]);
  decoder.write(data.subarray(0,2)); decoder.write(data.subarray(2,9)); decoder.end(data.subarray(9));
  await once(decoder,'end'); assert.deepEqual(messages,[{text:'héllo'},{second:true}]);
});
test('native framing rejects oversize and truncated input',async()=>{
  const decoder=new MessageDecoder(); decoder.resume(); const error=once(decoder,'error');
  const header=Buffer.alloc(4); header.writeUInt32LE(1024*1024+1); decoder.end(header);
  assert.match((await error)[0].message,/size/);
  const truncated=new MessageDecoder(); truncated.resume(); const shortError=once(truncated,'error'); truncated.end(Buffer.from([1,0]));
  assert.match((await shortError)[0].message,/Truncated/);
});
test('native framing rejects JSON primitives and arrays',async()=>{
  for(const value of [null,42,'text',[]]) {
    const decoder=new MessageDecoder(); decoder.resume(); const error=once(decoder,'error'); decoder.end(encodeMessage(value));
    assert.match((await error)[0].message,/must be an object/);
  }
});
test('request validation restricts URL, filenames, actions and passed fields',()=>{
  assert.deepEqual(sanitizeRequest({action:'download',url:'https://example.com/file',headers:{Cookie:'secret'},command:'bad'}),{url:'https://example.com/file'});
  for(const item of [{action:'execute',url:'https://example.com'},{action:'download',url:'file:///c:/x'},{action:'download',url:'https://user:pass@example.com'},{action:'download',url:'https://example.com',filename:'../x'},{action:'download',url:'https://example.com/a.mpd'}]) assert.throws(()=>sanitizeRequest(item));
  assert.equal(sanitizeRequest({action:'download',url:'https://example.com/a.m3u8'}).url,'https://example.com/a.m3u8');
});
test('desktop handoff authenticates, sends fields, and requires acceptance',async()=>{
  let rejectRequest=false;
  const server=http.createServer((request,response)=>{
    assert.equal(request.url,'/downloads'); assert.equal(request.method,'POST');
    assert.equal(request.headers.authorization,'Bearer test-token');
    let body=''; request.on('data',chunk=>body+=chunk); request.on('end',()=>{
      assert.deepEqual(JSON.parse(body),{url:'https://example.com/file'});
      response.writeHead(rejectRequest ? 503 : 201,{'Content-Type':'application/json'});
      response.end(JSON.stringify(rejectRequest ? {error:'busy'} : {ok:true,id:'accepted'}));
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const config={port:server.address().port,token:'test-token'};
    assert.deepEqual(await submitDownload({url:'https://example.com/file'},config),{ok:true,id:'accepted'});
    rejectRequest=true;
    await assert.rejects(submitDownload({url:'https://example.com/file'},config),/busy \(503\)/);
  } finally { server.close(); }
});

test('captured request context allows only bounded safe headers and audio URLs',()=>{
  const value=sanitizeRequest({action:'download',url:'https://example.com/video.m3u8',audioUrl:'https://example.com/audio.m3u8',requestHeaders:{cookie:'session=test','user-agent':'Browser','authorization':'Bearer test',host:'evil.test',origin:'bad\r\nInjected: true'}});
  assert.deepEqual(value.headers,{cookie:'session=test',authorization:'Bearer test','user-agent':'Browser'});
  assert.equal(value.audioUrl,'https://example.com/audio.m3u8');
  assert.throws(()=>sanitizeRequest({action:'download',url:'https://example.com/a',audioUrl:'file:///secret'}));
});
test('SABR handoff accepts only a bounded captured GoogleVideo session',()=>{
  const url='https://r1.googlevideo.com/videoplayback?id=asset&sabr=1';
  const sabr={videoId:'wLdZWyLOJCI',serverAbrStreamingUrl:url,videoPlaybackUstreamerConfig:'AQID',clientInfo:{clientName:1,clientVersion:'2.20261022.00.00'},requestBody:'AQID',videoItag:137,audioItag:140,formats:[
    {itag:137,mimeType:'video/mp4; codecs="avc1"',height:1080,qualityLabel:'1080p',bitrate:3000000,lastModified:'1',approxDurationMs:'10000'},
    {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,lastModified:'1',approxDurationMs:'10000'}
  ]};
  const value=sanitizeRequest({action:'download',url,sabr,outputFormat:'mp4'});assert.equal(value.sabr.videoItag,137);assert.equal(value.sabr.requestBody,'AQID');
  const mixed={...sabr,formats:[...sabr.formats,{itag:248,mimeType:'video/webm; codecs="vp9"',bitrate:2000000,xtags:'lang=en:acont=original'},{itag:251,mimeType:'audio/webm; codecs="opus"',bitrate:128000}]};
  assert.equal(sanitizeRequest({action:'download',url,sabr:mixed}).sabr.formats.length,4);
  assert.throws(()=>sanitizeRequest({action:'download',url,sabr:{...sabr,formats:[...sabr.formats,{itag:999,mimeType:'text/html',bitrate:1}]}}));
  assert.throws(()=>sanitizeRequest({action:'download',url,sabr:{...sabr,serverAbrStreamingUrl:'https://googlevideo.com.evil.test/videoplayback?sabr=1'}}));
  assert.throws(()=>sanitizeRequest({action:'download',url,sabr:{...sabr,audioItag:999}}));
});
