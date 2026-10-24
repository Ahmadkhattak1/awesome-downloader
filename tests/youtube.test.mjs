import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeUrl,choicesFromInfo,youtubeError} from '../core/youtube.mjs';
test('YouTube refusals explain rate limiting and verification without raw warnings or URLs',()=>{
  const rate=youtubeError('Deprecated Feature: Python\nHTTP Error 429: Too Many Requests\nSign in to confirm you are not a bot');
  assert.equal(rate.statusCode,429);assert.equal(rate.code,'YOUTUBE_RATE_LIMIT');assert.doesNotMatch(rate.message,/Python/);
  assert.equal(youtubeError('Sign in to confirm you are not a bot').statusCode,422);
  assert.equal(youtubeError('WARNING: old runtime\nERROR: failed https://secret.test/?token=secret').message,'ERROR: failed [URL]');
});
import {streamProgress} from '../core/stream-progress.mjs';
test('YouTube resolver accepts only canonical public video URL shapes',()=>{
  assert.equal(youtubeUrl('https://youtu.be/wLdZWyLOJCI'),'https://www.youtube.com/watch?v=wLdZWyLOJCI');
  for(const url of ['https://youtube.com.evil.test/watch?v=wLdZWyLOJCI','file:///secret','https://youtube.com/s/search/audio/no_input.mp3','https://user:secret@youtube.com/watch?v=wLdZWyLOJCI'])assert.equal(youtubeUrl(url),null);
});
test('YouTube formats pair audio, collapse duplicate quality and omit storyboards/DRM',()=>{
  const formats=[
    {format_id:'140',ext:'m4a',vcodec:'none',acodec:'mp4a',abr:128,url:'https://cdn/audio',protocol:'https',filesize:20},
    {format_id:'137',ext:'mp4',vcodec:'avc1',acodec:'none',height:1080,url:'https://cdn/video',protocol:'https',filesize:100},
    {format_id:'270',ext:'mp4',vcodec:'avc1',acodec:'none',height:1080,url:'https://cdn/hls',protocol:'m3u8'},
    {format_id:'secret',ext:'mp4',vcodec:'avc1',acodec:'none',height:2160,url:'https://cdn/drm',protocol:'https',has_drm:true},
    {format_id:'sb0',ext:'mhtml',vcodec:'images',url:'https://cdn/images',protocol:'mhtml'}];
  const choices=choicesFromInfo({title:'Test',formats},'https://www.youtube.com/watch?v=wLdZWyLOJCI');
  assert.equal(choices.length,2);assert.equal(choices[0].youtubeFormat,'137+140');assert.equal(choices[0].estimatedSize,120);assert.equal(choices[1].format,'MP3');
  assert.throws(()=>choicesFromInfo({formats:[],is_live:true},''),/Live/);
});
test('stream progress uses measured segments without inventing an exact file size',()=>{
  assert.equal(streamProgress([{done:true,downloaded:10}]).estimatedBytes,null);
  assert.deepEqual(streamProgress([{done:true,downloaded:10},{done:true,downloaded:30},{done:false,downloaded:2}]),{completed:2,total:3,estimatedBytes:60});
});
