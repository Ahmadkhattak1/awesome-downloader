const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function harness() {
  const events={}, nativeRequests=[];
  const event=name=>({addListener(fn){events[name]=fn;}});
  const data={};
  const storage={async get(key){return structuredClone({[key]:data[key]});},async set(value){Object.assign(data,structuredClone(value));},async remove(key){delete data[key];}};
  const browser={runtime:{id:'extension-id',onMessage:event('message'),onInstalled:event('installed'),async sendNativeMessage(host,payload){nativeRequests.push(structuredClone(payload));return {ok:true};}},storage:{session:storage,local:storage},webRequest:{onHeadersReceived:event('response'),onBeforeRequest:event('beforeRequest'),onBeforeSendHeaders:event('requestHeaders')},tabs:{onRemoved:event('removed'),onUpdated:event('updated')},contextMenus:{onClicked:event('context'),async removeAll(){},create(){}},downloads:{onCreated:event('download')},action:{}};
  browser.tabs.sendMessage=async()=>({ok:true});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),{browser,URL,URLSearchParams,Uint8Array,btoa:value=>Buffer.from(value,'binary').toString('base64'),youtubeMedia:require('./youtube-media.js')});
  return {events,data,nativeRequests,request(message,sender){return new Promise(resolve=>{const accepted=events.message(message,sender,resolve);if(accepted!==true)resolve(undefined);});}};
}
test('video selection forwards explicit one-click download intent',async()=>{
  const h=harness(),sender={id:'extension-id',tab:{id:3}};
  await h.request({action:'download',item:{url:'https://example.com/video.mp4',startNow:true}},sender);
  assert.equal(h.nativeRequests[0].startNow,true);
  await h.request({action:'download',item:{url:'https://example.com/video.mp4'}},sender);
  assert.equal(h.nativeRequests[1].startNow,false);
});
test('YouTube menu uses captured player formats without a desktop discovery request',async()=>{
 const h=harness(),sender={id:'extension-id',tab:{id:7,url:'https://www.youtube.com/watch?v=wLdZWyLOJCI'}};
 const base='https://r1.googlevideo.com/videoplayback?id=asset&expire=9999999999&itag=';
 await h.request({action:'playerResponse',data:{videoId:'wLdZWyLOJCI',title:'Captured',formats:[{itag:137,url:base+137,mimeType:'video/mp4',height:1080},{itag:140,url:base+140,mimeType:'audio/mp4'}]}},sender);
 const result=await h.request({action:'listForFrame'},sender);
 assert.equal(result.items[0].audioUrl,base+140);assert.equal(h.nativeRequests.length,0);
 await h.request({action:'download',item:{...result.items[0],startNow:true}},sender);
 assert.equal(h.nativeRequests[0].url,base+137);assert.equal(h.nativeRequests[0].audioUrl,base+140);
 const other=await h.request({action:'listForFrame'},{...sender,tab:{...sender.tab,url:'https://www.youtube.com/watch?v=abcdefghijk'}});
 assert.equal(other.items.length,0);
});
test('captured SABR request context is handed to the desktop with the selected tracks',async()=>{
 const h=harness(),sender={id:'extension-id',tab:{id:8,url:'https://www.youtube.com/watch?v=wLdZWyLOJCI'}};
 const stream='https://r1.googlevideo.com/videoplayback?id=asset&sabr=1&expire=9999999999';
 await h.request({action:'playerResponse',data:{videoId:'wLdZWyLOJCI',title:'Captured',sabr:true,sabrUrl:stream,ustreamerConfig:'AQID',clientName:1,clientVersion:'2.20261022.00.00',formats:[
  {itag:137,mimeType:'video/mp4; codecs="avc1"',height:1080,qualityLabel:'1080p',bitrate:3000000,lastModified:'1',approxDurationMs:'10000'},
  {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,lastModified:'1',approxDurationMs:'10000'}
 ]}},sender);
 h.events.beforeRequest({requestId:'success',tabId:8,url:stream,requestBody:{raw:[{bytes:Uint8Array.from([1,2,3]).buffer}]}});
 h.events.response({requestId:'success',tabId:8,url:stream,statusCode:200,type:'xmlhttprequest',responseHeaders:[{name:'Content-Type',value:'application/vnd.yt-ump'}]});
 // A later in-flight or rejected request must not replace the successful body.
 h.events.beforeRequest({requestId:'pending',tabId:8,url:stream+'&seq=2',requestBody:{raw:[{bytes:Uint8Array.from([4,5,6]).buffer}]}});
 const item=(await h.request({action:'listForFrame'},sender)).items.find(value=>value.quality==='1080p');assert.ok(item);
 await h.request({action:'download',item:{...item,startNow:true}},sender);
 assert.equal(h.nativeRequests[0].sabr.videoItag,137);assert.equal(h.nativeRequests[0].sabr.audioItag,140);assert.equal(h.nativeRequests[0].sabr.requestBody,'AQID');
 assert.equal(h.nativeRequests[0].sabr.serverAbrStreamingUrl,stream);
 h.events.response({requestId:'pending',tabId:8,url:stream+'&seq=2',statusCode:403});
 await h.request({action:'download',item:{...item,startNow:true}},sender);
 assert.equal(h.nativeRequests[1].sabr.requestBody,'AQID');
 h.events.updated(8,{status:'loading'});
 const rejected=await h.request({action:'download',item:{...item,startNow:true}},sender);
 assert.equal(rejected.ok,false);assert.equal(h.nativeRequests.length,2);
});
test('observing a video-only leaf never erases its master audio pairing',async()=>{
  const h=harness(),sender={id:'extension-id',tab:{id:3}};
  const url='https://example.com/video.m3u8';
  await h.request({action:'remember',items:[{url,format:'HLS',quality:'720p',audioUrl:'https://example.com/audio.m3u8',masterUrl:'https://example.com/master.m3u8',codecs:'avc1,mp4a'}]},sender);
  await h.request({action:'remember',items:[{url,format:'HLS'}]},sender);
  const item=(await h.request({action:'listForFrame'},sender)).items[0];
  assert.equal(item.audioUrl,'https://example.com/audio.m3u8');
  assert.equal(item.masterUrl,'https://example.com/master.m3u8');
});
test('frame list is restricted to its sender tab and excludes non-media links',async()=>{
  const h=harness();
  await h.request({action:'remember',items:[{url:'https://example.com/a.mp4'},{url:'https://example.com/page'},{url:'https://example.com/a.mpd'}]},{id:'extension-id',tab:{id:3}});
  await h.request({action:'remember',items:[{url:'https://private.example/other.mp4'}]},{id:'extension-id',tab:{id:4}});
  const result=await h.request({action:'listForFrame',tabId:4},{id:'extension-id',tab:{id:3}});
  assert.equal(result.items.length,2); assert.equal(result.items[0].url,'https://example.com/a.mp4'); assert.equal(result.items[1].unsupported,true);
  assert.equal(await h.request({action:'listForFrame'},{id:'foreign',tab:{id:3}}),undefined);
  assert.equal((await h.request({action:'listForFrame'},{id:'extension-id'})).ok,false);
});

