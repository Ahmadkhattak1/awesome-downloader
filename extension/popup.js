const api = globalThis.browser || chrome;
let tab, items = [];
const status = document.querySelector('#status');
const list = document.querySelector('#items');
async function download(item) {
  const result = await api.runtime.sendMessage({action:'download',tabId:tab.id, item:{...item, referer:tab.url}});
  if (!result?.ok) throw new Error(result?.error || 'Desktop connection failed.');
}
async function refresh() {
  const result = await api.runtime.sendMessage({action:'list', tabId:tab.id});
  items = result.items || []; list.replaceChildren();
  if (!items.length) { list.textContent = 'No media detected yet. Play a video or find page links.'; return; }
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className='item';
    const check = document.createElement('input'); check.type='checkbox'; check.dataset.index=index; check.disabled=item.unsupported;
    const label = document.createElement('span'); label.textContent=item.title || item.url.split('/').pop().slice(0,80) || 'Media';
    const detail=document.createElement('small'); detail.textContent=[item.format,item.quality,item.bitrate?`${Math.round(item.bitrate/1000)} kbps`:'',item.unsupported?(item.reason||'Unsupported DASH stream'):item.url.slice(0,140)].filter(Boolean).join(' · '); label.append(detail);
    const button=document.createElement('button'); button.textContent='↓'; button.title='Download'; button.disabled=item.unsupported;
    button.onclick=async()=> { try { await download(item); status.textContent='Added to desktop downloader.'; } catch(e) { status.textContent=e.message; } };
    row.append(check,label,button); list.append(row);
  });
}
document.querySelector('#collect').onclick=async()=> { try { await api.tabs.sendMessage(tab.id,{action:'collectLinks'}); await refresh(); } catch(e) { status.textContent='Reload this web page to enable link detection. '+e.message; } };
document.querySelector('#selected').onclick=async()=> {
  const selected=[...list.querySelectorAll('input:checked')].map(el=>items[Number(el.dataset.index)]);
  if (!selected.length) { status.textContent='Select at least one link.'; return; }
  let added=0;
  for (const item of selected) { try { await download(item); added++; } catch(e) { status.textContent=`Added ${added}/${selected.length}. ${e.message}`; return; } }
  status.textContent=`Added ${added} downloads.`;
};
const filterBox=document.querySelector('#filter');
function applyFilter(){const q=filterBox.value.trim().toLowerCase();list.querySelectorAll('.item').forEach(row=>{row.hidden=!!q&&!row.textContent.toLowerCase().includes(q);});}
filterBox.oninput=applyFilter;
document.querySelector('#select-all').onclick=()=>{const boxes=[...list.querySelectorAll('.item:not([hidden]) input[type=checkbox]:not(:disabled)')];const all=boxes.length>0&&boxes.every(box=>box.checked);boxes.forEach(box=>{box.checked=!all;});};
const live=document.querySelector('#live'), liveItems=document.querySelector('#live-items');
function formatSpeed(n){return n>=1048576?(n/1048576).toFixed(1)+' MB/s':n>=1024?Math.round(n/1024)+' KB/s':n>0?n+' B/s':'';}
async function control(id,action){try{const result=await api.runtime.sendMessage({action:'control',id,control:action});if(!result?.ok)throw new Error(result?.error||'Desktop request failed.');await refreshLive();}catch(e){status.textContent=e.message;}}
const connection=document.querySelector('#connection');
function connectionProblem(message){
  if(/native messaging host not found|host not found/i.test(message))return 'Desktop connector not found. Open Awesome Downloader \u2192 Browser Integration \u2192 Refresh, then reload this extension. (Awesome Downloader repairs the connection automatically while it is running.)';
  if(/forbidden/i.test(message))return 'This extension is not yet allowed to talk to the desktop app. Open Awesome Downloader \u2192 Browser Integration \u2192 Refresh.';
  if(/exited|disconnected|not running|timed out/i.test(message))return 'The desktop app is not running. Start Awesome Downloader; browser downloads continue in the browser until then.';
  return message||'Cannot reach the desktop app.';
}
async function refreshLive(){
  try{
    const result=await api.runtime.sendMessage({action:'status'});
    if(!result?.ok)throw new Error(result?.error||'');
    connection.textContent='Connected to Awesome Downloader.';connection.className='hint ok';
    const rows=(result.items||[]).filter(d=>!['complete','cancelled'].includes(d.status)).slice(0,6);
    live.hidden=!rows.length;liveItems.replaceChildren();
    for(const d of rows){
      const row=document.createElement('div');row.className='live-row';
      const name=document.createElement('span');name.textContent=`${d.filename} — ${d.percent===null?d.status:d.percent+'%'} ${formatSpeed(d.speed)}`.trim();name.title=d.error||d.status;
      row.append(name);
      const actions=d.status==='paused'||d.status==='error'?[['▶','Resume',d.status==='error'?'retry':'resume']]:[['❚❚','Pause','pause']];
      actions.push(['✕','Cancel','cancel']);
      for(const [text,title,act] of actions){const button=document.createElement('button');button.textContent=text;button.title=title;button.onclick=()=>control(d.id,act);row.append(button);}
      liveItems.append(row);
    }
  }catch(error){live.hidden=true;connection.textContent=connectionProblem(error.message);connection.className='hint bad';}
}
setInterval(refreshLive,2000);
document.querySelector('#intercept').onchange=event=>api.storage.local.set({interceptDownloads:event.target.checked});
document.querySelector('#exclude').onchange=event=>api.storage.local.set({interceptExclude:event.target.value.trim().slice(0,2000)});
document.querySelector('#page-video').onclick=async()=>{try{await download({url:tab.url,extract:true,title:tab.title});status.textContent='Looking for the video on this page\u2026 the desktop app will open it.';}catch(e){status.textContent=e.message;}};
(async()=> {
  [tab]=await api.tabs.query({active:true,currentWindow:true});
  const settings=await api.storage.local.get(['interceptDownloads','interceptExclude','lastError']);
  document.querySelector('#intercept').checked=settings.interceptDownloads!==false;
  document.querySelector('#exclude').value=settings.interceptExclude||'';
  status.textContent=settings.lastError || '';
  await api.storage.local.remove('lastError');
  await refresh();
  await refreshLive();
})().catch(e=>{status.textContent=e.message;});
