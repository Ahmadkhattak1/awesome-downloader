(() => {
  const api=globalThis.browser||chrome;
  const pending=new Set();
  let stopped=false;
  function shutdown(){
    if(stopped)return;stopped=true;
    removeEventListener('message',onPlayer);
    try{api.runtime.onMessage.removeListener(onMessage);}catch{}
    for(const done of pending)done(false);
    pending.clear();
  }
  function connected(){
    if(stopped)return false;
    try{if(api.runtime.id)return true;}catch{}
    shutdown();return false;
  }
  async function onPlayer(event){
    if(!connected())return;
    if(event.source!==window || event.origin!==location.origin)return;
    if(event.data?.type==='awesome-sabr-request'){
      const {url,body}=event.data;
      if(typeof url!=='string' || url.length>16384 || !(body instanceof Uint8Array) || !body.length || body.length>262144)return;
      let binary='';for(let i=0;i<body.length;i+=8192)binary+=String.fromCharCode(...body.subarray(i,i+8192));
      try{await api.runtime.sendMessage({action:'sabrRequest',url,requestBody:btoa(binary)});}
      catch(error){if(/extension context invalidated/i.test(error?.message||''))shutdown();}
      return;
    }
    if(event.data?.type!=='awesome-player-response')return;
    const data=event.data.data;
    if(!data || !/^[\w-]{11}$/.test(data.videoId||'') || !Array.isArray(data.formats) || data.formats.length>150)return;
    try{
      await api.runtime.sendMessage({action:'playerResponse',data});
      for(const done of pending)done();pending.clear();
    }catch(error){if(/extension context invalidated/i.test(error?.message||''))shutdown();}
  }
  addEventListener('message',onPlayer);
  function onMessage(message,sender,respond){
    if(!connected() || sender.id!==api.runtime.id)return;
    if(message.action==='relaySabr'){dispatchEvent(new Event('awesome-relay-sabr'));respond({ok:true});return;}
    if(message.action!=='refreshPlayer')return;
    let timer;const done=(ok=true)=>{clearTimeout(timer);pending.delete(done);try{respond({ok});}catch{}};
    pending.add(done);timer=setTimeout(done,1500);
    dispatchEvent(new Event('awesome-request-player'));return true;
  }
  api.runtime.onMessage.addListener(onMessage);
  dispatchEvent(new Event('awesome-request-player'));
})();
