(() => {
  const api = globalThis.browser || chrome;
  const seen = new WeakSet();
  const records = new Set();
  let pending = false;
  let stopped = false, scanFrame, mutationObserver, scrollTimer, scrolling=false;
  const listeners = new AbortController();
  const resizeObserver = new ResizeObserver(() => position());
  const intersectionObserver = new IntersectionObserver(entries => {
    for(const entry of entries){
      const record=[...records].find(value=>value.video===entry.target);
      if(record)record.intersection=entry;
    }
    position();
  },{threshold:[0,0.01]});
  const direct = value => { try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
  const mediaIdentity = video => JSON.stringify([location.href,video.currentSrc||'',video.src||'',video.poster||'']);
  function shutdown() {
    if(stopped)return;
    stopped=true;
    listeners.abort();
    clearTimeout(scrollTimer);
    mutationObserver?.disconnect();resizeObserver.disconnect();intersectionObserver.disconnect();
    if(scanFrame!==undefined)cancelAnimationFrame(scanFrame);
    for(const record of records){record.sourceObserver?.disconnect();record.host.remove();}
    records.clear();
    try{api.runtime.onMessage.removeListener(onMessage);}catch{}
  }
  function connected() {
    if(stopped)return false;
    try{if(api.runtime.id)return true;}catch{}
    shutdown();return false;
  }
  // sendMessage can throw synchronously after an extension reload, before a
  // caller's .catch exists. Always expose a promise and retire the stale script.
  async function send(message) {
    if(!connected())throw new Error('The extension was reloaded. Refresh this page to reconnect.');
    try{return await api.runtime.sendMessage(message);}
    catch(error){if(/extension context invalidated/i.test(error?.message||''))shutdown();throw error;}
  }
  function scan() {
    pending = false;
    if(!connected())return;
    for (const video of document.querySelectorAll('video')) {
      if (seen.has(video)) continue;
      seen.add(video);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;z-index:2147483647;display:none;pointer-events:auto';
      const shadow = host.attachShadow({mode:'closed'});
      shadow.innerHTML = '<style>:host{font:12px/1.45 "Segoe UI",Tahoma,sans-serif;color:#14202b}.bar{display:flex;justify-content:flex-end;align-items:stretch}.download,.dismiss{font:12px "Segoe UI",Tahoma,sans-serif;background:linear-gradient(#f7fcff,#c6e2f5);color:#17364b;border:1px solid #719ab7;cursor:default;box-shadow:0 1px 3px #0003;height:27px}.download{border-radius:4px 0 0 4px;padding:3px 10px}.dismiss{width:24px;padding:0;border-left:0;border-radius:0 4px 4px 0;font-size:16px;line-height:20px}.download:hover,.dismiss:hover{background:linear-gradient(#fff,#acd4ef)}.dismiss:hover{color:#8d1c18}.download:disabled{opacity:.65}.chooser{position:fixed;z-index:1;box-sizing:border-box;padding:8px;background:#fff;color:#14202b;border:1px solid #d7dde4;border-radius:10px;box-shadow:0 16px 38px #0f172a30,0 2px 6px #0f172a14;width:min(400px,calc(100vw - 12px));max-height:min(360px,60vh);overflow:auto;overscroll-behavior:contain}.hint{display:block;margin:0 0 6px;padding:2px 6px;line-height:1.45;color:#5c6875;font-size:11.5px}.chooser[data-tone=loading] .hint{display:flex;align-items:center;gap:7px}.chooser[data-tone=loading] .hint:before{content:"";width:11px;height:11px;flex:0 0 auto;border:2px solid #c9d6e4;border-top-color:#1f6feb;border-radius:50%;animation:awesome-spin .7s linear infinite}.chooser[data-tone=error] .hint{color:#a12a24}.chooser[data-tone=success] .hint{color:#1c6b3a}@keyframes awesome-spin{to{transform:rotate(1turn)}}.row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;padding:8px 9px;font:12px "Segoe UI",Tahoma,sans-serif;color:#14202b}.row+.row{margin-top:2px}.row:hover:not(:disabled){background:#eff5fd;border-color:#d3e3f8}.row:active:not(:disabled){background:#e2eefc}.row:focus-visible{outline:2px solid #1f6feb;outline-offset:-2px}.row:disabled{opacity:.55;color:#7b8794}.badge{flex:0 0 auto;min-width:52px;padding:3px 8px;border-radius:7px;background:#e9f1fc;color:#1b4f8f;font-weight:700;font-size:11.5px;text-align:center;font-variant-numeric:tabular-nums}.row:disabled .badge{background:#eceff2;color:#7b8794}.row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}.row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.row-meta{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:11px;color:#5f6b78}.row-meta span{white-space:nowrap}@media(max-width:420px){.chooser{width:calc(100vw - 12px);padding:6px}.row{padding:7px;gap:8px}.badge{min-width:46px}}</style><div class="bar"><button class="download" type="button">↓ Download this video ▾</button><button class="dismiss" type="button" title="Hide this download panel" aria-label="Hide this download panel">×</button></div>';
      const button = shadow.querySelector('.download');
      const dismiss = shadow.querySelector('.dismiss');
      const record = {video, host, shadow, button, dismissed:false, identity:mediaIdentity(video)}; records.add(record);
      resizeObserver.observe(video);
      intersectionObserver.observe(video);
      document.documentElement.appendChild(host);
      button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
      const syncIdentity=()=>{
        const identity=mediaIdentity(video);if(identity===record.identity)return false;
        record.identity=identity;record.dismissed=false;closeChooser(record);return true;
      };
      const report = () => {
        syncIdentity();
        const urls = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source'), source => source.src)].map(direct).filter(Boolean);
        if (urls.length) send({action:'remember', items: urls.map(url => ({url, title:document.title}))}).catch(() => {});
      };
      video.addEventListener('loadedmetadata', report, {signal:listeners.signal});
      record.sourceObserver=new MutationObserver(report);
      record.sourceObserver.observe(video,{attributes:true,attributeFilter:['src'],subtree:true,childList:true});
      report();if(stopped)return;
      dismiss.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        record.dismissed=true;
        closeChooser(record);
        host.style.display='none';
      });
      button.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        const url = direct(video.currentSrc || video.src || video.querySelector('source')?.src);
        {
          const old = shadow.querySelector('.chooser'); if(old) { closeChooser(record); position(); return; }
          closeChoosers(record);
          const chooser=document.createElement('div'); chooser.className='chooser';chooser.setAttribute('role','dialog');chooser.setAttribute('aria-label','Choose a video format');
          const hint=document.createElement('p'); hint.className='hint';hint.setAttribute('role','status');hint.textContent='Checking available video formats…';
          const setHint=(text,tone='')=>{hint.textContent=text;chooser.setAttribute('data-tone',tone);};
          chooser.setAttribute('data-tone','loading');
          chooser.append(hint); shadow.append(chooser);button.setAttribute('aria-expanded','true'); position();
          try {
            const result=await send({action:'listForFrame'});
            if(!result?.ok)throw new Error(result?.error||'Could not list video formats.');
            setHint('Choose a format to download');
            const candidates=result?.items||[];
            const youtube=/(^|\.)youtube\.com$/.test(location.hostname);
            if(!youtube&&url&&!candidates.some(item=>item.url===url)) candidates.unshift({url,title:document.title});
            if (!candidates.length) { setHint(result.notice || (youtube?'Play the video briefly, then reopen this menu. No complete video with audio has been captured yet.':'No direct media links detected. Play the video and try again.'),'error'); return; }
            const choices=globalThis.mediaChoices(candidates,{url,poster:video.poster});
            if(!choices.length){setHint('No complete formats detected for this video yet. Play it briefly, then try again.','error');return;}
            const rate=value=>value>=1e6?`${(value/1e6).toFixed(1)} Mbps`:`${Math.round(value/1000)} kbps`;
            choices.forEach(item=>{
              const row=document.createElement('button');row.className='row';row.type='button';row.disabled=item.unsupported;
              if(item.unsupported)row.setAttribute('aria-disabled','true');
              row.title=/https?:\/\//i.test(item.reason||'')?'':item.reason||'';
              const format=item.format||(/\.m3u8(?:[?#]|$)/i.test(item.url)?'HLS':/\.(mp4|webm|mp3|m4a|mov)(?:[?#]|$)/.exec(item.url)?.[1]?.toUpperCase()||'Media');
              const title = item.asset ? `Video ${item.asset}` : item.title || document.title || 'Video';
              // The resolution is the scan anchor; format, audio state and bitrate
              // stay readable beside it while a long title truncates.
              const badge=document.createElement('span');badge.className='badge';
              badge.textContent=(item.quality||format).replace(/\s+/g,' ').trim();
              const main=document.createElement('span');main.className='row-main';
              const titleNode=document.createElement('span');titleNode.className='row-title';titleNode.textContent=title;
              const meta=document.createElement('span');meta.className='row-meta';
              const details=[format,item.audioState,item.bitrate?rate(Number(item.bitrate)):''].filter(Boolean);
              for(const text of details){const piece=document.createElement('span');piece.textContent=text;meta.append(piece);}
              main.append(titleNode,meta);row.append(badge,main);
              row.setAttribute('aria-label',`${badge.textContent}, ${details.join(', ')}`);
              row.onclick=async event=>{
                event.preventDefault();event.stopPropagation();row.disabled=true;
                setHint('Opening download options…','loading');
                try{
                  const response=await send({action:'download',item:{...item,startNow:false}});
                  globalThis.awesomeMenuResult(response,{
                    accepted:()=>{closeChooser(record);position();},
                    rejected:message=>{setHint(friendlyError(message),'error');row.disabled=false;}
                  });
                }catch(error){setHint(friendlyError(error.message),'error');row.disabled=false;}
              };chooser.append(row);
            });
            chooser.addEventListener('keydown',event=>{
              const rows=[...chooser.querySelectorAll('.row:not(:disabled)')];if(!rows.length)return;
              const current=rows.indexOf(shadow.activeElement||document.activeElement),last=rows.length-1;
              let next;if(event.key==='ArrowDown')next=current<0?0:(current+1)%rows.length;
              else if(event.key==='ArrowUp')next=current<0?last:(current-1+rows.length)%rows.length;
              else if(event.key==='Home')next=0;else if(event.key==='End')next=last;else return;
              event.preventDefault();event.stopPropagation();rows[next].focus();
            });
            chooser.querySelector('.row:not(:disabled)')?.focus();position();
          } catch(error) {setHint(error.message,'error');}
          return;
        }
      });
    }
    position();
  }
  function friendlyError(message) { return /native messaging host not found/i.test(message || '') ? 'Chrome cannot find the desktop connector. Open Awesome Downloader → Browser Integration → Refresh browsers, then reload this extension and page. Details: '+message : message; }
  function closeChooser(record,restoreFocus=false){
    const chooser=record.shadow.querySelector('.chooser');if(!chooser)return false;
    chooser.remove();record.button.setAttribute('aria-expanded','false');if(restoreFocus)record.button.focus();return true;
  }
  function closeChoosers(except,restoreFocus=false) {
    for(const record of records){
      if(record===except)continue;
      closeChooser(record,restoreFocus);
    }
    position();
  }
  function position() {
    if(!connected())return;
    for (const record of records) {
      if (!record.video.isConnected) { resizeObserver.unobserve(record.video); intersectionObserver.unobserve(record.video); record.sourceObserver.disconnect(); record.host.remove(); records.delete(record); continue; }
      const identity=mediaIdentity(record.video);if(identity!==record.identity){record.identity=identity;record.dismissed=false;closeChooser(record);}
      const fullscreen=document.fullscreenElement;
      const parent=fullscreen && fullscreen !== record.video && fullscreen.contains(record.video) ? fullscreen : document.documentElement;
      if(record.host.parentNode !== parent) parent.appendChild(record.host);
      const rect = record.video.getBoundingClientRect(),intersection=record.intersection;
      const clipped=intersection?.intersectionRect;
      const visibleRect=clipped&&intersection.isIntersecting?clipped:rect;
      const visible = !scrolling && !record.dismissed && (!intersection||intersection.isIntersecting) && visibleRect.width > 100 && visibleRect.height > 60 && visibleRect.bottom > 0 && visibleRect.top < innerHeight && visibleRect.right > 0 && visibleRect.left < innerWidth;
      record.host.style.display = visible ? 'block' : 'none';
      if(!visible){closeChooser(record);continue;}
      const width = record.host.offsetWidth || 180, height = record.host.offsetHeight || 27;
      const above = visibleRect.top >= height + 6;
      record.host.style.top = `${Math.max(5, Math.min(innerHeight - height - 5,above ? visibleRect.top-height-4 : visibleRect.top+4))}px`;
      record.host.style.left = `${Math.max(5, Math.min(innerWidth - width - 5, visibleRect.right - width - 8))}px`;
      const chooser=record.shadow.querySelector('.chooser');
      if(chooser){
        const chooserWidth=Math.min(400,innerWidth-12), chooserHeight=Math.min(chooser.scrollHeight||360,Math.min(360,innerHeight*.6));
        const hostRect=record.host.getBoundingClientRect();
        chooser.style.left=`${Math.max(5,Math.min(innerWidth-chooserWidth-5,hostRect.right-chooserWidth))}px`;
        const below=hostRect.bottom+4, aboveMenu=hostRect.top-chooserHeight-4;
        chooser.style.top=`${below+chooserHeight<=innerHeight-5?below:Math.max(5,aboveMenu)}px`;
      }
    }
  }
  mutationObserver=new MutationObserver(() => { if (!stopped && !pending) { pending = true; scanFrame=requestAnimationFrame(scan); } });
  mutationObserver.observe(document.documentElement, {subtree:true, childList:true});
  document.addEventListener('pointerdown',event=>{
    const path=event.composedPath();
    const inside=[...records].find(record=>path.includes(record.host));
    if(!inside)closeChoosers();
  },{capture:true,signal:listeners.signal});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeChoosers(undefined,true);},{capture:true,signal:listeners.signal});
  function onScroll(event) {
    // Scrolling the quality list itself must remain usable.
    if(event?.composedPath?.().some(node=>[...records].some(record=>node===record.host)))return;
    scrolling=true;closeChoosers();clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>{scrolling=false;position();},140);
  }
  addEventListener('scroll', onScroll, {capture:true,signal:listeners.signal}); addEventListener('resize', position, {signal:listeners.signal});addEventListener('popstate',position,{signal:listeners.signal});addEventListener('hashchange',position,{signal:listeners.signal}); document.addEventListener('fullscreenchange',position,{signal:listeners.signal});document.addEventListener('yt-navigate-finish',position,{signal:listeners.signal});
  function onMessage(message, sender, respond) {
    if (!connected() || sender.id !== api.runtime.id || message.action !== 'collectLinks') return;
    const items = Array.from(document.querySelectorAll('a[href]')).slice(0, 1000).map(a => ({url:direct(a.href), title:a.textContent.trim()})).filter(item => item.url);
    send({action:'remember', items:items.slice(0, 100)}).then(respond,error=>{try{respond({ok:false,error:error.message});}catch{}}).catch(()=>{});
    return true;
  }
  api.runtime.onMessage.addListener(onMessage);
  scan();
})();
