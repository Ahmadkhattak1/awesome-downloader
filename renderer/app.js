'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.downloader;
const progressMode = new URLSearchParams(location.search).get('progress');
if (progressMode) document.body.classList.add('progress-window');

let state = { downloads: [], settings: {}, integration: {} };
let selectedId = null, detailId = null, filter = 'all', category = '', searchTerm = '';
let sort = 'createdAt', ascending = false, visibleDownloads = [];
let toastTimer, unsubscribe, unsubscribeCommands;
const selectedIds = new Set();
const pending = new Set();
let pendingReviewId = null;
let selectionDrag = null, suppressRowClick = false;
const dismissedReviews = new Set();

/* --- Theme Management (Dark / Light) --- */
function initTheme() {
  const saved = localStorage.getItem('awesome-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  setTheme(theme);
}

function setTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-theme', isDark);
  document.body.classList.toggle('light-theme', !isDark);
  localStorage.setItem('awesome-theme', theme);
  const toggleBtn = $('#theme-toggle');
  if (toggleBtn) toggleBtn.setAttribute('aria-checked', String(isDark));
  const themeText = $('#theme-text');
  if (themeText) themeText.textContent = isDark ? 'Light theme' : 'Dark theme';
}

function toggleTheme() {
  const isDark = document.body.classList.contains('dark-theme');
  setTheme(isDark ? 'light' : 'dark');
}

/* Helper element builder */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* Formatters & Helpers */
function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function statusOf(d) {
  const value = String(d.status || 'queued').toLowerCase();
  return ({ active: 'downloading', running: 'downloading', probing: 'connecting', complete: 'completed', done: 'completed', error: 'failed', canceled: 'cancelled', pending: 'queued' })[value] || value;
}

function categoryOf(d) {
  const value = String(d.category || '').toLowerCase();
  if (/video/.test(value)) return 'Video';
  if (/audio|music/.test(value)) return 'Audio';
  if (/doc|text|pdf/.test(value)) return 'Documents';
  if (/arch|compress|zip|rar|7z/.test(value)) return 'Archives';
  if (/program|game|exe|msi/.test(value)) return 'Programs';
  return 'Other';
}

function bytes(value) {
  const size = numeric(value);
  if (!size) return '0 B';
  const power = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** power).toFixed(power ? 2 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][power]}`;
}

function date(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function timeLeft(d) {
  const total = numeric(d.total) || numeric(d.streamProgress?.estimatedBytes);
  if (!total || !numeric(d.speed)) return '';
  const seconds = Math.max(0, Math.ceil((total - numeric(d.downloaded)) / numeric(d.speed)));
  return ((!d.total || d.estimated) ? '≈ ' : '') + duration(seconds);
}

function sizeLabel(d) {
  return numeric(d.total) ? (d.estimated ? '≈ ' : '') + bytes(d.total) : d.streamProgress?.estimatedBytes ? '≈ ' + bytes(d.streamProgress.estimatedBytes) : d.kind === 'hls' ? 'Calculating…' : 'Unknown';
}

function duration(seconds) {
  return seconds < 60 ? `${Math.ceil(seconds)} sec` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} hr ${Math.floor(seconds % 3600 / 60)} min`;
}

function percentage(d) {
  return statusOf(d) === 'completed' ? 100 : numeric(d.total) ? Math.min(100, numeric(d.downloaded) / numeric(d.total) * 100) : d.streamProgress?.total ? d.streamProgress.completed / d.streamProgress.total * 100 : null;
}

function messageOf(error) {
  return error?.message || String(error || 'The operation failed.');
}

function notify(message, error = false) {
  clearTimeout(toastTimer);
  const toast = $('#toast'), text = $('#toast-text');
  if (!toast || !text) return;
  text.textContent = message;
  toast.dataset.error = String(error);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 12000 : 5000);
}

async function call(method, ...args) {
  if (!api || typeof api[method] !== 'function') throw new Error('Download service unavailable. Please restart.');
  const result = await api[method](...args);
  if (result?.error && !result.downloads) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Request failed.');
  return result;
}

function acceptSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.downloads)) return;
  state = { downloads: snapshot.downloads, settings: snapshot.settings || state.settings, integration: snapshot.integration || state.integration };
  const valid = new Set(state.downloads.map(d => d.id));
  for (const id of selectedIds) if (!valid.has(id)) selectedIds.delete(id);
  if (!valid.has(selectedId)) selectedId = selectedIds.values().next().value || null;
  const list = $('#download-list');
  if (list) list.setAttribute('aria-busy', 'false');
  const conn = $('#connection-label');
  if (conn) conn.textContent = 'Connected';
  render();
  if (!$$('dialog[open]').length) {
    const review = state.downloads.find(d => d.needsReview && !dismissedReviews.has(d.id));
    if (review) openReview(review.id);
  }
}

async function refresh() {
  acceptSnapshot(await call('snapshot'));
}

function selected() {
  return state.downloads.find(d => d.id === selectedId);
}

function canResume(d) {
  return d && !d.needsReview && ['paused', 'queued', 'scheduled', 'failed', 'cancelled'].includes(statusOf(d));
}

function canPause(d) {
  return d && !d.needsReview && ['downloading', 'connecting', 'queued', 'scheduled', 'assembling'].includes(statusOf(d));
}

