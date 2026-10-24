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
    if(event.source!==window || event.origin!==location.origin || event.data?.type!=='awesome-player-response')return;
    const data=event.data.data;
    if(!data || !/^[\w-]{11}$/.test(data.videoId||'') || !Array.isArray(data.formats) || data.formats.length>150)return;
    try{
      await api.runtime.sendMessage({action:'playerResponse',data});
      for(const done of pending)done();pending.clear();
    }catch(error){if(/extension context invalidated/i.test(error?.message||''))shutdown();}
  }
  addEventListener('message',onPlayer);
  function onMessage(message,sender,respond){
    if(!connected() || sender.id!==api.runtime.id || message.action!=='refreshPlayer')return;
    let timer;const done=(ok=true)=>{clearTimeout(timer);pending.delete(done);try{respond({ok});}catch{}};
    pending.add(done);timer=setTimeout(done,1500);
    dispatchEvent(new Event('awesome-request-player'));return true;
  }
  api.runtime.onMessage.addListener(onMessage);
  dispatchEvent(new Event('awesome-request-player'));
})();
