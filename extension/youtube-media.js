(function(root) {
  const MAX_URL=16384, MAX_FORMATS=150;
  const text=(value,max=200)=>String(value||'').slice(0,max);
  const integer=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:0;};
  const decimal=(value,max=32)=>/^\d+$/.test(String(value||''))?String(value).slice(0,max):'';
  function googleVideoUrl(value, requireSabr) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || !(u.hostname==='googlevideo.com'||u.hostname.endsWith('.googlevideo.com')) || u.pathname !== '/videoplayback' || u.username || u.password || u.href.length > MAX_URL) return null;
      if (requireSabr) return u.searchParams.get('sabr')==='1' ? u.href : null;
      if (u.searchParams.has('sq') || u.searchParams.get('source') === 'yt_live_broadcast' || u.searchParams.get('sabr') === '1') return null;
      if (u.searchParams.has('range')) {
        if ((u.searchParams.get('sparams') || '').split(',').includes('range')) return null;
        u.searchParams.delete('range');
      }
      return u.href;
    } catch { return null; }
  }
  const mediaUrl=value=>googleVideoUrl(value,false);
  const sabrUrl=value=>googleVideoUrl(value,true);
  function cleanFormat(f) {
    if(!f||typeof f!=='object'||Array.isArray(f)||f.drmFamilies?.length||f.drmTrackType)return null;
    const cipher = new URLSearchParams(typeof f.signatureCipher === 'string' ? f.signatureCipher : '');
    const mimeType=text(f.mimeType,200);
    const audioTrack=f.audioTrack&&typeof f.audioTrack==='object'?{id:text(f.audioTrack.id,100),audioIsDefault:!!f.audioTrack.audioIsDefault}:null;
    const colorInfo=f.colorInfo&&typeof f.colorInfo==='object'?{transferCharacteristics:text(f.colorInfo.transferCharacteristics,80)}:undefined;
    return {
      itag:integer(f.itag),url:mediaUrl(f.url),sourceUrl:mediaUrl(f.url||cipher.get('url')),mimeType,
      width:integer(f.width),height:integer(f.height),fps:integer(f.fps),bitrate:integer(f.bitrate),averageBitrate:integer(f.averageBitrate),
      audioQuality:text(f.audioQuality,80),audioTrack,lastModified:decimal(f.lastModified),xtags:text(f.xtags,2048),
      contentLength:decimal(f.contentLength),approxDurationMs:decimal(f.approxDurationMs),quality:text(f.quality,80),qualityLabel:text(f.qualityLabel,80),
      audioChannels:integer(f.audioChannels),targetDurationSec:Number.isFinite(Number(f.targetDurationSec))?Number(f.targetDurationSec):undefined,
      isDrc:!!f.isDrc,isVb:!!f.isVb,colorInfo
    };
  }
  function sanitizePlayer(value) {
    if(!value||!/^[\w-]{11}$/.test(value.videoId||'')||!Array.isArray(value.formats)||value.formats.length>MAX_FORMATS)return null;
    const formats=value.formats.map(cleanFormat).filter(f=>f&&f.itag&&f.mimeType);
    const url=sabrUrl(value.sabrUrl);
    const config=/^[A-Za-z0-9_+\/=.-]{1,131072}$/.test(String(value.ustreamerConfig||''))?String(value.ustreamerConfig):'';
    const clientName=integer(value.clientName)||1;
    const clientVersion=/^[\w.-]{1,80}$/.test(String(value.clientVersion||''))?String(value.clientVersion):'';
    return {videoId:value.videoId,title:text(value.title||'Video',180),sabr:!!value.sabr||!!url,sabrUrl:url,ustreamerConfig:config,clientName,clientVersion,formats};
  }
  function playerData(value) {
    if(value?.videoId&&Array.isArray(value.formats))return sanitizePlayer(value);
    if (!value || !/^[\w-]{11}$/.test(value.videoDetails?.videoId || '') || value.videoDetails?.isLiveContent) return null;
    const formats = [...(Array.isArray(value.streamingData?.formats) ? value.streamingData.formats : []), ...(Array.isArray(value.streamingData?.adaptiveFormats) ? value.streamingData.adaptiveFormats : [])];
    const ytcfg=root.ytcfg;
    return sanitizePlayer({
      videoId:value.videoDetails.videoId,title:value.videoDetails.title,sabr:!!value.streamingData?.serverAbrStreamingUrl,
      sabrUrl:value.streamingData?.serverAbrStreamingUrl,
      ustreamerConfig:value.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
      clientName:ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME')||ytcfg?.data_?.INNERTUBE_CONTEXT_CLIENT_NAME||1,
      clientVersion:ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_VERSION')||ytcfg?.data_?.INNERTUBE_CONTEXT_CLIENT_VERSION||'',formats
    });
  }
  function choices(data, observed = []) {
    if (!data) return [];
    const formats = data.formats.map(f => {
      const source=f.sourceUrl && new URL(f.sourceUrl);
      const match=source && observed.find(raw => { try{const u=new URL(raw);return u.searchParams.get('itag')===String(f.itag) && !!source.searchParams.get('id') && u.searchParams.get('id')===source.searchParams.get('id');}catch{return false;} });
      // With SABR available, metadata-only direct URLs can be unusable (403).
      // Prefer SABR unless this exact asset/itag was observed succeeding.
      return {...f,url:match || (data.sabrUrl&&data.ustreamerConfig?null:f.url)};
    }).filter(f=>f.url && (!new URL(f.url).searchParams.has('expire') || Number(new URL(f.url).searchParams.get('expire'))*1000>Date.now()+30000));
    const result=[], seen=new Set();
    const title=data.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,170);
    const audio=formats.filter(f=>/^audio\/mp4/i.test(f.mimeType) && (!f.audioTrack || f.audioTrack.audioIsDefault)).sort((a,b)=>b.bitrate-a.bitrate)[0];
    for(const f of formats.filter(f=>/^video\/mp4/i.test(f.mimeType)&&f.height).sort((a,b)=>b.height-a.height||b.fps-a.fps||b.bitrate-a.bitrate)){
      const muxed=f.audioQuality||/mp4a/i.test(f.mimeType);if(!muxed&&!audio)continue;
      const key=f.height+':'+f.fps;if(seen.has(key))continue;seen.add(key);
      result.push({url:f.url,audioUrl:muxed?undefined:audio.url,provider:'youtube',format:'MP4',outputFormat:'mp4',quality:f.height+'p'+(f.fps>30?' '+f.fps+'fps':''),audioState:'Video + audio',title:data.title,filename:title+'.mp4',bitrate:f.bitrate});
    }
    if(audio)result.push({url:audio.url,provider:'youtube',format:'MP3',outputFormat:'mp3',quality:'Audio',audioState:'Audio only',title:data.title,filename:title+'.mp3'});
    if(!data.sabrUrl||!data.ustreamerConfig)return result;
    const sabrAudio=data.formats.filter(f=>/^audio\/mp4/i.test(f.mimeType)&&(!f.audioTrack||f.audioTrack.audioIsDefault)&&!f.isDrc&&!f.isVb).sort((a,b)=>b.bitrate-a.bitrate)[0];
    if(!sabrAudio)return result;
    for(const f of data.formats.filter(f=>/^video\/mp4/i.test(f.mimeType)&&f.height&&!f.audioQuality&&!/mp4a/i.test(f.mimeType)).sort((a,b)=>b.height-a.height||b.fps-a.fps||b.bitrate-a.bitrate)){
      const key=f.height+':'+f.fps;if(seen.has(key))continue;seen.add(key);
      result.push({url:data.sabrUrl,provider:'youtube',format:'MP4',outputFormat:'mp4',quality:f.height+'p'+(f.fps>30?' '+f.fps+'fps':''),audioState:'Video + audio',title:data.title,filename:title+'.mp4',bitrate:f.bitrate,sabrSelection:{videoItag:f.itag,audioItag:sabrAudio.itag}});
    }
    if(!result.some(item=>item.format==='MP3'))result.push({url:data.sabrUrl,provider:'youtube',format:'MP3',outputFormat:'mp3',quality:'Audio',audioState:'Audio only',title:data.title,filename:title+'.mp3',bitrate:sabrAudio.bitrate,sabrSelection:{audioItag:sabrAudio.itag}});
    return result;
  }
  root.youtubeMedia={mediaUrl,sabrUrl,playerData,sanitizePlayer,choices};
  if(typeof module!=='undefined')module.exports=root.youtubeMedia;
})(globalThis);