function matches(d) {
  const status = statusOf(d);
  if (filter === 'completed' && status !== 'completed') return false;
  if (filter === 'unfinished' && status === 'completed') return false;
  if (filter === 'queued' && !['queued', 'scheduled', 'paused'].includes(status)) return false;
  if (category && categoryOf(d) !== category) return false;
  return !searchTerm || `${d.filename || ''} ${d.url || ''}`.toLowerCase().includes(searchTerm);
}

function paintSelection() {
  $$('.download-row').forEach(row => {
    const active = selectedIds.has(row.dataset.id);
    row.classList.toggle('selected', active);
    row.setAttribute('aria-selected', String(active));
  });
  updateControls();
}

function selectDownload(id, { additive = false, toggle = false } = {}) {
  if (!additive) selectedIds.clear();
  if (toggle && selectedIds.has(id)) selectedIds.delete(id);
  else if (id) selectedIds.add(id);
  selectedId = selectedIds.has(id) ? id : (selectedIds.values().next().value || null);
  paintSelection();
}

/* Category & File Type Helpers */
function iconClassForCategory(cat) {
  switch (cat) {
    case 'Video': return 'video';
    case 'Audio': return 'audio';
    case 'Documents': return 'doc';
    case 'Archives': return 'archive';
    case 'Programs': return 'games';
    default: return 'other';
  }
}

function categorySymbol(cat) {
  switch (cat) {
    case 'Video': return '🎬';
    case 'Audio': return '🎵';
    case 'Documents': return '📄';
    case 'Archives': return '📦';
    case 'Programs': return '⚙️';
    default: return '📁';
  }
}

/* Render Dashboard Download Queue Cards */
function renderDashboardQueue() {
  const container = $('#dashboard-queue-list');
  if (!container) return;

  const activeDownloads = state.downloads.filter(d => statusOf(d) !== 'completed' && statusOf(d) !== 'cancelled');
  const queueCountLabel = $('#queue-count-label');
  if (queueCountLabel) queueCountLabel.textContent = `Downloading file (${activeDownloads.length})`;

  if (!activeDownloads.length) {
    container.innerHTML = `
      <div class="queue-empty-state">
        <span>No active downloads in queue.</span>
        <p>Click <strong>Add URL</strong> above or start video capture from your browser.</p>
      </div>`;
    return;
  }

  container.replaceChildren(...activeDownloads.slice(0, 10).map(d => {
    const status = statusOf(d);
    const percent = percentage(d);
    const cat = categoryOf(d);
    const iconClass = iconClassForCategory(cat);

    const row = element('div', 'queue-row');
    row.dataset.id = d.id;

    // File icon
    const icon = element('div', `queue-icon ${iconClass}`, categorySymbol(cat));

    // Info (name & size)
    const info = element('div', 'queue-info');
    const name = element('span', 'queue-name', d.filename || 'Preparing download…');
    name.title = d.filename || d.url;
    const size = element('span', 'queue-size', sizeLabel(d));
    info.append(name, size);

    // Progress Column
    const progCol = element('div', 'queue-progress-col');
    const progHeader = element('div', 'queue-progress-header');
    const statusText = status === 'completed' ? 'Complete' :
      status === 'downloading' ? (percent !== null ? `Downloading ${percent.toFixed(0)}%` : 'Receiving data…') :
      status === 'connecting' ? 'Connecting…' :
      status === 'paused' ? `Paused ${percent ? percent.toFixed(0) + '%' : ''}` :
      status === 'assembling' ? 'Finalizing…' : status;
    
    progHeader.append(element('span', '', statusText));

    const barWrap = element('div', 'queue-progress-bar-wrap');
    const barFill = element('div', 'queue-progress-bar-fill');
    barFill.style.width = `${percent || (status === 'completed' ? 100 : 0)}%`;
    barWrap.append(barFill);
    progCol.append(progHeader, barWrap);

    // Meta stats (bytes & speed)
    const meta = element('div', 'queue-meta');
    if (status === 'downloading') {
      meta.textContent = `${bytes(d.downloaded)} of ${sizeLabel(d)} | ${bytes(d.speed)}/s`;
    } else {
      meta.textContent = `${bytes(d.downloaded)} downloaded`;
    }

    // Actions
    const actions = element('div', 'queue-actions');

    // Pause / Resume
    const toggleBtn = element('button', `queue-action-btn ${canPause(d) ? 'pause-btn' : ''}`);
    toggleBtn.title = canPause(d) ? 'Pause' : 'Resume';
    toggleBtn.innerHTML = canPause(d) ?
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>' :
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="6 4 18 12 6 20 6 4"></polygon></svg>';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performAction(d, canPause(d) ? 'pause' : 'resume');
    });

    // Cancel / Delete
    const cancelBtn = element('button', 'queue-action-btn');
    cancelBtn.title = 'Cancel download';
    cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performAction(d, 'cancel');
    });

    // Open Folder
    const folderBtn = element('button', 'queue-action-btn');
    folderBtn.title = 'Open download folder';
    folderBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performAction(d, 'reveal');
    });

    actions.append(toggleBtn, cancelBtn, folderBtn);
    row.append(icon, info, progCol, meta, actions);

    row.addEventListener('dblclick', () => showDetails(d.id));
    return row;
  }));
}

