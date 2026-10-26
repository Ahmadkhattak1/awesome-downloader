// Observes only player responses consumed by this YouTube page. Never initiates downloads.
(() => {
  const publish=value=>{ const data=globalThis.youtubeMedia.playerData(value); if(data)window.postMessage({type:'awesome-player-response',data},location.origin); };
  const playerEndpoint=value=>{try{const u=new URL(value,location.href);return u.origin===location.origin && /^\/youtubei\/v1\/player$/.test(u.pathname);}catch{return false;}};
  // YouTube posts SABR media requests as Request objects whose bodies Chrome does not expose
  // to webRequest ("Unknown error."). Copy that request context here, before fetch consumes it.
  const sabrRequest=(input,init)=>{
    try{
      const url=globalThis.youtubeMedia.sabrUrl(String(input?.url||input));
      if(!url || String(init?.method||input?.method||'GET').toUpperCase()!=='POST' || init?.body instanceof ReadableStream)return null;
      const copy=init?.body===undefined&&input instanceof Request?input.clone():new Request(url,{method:'POST',body:init?.body});
      return copy.arrayBuffer().then(buffer=>buffer.byteLength&&buffer.byteLength<=262144?{url,body:new Uint8Array(buffer)}:null,()=>null);
    }catch{return null;}
  };
  const originalFetch=window.fetch;
  window.fetch=function(...args){
    const sabr=sabrRequest(args[0],args[1]);
    const result=Reflect.apply(originalFetch,this,args);
    // Only a request the server accepted becomes the captured session.
    if(sabr)Promise.all([sabr,result]).then(([request,response])=>{if(request&&[200,206].includes(response.status))window.postMessage({type:'awesome-sabr-request',...request},location.origin);},()=>{});
    if(playerEndpoint(args[0]?.url || args[0]))result.then(async response=>{
      if(!response.ok || Number(response.headers.get('content-length'))>2097152)return;
      const reader=response.clone().body?.getReader();if(!reader)return;
      const chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2097152){void reader.cancel();return;}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}publish(JSON.parse(new TextDecoder().decode(bytes)));}catch{}
    }).catch(()=>{});
    return result;
  };
  const open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,...rest){
    if(playerEndpoint(url))this.addEventListener('load',()=>{try{if(this.responseType==='json')publish(this.response);else if((this.responseType===''||this.responseType==='text') && this.responseText.length<=2097152)publish(JSON.parse(this.responseText));}catch{}},{once:true});
    return Reflect.apply(open,this,[method,url,...rest]);
  };
  function current(){try{publish(window.ytInitialPlayerResponse);const player=document.getElementById('movie_player');if(player?.getPlayerResponse)publish(player.getPlayerResponse());}catch{}}
  addEventListener('awesome-request-player',current);
  addEventListener('yt-navigate-finish',current);
  addEventListener('DOMContentLoaded',current,{once:true});
})();
