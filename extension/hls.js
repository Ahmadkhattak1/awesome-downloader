(function(root){
  function parseHlsMaster(text,baseUrl) {
    if(typeof text!=='string' || text.length>1048576 || !text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid or oversized HLS manifest.');
    const lines=text.split(/\r?\n/).slice(0,20000), variants=[];
    const attributes=line=>{const values={}; const regex=/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;let match;while((match=regex.exec(line))) values[match[1]]=match[2].replace(/^"|"$/g,'');return values;};
    const externalAudio=new Map();
    for(const a of lines.filter(line=>line.startsWith('#EXT-X-MEDIA:')).map(attributes)) {
      if(a.TYPE==='AUDIO'&&a.URI&&a['GROUP-ID']&&(!externalAudio.has(a['GROUP-ID'])||a.DEFAULT==='YES')) {
        try { const u=new URL(a.URI,baseUrl); if(/^https?:$/.test(u.protocol)&&!u.username&&!u.password) externalAudio.set(a['GROUP-ID'],u.href); }catch{}
      }
    }
    for(let i=0;i<lines.length && variants.length<20;i++) {
      if(!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a=attributes(lines[i]);let j=i+1;while(j<lines.length&&!lines[j].trim())j++;
      const next=lines[j]?.trim();if(!next||next.startsWith('#'))continue;
      let url;try {url=new URL(next,baseUrl);if(!/^https?:$/.test(url.protocol)||url.username||url.password)continue;}catch{continue;}
      const resolution=/^(\d{1,5})x(\d{1,5})$/i.exec(a.RESOLUTION||'');
      const bitrate=Number(a['AVERAGE-BANDWIDTH']||a.BANDWIDTH)||0;
      const separateAudio=!!a.AUDIO&&externalAudio.has(a.AUDIO);
      variants.push({url:url.href,audioUrl:externalAudio.get(a.AUDIO),quality:resolution?`${resolution[2]}p`:'',bitrate:Number.isSafeInteger(bitrate)&&bitrate>0?bitrate:0,codecs:(a.CODECS||'').slice(0,200),mime:'application/vnd.apple.mpegurl',format:'HLS',separateAudio,unsupported:false,reason:''});
    }
    if(!variants.length) variants.push({url:new URL(baseUrl).href,quality:'',bitrate:0,mime:'application/vnd.apple.mpegurl',format:'HLS',unsupported:false});
    for (const item of variants) if (item.codecs || item.quality || item.audioUrl) item.masterUrl=baseUrl;
    return variants;
  }
  root.parseHlsMaster=parseHlsMaster;
  if(typeof module!=='undefined')module.exports={parseHlsMaster};
})(globalThis);