/* Update Category Counts in Dashboard */
function updateCategoryCounts() {
  const counts = { Documents: 0, Video: 0, Audio: 0, Archives: 0, Programs: 0, Other: 0 };
  for (const d of state.downloads) {
    const cat = categoryOf(d);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(counts)) {
    const el = $(`#count-${cat}`);
    if (el) el.textContent = String(count);
  }
}

/* Update Limitation & Gauge Widgets */
function updateLimitationStats() {
  const totalDownloaded = state.downloads.reduce((acc, d) => acc + numeric(d.downloaded), 0);
  const gaugeVal = $('#gauge-stat-value');
  if (gaugeVal) gaugeVal.textContent = bytes(totalDownloaded);

  const speedLimit = state.settings.speedLimitKbps;
  const quotaUsed = $('#quota-used');
  if (quotaUsed) {
    quotaUsed.textContent = speedLimit ? `${speedLimit} KB/s limit` : `${bytes(totalDownloaded)} total`;
  }
}

/* Render Table Row for File Management */
function rowFor(d) {
  const status = statusOf(d), percent = percentage(d);
  const row = element('tr', 'download-row');
  row.dataset.id = d.id;
  row.dataset.status = status;
  row.classList.toggle('selected', selectedIds.has(d.id));
  row.setAttribute('aria-selected', String(selectedIds.has(d.id)));

  const nameCell = element('td');
  nameCell.title = d.filename || d.url;
  const name = element('span', 'file-name');
  name.append(
    element('span', 'file-type-icon', status === 'completed' ? '✓' : status === 'failed' ? '!' : '↓'),
    element('span', '', d.filename || 'Preparing file…')
  );
  nameCell.append(name);

  const names = {
    completed: 'Complete',
    downloading: percent === null ? 'Receiving data…' : `${percent.toFixed(1)}%`,
    connecting: 'Connecting…',
    assembling: 'Finalizing…',
    queued: 'Queued',
    scheduled: 'Scheduled',
    paused: 'Stopped',
    cancelled: 'Cancelled',
    failed: 'Error'
  };

  const statusCell = element('td', `row-status ${status}`, names[status] || status);
  statusCell.title = d.error || names[status] || status;
  const description = d.description || d.error || (d.scheduledAt && status === 'scheduled' ? `Starts ${date(d.scheduledAt)}` : '');
  const descriptionCell = element('td', '', description);
  descriptionCell.title = description;

  row.append(
    nameCell,
    element('td', '', ['queued', 'scheduled', 'paused'].includes(status) ? '✓' : ''),
    element('td', '', sizeLabel(d)),
    statusCell,
    element('td', '', status === 'downloading' ? timeLeft(d) : ''),
    element('td', '', status === 'downloading' ? `${bytes(d.speed)}/sec` : ''),
    element('td', '', date(d.lastTry || d.createdAt)),
    descriptionCell
  );

  row.addEventListener('click', event => {
    if (suppressRowClick) return;
    selectDownload(d.id, { additive: event.ctrlKey || event.metaKey, toggle: event.ctrlKey || event.metaKey });
  });
  row.addEventListener('dblclick', () => showDetails(d.id));
  row.addEventListener('contextmenu', event => {
    event.preventDefault();
    selectDownload(d.id);
    showDetails(d.id);
  });
  return row;
}

function updateControls() {
  const d = selected(), busy = d && pending.has(d.id);
  const setDisabled = (id, val) => { const el = $(id); if (el) el.disabled = Boolean(val); };

  setDisabled('#resume-selected', (!canResume(d) && !d?.needsReview) || busy);
  setDisabled('#stop-selected', !canPause(d) || busy);
  setDisabled('#remove-selected', !d || busy);
  setDisabled('#open-selected', !d || statusOf(d) !== 'completed');
  setDisabled('#reveal-selected', !d);
  setDisabled('#details-selected', !d);
  setDisabled('#pause-all', !state.downloads.some(canPause));
  setDisabled('#header-pause-all', !state.downloads.some(canPause));
  setDisabled('#queue-pause-all', !state.downloads.some(canPause));
  setDisabled('#resume-all', !state.downloads.some(canResume));
  setDisabled('#header-resume-all', !state.downloads.some(canResume));
  setDisabled('#queue-resume-all', !state.downloads.some(canResume));
  setDisabled('#remove-completed', !state.downloads.some(d => statusOf(d) === 'completed'));
  setDisabled('#scheduler-start', !state.downloads.some(canResume));
  setDisabled('#scheduler-stop', !state.downloads.some(canPause));
}

function render() {
  visibleDownloads = state.downloads.filter(matches).sort((a, b) => {
    const result = sort === 'total' ? numeric(a.total) - numeric(b.total) :
      sort === 'createdAt' ? new Date(a.createdAt || 0) - new Date(b.createdAt || 0) :
      String(a[sort] || '').localeCompare(String(b[sort] || ''));
    return ascending ? result : -result;
  });

  const list = $('#download-list');
  if (list) list.replaceChildren(...visibleDownloads.map(rowFor));

  const emptyState = $('#empty-state');
  if (emptyState) emptyState.hidden = visibleDownloads.length > 0;
  const emptyMsg = $('#empty-message');
  if (emptyMsg) emptyMsg.textContent = searchTerm ? 'No downloads match your search.' : 'No downloads to display.';

  const complete = state.downloads.filter(d => statusOf(d) === 'completed').length;
  const listCount = $('#list-count');
  if (listCount) listCount.textContent = `${visibleDownloads.length} ${visibleDownloads.length === 1 ? 'download' : 'downloads'}${state.downloads.length !== visibleDownloads.length ? ` of ${state.downloads.length}` : ''} (${complete} completed)`;

  const statusSummary = $('#status-summary');
  if (statusSummary) statusSummary.textContent = `${bytes(state.downloads.reduce((sum, d) => sum + numeric(d.speed), 0))}/sec`;

  renderDashboardQueue();
  updateCategoryCounts();
  updateLimitationStats();
  updateControls();

  if ($('#details-dialog')?.open) renderDetails();
  if ($('#scheduler-dialog')?.open) renderScheduler();
}

