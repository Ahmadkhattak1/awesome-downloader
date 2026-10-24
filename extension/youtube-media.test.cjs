const test=require('node:test');
const assert=require('node:assert/strict');
const {mediaUrl,playerData,choices}=require('./youtube-media.js');
const url=(itag,id='asset')=>`https://r1.googlevideo.com/videoplayback?id=${id}&itag=${itag}&expire=9999999999`;
const player=(formats)=>playerData({videoDetails:{videoId:'wLdZWyLOJCI',title:'Test video'},streamingData:{adaptiveFormats:formats}});
const audio={itag:140,url:url(140),mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:128000};
test('captured adaptive video is paired with audio, never silently offered alone',()=>{
 const video={itag:137,url:url(137),mimeType:'video/mp4; codecs="avc1"',height:1080};
 assert.deepEqual(choices(player([video])),[]);
 const result=choices(player([video,audio]));assert.equal(result[0].audioUrl,url(140));assert.equal(result[0].quality,'1080p');assert.equal(result[1].format,'MP3');
});
test('an observed resolved URL must match both asset and itag',()=>{
 const data=player([{itag:137,signatureCipher:new URLSearchParams({url:url(137),s:'unresolved'}).toString(),mimeType:'video/mp4',height:1080},audio]);
 assert.equal(choices(data,[url(137,'wrong')]).some(x=>x.format==='MP4'),false);
 assert.equal(choices(data,[url(137)+'&sig=resolved'])[0].format,'MP4');
});
test('reject fragments, lookalike hosts and signed partial ranges',()=>{
 assert.equal(mediaUrl('https://googlevideo.com.evil.test/videoplayback'),null);
 assert.equal(mediaUrl(url(137)+'&sq=2'),null);
 assert.equal(mediaUrl(url(137)+'&range=0-100&sparams=id,range'),null);
 assert.equal(new URL(mediaUrl(url(137)+'&range=0-100')).searchParams.has('range'),false);
});
test('expired formats and live/DRM tracks are not selectable',()=>{
 assert.equal(choices(player([{...audio,url:url(140).replace('9999999999','1')}])).length,0);
 assert.equal(choices(player([{...audio,drmFamilies:['widevine']}])).length,0);
 assert.equal(playerData({videoDetails:{videoId:'wLdZWyLOJCI',isLiveContent:true}}),null);
});
test('SABR metadata is detected without inventing downloadable URLs',()=>{
 const data=playerData({videoDetails:{videoId:'wLdZWyLOJCI'},streamingData:{serverAbrStreamingUrl:'https://r1.googlevideo.com/videoplayback?sabr=1',adaptiveFormats:[{itag:137,mimeType:'video/mp4',height:1080}]}});
 assert.equal(data.sabr,true);assert.deepEqual(choices(data),[]);
 assert.equal(mediaUrl(url(137)+'&sabr=1'),null);
});
test('SABR metadata produces real video plus audio choices when the browser session is complete',()=>{
 const stream='https://r1.googlevideo.com/videoplayback?id=asset&sabr=1&expire=9999999999';
 const data=playerData({videoDetails:{videoId:'wLdZWyLOJCI',title:'Captured'},streamingData:{serverAbrStreamingUrl:stream,adaptiveFormats:[
  {itag:137,mimeType:'video/mp4; codecs="avc1"',height:1080,qualityLabel:'1080p',bitrate:3000000,lastModified:'1',approxDurationMs:'10000'},
  {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,lastModified:'1',approxDurationMs:'10000'}
 ]},playerConfig:{mediaCommonConfig:{mediaUstreamerRequestConfig:{videoPlaybackUstreamerConfig:'AQID'}}}});
 const result=choices(data);assert.equal(result[0].quality,'1080p');assert.deepEqual(result[0].sabrSelection,{videoItag:137,audioItag:140});assert.equal(result.at(-1).format,'MP3');
});

test('SABR avoids unobserved direct URLs and does not treat muxed itags as adaptive',()=>{
 const data={...player([
  {itag:18,url:url(18),mimeType:'video/mp4; codecs="avc1, mp4a"',height:360,audioQuality:'AUDIO_QUALITY_LOW'},
  {itag:134,url:url(134),mimeType:'video/mp4; codecs="avc1"',height:360},audio
 ]),sabrUrl:'https://r1.googlevideo.com/videoplayback?id=asset&sabr=1',ustreamerConfig:'AQID'};
 const result=choices(data);
 assert.equal(result.filter(x=>x.format==='MP4').length,1);
 assert.deepEqual(result[0].sabrSelection,{videoItag:134,audioItag:140});
 assert.equal(choices(data,[url(18)])[0].url,url(18));
 assert.equal(choices(data,[url(18)])[0].sabrSelection,undefined);
});
