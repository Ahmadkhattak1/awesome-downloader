/* Downloads require extension UI messages; page player metadata is bounded and sanitized. */
if(typeof importScripts==='function') importScripts('hls.js','youtube-media.js');
const api = globalThis.browser || chrome;
const HOST = 'com.awesome.downloader';
const CACHE_KEY = 'mediaByTab';
const SABR_KEY = 'sabrByTab';
let serial = Promise.resolve();
// Credentials stay in worker memory and are used only for the selected observed URL.
const requestContext = new Map();
const youtubePlayers=new Map(), youtubeObserved=new Map(), youtubeSabrObserved=new Map(), youtubeSabrSeed=new Map(), sabrRelayTabs=new Set();
function tabVideoId(value){
  try{
    const page=new URL(value);if(!['www.youtube.com','youtube.com','m.youtube.com'].includes(page.hostname))return null;
    const id=page.searchParams.get('v')||/^\/shorts\/([\w-]{11})/.exec(page.pathname)?.[1];
    return /^[\w-]{11}$/.test(id||'')?id:null;
  }catch{return null;}
}
function rememberSabrCapture(tabId,seed){
  const fresh=!youtubeSabrObserved.has(tabId);
  youtubeSabrObserved.set(tabId,seed);
  if(youtubeSabrObserved.size>50)youtubeSabrObserved.delete(youtubeSabrObserved.keys().next().value);
  updateSession(SABR_KEY,map=>{map[tabId]={url:seed.url,requestBody:seed.requestBody};}).catch(()=>{});
  // A menu still waiting for this session refills without being reopened.
  if(fresh)api.tabs.sendMessage(tabId,{action:'sabrCaptured'}).catch(()=>{});
}
// Only a tab whose SABR body webRequest could not read is asked to relay it from the page.
function requestSabrRelay(tabId){
  if(sabrRelayTabs.has(tabId))return;
  sabrRelayTabs.add(tabId);
  api.tabs.sendMessage(tabId,{action:'relaySabr'}).catch(()=>sabrRelayTabs.delete(tabId));
}
async function sabrCapture(tabId){
  const live=youtubeSabrObserved.get(tabId);
  if(live)return live;
  await serial;
  try{
    const data=await api.storage.session.get(SABR_KEY),stored=data[SABR_KEY]?.[tabId];
    if(stored&&typeof stored.url==='string'&&typeof stored.requestBody==='string'){
      const capture={...stored,tabId};youtubeSabrObserved.set(tabId,capture);return capture;
    }
  }catch{}
}
function clearSabrCapture(tabId){
  youtubeSabrObserved.delete(tabId);
  for(const [id,seed] of youtubeSabrSeed)if(seed.tabId===tabId)youtubeSabrSeed.delete(id);
  updateSession(SABR_KEY,map=>{delete map[tabId];}).catch(()=>{});
}
function bytesBase64(bytes){let binary='';const view=new Uint8Array(bytes);for(let i=0;i<view.length;i+=8192)binary+=String.fromCharCode(...view.subarray(i,i+8192));return btoa(binary);}
api.webRequest.onBeforeRequest?.addListener(details=>{
  const url=globalThis.youtubeMedia?.sabrUrl(details.url), body=details.requestBody, raw=body?.raw;
  if(!url||details.tabId<0||!body)return;
  if(body.error||!Array.isArray(raw)||!raw.length||raw.some(part=>!part.bytes)){requestSabrRelay(details.tabId);return;}
  let size=0;for(const part of raw)size+=part.bytes.byteLength;if(!size||size>262144)return;
  const bytes=new Uint8Array(size);let offset=0;for(const part of raw){bytes.set(new Uint8Array(part.bytes),offset);offset+=part.bytes.byteLength;}
  youtubeSabrSeed.set(details.requestId,{tabId:details.tabId,url,requestBody:bytesBase64(bytes)});
  if(youtubeSabrSeed.size>100)youtubeSabrSeed.delete(youtubeSabrSeed.keys().next().value);
},{urls:['https://*.googlevideo.com/videoplayback*','https://googlevideo.com/videoplayback*']},['requestBody']);
function rememberRequest(details) {
  if(details.tabId<0 || !httpUrl(details.url))return;
  let tab=requestContext.get(details.tabId);
  if(!tab){tab=new Map();requestContext.set(details.tabId,tab);if(requestContext.size>50)requestContext.delete(requestContext.keys().next().value);}
  const headers={};
  for(const h of details.requestHeaders||[]) {
    const name=h.name.toLowerCase();
    if(['cookie','authorization','user-agent','referer','origin'].includes(name)&&typeof h.value==='string'&&h.value.length<=16384&&!/[\r\n]/.test(h.value))headers[name]=h.value;
  }
  tab.set(details.url,headers);if(tab.size>100)tab.delete(tab.keys().next().value);
}
// Chromium (which now also defines `browser`) withholds Cookie and Referer unless extraHeaders is requested; Firefox has no such option.
api.webRequest.onBeforeSendHeaders?.addListener(rememberRequest,{urls:['http://*/*','https://*/*']},['requestHeaders',...(api.webRequest.OnBeforeSendHeadersOptions?.EXTRA_HEADERS?['extraHeaders']:[])]);
function httpUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function unsupported(url, mime = '') { return /\.mpd(?:[?#]|$)/i.test(url) || /dash\+xml/i.test(mime); }
function isFragment(url) { return /\.(m4s|ts|aac)(?:[?#]|$)/i.test(url) || /\/init[^/]*\.mp4(?:[?#]|$)/i.test(url); }
const hlsSeen=new Map(); let hlsActive=0;
async function discoverHls(tabId,url) {
  if(tabId<0 || hlsActive>=8)return;
  let seen=hlsSeen.get(tabId);if(!seen){seen=new Set();hlsSeen.set(tabId,seen);if(hlsSeen.size>50)hlsSeen.delete(hlsSeen.keys().next().value);}
  if(seen.has(url)||seen.size>=20)return;seen.add(url);hlsActive++;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch(url,{signal:controller.signal,credentials:'omit'});
    if(!response.ok)throw new Error('Manifest fetch failed.');
    const reader=response.body.getReader();let size=0;const chunks=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw new Error('Manifest too large.');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const variants=globalThis.parseHlsMaster(new TextDecoder().decode(bytes),response.url||url);
    let title='';try{title=(await api.tabs.get(tabId)).title||'';}catch{}
    if(hlsSeen.get(tabId)===seen)await remember(tabId,variants.map(item=>({...item,title})));
  } catch {} finally {clearTimeout(timer);hlsActive--;}
}
function nativeSend(payload) {
  return new Promise((resolve, reject) => {
    // Chrome callbacks retain useful runtime.lastError diagnostics.
    if (!globalThis.browser) chrome.runtime.sendNativeMessage(HOST, payload, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!result?.ok) reject(new Error(result?.error || 'The desktop app did not accept this download.'));
      else resolve(result);
    });
    else browser.runtime.sendNativeMessage(HOST, payload).then(result => result?.ok ? resolve(result) : reject(new Error(result?.error || 'Desktop rejected download.')), reject);
  });
}
async function enqueue(item, tabId) {
  let sabr;
  if(item.sabrSelection){
    const player=youtubePlayers.get(tabId), selection=item.sabrSelection;
    const videoItag=selection.videoItag===undefined?undefined:Number(selection.videoItag), audioItag=Number(selection.audioItag);
    if(!player||!Number.isSafeInteger(audioItag)||audioItag<=0||videoItag!==undefined&&(!Number.isSafeInteger(videoItag)||videoItag<=0))throw new Error('The captured YouTube session expired. Reopen the menu.');
    const audio=player.formats.find(f=>f.itag===audioItag&&/^audio\/mp4/i.test(f.mimeType));
    const video=videoItag===undefined?undefined:player.formats.find(f=>f.itag===videoItag&&/^video\/mp4/i.test(f.mimeType));
    const captured=await sabrCapture(tabId);
    if(!captured)throw new Error('Play this YouTube video briefly so its streaming session can be captured, then try again.');
    const serverAbrStreamingUrl=captured.url;
    if(!audio||videoItag!==undefined&&!video||!globalThis.youtubeMedia.sabrUrl(serverAbrStreamingUrl)||!player.ustreamerConfig)throw new Error('The captured YouTube SABR session is incomplete. Play the video briefly and reopen the menu.');
    // Native messaging is limited to 1 MiB. The desktop only needs the two
    // selected tracks, not every format advertised by YouTube's player.
    sabr={videoId:player.videoId,serverAbrStreamingUrl,videoPlaybackUstreamerConfig:player.ustreamerConfig,clientInfo:{clientName:player.clientName,clientVersion:player.clientVersion},formats:[video,audio].filter(Boolean),videoItag,audioItag,requestBody:captured.requestBody};
  }
  const url = httpUrl(sabr?.serverAbrStreamingUrl||item.url);
  if (!url) throw new Error('Only direct HTTP and HTTPS links are supported.');
  if (unsupported(url, item.mime) || item.unsupported) throw new Error(item.reason || 'DASH streams are unsupported.');
  const requestHeaders=requestContext.get(tabId)?.get(url);
  return nativeSend({action: 'download', url, youtubeFormat:item.youtubeFormat, sabr, startNow:item.startNow===true, audioUrl:httpUrl(item.audioUrl)||undefined, outputFormat:item.outputFormat, filename: item.filename, referer: httpUrl(requestHeaders?.referer || item.referer) || undefined,requestHeaders});
}
function updateSession(key,change) {
  const next = serial.then(async () => {
    const data = await api.storage.session.get(key);
    const map = data[key] || {};
    await change(map);
    // Bound total tracked tabs as well as each tab's results.
    const keys = Object.keys(map);
    keys.slice(0, Math.max(0, keys.length - 50)).forEach(entry => delete map[entry]);
    await api.storage.session.set({[key]: map});
  });
  serial = next.catch(() => {});
  return next;
}
const updateCache=change=>updateSession(CACHE_KEY,change);
async function remember(tabId, items) {
  if (tabId < 0) return;
  await updateCache(map => {
    const prior = map[tabId] || [];
    for (const item of items.slice(0, 100)) {
      const url = httpUrl(item.url);
      if (!url || isFragment(url)) continue;
      const value={url, mime: String(item.mime || '').slice(0, 100), title: String(item.title || '').slice(0, 180), quality:String(item.quality||'').slice(0,40),bitrate:Number(item.bitrate)||0,format:String(item.format||'').slice(0,20),separateAudio:!!item.separateAudio,reason:String(item.reason||'').slice(0,180),unsupported: unsupported(url, item.mime)||!!item.unsupported};
      value.audioUrl=httpUrl(item.audioUrl)||undefined;
      value.codecs=String(item.codecs||'').slice(0,200);
      value.masterUrl=httpUrl(item.masterUrl)||undefined;
      const existing=prior.findIndex(v=>v.url===url);
      if(existing>=0){const previous=prior[existing];if(previous.format==='HLS'&&!item.format){if(value.title)previous.title=value.title;continue;}prior[existing]={...previous,...value,audioUrl:value.audioUrl||previous.audioUrl,codecs:value.codecs||previous.codecs,masterUrl:value.masterUrl||previous.masterUrl,title:value.title||previous.title,quality:value.quality||previous.quality,bitrate:value.bitrate||previous.bitrate,format:value.format||previous.format,separateAudio:value.separateAudio||previous.separateAudio,unsupported:value.unsupported||previous.unsupported,reason:value.reason||previous.reason};continue;}
      prior.push(value);
    }
    map[tabId] = prior.slice(-100);
  });
}
api.webRequest.onHeadersReceived.addListener(details => {
  const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  const captured=globalThis.youtubeMedia?.mediaUrl(details.url);
  const capturedSabr=globalThis.youtubeMedia?.sabrUrl(details.url);
  if(capturedSabr && details.tabId>=0 && [200,206].includes(details.statusCode)){
    const seed=youtubeSabrSeed.get(details.requestId);
    if(seed?.tabId===details.tabId&&seed.url===capturedSabr)rememberSabrCapture(details.tabId,seed);
    youtubeSabrSeed.delete(details.requestId);
  }
  if(captured && details.tabId>=0 && [200,206].includes(details.statusCode) && /^(video|audio)\//i.test(mime)) {
    const urls=youtubeObserved.get(details.tabId)||[];
    if(!urls.includes(captured))urls.unshift(captured);
    youtubeObserved.set(details.tabId,urls.slice(0,100));
    if(youtubeObserved.size>50)youtubeObserved.delete(youtubeObserved.keys().next().value);
  }
  if (details.type === 'media' || /^(video|audio)\//i.test(mime) || unsupported(details.url, mime)) {
    remember(details.tabId, [{url: details.url, mime}]).catch(() => {});
  }
  if(/\.m3u8(?:[?#]|$)/i.test(details.url)||/mpegurl/i.test(mime))discoverHls(details.tabId,details.url);
}, {urls: ['http://*/*', 'https://*/*']}, ['responseHeaders']);
api.tabs.onRemoved.addListener(tabId => {youtubePlayers.delete(tabId);youtubeObserved.delete(tabId);clearSabrCapture(tabId);sabrRelayTabs.delete(tabId);requestContext.delete(tabId);hlsSeen.delete(tabId);updateCache(map => { delete map[tabId]; }).catch(() => {});});
api.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') {youtubePlayers.delete(tabId);youtubeObserved.delete(tabId);clearSabrCapture(tabId);sabrRelayTabs.delete(tabId);requestContext.delete(tabId);hlsSeen.delete(tabId);updateCache(map => { delete map[tabId]; }).catch(() => {});} });
api.runtime.onInstalled.addListener(async () => {
  try {
    await api.contextMenus.removeAll();
    api.contextMenus.create({id: 'awesome-link', title: 'Download with Awesome Downloader', contexts: ['link', 'video', 'audio']});
    api.contextMenus.create({id: 'awesome-page', title: 'Find downloadable links on this page', contexts: ['page']});
  } catch (error) { await api.storage.local.set({lastError: error.message}); }
});
api.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'awesome-page') { await api.tabs.sendMessage(tab.id, {action: 'collectLinks'}); await api.action.setBadgeText({tabId: tab.id, text: 'LINK'}); return; }
    await enqueue({url: info.linkUrl || info.srcUrl, referer: tab?.url},tab?.id);
    await api.action.setBadgeText({tabId: tab.id, text: 'OK'});
  } catch (e) {
    await api.storage.local.set({lastError: e.message});
    if (tab?.id) await api.action.setBadgeText({tabId: tab.id, text: '!'});
  }
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return false;
  const task = async () => {
    if(message.action==='playerResponse' && sender.tab) {
      const page=new URL(sender.url || sender.tab.url || 'https://invalid.local');
      if(!['www.youtube.com','youtube.com','m.youtube.com'].includes(page.hostname))throw new Error('Invalid player source.');
      const data=message.data;
      if(!data || !Array.isArray(data.formats) || data.formats.length>150)throw new Error('Invalid player data.');
      const clean=globalThis.youtubeMedia.sanitizePlayer(data);
      // The page also loads players for other videos; those must not replace the tab's own or erase its session.
      const shown=tabVideoId(sender.tab.url);
      if(clean&&(!shown||clean.videoId===shown)){
        const previous=youtubePlayers.get(sender.tab.id);
        if(previous&&previous.videoId!==clean.videoId){clearSabrCapture(sender.tab.id);youtubeObserved.delete(sender.tab.id);}
        youtubePlayers.set(sender.tab.id,clean);if(youtubePlayers.size>50)youtubePlayers.delete(youtubePlayers.keys().next().value);
      }
      return {ok:true};
    }
    if(message.action==='sabrRequest' && sender.tab) {
      const page=new URL(sender.url || sender.tab.url || 'https://invalid.local');
      if(!['www.youtube.com','youtube.com','m.youtube.com'].includes(page.hostname)||!sabrRelayTabs.has(sender.tab.id))throw new Error('Invalid SABR source.');
      const url=globalThis.youtubeMedia.sabrUrl(message.url),requestBody=message.requestBody;
      // Decoded size, so the limit matches the 256 KiB webRequest captures are held to.
      const size=typeof requestBody==='string'&&requestBody.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(requestBody)?requestBody.length/4*3-/=*$/.exec(requestBody)[0].length:0;
      if(!url||!size||size>262144)throw new Error('Invalid SABR request.');
      rememberSabrCapture(sender.tab.id,{tabId:sender.tab.id,url,requestBody});
      return {ok:true};
    }
    if (message.action === 'remember' && sender.tab) { await remember(sender.tab.id, message.items || []); return {ok: true}; }
    if (message.action === 'download') {
      const tabId=sender.tab?.id ?? message.tabId;
      return enqueue({...message.item, referer: sender.tab?.url || message.item?.referer},tabId);
    }
    if (message.action === 'list' && !sender.tab) {
      await serial;
      const data = await api.storage.session.get(CACHE_KEY);
      return {ok: true, items: data[CACHE_KEY]?.[message.tabId] || []};
    }
    if (message.action === 'listForFrame' && sender.tab) {
      const page=new URL(sender.tab.url||'https://invalid.local');
      if(['www.youtube.com','youtube.com','m.youtube.com'].includes(page.hostname)) {
        const id=tabVideoId(page.href);
        if(!id)return {ok:true,items:[]};
        await api.tabs.sendMessage(sender.tab.id,{action:'refreshPlayer'}).catch(()=>{});
        const player=youtubePlayers.get(sender.tab.id);
        if(player?.videoId!==id)return {ok:true,items:[]};
        const capture=player.sabr?await sabrCapture(sender.tab.id):undefined;
        const active={...player,sabrUrl:capture?.url||player.sabrUrl};
        let items=globalThis.youtubeMedia.choices(active,youtubeObserved.get(sender.tab.id)||[]);
        if(!capture&&items.some(item=>item.sabrSelection)){
          items=items.filter(item=>!item.sabrSelection);
          if(!items.length)return {ok:true,items,notice:'Play this video for a few seconds so its streaming session can be captured. This menu updates once it is.'};
        }
        return {ok:true,items};
      }
      await serial;
      const data = await api.storage.session.get(CACHE_KEY);
      return {ok:true, items:(data[CACHE_KEY]?.[sender.tab.id] || []).filter(item => item.unsupported || item.format==='HLS' || /^(video|audio)\//i.test(item.mime) || /\.(m3u8|mp4|webm|mov|m4v|mp3|m4a|ogg|wav)(?:[?#]|$)/i.test(item.url))};
    }
    throw new Error('Unsupported extension request.');
  };
  task().then(respond, error => respond({ok: false, error: error.message}));
  return true;
});
const pendingHandoffs=new Map();
function sharedHandoff(url,item){
  const key=JSON.stringify([item.tabId,item.referrer||'',url]);
  let pending=pendingHandoffs.get(key);if(pending)return pending;
  pending=enqueue({url,filename:item.filename?.split(/[\\/]/).pop(),referer:item.referrer},item.tabId).finally(()=>pendingHandoffs.delete(key));
  pendingHandoffs.set(key,pending);pending.catch(()=>{});return pending;
}
api.downloads.onCreated.addListener(async item => {
  const url=item.finalUrl||item.url;
  let paused=false,accepted=false;
  try {
    if (!httpUrl(url) || item.state==='complete') return;
    // IDM's observed ownership model: pause during handoff, resume on failure.
    await api.downloads.pause(item.id); paused=true;
    await sharedHandoff(url,item);accepted=true;
    await api.downloads.cancel(item.id);
  } catch (e) {
    if(paused&&!accepted)await api.downloads.resume(item.id).catch(()=>{});
    await api.storage.local.set({lastError:accepted?`The browser download could not be canceled; Awesome Downloader continues the transfer: ${e.message}`:`Browser download was kept: ${e.message}`});
  }
});