async function performAction(d, action) {
  if (!d || pending.has(d.id)) return;
  if (action === 'remove' && !window.confirm(`Delete “${d.filename || 'this download'}” from the download list?\n\nThe downloaded file will remain on your PC.`)) return;
  pending.add(d.id);
  updateControls();
  try {
    await call('action', { id: d.id, action });
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  } finally {
    pending.delete(d.id);
    updateControls();
    if ($('#details-dialog')?.open) renderDetails();
  }
}

async function bulkAction(action) {
  const downloads = state.downloads.filter(action === 'pause' ? canPause : canResume);
  const results = await Promise.allSettled(downloads.map(d => call('action', { id: d.id, action: action === 'resume' && ['failed', 'cancelled'].includes(statusOf(d)) ? 'retry' : action })));
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) notify(`${failures.length} operation(s) failed: ${messageOf(failures[0].reason)}`, true);
  try {
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  }
}

async function removeCompleted() {
  const downloads = state.downloads.filter(d => statusOf(d) === 'completed');
  if (!downloads.length || !window.confirm(`Delete ${downloads.length} completed download(s) from the list?\n\nThe downloaded files will remain on your PC.`)) return;
  const results = await Promise.allSettled(downloads.map(d => call('action', { id: d.id, action: 'remove' })));
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) notify(messageOf(failures[0].reason), true);
  try {
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  }
}

