import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { normalizeSabrSession } from '../core/sabr.mjs';

test('captured SABR protobuf supplies browser client identity and proof token',()=>{
  const body=VideoPlaybackAbrRequest.encode({initializationFormatIds:[],bufferedRanges:[],selectedAudioFormatIds:[],selectedVideoFormatIds:[],selectedCaptionFormatIds:[],ssapPlaybackInfos:[],field1000:[],streamerContext:{clientInfo:{clientName:1,clientVersion:'2.20261022.00.00'},poToken:Uint8Array.from([7,8,9]),sabrContexts:[],unsentSabrContexts:[]}}).finish();
  const value=normalizeSabrSession({videoId:'wLdZWyLOJCI',serverAbrStreamingUrl:'https://r1.googlevideo.com/videoplayback?id=asset&sabr=1',videoPlaybackUstreamerConfig:'AQID',requestBody:Buffer.from(body).toString('base64'),clientInfo:{clientName:1,clientVersion:''},videoItag:137,audioItag:140,formats:[
    {itag:137,mimeType:'video/mp4; codecs="avc1"',height:1080,qualityLabel:'1080p',bitrate:3000000,lastModified:'1',approxDurationMs:'10000'},
    {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,lastModified:'1',approxDurationMs:'10000'}
  ]});
  assert.equal(value.clientInfo.clientVersion,'2.20261022.00.00');assert.equal(value.poToken,'BwgJ');assert.equal(value.formats.find(format=>format.itag===140).hasAudio,true);
});

test('one default audio variant and one video survive repeated normalization',()=>{
  const audio={itag:140,mimeType:'audio/mp4',audioQuality:'AUDIO_QUALITY_MEDIUM',contentLength:'100',lastModified:'1'};
  const session={videoId:'wLdZWyLOJCI',serverAbrStreamingUrl:'https://r1.googlevideo.com/videoplayback?sabr=1',videoPlaybackUstreamerConfig:'AQID',audioItag:140,videoItag:137,formats:[
    {...audio,audioTrack:{id:'dubbed',audioIsDefault:false}},
    {...audio,isDrc:true,audioTrack:{id:'default',audioIsDefault:true}},
    {...audio,audioTrack:{id:'default',audioIsDefault:true}},
    {itag:137,mimeType:'video/mp4',qualityLabel:'1080p',contentLength:'900',lastModified:'1'}
  ]};
  const first=normalizeSabrSession(session),second=normalizeSabrSession(first);
  for(const result of [first,second]){
    assert.equal(result.formats.length,2);
    assert.equal(result.formats.find(f=>f.hasAudio).audioTrackId,'default');
    assert.equal(result.formats.reduce((sum,f)=>sum+Number(f.contentLength),0),1000);
  }
});