test('request credentials stay out of storage and cannot cross tab or URL boundaries',async()=>{
  const h=harness(),url='https://example.com/video.mp4';
  h.events.requestHeaders({tabId:3,url,requestHeaders:[{name:'Cookie',value:'session=test-only'}]});
  await h.request({action:'download',item:{url}},{id:'extension-id',tab:{id:3}});
  assert.equal(h.nativeRequests[0].requestHeaders.cookie,'session=test-only');
  await h.request({action:'download',item:{url}},{id:'extension-id',tab:{id:4}});
  assert.equal(h.nativeRequests[1].requestHeaders,undefined);
  assert.equal(JSON.stringify(h.data).includes('session=test-only'),false);
  h.events.updated(3,{status:'loading'});
  await h.request({action:'download',item:{url}},{id:'extension-id',tab:{id:3}});
  assert.equal(h.nativeRequests[2].requestHeaders,undefined);
});

test('individual HLS media fragments are not listed as complete videos',async()=>{
  const h=harness(),sender={id:'extension-id',tab:{id:3}};
  await h.request({action:'remember',items:['a.m4s','a.ts','init.mp4','movie.mp4'].map(name=>({url:'https://example.com/'+name}))},sender);
  const result=await h.request({action:'listForFrame'},sender);
  assert.equal(result.items.length,1);assert.equal(result.items[0].url,'https://example.com/movie.mp4');
});
test('media cache is bounded, deduplicated, and cleared on navigation',async()=>{
  const h=harness(),sender={id:'extension-id',tab:{id:9}};
  const items=Array.from({length:120},(_,i)=>({url:`https://example.com/${i}.mp4`}));
  await h.request({action:'remember',items:items.slice(0,80)},sender);
  await h.request({action:'remember',items:items.slice(60)},sender);
  let result=await h.request({action:'listForFrame'},sender);
  assert.equal(result.items.length,100); assert.equal(new Set(result.items.map(i=>i.url)).size,100);
  h.events.updated(9,{status:'loading'});
  result=await h.request({action:'listForFrame'},sender); assert.equal(result.items.length,0);
});