function showDialog(id) {
  const dialog = $(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function openAdd(text = '', scheduled = '') {
  pendingReviewId = null;
  const addErr = $('#add-error');
  if (addErr) addErr.hidden = true;
  const urls = $('#download-urls');
  if (urls) { urls.value = text; urls.readOnly = false; }
  const fn = $('#download-filename'); if (fn) fn.value = '';
  const desc = $('#download-description'); if (desc) desc.value = '';
  const cat = $('#download-category'); if (cat) cat.value = '';
  const rem = $('#remember-category-path'); if (rem) { rem.checked = false; rem.disabled = true; }
  const sch = $('#download-schedule'); if (sch) sch.value = scheduled;
  const dir = $('#add-directory'); if (dir) dir.value = state.settings.defaultDirectory || '';
  showDialog('#add-dialog');
  urls?.focus();
}

function openReview(id) {
  if (progressMode) return;
  const d = state.downloads.find(item => item.id === id && item.needsReview);
  if (!d || dismissedReviews.has(id)) return;
  openAdd(d.url || '');
  pendingReviewId = id;
  const urls = $('#download-urls'); if (urls) urls.readOnly = true;
  const fn = $('#download-filename'); if (fn) fn.value = d.filename || '';
  const desc = $('#download-description'); if (desc) desc.value = d.description || '';
  const cat = $('#download-category'); if (cat) cat.value = d.category || '';
  const rem = $('#remember-category-path'); if (rem) rem.disabled = !$('#download-category')?.value;
  const dir = $('#add-directory'); if (dir) dir.value = d.directory || state.settings.defaultDirectory || '';
}

async function dismissReview() {
  if (!pendingReviewId) return;
  const id = pendingReviewId;
  dismissedReviews.add(id);
  pendingReviewId = null;
  try {
    await call('action', { id, action: 'remove' });
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  }
}

function showDetails(id) {
  if (state.downloads.find(d => d.id === id)?.needsReview) {
    openReview(id);
    return;
  }
  if (!progressMode) {
    call('openProgress', { id }).catch(e => notify(messageOf(e), true));
    return;
  }
  detailId = id;
  const speedLimit = $('#detail-speed-limit'); if (speedLimit) speedLimit.value = state.settings.speedLimitKbps || 0;
  const notifyComp = $('#notify-complete'); if (notifyComp) notifyComp.checked = state.settings.notifyOnComplete !== false;
  const revealComp = $('#reveal-complete'); if (revealComp) revealComp.checked = state.settings.revealOnComplete === true;
  const compRes = $('#completion-result'); if (compRes) compRes.textContent = '';
  setDetailTab('status');
  renderDetails();
  showDialog('#details-dialog');
}

function renderDetails() {
  const d = state.downloads.find(d => d.id === detailId);
  if (!d) {
    $('#details-dialog')?.close();
    return;
  }
  const status = statusOf(d), percent = percentage(d), content = $('#details-content');
  const title = $('#details-title'); if (title) title.textContent = `${percent !== null ? `${Math.floor(percent)}% ` : ''}${d.filename || 'Download status'}`;
  const src = $('#transfer-source'); if (src) { src.textContent = d.url || ''; src.title = d.url || ''; }

  const names = { completed: 'Complete', downloading: 'Receiving data…', connecting: 'Connecting…', paused: 'Stopped', queued: 'Queued', scheduled: 'Scheduled', failed: 'Error', cancelled: 'Cancelled', assembling: 'Finalizing…' };
  const rows = [
    ['Status', names[status] || status],
    ['File size', sizeLabel(d)],
    ['Downloaded', `${bytes(d.downloaded)}${percent !== null ? ` (${percent.toFixed(2)}%)` : ''}`],
    ['Transfer rate', status === 'downloading' ? `${bytes(d.speed)}/sec` : '0 B/sec'],
    ['Time left', status === 'downloading' ? timeLeft(d) || 'Estimating…' : '—'],
    ['Resume capability', d.resumable === true ? 'Yes' : d.resumable === false ? 'No' : 'Checking…']
  ];
  if (numeric(d.duration)) rows.splice(1, 0, ['Video duration', `${Math.floor(d.duration / 60)} min ${Math.floor(d.duration % 60)} sec`]);
  if (d.streamProgress?.total && status !== 'completed') rows.push(['Segments', `${d.streamProgress.completed} / ${d.streamProgress.total}`]);
  if (d.scheduledAt && status === 'scheduled') rows.push(['Start at', date(d.scheduledAt)]);

  if (content) {
    content.replaceChildren();
    for (const [label, val] of rows) content.append(element('dt', '', label), element('dd', '', val));
  }

  const progress = $('#detail-progress');
  if (progress) {
    if (percent === null && ['downloading', 'connecting'].includes(status)) progress.removeAttribute('value');
    else progress.value = percent || 0;
  }

  const segments = Array.isArray(d.connectionsProgress) ? d.connectionsProgress : [];
  const bars = $('#segment-bars'), map = $('#segment-map');
  if (bars) bars.replaceChildren();
  if (map) map.replaceChildren();

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const row = element('tr');
    const segmentStatus = segment.status === 'complete' || segment.status === 'completed' ? 'Completed.' : segment.status || (status === 'downloading' ? 'Receiving data…' : names[status] || status);
    row.append(element('td', '', String(index + 1)), element('td', '', bytes(segment.downloaded)), element('td', '', segmentStatus));
    if (bars) bars.append(row);

    const bar = element('progress');
    bar.max = 100;
    const total = numeric(segment.total);
    bar.value = total ? Math.min(100, numeric(segment.downloaded) / total * 100) : 0;
    bar.setAttribute('aria-label', `Connection ${index + 1} progress`);
    if (!total && status === 'downloading') bar.removeAttribute('value');
    if (map) map.append(bar);
  }

  const note = $('#segment-note'); if (note) note.textContent = segments.length ? `${segments.length} connection(s)` : status === 'completed' ? 'Download completed.' : 'Connection progress appears when the transfer starts.';
  const err = $('#detail-error'); if (err) { err.textContent = d.error || ''; err.hidden = !d.error; }

  const setDisabled = (id, val) => { const el = $(id); if (el) el.disabled = Boolean(val); };
  setDisabled('#detail-open', status !== 'completed');
  setDisabled('#detail-resume', !canResume(d) || pending.has(d.id));
  setDisabled('#detail-stop', !canPause(d) || pending.has(d.id));
  setDisabled('#detail-cancel', ['completed', 'cancelled'].includes(status) || pending.has(d.id));

  const transferBtns = $('.transfer-buttons'); if (transferBtns) transferBtns.hidden = status === 'completed';
  const completeActions = $('#download-complete-actions'); if (completeActions) completeActions.hidden = status !== 'completed';
  $('#details-dialog')?.classList.toggle('is-complete', status === 'completed');
}

function setDetailTab(name) {
  for (const tab of ['status', 'speed', 'completion']) {
    const active = tab === name;
    const btn = $(`#tab-${tab}`);
    if (btn) {
      btn.classList.toggle('active-tab', active);
      btn.setAttribute('aria-selected', String(active));
    }
    const panel = $(`#${tab}-panel`);
    if (panel) panel.hidden = !active;
  }
}

/* Switch Views (Dashboard vs File Management) */
function setNavView(viewName) {
  $$('.nav-item[data-nav]').forEach(item => {
    item.classList.toggle('active', item.dataset.nav === viewName);
  });
  const isDashboard = viewName === 'dashboard';
  $('#view-dashboard')?.classList.toggle('active', isDashboard);
  $('#view-files')?.classList.toggle('active', !isDashboard);

  const title = $('#view-title');
  if (title) {
    title.textContent = isDashboard ? 'Download Management' : viewName === 'history' ? 'History' : 'File Management';
  }

  if (viewName === 'history') {
    setView('completed');
  } else if (!isDashboard && filter === 'completed') {
    setView('all');
  }
}

function setView(nextFilter, nextCategory = '') {
  filter = nextFilter;
  category = nextCategory;
  $$('.pill-btn[data-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === nextFilter);
  });
  $$('.pill-btn[data-category]').forEach(button => {
    button.classList.toggle('active', button.dataset.category === nextCategory);
  });
  render();
}

function openSettings() {
  const settings = state.settings;
  const defDir = $('#default-directory'); if (defDir) defDir.value = settings.defaultDirectory || '';
  const maxC = $('#max-concurrent'); if (maxC) maxC.value = settings.maxConcurrent || 3;
  const conn = $('#connections'); if (conn) conn.value = settings.connections || 8;
  const spd = $('#speed-limit'); if (spd) spd.value = settings.speedLimitKbps || 0;
  const err = $('#settings-error'); if (err) err.hidden = true;
  showDialog('#settings-dialog');
}

