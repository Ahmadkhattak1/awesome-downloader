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
document.querySelector('#intercept').onchange=event=>api.storage.local.set({interceptDownloads:event.target.checked});
(async()=> {
  [tab]=await api.tabs.query({active:true,currentWindow:true});
  const settings=await api.storage.local.get(['interceptDownloads','lastError']);
  document.querySelector('#intercept').checked=!!settings.interceptDownloads;
  status.textContent=settings.lastError || '';
  await api.storage.local.remove('lastError');
  await refresh();
})().catch(e=>{status.textContent=e.message;});
