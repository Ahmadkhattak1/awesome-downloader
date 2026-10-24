const test=require('node:test');const assert=require('node:assert/strict');const {parseHlsMaster}=require('./hls.js');
test('HLS master uses actual resolution bandwidth codecs and relative variants',()=>{
  const items=parseHlsMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n720/video.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1920x1080\nhttps://cdn.example/high.m3u8','https://example.com/master.m3u8');
  assert.equal(items.length,2);assert.equal(items[0].url,'https://example.com/720/video.m3u8');assert.equal(items[0].quality,'720p');assert.equal(items[0].codecs,'avc1.64001f,mp4a.40.2');assert.equal(items[1].bitrate,2000000);
});
test('HLS separate audio is paired with video and missing resolution is not guessed',()=>{
  const [item]=parseHlsMaster('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,AUDIO="audio"\n1080.m3u8','https://example.com/master.m3u8');
  assert.equal(item.quality,'');assert.equal(item.separateAudio,true);assert.equal(item.unsupported,false);assert.equal(item.audioUrl,'https://example.com/audio.m3u8');
});
test('HLS parsing is bounded, rejects non-playlists, and retains VOD leaf identity',()=>{
  assert.throws(()=>parseHlsMaster('x'.repeat(1048577),'https://example.com/a'));assert.throws(()=>parseHlsMaster('not a playlist','https://example.com/a'));
  const master='#EXTM3U\n'+Array.from({length:25},(_,i)=>`#EXT-X-STREAM-INF:BANDWIDTH=100\n${i}.m3u8`).join('\n');
  assert.equal(parseHlsMaster(master,'https://example.com/a').length,20);
  assert.equal(parseHlsMaster('#EXTM3U\n#EXTINF:5,\nchunk.ts\n#EXT-X-ENDLIST','https://example.com/vod.m3u8')[0].url,'https://example.com/vod.m3u8');
});