function renderScheduler() {
  const downloads = state.downloads.filter(d => statusOf(d) === 'scheduled').sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  const list = $('#scheduled-list');
  if (!list) return;
  list.replaceChildren();
  if (!downloads.length) {
    list.append(element('p', 'field-help', 'No scheduled downloads.'));
    return;
  }
  for (const d of downloads) {
    const row = element('div', 'scheduled-item');
    const name = element('span', '', d.filename);
    name.title = d.filename;
    row.append(name, element('time', '', date(d.scheduledAt)));
    list.append(row);
  }
}

function openScheduler() {
  renderScheduler();
  showDialog('#scheduler-dialog');
}

async function openIntegration() {
  try {
    const info = await call('integration') || state.integration;
    const extPath = $('#extension-path'); if (extPath) extPath.value = info.extensionPath || '';
    const port = $('#integration-port'); if (port) port.value = info.port ? 'Ready' : 'Unavailable';
    showDialog('#integration-dialog');
  } catch (error) {
    notify(messageOf(error), true);
  }
}

/* Global App Commands */
const commands = {
  add: () => openAdd(),
  paste: async () => {
    try {
      openAdd(await call('clipboard'));
    } catch (error) {
      notify(messageOf(error), true);
    }
  },
  find: () => {
    setNavView('files');
    $('#search')?.focus();
  },
  settings: openSettings,
  integration: openIntegration,
  scheduler: openScheduler,
  pauseAll: () => bulkAction('pause'),
  resumeAll: () => bulkAction('resume'),
  removeCompleted
};
commands.details = () => { if (selectedId) showDetails(selectedId); };
commands.remove = () => performAction(selected(), 'remove');
commands.all = () => setView('all');

