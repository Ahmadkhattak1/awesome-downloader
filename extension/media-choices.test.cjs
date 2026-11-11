const test=require('node:test'),assert=require('node:assert/strict');
const {mediaChoices}=require('./media-choices.js');
test('choices keep only the matching tweet and deduplicate paired audio',()=>{
  const base='https://video.twimg.com/amplify_video/123/';
  const audioUrl=base+'audio.m3u8';
  const items=[{url:base+'720.m3u8',format:'HLS',quality:'720p',audioUrl,masterUrl:base+'master.m3u8'},
    {url:base+'360.m3u8',format:'HLS',quality:'360p',audioUrl,masterUrl:base+'master.m3u8'},
    {url:audioUrl,format:'HLS'}, {url:base+'init.mp4'},
    {url:'https://video.twimg.com/amplify_video/456/other.mp4'}];
  const choices=mediaChoices(items,{poster:'https://pbs.twimg.com/amplify_video_thumb/123/img/a.jpg'});
  assert.equal(choices.length,3);
  assert.equal(choices.filter(i=>i.format==='MP3').length,1);
  assert.equal(choices.filter(i=>i.audioState==='Video + audio').length,2);
});
test('a magnet link is offered as a torrent choice without media audio metadata',()=>{
  const magnet='magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Sample';
  const choices=mediaChoices([{url:magnet,format:'Torrent',title:'Sample'},{url:'https://example.com/a.m4s'}],{});
  assert.equal(choices.length,1);
  assert.equal(choices[0].url,magnet);
  assert.equal(choices[0].format,'Torrent');
  assert.equal(choices[0].audioState,'BitTorrent');
});
