'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.downloader;
const progressMode = new URLSearchParams(location.search).get('progress');
if(progressMode)document.body.classList.add('progress-window');
let state = { downloads: [], settings: {}, integration: {} }, selectedId = null, detailId = null, filter = 'all', category = '', searchTerm = '', sort = 'createdAt', ascending = false, visibleDownloads = [], toastTimer, unsubscribe, unsubscribeCommands;
const selectedIds = new Set();
const pending = new Set();
let pendingReviewId = null;
let selectionDrag = null, suppressRowClick = false;
const dismissedReviews = new Set();
const iconPaths = {
  add:['M17 3a14 14 0 1 0 0 28a14 14 0 0 0 0-28','M17 10v14M10 17h14'],
  resume:['M17 3a14 14 0 1 0 0 28a14 14 0 0 0 0-28','M14 11l9 6-9 6z'],
  stop:['M17 3a14 14 0 1 0 0 28a14 14 0 0 0 0-28','M12 12h10v10H12z'],
  stopall:['M17 3a14 14 0 1 0 0 28a14 14 0 0 0 0-28','M10 10h5v5h-5zM19 10h5v5h-5zM10 19h5v5h-5zM19 19h5v5h-5z'],
  delete:['M5 7h22M12 7V3h8v4M7 10l2 20h14l2-20M13 12v14M19 12v14'],
  clear:['M5 6h22l-2 24H7zM12 6V3h8v3','M10 17l5 5 8-11'],
  options:['M27.7 13.7 L31.2 14.2 L31.2 19.8 L27.7 20.3 L26.9 22.3 L29.0 25.1 L25.1 29.0 L22.3 26.9 L20.3 27.7 L19.8 31.2 L14.2 31.2 L13.7 27.7 L11.7 26.9 L8.9 29.0 L5.0 25.1 L7.1 22.3 L6.3 20.3 L2.8 19.8 L2.8 14.2 L6.3 13.7 L7.1 11.7 L5.0 8.9 L8.9 5.0 L11.7 7.1 L13.7 6.3 L14.2 2.8 L19.8 2.8 L20.3 6.3 L22.3 7.1 L25.1 5.0 L29.0 8.9 L26.9 11.7Z','M17 12.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 0 0 0-9'],
  clock:['M16 4a13 13 0 1 0 0 26a13 13 0 0 0 0-26','M6 5 3 2M26 5l3-3M16 9v8l6-6'],
  startqueue:['M3 8h15M3 17h11M3 26h15','M21 10l10 7-10 7z'],
  stopqueue:['M3 8h15M3 17h11M3 26h15','M21 11h10v12H21z'],
  browser:['M16 3a13 13 0 1 0 0 26a13 13 0 0 0 0-26','M3 16h26M16 3c-8 8-8 18 0 26M16 3c8 8 8 18 0 26M6 8h20M6 24h20']
};
for (const button of $$('[data-icon]')) { const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 34 34'); svg.setAttribute('aria-hidden','true'); for (const data of iconPaths[button.dataset.icon] || []) { const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',data); svg.append(path); } button.prepend(svg); }
function element(tag,className,text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
// Browser registration stays local and is performed by the trusted desktop bridge.
const registrationForm = element('form','registration-form');
const registrationFieldset = element('fieldset');
registrationFieldset.append(element('legend','','Connect browser'));
const browserLine = element('div','form-line');
const browserLabel = element('label','','Browser:'); browserLabel.htmlFor = 'register-browser';
const browserSelect = element('select'); browserSelect.id = 'register-browser';
for (const browser of ['Chrome','Edge','Firefox']) browserSelect.append(element('option','',browser));
browserLine.append(browserLabel,browserSelect);
const idLine = element('div','form-line'); const idLabel = element('label','','Extension ID:'); idLabel.htmlFor = 'register-extension-id';
const idInput = element('input'); idInput.id = 'register-extension-id'; idInput.required = true; idInput.spellcheck = false;
idLine.append(idLabel,idInput);
const registerButton = element('button','button','Connect'); registerButton.type = 'submit';
const registrationResult = element('p','registration-result'); registrationResult.id = 'registration-result'; registrationResult.setAttribute('role','status');
registrationFieldset.append(browserLine,idLine,registerButton,registrationResult); registrationForm.append(registrationFieldset);
$('.setup-steps').after(registrationForm);
registrationForm.addEventListener('submit',async event => { event.preventDefault(); registerButton.disabled = true; registrationResult.textContent = ''; try { const result = await call('registerBrowser',{browser:browserSelect.value,extensionId:idInput.value.trim()}); if (result?.extensionPath) $('#extension-path').value = result.extensionPath; registrationResult.dataset.error = 'false'; registrationResult.textContent = 'Browser connected. Reload the extension, then try a download.'; } catch (error) { registrationResult.dataset.error = 'true'; registrationResult.textContent = messageOf(error); } finally { registerButton.disabled = false; } });
const rememberLabel = element('label','checkbox-label'); const rememberInput = element('input'); rememberInput.type = 'checkbox'; rememberInput.id = 'remember-category-path'; rememberInput.disabled = true; rememberLabel.append(rememberInput,document.createTextNode('Remember this folder for the selected category'));
$('#add-directory').closest('.form-line').after(rememberLabel);
const integrationHelp = $$('.field-help',$('#integration-dialog'));
if (integrationHelp.length) integrationHelp[integrationHelp.length - 1].textContent = 'Video choices open Download File Info, then a separate progress window. Supported HLS videos can be saved as MP4, including separate audio tracks. MP3 is offered when an audio track is detected.';
const manualConnection = element('details'); manualConnection.append(element('summary','','Manual connection command'),$('#registration-command'));
const connectionStep = $$('.setup-steps li')[2]; connectionStep.replaceChildren(document.createTextNode('Copy the extension ID shown by your browser and enter it below. Click Connect, then reload the extension.'));
registrationForm.after(manualConnection);
registrationForm.hidden = true;
manualConnection.hidden = true;
$('.setup-steps').hidden = true;
const automaticConnection = element('p','connection-status','Checking installed browsers…');
automaticConnection.id = 'automatic-connection';
registrationForm.before(automaticConnection);
const retryConnection = element('button','button','Refresh browsers');
retryConnection.type = 'button'; retryConnection.addEventListener('click',()=>openIntegration());
automaticConnection.after(retryConnection);
const installHelp = element('section');
installHelp.append(element('p','','The browser extension adds “Download this video” buttons to web videos. It is included with Awesome Downloader. Follow these steps once for each browser you use.'));
const setupActions = element('div','transfer-buttons');
for (const browser of ['Chrome','Edge']) {
  const button = element('button','button',`Open ${browser} extensions`); button.type = 'button';
  button.addEventListener('click',async()=>{try{await call('browserSetup',{action:'open',browser});}catch(error){notify(messageOf(error),true);}});
  setupActions.append(button);
}
installHelp.append(setupActions);
const steps = element('ol');
for(const text of [
  'Here in Awesome Downloader, click Copy extension folder path above. This copies the location of the included browser extension, not your download folder.',
  'Click Open Chrome extensions or Open Edge extensions above. Your browser opens its Extensions page.',
  'On that browser page, turn on Developer mode. In Edge, you may need to expand the left menu to find it.',
  'Click Load unpacked on the Extensions page. A Windows folder selection window opens.',
  'In that folder selection window, press Ctrl+L to select its address bar at the top. Press Ctrl+V to paste the copied extension folder path, then press Enter. Do not paste into the browser’s web address bar or the Search box.',
  'Click Select Folder (or Select) in the Windows window. Select the extension folder itself; do not select an individual file or its icons subfolder.',
  'Check that Awesome Downloader Integration appears on the browser’s Extensions page and is switched on. Return here and wait for the connection message, then refresh your video page and play the video.'
]) steps.append(element('li','',text));
const extensionFolderLabel=element('label','','Included browser extension folder:');extensionFolderLabel.htmlFor='extension-path';
const extensionFolderInput = $('#extension-path');
const folderActions = element('div','transfer-buttons');
for(const [label,action] of [['Copy extension folder path','copy'],['Show extension folder','folder']]) {
  const button = element('button','button',label); button.type='button';
  button.addEventListener('click',async()=>{try{await call('browserSetup',{action});if(action==='copy')notify('Extension folder path copied. In the Windows window opened by Load unpacked, press Ctrl+L, Ctrl+V, then Enter.');}catch(error){notify(messageOf(error),true);}});
  folderActions.append(button);
}
installHelp.classList.add('browser-setup-guide');
installHelp.append(extensionFolderLabel,extensionFolderInput,folderActions,setupActions,steps); retryConnection.after(installHelp);
let setupPolling = false;
const setupPoll = setInterval(async()=>{
  if(progressMode || !$('#integration-dialog').open || setupPolling)return;
  setupPolling=true;
  try { const info=await call('integration'); $('#extension-path').value=info.extensionPath || ''; automaticConnection.textContent=info.connectionError ? `Setup needs attention: ${info.connectionError}` : info.connectedBrowsers?.length ? `${info.connectedBrowsers.map(b=>b.browser).join(', ')} connected. Refresh your video page to see Download this video.` : 'Waiting for you to add the extension. We will connect it automatically.'; }
  catch(error){automaticConnection.textContent=messageOf(error);}finally{setupPolling=false;}
},3000);
window.addEventListener('beforeunload',()=>clearInterval(setupPoll));
const completionActions=element('div','transfer-buttons');completionActions.id='download-complete-actions';completionActions.hidden=true;
for(const [label,action] of [['Open','open'],['Open with…','openWith'],['Open folder','reveal'],['Close','close']]){const button=element('button','button',label);button.type='button';button.addEventListener('click',()=>action==='close'?$('#details-dialog').close():performAction(detailDownload(),action));completionActions.append(button);}
const completedPanel=element('section','completed-panel');
const completedSummary=element('div','completed-summary');
completedPanel.append(completedSummary);
const completedFields={};
for(const [key,label] of [['url','Address'],['path','The file saved as']]){
  const fieldLabel=element('label','completed-field',label),input=element('input');
  input.readOnly=true; input.setAttribute('aria-label',label);fieldLabel.append(input);completedPanel.append(fieldLabel);completedFields[key]=input;
}
completedPanel.append(completionActions);
const suppressLabel=element('label','checkbox-label'),suppressCompletion=element('input');suppressCompletion.type='checkbox';
suppressLabel.append(suppressCompletion,document.createTextNode("Don't show this dialog again"));completedPanel.append(suppressLabel);
suppressCompletion.addEventListener('change',async()=>{try{await call('settings',{hideCompletionDialog:suppressCompletion.checked});}catch(error){suppressCompletion.checked=!suppressCompletion.checked;notify(messageOf(error),true);}});
$('#details-dialog').append(completedPanel);
const protocolNames={'h2':'HTTP/2','http/1.1':'HTTP/1.1','http/1.0':'HTTP/1.0'};
function badge(text,kind,title){const node=element('span','badge badge-'+kind,text);if(title)node.title=title;return node;}
// On-screen protocol indicators: negotiated HTTP version, multiplexing, adaptive scaling, rate limiting, hashing and integrity.
function renderProtocol(d){
  const box=$('#protocol-badges');if(!box)return;
  const t=d.transfer||{},status=statusOf(d),live=['downloading','connecting'].includes(status),badges=[];
  const proto=protocolNames[d.protocol];
  if(proto)badges.push(badge(proto,d.protocol==='h2'?'good':'plain',d.protocol==='h2'?'Negotiated HTTP/2 (TLS ALPN)':'Negotiated HTTP/1.1'));
  else if(live)badges.push(badge('Negotiating…','plain'));
  if(d.layout==='direct')badges.push(badge('Range blocks','plain','Segmented 2–4 MB range requests written directly into the file'));
  else if(d.resumable===false)badges.push(badge('Single stream','warn','The server does not support byte ranges'));
  if(t.multiplex)badges.push(badge('Multiplexed','good','Blocks share one HTTP/2 session because the server rate-limited extra connections'));
  if(live&&t.configured)badges.push(badge(`${t.active||0}/${t.allowed} connections`+(t.allowed<t.configured?` (limit ${t.configured})`:''),t.allowed<t.configured?'warn':'plain','Active / currently allowed connections'));
  if(t.lastThrottle&&live)badges.push(badge(`Server throttling (HTTP ${t.lastThrottle.statusCode})`,'bad',`Connections were scaled down to ${t.lastThrottle.allowed}; waiting ${Math.ceil((t.lastThrottle.waitMs||0)/1000)} s`));
  if(live&&t.drops)badges.push(badge(`${t.drops} slow dropped`,'plain','Slow connections replaced by faster ones'));
  if(t.adaptive===false&&live)badges.push(badge('Adaptive off','plain'));
  if(t.hashing?.enabled&&live)badges.push(badge(t.hashing.threaded?'Hashing (worker)':'Hashing','plain','SHA-256 and MD5 are computed while downloading'));
  const i=d.integrity;
  if(i)badges.push(badge(i.status==='verified'?'Checksum verified':i.status==='mismatch'?'Checksum MISMATCH':i.status==='warning'?'Server checksum differs':'Checksums computed',i.status==='verified'?'good':i.status==='mismatch'||i.status==='warning'?'bad':'plain'));
  box.replaceChildren(...badges);
  const content=$('#details-content');
  if(content&&i){content.append(element('dt','','SHA-256'),element('dd','mono',i.sha256||'—'),element('dt','','MD5'),element('dd','mono',i.md5||'—'));
    if(i.expected)content.append(element('dt','','Expected'),element('dd','mono',`${i.expected.algorithm}:${i.expected.value} (${i.expected.source==='user'?'entered by you':'announced by server'})`));}
  const list=$('#source-list'),sources=t.sources||[];
  if(list){list.hidden=!(live&&sources.length>1);list.replaceChildren();
    if(!list.hidden){list.append(element('p','connection-caption','Mirrors'));const table=element('table','connections-table');
      const head=element('tr');for(const label of ['Host','Protocol','Conns','Speed','State'])head.append(element('th','',label));table.append(head);
      for(const x of sources){const row=element('tr');row.append(element('td','',x.host),element('td','',protocolNames[x.protocol]||x.protocol||'—'),element('td','',`${x.active}/${x.allowed}`),element('td','',`${bytes(x.speed)}/s`),element('td','',x.dead?'Unavailable':x.coolingMs>0?'Cooling down':'Active'));table.append(row);}
      list.append(table);}}
}
const renderTransferDetails=renderDetails;
renderDetails=function(){
  renderTransferDetails();const d=detailDownload();if(d)renderProtocol(d);if(!d||statusOf(d)!=='completed')return;
  completedSummary.replaceChildren(element('span','completed-icon','✓'),element('div','',`Download complete\nDownloaded ${bytes(d.total||d.downloaded)} (${Math.round(d.total||d.downloaded||0)} Bytes)`));
  completedFields.url.value=d.url||'';completedFields.path.value=d.path||'';
  suppressCompletion.checked=state.settings.hideCompletionDialog===true;
};
function numeric(value) { const result = Number(value); return Number.isFinite(result) && result > 0 ? result : 0; }
function statusOf(d) { const value = String(d.status || 'queued').toLowerCase(); return ({active:'downloading',running:'downloading',probing:'connecting',complete:'completed',done:'completed',error:'failed',canceled:'cancelled',pending:'queued'})[value] || value; }
function categoryOf(d) { const value = String(d.category || '').toLowerCase(); if (/video/.test(value)) return 'Video'; if (/audio|music/.test(value)) return 'Audio'; if (/doc|text/.test(value)) return 'Documents'; if (/arch|compress/.test(value)) return 'Archives'; if (/program/.test(value)) return 'Programs'; if (/image|picture|photo/.test(value)) return 'Images'; return 'Other'; }
function bytes(value) { const size = numeric(value); if (!size) return '0 B'; const power = Math.min(4,Math.floor(Math.log(size) / Math.log(1024))); return `${(size / 1024 ** power).toFixed(power ? 2 : 0)} ${['B','KB','MB','GB','TB'][power]}`; }
function date(value) { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString([],{dateStyle:'short',timeStyle:'short'}); }
function timeLeft(d) { const total=numeric(d.total)||numeric(d.streamProgress?.estimatedBytes); if (!total || !numeric(d.speed)) return ''; const seconds=Math.max(0,Math.ceil((total-numeric(d.downloaded))/numeric(d.speed))); return ((!d.total||d.estimated)?'≈ ':'')+duration(seconds); }
function sizeLabel(d) { return numeric(d.total)?(d.estimated?'≈ ':'')+bytes(d.total):d.streamProgress?.estimatedBytes?'≈ '+bytes(d.streamProgress.estimatedBytes):d.kind==='hls'?'Calculating from segments…':'Not supplied by server'; }
function duration(seconds) { return seconds < 60 ? `${Math.ceil(seconds)} sec` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} hr ${Math.floor(seconds % 3600 / 60)} min`; }
function percentage(d) { return statusOf(d) === 'completed' ? 100 : numeric(d.total) ? Math.min(100,numeric(d.downloaded) / numeric(d.total) * 100) : d.streamProgress?.total ? d.streamProgress.completed/d.streamProgress.total*100 : null; }
function messageOf(error) { return error?.message || String(error || 'The operation failed.'); }
function notify(message,error = false) { clearTimeout(toastTimer); $('#toast-text').textContent = message; $('#toast').dataset.error = String(error); $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; },error ? 14000 : 7000); }
async function call(method,...args) { if (!api || typeof api[method] !== 'function') throw new Error('The download service is unavailable. Restart Awesome Downloader.'); const result = await api[method](...args); if (result?.error && !result.downloads) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'The request failed.'); return result; }
function acceptSnapshot(snapshot) { if (!snapshot || !Array.isArray(snapshot.downloads)) return; state = {downloads:snapshot.downloads,settings:snapshot.settings || state.settings,integration:snapshot.integration || state.integration}; const valid=new Set(state.downloads.map(d=>d.id)); for(const id of selectedIds)if(!valid.has(id))selectedIds.delete(id); if (!valid.has(selectedId)) selectedId = selectedIds.values().next().value || null; $('#download-list').setAttribute('aria-busy','false'); $('#connection-label').textContent = 'Connected'; render(); if (!$$('dialog[open]').length) { const review = state.downloads.find(d => d.needsReview && !dismissedReviews.has(d.id)); if (review) openReview(review.id); } }
async function refresh() { acceptSnapshot(await call('snapshot')); }
function selected() { return state.downloads.find(d => d.id === selectedId); }
function canResume(d) { return d && !d.needsReview && ['paused','queued','scheduled','failed','cancelled'].includes(statusOf(d)); }
function canPause(d) { return d && !d.needsReview && ['downloading','connecting','queued','scheduled','assembling'].includes(statusOf(d)); }
function matches(d) { const status = statusOf(d); if (filter === 'completed' && status !== 'completed') return false; if (filter === 'unfinished' && status === 'completed') return false; if (filter === 'queued' && !['queued','scheduled','paused'].includes(status)) return false; if (category && categoryOf(d) !== category) return false; return !searchTerm || `${d.filename || ''} ${d.url || ''}`.toLowerCase().includes(searchTerm); }
function paintSelection() { $$('.download-row').forEach(row => { const active=selectedIds.has(row.dataset.id); row.classList.toggle('selected',active); row.setAttribute('aria-selected',String(active)); }); updateControls(); }
function selectDownload(id,{additive=false,toggle=false}={}) { if(!additive)selectedIds.clear(); if(toggle&&selectedIds.has(id))selectedIds.delete(id); else if(id)selectedIds.add(id); selectedId=selectedIds.has(id)?id:(selectedIds.values().next().value||null); paintSelection(); }
function rowFor(d) { const status = statusOf(d), percent = percentage(d); const row = element('tr','download-row'); row.dataset.id = d.id; row.dataset.status = status; row.classList.toggle('selected',selectedIds.has(d.id)); row.setAttribute('aria-selected',String(selectedIds.has(d.id))); const nameCell = element('td'); nameCell.title = d.filename || d.url; const name = element('span','file-name'); name.append(element('span','file-type-icon',status === 'completed' ? '✓' : status === 'failed' ? '!' : '↓'),element('span','',d.filename || 'Preparing file…')); nameCell.append(name); const names = {completed:'Complete',downloading:percent === null ? 'Receiving data…' : `${percent.toFixed(2)}%`,connecting:'Connecting…',assembling:'Finalizing…',queued:'Queued',scheduled:'Scheduled',paused:'Stopped',cancelled:'Cancelled',failed:'Error'}; const statusCell = element('td',`row-status ${status}`,names[status] || status); statusCell.title = d.error || names[status] || status; const description = d.description || d.error || (d.scheduledAt && status === 'scheduled' ? `Starts ${date(d.scheduledAt)}` : ''); const descriptionCell = element('td','',description); descriptionCell.title = description; row.append(nameCell,element('td','',['queued','scheduled','paused'].includes(status) ? '✓' : ''),element('td','',sizeLabel(d)),statusCell,element('td','',status === 'downloading' ? timeLeft(d) : ''),element('td','',status === 'downloading' ? `${bytes(d.speed)}/sec` : ''),element('td','',date(d.lastTry || d.createdAt)),descriptionCell); row.addEventListener('click',event => {if(suppressRowClick)return;selectDownload(d.id,{additive:event.ctrlKey||event.metaKey,toggle:event.ctrlKey||event.metaKey});}); row.addEventListener('dblclick',() => showDetails(d.id)); row.addEventListener('contextmenu',event => { event.preventDefault(); selectDownload(d.id); showDetails(d.id); }); return row; }
function updateControls() { const d = selected(), busy = d && pending.has(d.id); $('#resume-selected').disabled = (!canResume(d) && !d?.needsReview) || busy; $('#stop-selected').disabled = !canPause(d) || busy; $('#remove-selected').disabled = !d || busy; $('#open-selected').disabled = !d || statusOf(d) !== 'completed'; $('#reveal-selected').disabled = !d; $('#details-selected').disabled = !d; $('#pause-all').disabled = !state.downloads.some(canPause); $('#stop-queue').disabled = $('#pause-all').disabled; $('#resume-all').disabled = !state.downloads.some(canResume); $('#remove-completed').disabled = !state.downloads.some(d => statusOf(d) === 'completed'); $('#scheduler-start').disabled = $('#resume-all').disabled; $('#scheduler-stop').disabled = $('#pause-all').disabled; }
function render() { visibleDownloads = state.downloads.filter(matches).sort((a,b) => { const result = sort === 'total' ? numeric(a.total) - numeric(b.total) : sort === 'createdAt' ? new Date(a.createdAt || 0) - new Date(b.createdAt || 0) : String(a[sort] || '').localeCompare(String(b[sort] || '')); return ascending ? result : -result; }); $('#download-list').replaceChildren(...visibleDownloads.map(rowFor)); $('#empty-state').hidden = visibleDownloads.length > 0; $('#empty-message').textContent = searchTerm ? 'No downloads match your search.' : 'No downloads to display.'; const complete = state.downloads.filter(d => statusOf(d) === 'completed').length; $('#list-count').textContent = `${visibleDownloads.length} ${visibleDownloads.length === 1 ? 'download' : 'downloads'}${state.downloads.length !== visibleDownloads.length ? ` of ${state.downloads.length}` : ''} (${complete} completed)`; $('#status-summary').textContent = `${bytes(state.downloads.reduce((sum,d) => sum + numeric(d.speed),0))}/sec`; updateControls(); if ($('#details-dialog').open) renderDetails(); if ($('#scheduler-dialog').open) renderScheduler(); }
async function performAction(d,action) { if (!d || pending.has(d.id)) return; if (action === 'remove' && !window.confirm(`Delete “${d.filename || 'this download'}” from the download list?\n\nThe downloaded file will remain on your PC.`)) return; pending.add(d.id); updateControls(); try { await call('action',{id:d.id,action}); await refresh(); } catch (error) { notify(messageOf(error),true); } finally { pending.delete(d.id); updateControls(); if ($('#details-dialog').open) renderDetails(); } }
async function bulkAction(action) { const downloads = state.downloads.filter(action === 'pause' ? canPause : canResume); const results = await Promise.allSettled(downloads.map(d => call('action',{id:d.id,action:action === 'resume' && ['failed','cancelled'].includes(statusOf(d)) ? 'retry' : action}))); const failures = results.filter(r => r.status === 'rejected'); if (failures.length) notify(`${failures.length} operation(s) failed: ${messageOf(failures[0].reason)}`,true); try { await refresh(); } catch (error) { notify(messageOf(error),true); } }
async function removeCompleted() { const downloads = state.downloads.filter(d => statusOf(d) === 'completed'); if (!downloads.length || !window.confirm(`Delete ${downloads.length} completed download(s) from the list?\n\nThe downloaded files will remain on your PC.`)) return; const results = await Promise.allSettled(downloads.map(d => call('action',{id:d.id,action:'remove'}))); const failures = results.filter(r => r.status === 'rejected'); if (failures.length) notify(messageOf(failures[0].reason),true); try { await refresh(); } catch (error) { notify(messageOf(error),true); } }
function showDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function openAdd(text = '',scheduled = '') { pendingReviewId = null; $('#add-error').hidden = true; $('#download-urls').value = text; $('#download-mirrors').value = ''; $('#download-checksum').value = ''; $('#download-extract').checked = false; $('#download-quality').value = ''; $('#download-container').value = ''; $('#download-urls').readOnly = false; $('#download-filename').value = ''; $('#download-description').value = ''; $('#download-category').value = ''; rememberInput.checked = false; rememberInput.disabled = true; $('#download-schedule').value = scheduled; $('#add-directory').value = state.settings.defaultDirectory || ''; showDialog('#add-dialog'); $('#download-urls').focus(); }
function openReview(id) { if(progressMode)return; const d = state.downloads.find(item => item.id === id && item.needsReview); if (!d || dismissedReviews.has(id)) return; openAdd(d.url || ''); pendingReviewId = id; $('#download-urls').readOnly = true; $('#download-filename').value = d.filename || ''; $('#download-description').value = d.description || ''; $('#download-category').value = d.category || ''; rememberInput.disabled = !$('#download-category').value; $('#add-directory').value = d.directory || state.settings.defaultDirectory || ''; }
async function dismissReview() { if (!pendingReviewId) return; const id = pendingReviewId; dismissedReviews.add(id); pendingReviewId = null; try { await call('action',{id,action:'remove'}); await refresh(); } catch (error) { notify(messageOf(error),true); } }
function showDetails(id) { if (state.downloads.find(d => d.id === id)?.needsReview) { openReview(id); return; } if(!progressMode){call('openProgress',{id}).catch(e=>notify(messageOf(e),true));return;} detailId = id; $('#detail-speed-limit').value = state.settings.speedLimitKbps || 0; $('#notify-complete').checked = state.settings.notifyOnComplete !== false; $('#reveal-complete').checked = state.settings.revealOnComplete === true; $('#completion-result').textContent = ''; setDetailTab('status'); renderDetails(); showDialog('#details-dialog'); }
function renderDetails() { const d = state.downloads.find(d => d.id === detailId); if (!d) { $('#details-dialog').close(); return; } const status = statusOf(d), percent = percentage(d), content = $('#details-content'); $('#details-title').textContent = `${percent !== null ? `${Math.floor(percent)}% ` : ''}${d.filename || 'Download status'}`; $('#transfer-source').textContent = d.url || ''; $('#transfer-source').title = d.url || ''; const names = {completed:'Complete',downloading:'Receiving data…',connecting:'Connecting…',paused:'Stopped',queued:'Queued',scheduled:'Scheduled',failed:'Error',cancelled:'Cancelled',assembling:'Finalizing…'}; const rows = [['Status',names[status] || status],['File size',sizeLabel(d)],['Downloaded',`${bytes(d.downloaded)}${percent !== null ? ` (${percent.toFixed(2)}%)` : ''}`],['Transfer rate',status === 'downloading' ? `${bytes(d.speed)}/sec` : '0 B/sec'],['Time left',status === 'downloading' ? timeLeft(d) || 'Estimating…' : '—'],['Resume capability',d.resumable === true ? 'Yes' : d.resumable === false ? 'No' : 'Checking…']]; if (numeric(d.duration)) rows.splice(1,0,['Video duration',`${Math.floor(d.duration/60)} min ${Math.floor(d.duration%60)} sec`]); if(d.streamProgress?.total&&status!=='completed')rows.push(['Segments',`${d.streamProgress.completed} / ${d.streamProgress.total}`]); if (d.scheduledAt && status === 'scheduled') rows.push(['Start at',date(d.scheduledAt)]); content.replaceChildren(); for (const [label,value] of rows) content.append(element('dt','',label),element('dd','',value)); const progress = $('#detail-progress'); if (percent === null && ['downloading','connecting'].includes(status)) progress.removeAttribute('value'); else progress.value = percent || 0; const segments = Array.isArray(d.connectionsProgress) ? d.connectionsProgress : []; const bars = $('#segment-bars'), map = $('#segment-map'); bars.replaceChildren(); map.replaceChildren(); for (let index = 0; index < segments.length; index++) { const segment = segments[index]; const row = element('tr'); const segmentStatus = segment.status === 'complete' || segment.status === 'completed' ? 'Completed.' : segment.status || (status === 'downloading' ? 'Receiving data…' : names[status] || status); row.append(element('td','',String(index + 1)),element('td','',bytes(segment.downloaded)),element('td','',segmentStatus)); bars.append(row); const bar = element('progress'); bar.max = 100; const total = numeric(segment.total); bar.value = total ? Math.min(100,numeric(segment.downloaded) / total * 100) : 0; bar.setAttribute('aria-label',`Connection ${index + 1} progress`); if (!total && status === 'downloading') bar.removeAttribute('value'); map.append(bar); } $('#segment-note').textContent = segments.length ? `${segments.length} connection(s)` : status === 'completed' ? 'Download completed.' : 'Connection progress appears when the transfer starts.'; $('#detail-error').textContent = d.error || ''; $('#detail-error').hidden = !d.error; $('#detail-open').disabled = status !== 'completed'; $('#detail-resume').disabled = !canResume(d) || pending.has(d.id); $('#detail-stop').disabled = !canPause(d) || pending.has(d.id); $('#detail-cancel').disabled = ['completed','cancelled'].includes(status) || pending.has(d.id); $('.transfer-buttons').hidden=status==='completed'; $('#download-complete-actions').hidden=status!=='completed'; $('#details-dialog').classList.toggle('is-complete',status==='completed'); }
function setDetailTab(name) { for (const tab of ['status','speed','completion']) { const active = tab === name; $(`#tab-${tab}`).classList.toggle('active-tab',active); $(`#tab-${tab}`).setAttribute('aria-selected',String(active)); $(`#${tab}-panel`).hidden = !active; } }
function setView(nextFilter,nextCategory = '') { filter = nextFilter; category = nextCategory; $$('[data-filter],[data-category]').forEach(button => { const active = nextCategory ? button.dataset.category === nextCategory : button.dataset.filter === nextFilter; button.classList.toggle('selected',active); if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }); render(); }
function setSettingsTab(name) { for (const tab of ['general','connection','integrity','about']) { const active = tab === name; $(`#stab-${tab}`).classList.toggle('active-tab',active); $(`#stab-${tab}`).setAttribute('aria-selected',String(active)); $(`#spanel-${tab}`).hidden = !active; } }
function openSettings() { const settings = state.settings; setSettingsTab('general'); $('#set-notify').checked = settings.notifyOnComplete !== false; $('#set-reveal').checked = settings.revealOnComplete === true; $('#set-confirm').checked = settings.confirmBrowserDownloads !== false; $('#set-clipboard').checked = settings.watchClipboard !== false; $('#set-tray').checked = settings.closeToTray !== false; $('#set-login').checked = settings.launchAtLogin === true; $('#set-http2').checked = settings.http2 !== false; $('#set-adaptive').checked = settings.adaptive !== false; $('#set-verify').checked = settings.verifyHashes !== false; $('#set-workers').checked = settings.workerThreads !== false; $('#set-direct').checked = settings.directWrite !== false; $('#memory-budget').value = settings.memoryBudgetMb || 256; $('#default-directory').value = settings.defaultDirectory || ''; $('#max-concurrent').value = settings.maxConcurrent || 3; $('#connections').value = settings.connections || 8; $('#speed-limit').value = settings.speedLimitKbps || 0; $('#settings-error').hidden = true; showDialog('#settings-dialog'); }
function renderScheduler() { const downloads = state.downloads.filter(d => statusOf(d) === 'scheduled').sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)); const list = $('#scheduled-list'); list.replaceChildren(); if (!downloads.length) list.append(element('p','field-help','No scheduled downloads.')); for (const d of downloads) { const row = element('div','scheduled-item'); const name = element('span','',d.filename); name.title = d.filename; row.append(name,element('time','',date(d.scheduledAt))); list.append(row); } }
function openScheduler() { renderScheduler(); showDialog('#scheduler-dialog'); }
async function openIntegration() { try { const info = await call('integration') || state.integration; $('#extension-path').value = info.extensionPath || ''; automaticConnection.textContent = info.connectionError ? `Browser setup needs attention: ${info.connectionError}` : info.connectedBrowsers?.length ? `${info.connectedBrowsers.map(b=>b.browser).join(', ')} connected automatically. Click Download this video in your browser to choose a file.` : 'Ready to connect automatically when the browser extension is installed.'; const issues = (info.registration || []).filter(r => r.problem && r.problem !== 'not connected').map(r => `${r.browser}: ${r.problem}${r.repairError ? ` (${r.repairError})` : ''}`); if (issues.length) automaticConnection.textContent += ` \u2014 ${issues.join('; ')}. Repair was attempted; if the browser still says the connector is not found, click Refresh and reload the extension.`; $('#integration-port').value = info.port ? 'Ready' : 'Unavailable'; showDialog('#integration-dialog'); } catch (error) { notify(messageOf(error),true); } }
const commands = {add:() => openAdd(),paste:async () => { try { openAdd(await call('clipboard')); } catch (error) { notify(messageOf(error),true); } },find:() => $('#search').focus(),settings:openSettings,integration:openIntegration,scheduler:openScheduler,pauseAll:() => bulkAction('pause'),resumeAll:() => bulkAction('resume'),removeCompleted};
commands.find = () => { $('.list-search').classList.add('visible'); $('#search').focus(); };
commands.details = () => { if (selectedId) showDetails(selectedId); };
commands.remove = () => performAction(selected(),'remove');
commands.all = () => setView('all');
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'f') commands.find(); if (event.key === 'Escape') $('.list-search').classList.remove('visible'); });
$('#new-download').addEventListener('click',commands.add); $('#settings-button').addEventListener('click',openSettings); $('#integration-button').addEventListener('click',openIntegration); $('#scheduler-button').addEventListener('click',openScheduler); $('#pause-all').addEventListener('click',commands.pauseAll); $('#stop-queue').addEventListener('click',commands.pauseAll); $('#resume-all').addEventListener('click',commands.resumeAll); $('#remove-completed').addEventListener('click',removeCompleted);
$('#resume-selected').addEventListener('click',() => { const d = selected(); if (d?.needsReview) { openReview(d.id); return; } performAction(d,d && ['failed','cancelled'].includes(statusOf(d)) ? 'retry' : 'resume'); }); $('#stop-selected').addEventListener('click',() => performAction(selected(),'pause')); $('#remove-selected').addEventListener('click',() => performAction(selected(),'remove')); $('#open-selected').addEventListener('click',() => performAction(selected(),'open')); $('#reveal-selected').addEventListener('click',() => performAction(selected(),'reveal')); $('#details-selected').addEventListener('click',() => { if (selectedId) showDetails(selectedId); });
const detailDownload = () => state.downloads.find(d => d.id === detailId);
$('#detail-open').addEventListener('click',() => performAction(detailDownload(),'open')); $('#detail-folder').addEventListener('click',() => performAction(detailDownload(),'reveal')); $('#detail-stop').addEventListener('click',() => performAction(detailDownload(),'pause')); $('#detail-cancel').addEventListener('click',() => performAction(detailDownload(),'cancel')); $('#detail-resume').addEventListener('click',() => { const d = detailDownload(); performAction(d,d && ['failed','cancelled'].includes(statusOf(d)) ? 'retry' : 'resume'); });
$('#toggle-details').addEventListener('click',async() => { const details = $('#connection-details'); details.hidden = !details.hidden; document.body.classList.toggle('details-collapsed',details.hidden); $('#toggle-details').textContent = details.hidden ? '>> Show details' : '<< Hide details'; if(progressMode)try{await call('resizeProgress',{expanded:!details.hidden});}catch(error){notify(messageOf(error),true);} });
for (const tab of ['status','speed','completion']) $(`#tab-${tab}`).addEventListener('click',() => setDetailTab(tab));
$('#detail-speed-form').addEventListener('submit',async event => { event.preventDefault(); $('#detail-speed-error').hidden = true; try { await call('settings',{speedLimitKbps:Number($('#detail-speed-limit').value)}); await refresh(); notify('Global speed limit saved.'); } catch (error) { $('#detail-speed-error').textContent = messageOf(error); $('#detail-speed-error').hidden = false; } });
$('#completion-form').addEventListener('submit',async event => { event.preventDefault(); try { await call('settings',{notifyOnComplete:$('#notify-complete').checked,revealOnComplete:$('#reveal-complete').checked}); await refresh(); $('#completion-result').textContent = ' Saved.'; } catch (error) { $('#completion-result').textContent = ` ${messageOf(error)}`; } });
$('#scheduler-start').addEventListener('click',commands.resumeAll); $('#scheduler-stop').addEventListener('click',commands.pauseAll); $('#schedule-new').addEventListener('click',() => { $('#scheduler-dialog').close(); const future = new Date(Date.now() + 3600000); openAdd('',new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0,16)); });
$('#grabber-button').addEventListener('click',() => notify('Website grabber projects are not available in this build. Use Add URL to add direct download links.'));
$$('[data-filter]').forEach(button => button.addEventListener('click',() => setView(button.dataset.filter))); $$('[data-category]').forEach(button => button.addEventListener('click',() => setView('all',button.dataset.category))); $$('[data-sort]').forEach(button => button.addEventListener('click',() => { const next = button.dataset.sort; ascending = sort === next ? !ascending : true; sort = next; render(); })); $('#search').addEventListener('input',event => { searchTerm = event.target.value.trim().toLowerCase(); render(); });
const categoryExpander=$('.tree-expander[aria-controls]');
function setCategoryTreeExpanded(expanded){const children=$(`#${categoryExpander.getAttribute('aria-controls')}`);children.hidden=!expanded;categoryExpander.textContent=expanded?'⊟':'⊞';categoryExpander.setAttribute('aria-expanded',String(expanded));categoryExpander.setAttribute('aria-label',`${expanded?'Collapse':'Expand'} All Downloads categories`);}
categoryExpander.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();setCategoryTreeExpanded(categoryExpander.getAttribute('aria-expanded')!=='true');});
categoryExpander.addEventListener('keydown',event=>{if(!['Enter',' '].includes(event.key))return;event.preventDefault();event.stopPropagation();setCategoryTreeExpanded(categoryExpander.getAttribute('aria-expanded')!=='true');});
const tableScroll=$('#table-scroll'),selectionRectangle=$('#selection-rectangle');
const tablePoint=event=>{const bounds=tableScroll.getBoundingClientRect();return{x:event.clientX-bounds.left+tableScroll.scrollLeft,y:event.clientY-bounds.top+tableScroll.scrollTop};};
tableScroll.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('thead')||event.target.closest('button'))return;
  const point=tablePoint(event),row=event.target.closest('.download-row');
  selectionDrag={pointerId:event.pointerId,startX:point.x,startY:point.y,row,base:(event.ctrlKey||event.metaKey)?new Set(selectedIds):new Set(),moved:false};
  tableScroll.setPointerCapture(event.pointerId);event.preventDefault();
});
tableScroll.addEventListener('pointermove',event=>{
  if(!selectionDrag||selectionDrag.pointerId!==event.pointerId)return;
  const point=tablePoint(event),dx=point.x-selectionDrag.startX,dy=point.y-selectionDrag.startY;
  if(!selectionDrag.moved&&Math.hypot(dx,dy)<4)return;
  selectionDrag.moved=true;
  const left=Math.min(selectionDrag.startX,point.x),top=Math.min(selectionDrag.startY,point.y),right=Math.max(selectionDrag.startX,point.x),bottom=Math.max(selectionDrag.startY,point.y);
  Object.assign(selectionRectangle.style,{left:`${left}px`,top:`${top}px`,width:`${Math.max(1,right-left)}px`,height:`${Math.max(1,bottom-top)}px`});selectionRectangle.hidden=false;
  selectedIds.clear();for(const id of selectionDrag.base)selectedIds.add(id);
  const viewport=tableScroll.getBoundingClientRect();
  for(const row of $$('.download-row')){const rect=row.getBoundingClientRect(),rowLeft=rect.left-viewport.left+tableScroll.scrollLeft,rowTop=rect.top-viewport.top+tableScroll.scrollTop;if(rowLeft<right&&rowLeft+rect.width>left&&rowTop<bottom&&rowTop+rect.height>top)selectedIds.add(row.dataset.id);}
  selectedId=selectedIds.values().next().value||null;paintSelection();event.preventDefault();
});
function finishMarquee(event){if(!selectionDrag||selectionDrag.pointerId!==event.pointerId)return;const moved=selectionDrag.moved,row=selectionDrag.row;try{tableScroll.releasePointerCapture(event.pointerId);}catch{}selectionDrag=null;selectionRectangle.hidden=true;if(moved){suppressRowClick=true;setTimeout(()=>{suppressRowClick=false;},0);}else if(!row)selectDownload(null);}
tableScroll.addEventListener('pointerup',finishMarquee);tableScroll.addEventListener('pointercancel',finishMarquee);
$('#table-scroll').addEventListener('keydown',event => { if (!visibleDownloads.length) return; const index = visibleDownloads.findIndex(d => d.id === selectedId); if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleDownloads.length - 1 : Math.max(0,Math.min(visibleDownloads.length - 1,index + (event.key === 'ArrowDown' ? 1 : -1))); selectDownload(visibleDownloads[next].id); $$('.download-row').find(row => row.dataset.id === selectedId)?.scrollIntoView({block:'nearest'}); } if (event.key === 'Enter' && selectedId) showDetails(selectedId); if (event.key === 'Delete') performAction(selected(),'remove'); });
$('#dismiss-toast').addEventListener('click',() => { $('#toast').hidden = true; }); $$('[data-close]').forEach(button => button.addEventListener('click',() => { const dialog = button.closest('dialog'); dialog.close(); if (dialog.id === 'add-dialog') dismissReview(); })); $('#add-dialog').addEventListener('cancel',() => dismissReview()); document.addEventListener('keydown',event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!$$('dialog[open]').length) openAdd(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !$$('dialog[open]').length) { event.preventDefault(); $('#search').focus(); } });
$('#paste-button').addEventListener('click',async () => { try { $('#download-urls').value = await call('clipboard'); $('#download-urls').focus(); } catch (error) { $('#add-error').textContent = messageOf(error); $('#add-error').hidden = false; } }); $('#add-browse').addEventListener('click',async () => { try { const path = await call('chooseDirectory'); if (typeof path === 'string' && path) $('#add-directory').value = path; } catch (error) { $('#add-error').textContent = messageOf(error); $('#add-error').hidden = false; } });
$('#download-category').addEventListener('change',event => { const folder = state.settings.categoryDirectories?.[event.target.value]; if (folder) $('#add-directory').value = folder; rememberInput.disabled = !event.target.value; if (rememberInput.disabled) rememberInput.checked = false; });
$('#add-form').addEventListener('submit',async event => {
  event.preventDefault();
  const errorElement = $('#add-error'); errorElement.hidden = true;
  const urls = $('#download-urls').value.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
  const filename = $('#download-filename').value.trim(), scheduled = $('#download-schedule').value;
  try {
    if (!urls.length) throw new Error('Enter at least one download address.');
    for (const url of urls) { let parsed; try { parsed = new URL(url); } catch { throw new Error(`Invalid address: ${url}`); } if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Download addresses must begin with http:// or https://.'); }
    if (filename && urls.length !== 1) throw new Error('A custom file name can only be used for a single address.');
    const mirrors = $('#download-mirrors').value.split(/\r?\n/).map(url => url.trim()).filter(Boolean), checksum = $('#download-checksum').value.trim();
    for (const url of mirrors) { let parsed; try { parsed = new URL(url); } catch { throw new Error(`Invalid mirror address: ${url}`); } if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Mirror addresses must begin with http:// or https://.'); }
    if ((mirrors.length || checksum) && urls.length !== 1) throw new Error('Mirrors and a checksum can only be used with a single address.');
    const scheduledAt = scheduled ? new Date(scheduled).toISOString() : undefined;
    if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) throw new Error('Choose a future start time or leave Start at empty.');
    $('#add-submit').disabled = true; $('#add-later').disabled = true;
    const directory = $('#add-directory').value, selectedCategory = $('#download-category').value, description = $('#download-description').value.trim();
    if (rememberInput.checked && selectedCategory && directory) await call('settings',{categoryDirectories:{...state.settings.categoryDirectories,[selectedCategory]:directory}});
    const extract = $('#download-extract').checked, container = $('#download-container').value, quality = $('#download-quality').value;
    if (extract && urls.length !== 1) throw new Error('Page video extraction works with a single address at a time.');
    const data = {...(extract ? {extract: true, ...(quality ? {extractFormat: quality} : {}), ...(container ? {outputFormat: container} : {})} : {}),...(mirrors.length ? {mirrors} : {}),...(checksum ? {checksum} : {}),...(filename ? {filename} : {}),...(scheduledAt ? {scheduledAt} : {}),...(directory ? {directory} : {}),...(selectedCategory ? {category:selectedCategory} : {}),description,queueOnly:event.submitter?.dataset.queueOnly === 'true'};
    const ids = pendingReviewId ? await call('review',{id:pendingReviewId,...data}) : await call('add',{urls,...data});
    pendingReviewId = null; $('#add-dialog').close(); setView('all'); await refresh();
    if (!data.queueOnly && !scheduledAt && ids?.length === 1) { selectDownload(ids[0]); showDetails(ids[0]); }
  } catch (error) { errorElement.textContent = messageOf(error); errorElement.hidden = false; }
  finally { $('#add-submit').disabled = false; $('#add-later').disabled = false; }
});
$('#choose-directory').addEventListener('click',async () => { try { const path = await call('chooseDirectory'); if (typeof path === 'string' && path) $('#default-directory').value = path; } catch (error) { $('#settings-error').textContent = messageOf(error); $('#settings-error').hidden = false; } }); $('#settings-form').addEventListener('submit',async event => { event.preventDefault(); const button = $('button[type=submit]',event.target); $('#settings-error').hidden = true; button.disabled = true; try { await call('settings',{defaultDirectory:$('#default-directory').value.trim(),maxConcurrent:Number($('#max-concurrent').value),connections:Number($('#connections').value),speedLimitKbps:Number($('#speed-limit').value),notifyOnComplete:$('#set-notify').checked,revealOnComplete:$('#set-reveal').checked,confirmBrowserDownloads:$('#set-confirm').checked,watchClipboard:$('#set-clipboard').checked,closeToTray:$('#set-tray').checked,launchAtLogin:$('#set-login').checked,http2:$('#set-http2').checked,adaptive:$('#set-adaptive').checked,verifyHashes:$('#set-verify').checked,workerThreads:$('#set-workers').checked,directWrite:$('#set-direct').checked,memoryBudgetMb:Number($('#memory-budget').value)}); await refresh(); $('#settings-dialog').close(); } catch (error) { $('#settings-error').textContent = messageOf(error); $('#settings-error').hidden = false; } finally { button.disabled = false; } });
for (const tab of ['general','connection','integrity','about']) $(`#stab-${tab}`).addEventListener('click',() => setSettingsTab(tab));
$('#open-about').addEventListener('click',async () => { try { await call('about'); } catch (error) { $('#settings-error').textContent = messageOf(error); $('#settings-error').hidden = false; } });
async function start() { try { await refresh(); if (typeof api.subscribe === 'function') unsubscribe = api.subscribe(snapshot => { if (snapshot?.downloads) acceptSnapshot(snapshot); else refresh().catch(error => notify(messageOf(error),true)); }); if (typeof api.onCommand === 'function') unsubscribeCommands = api.onCommand(async payload => { const command = typeof payload === 'string' ? payload : payload?.command; if (command === 'clipboardLink') { if (!$$('dialog[open]').length && typeof payload.text === 'string') { openAdd(payload.text); if (payload.extract) { $('#download-extract').checked = true; document.querySelector('.advanced-fields').open = true; } } return; }
 if (command === 'reviewDownload') { try { await refresh(); if (!$$('dialog[open]').length) openReview(payload.id); } catch (error) { notify(messageOf(error),true); } return; } if (!$$('dialog[open]').length || ['pauseAll','resumeAll','removeCompleted'].includes(command)) commands[command]?.(); }); } catch (error) { $('#download-list').setAttribute('aria-busy','false'); $('#list-count').textContent = 'Download service unavailable'; $('#connection-label').textContent = 'Disconnected'; notify(messageOf(error),true); } }
window.addEventListener('beforeunload',() => { if (typeof unsubscribe === 'function') unsubscribe(); if (typeof unsubscribeCommands === 'function') unsubscribeCommands(); });
if(progressMode){
  $('#details-dialog').addEventListener('close',()=>call('closeProgress'));
  new MutationObserver(()=>{document.title=$('#details-title').textContent;}).observe($('#details-title'),{childList:true,characterData:true,subtree:true});
  detailId=progressMode;showDialog('#details-dialog');
}
start().then(async()=>{
  if(progressMode){showDetails(progressMode);return;}
  if(state.integration.packaged && !state.integration.connectedBrowsers?.length && !localStorage.getItem('browser-setup-introduced') && !$$('dialog[open]').length){
    await openIntegration();
    localStorage.setItem('browser-setup-introduced','1');
  }
});