/* Event Bindings */
function setupEventHandlers() {
  // Theme toggle
  $('#theme-toggle')?.addEventListener('click', toggleTheme);
  $('#header-theme-toggle')?.addEventListener('click', toggleTheme);

  // Navigation switching
  $$('.nav-item[data-nav]').forEach(item => {
    item.addEventListener('click', () => setNavView(item.dataset.nav));
  });

  // Sidebar CTAs & Tools
  $('#sidebar-add-btn')?.addEventListener('click', () => openAdd());
  $('#header-add-btn')?.addEventListener('click', () => openAdd());
  $('#sidebar-settings-btn')?.addEventListener('click', openSettings);
  $('#sidebar-scheduler-btn')?.addEventListener('click', openScheduler);
  $('#sidebar-integration-btn')?.addEventListener('click', openIntegration);
  $('#sidebar-help-btn')?.addEventListener('click', openIntegration);
  $('#promo-setup-btn')?.addEventListener('click', openIntegration);
  $('#quick-speed-limit-btn')?.addEventListener('click', openSettings);

  // Queue actions
  $('#queue-resume-all')?.addEventListener('click', commands.resumeAll);
  $('#queue-pause-all')?.addEventListener('click', commands.pauseAll);
  $('#header-resume-all')?.addEventListener('click', commands.resumeAll);
  $('#header-pause-all')?.addEventListener('click', commands.pauseAll);
  $('#queue-view-all')?.addEventListener('click', () => setNavView('files'));
  $('#analytics-view-all')?.addEventListener('click', () => setNavView('files'));
  $('#filetype-view-all')?.addEventListener('click', () => setNavView('files'));

  // Filetype Category Cards click
  $$('.filetype-item[data-category]').forEach(card => {
    card.addEventListener('click', () => {
      setNavView('files');
      setView('all', card.dataset.category);
    });
  });

  // Table action buttons
  $('#resume-selected')?.addEventListener('click', () => {
    const d = selected();
    if (d?.needsReview) { openReview(d.id); return; }
    performAction(d, d && ['failed', 'cancelled'].includes(statusOf(d)) ? 'retry' : 'resume');
  });
  $('#stop-selected')?.addEventListener('click', () => performAction(selected(), 'pause'));
  $('#remove-selected')?.addEventListener('click', () => performAction(selected(), 'remove'));
  $('#open-selected')?.addEventListener('click', () => performAction(selected(), 'open'));
  $('#reveal-selected')?.addEventListener('click', () => performAction(selected(), 'reveal'));
  $('#details-selected')?.addEventListener('click', () => { if (selectedId) showDetails(selectedId); });
  $('#remove-completed')?.addEventListener('click', removeCompleted);

  // Search input
  $('#search')?.addEventListener('input', event => {
    searchTerm = event.target.value.trim().toLowerCase();
    render();
  });

  // Pills filtering
  $$('.pill-btn[data-filter]').forEach(button => {
    button.addEventListener('click', () => setView(button.dataset.filter, ''));
  });
  $$('.pill-btn[data-category]').forEach(button => {
    button.addEventListener('click', () => setView('all', button.dataset.category));
  });

  // Sorting
  $$('[data-sort]').forEach(button => {
    button.addEventListener('click', () => {
      const next = button.dataset.sort;
      ascending = sort === next ? !ascending : true;
      sort = next;
      render();
    });
  });

  // Dialog Close buttons
  $$('[data-close]').forEach(button => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      dialog?.close();
      if (dialog?.id === 'add-dialog') dismissReview();
    });
  });
  $('#add-dialog')?.addEventListener('cancel', () => dismissReview());

  // Add Dialog Form
  $('#paste-button')?.addEventListener('click', async () => {
    try {
      const urls = $('#download-urls');
      if (urls) {
        urls.value = await call('clipboard');
        urls.focus();
      }
    } catch (error) {
      const err = $('#add-error');
      if (err) { err.textContent = messageOf(error); err.hidden = false; }
    }
  });

  $('#add-browse')?.addEventListener('click', async () => {
    try {
      const path = await call('chooseDirectory');
      const dir = $('#add-directory');
      if (typeof path === 'string' && path && dir) dir.value = path;
    } catch (error) {
      const err = $('#add-error');
      if (err) { err.textContent = messageOf(error); err.hidden = false; }
    }
  });

  $('#add-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const errorElement = $('#add-error');
    if (errorElement) errorElement.hidden = true;
    const urlsVal = $('#download-urls')?.value || '';
    const urls = urlsVal.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
    const filename = $('#download-filename')?.value.trim() || '';
    const scheduled = $('#download-schedule')?.value || '';

    try {
      if (!urls.length) throw new Error('Enter at least one download address.');
      for (const url of urls) {
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error(`Invalid address: ${url}`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Download addresses must begin with http:// or https://.');
      }
      if (filename && urls.length !== 1) throw new Error('A custom file name can only be used for a single address.');
      const scheduledAt = scheduled ? new Date(scheduled).toISOString() : undefined;
      if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) throw new Error('Choose a future start time or leave Start at empty.');

      const submitBtn = $('#add-submit'), laterBtn = $('#add-later');
      if (submitBtn) submitBtn.disabled = true;
      if (laterBtn) laterBtn.disabled = true;

      const directory = $('#add-directory')?.value;
      const selectedCategory = $('#download-category')?.value;
      const description = $('#download-description')?.value.trim() || '';

      const data = {
        ...(filename ? { filename } : {}),
        ...(scheduledAt ? { scheduledAt } : {}),
        ...(directory ? { directory } : {}),
        ...(selectedCategory ? { category: selectedCategory } : {}),
        description,
        queueOnly: event.submitter?.dataset.queueOnly === 'true'
      };

      const ids = pendingReviewId ? await call('review', { id: pendingReviewId, ...data }) : await call('add', { urls, ...data });
      pendingReviewId = null;
      $('#add-dialog')?.close();
      setView('all');
      await refresh();
      if (!data.queueOnly && !scheduledAt && ids?.length === 1) {
        selectDownload(ids[0]);
        showDetails(ids[0]);
      }
    } catch (error) {
      if (errorElement) { errorElement.textContent = messageOf(error); errorElement.hidden = false; }
    } finally {
      const submitBtn = $('#add-submit'), laterBtn = $('#add-later');
      if (submitBtn) submitBtn.disabled = false;
      if (laterBtn) laterBtn.disabled = false;
    }
  });

  // Settings Dialog Form
  $('#choose-directory')?.addEventListener('click', async () => {
    try {
      const path = await call('chooseDirectory');
      const defDir = $('#default-directory');
      if (typeof path === 'string' && path && defDir) defDir.value = path;
    } catch (error) {
      const err = $('#settings-error');
      if (err) { err.textContent = messageOf(error); err.hidden = false; }
    }
  });

  $('#settings-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type=submit]', event.target);
    const err = $('#settings-error');
    if (err) err.hidden = true;
    if (button) button.disabled = true;
    try {
      await call('settings', {
        defaultDirectory: $('#default-directory')?.value.trim(),
        maxConcurrent: Number($('#max-concurrent')?.value),
        connections: Number($('#connections')?.value),
        speedLimitKbps: Number($('#speed-limit')?.value)
      });
      await refresh();
      $('#settings-dialog')?.close();
    } catch (error) {
      if (err) { err.textContent = messageOf(error); err.hidden = false; }
    } finally {
      if (button) button.disabled = false;
    }
  });

  // Scheduler Dialog Actions
  $('#scheduler-start')?.addEventListener('click', commands.resumeAll);
  $('#scheduler-stop')?.addEventListener('click', commands.pauseAll);
  $('#schedule-new')?.addEventListener('click', () => {
    $('#scheduler-dialog')?.close();
    const future = new Date(Date.now() + 3600000);
    openAdd('', new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  });

  // Details Modal actions
  const detailDownload = () => state.downloads.find(d => d.id === detailId);
  $('#detail-open')?.addEventListener('click', () => performAction(detailDownload(), 'open'));
  $('#detail-folder')?.addEventListener('click', () => performAction(detailDownload(), 'reveal'));
  $('#detail-stop')?.addEventListener('click', () => performAction(detailDownload(), 'pause'));
  $('#detail-cancel')?.addEventListener('click', () => performAction(detailDownload(), 'cancel'));
  $('#detail-resume')?.addEventListener('click', () => {
    const d = detailDownload();
    performAction(d, d && ['failed', 'cancelled'].includes(statusOf(d)) ? 'retry' : 'resume');
  });

  $('#toggle-details')?.addEventListener('click', async () => {
    const details = $('#connection-details');
    if (!details) return;
    details.hidden = !details.hidden;
    document.body.classList.toggle('details-collapsed', details.hidden);
    $('#toggle-details').textContent = details.hidden ? '>> Show details' : '<< Hide details';
    if (progressMode) try { await call('resizeProgress', { expanded: !details.hidden }); } catch (e) { notify(messageOf(e), true); }
  });

  for (const tab of ['status', 'speed', 'completion']) {
    $(`#tab-${tab}`)?.addEventListener('click', () => setDetailTab(tab));
  }

  $('#dismiss-toast')?.addEventListener('click', () => { $('#toast').hidden = true; });

  // Table Drag Selection (Marquee)
  const tableScroll = $('#table-scroll'), selectionRectangle = $('#selection-rectangle');
  if (tableScroll && selectionRectangle) {
    const tablePoint = event => {
      const bounds = tableScroll.getBoundingClientRect();
      return { x: event.clientX - bounds.left + tableScroll.scrollLeft, y: event.clientY - bounds.top + tableScroll.scrollTop };
    };

    tableScroll.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('thead') || event.target.closest('button')) return;
      const point = tablePoint(event), row = event.target.closest('.download-row');
      selectionDrag = { pointerId: event.pointerId, startX: point.x, startY: point.y, row, base: (event.ctrlKey || event.metaKey) ? new Set(selectedIds) : new Set(), moved: false };
      tableScroll.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    tableScroll.addEventListener('pointermove', event => {
      if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
      const point = tablePoint(event), dx = point.x - selectionDrag.startX, dy = point.y - selectionDrag.startY;
      if (!selectionDrag.moved && Math.hypot(dx, dy) < 4) return;
      selectionDrag.moved = true;
      const left = Math.min(selectionDrag.startX, point.x), top = Math.min(selectionDrag.startY, point.y);
      const right = Math.max(selectionDrag.startX, point.x), bottom = Math.max(selectionDrag.startY, point.y);
      Object.assign(selectionRectangle.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(1, right - left)}px`, height: `${Math.max(1, bottom - top)}px` });
      selectionRectangle.hidden = false;
      selectedIds.clear();
      for (const id of selectionDrag.base) selectedIds.add(id);
      const viewport = tableScroll.getBoundingClientRect();
      for (const row of $$('.download-row')) {
        const rect = row.getBoundingClientRect();
        const rowLeft = rect.left - viewport.left + tableScroll.scrollLeft, rowTop = rect.top - viewport.top + tableScroll.scrollTop;
        if (rowLeft < right && rowLeft + rect.width > left && rowTop < bottom && rowTop + rect.height > top) {
          selectedIds.add(row.dataset.id);
        }
      }
      selectedId = selectedIds.values().next().value || null;
      paintSelection();
      event.preventDefault();
    });

    const finishMarquee = event => {
      if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
      const moved = selectionDrag.moved, row = selectionDrag.row;
      try { tableScroll.releasePointerCapture(event.pointerId); } catch {}
      selectionDrag = null;
      selectionRectangle.hidden = true;
      if (moved) {
        suppressRowClick = true;
        setTimeout(() => { suppressRowClick = false; }, 0);
      } else if (!row) {
        selectDownload(null);
      }
    };
    tableScroll.addEventListener('pointerup', finishMarquee);
    tableScroll.addEventListener('pointercancel', finishMarquee);
  }

  // Keyboard Shortcuts
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!$$('dialog[open]').length) openAdd();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !$$('dialog[open]').length) {
      event.preventDefault();
      commands.find();
    }
  });
}

/* Initialization */
async function start() {
  initTheme();
  setupEventHandlers();

  try {
    await refresh();
    if (typeof api.subscribe === 'function') {
      unsubscribe = api.subscribe(snapshot => {
        if (snapshot?.downloads) acceptSnapshot(snapshot);
        else refresh().catch(error => notify(messageOf(error), true));
      });
    }
    if (typeof api.onCommand === 'function') {
      unsubscribeCommands = api.onCommand(async payload => {
        const command = typeof payload === 'string' ? payload : payload?.command;
        if (command === 'reviewDownload') {
          try {
            await refresh();
            if (!$$('dialog[open]').length) openReview(payload.id);
          } catch (error) {
            notify(messageOf(error), true);
          }
          return;
        }
        if (!$$('dialog[open]').length || ['pauseAll', 'resumeAll', 'removeCompleted'].includes(command)) {
          commands[command]?.();
        }
      });
    }
  } catch (error) {
    const list = $('#download-list'); if (list) list.setAttribute('aria-busy', 'false');
    const count = $('#list-count'); if (count) count.textContent = 'Download service unavailable';
    const conn = $('#connection-label'); if (conn) conn.textContent = 'Disconnected';
    notify(messageOf(error), true);
  }
}

window.addEventListener('beforeunload', () => {
  if (typeof unsubscribe === 'function') unsubscribe();
  if (typeof unsubscribeCommands === 'function') unsubscribeCommands();
});

if (progressMode) {
  $('#details-dialog')?.addEventListener('close', () => call('closeProgress'));
  const title = $('#details-title');
  if (title) {
    new MutationObserver(() => { document.title = title.textContent; }).observe(title, { childList: true, characterData: true, subtree: true });
  }
  detailId = progressMode;
  showDialog('#details-dialog');
}

start().then(async () => {
  if (progressMode) {
    showDetails(progressMode);
    return;
  }
  if (state.integration.packaged && !state.integration.connectedBrowsers?.length && !localStorage.getItem('browser-setup-introduced') && !$$('dialog[open]').length) {
    await openIntegration();
    localStorage.setItem('browser-setup-introduced', '1');
  }
});
