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
let analyticsMode = 'size', analyticsTimeframe = 'week', limitationTimeframe = 'week', selectedBarIndex = null;

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
  const visible = visibleDownloads.map(d => d.id);
  const allSelected = visible.length > 0 && visible.every(id => selectedIds.has(id));
  const someSelected = visible.some(id => selectedIds.has(id));

  const selectAll = $('#select-all-checkbox');
  if (selectAll) {
    selectAll.classList.toggle('checked', allSelected);
    selectAll.classList.toggle('indeterminate', someSelected && !allSelected);
    selectAll.setAttribute('aria-checked', allSelected ? 'true' : someSelected ? 'mixed' : 'false');
  }

  $$('.download-row').forEach(row => {
    const active = selectedIds.has(row.dataset.id);
    row.classList.toggle('selected', active);
    row.setAttribute('aria-selected', String(active));
    const chk = row.querySelector('.row-checkbox');
    if (chk) {
      chk.classList.toggle('checked', active);
      chk.setAttribute('aria-checked', String(active));
    }
  });

  // Update dashboard queue rows as well
  $$('.queue-row').forEach(row => {
    const active = selectedIds.has(row.dataset.id);
    row.classList.toggle('selected', active);
    const chk = row.querySelector('.row-checkbox');
    if (chk) {
      chk.classList.toggle('checked', active);
      chk.setAttribute('aria-checked', String(active));
    }
  });

  const countBadge = $('#selected-count-badge');
  if (countBadge) {
    countBadge.textContent = selectedIds.size > 0 ? `${selectedIds.size} selected` : '0 selected';
    countBadge.hidden = selectedIds.size === 0;
  }

  // Update queue header batch buttons
  const hasSelection = selectedIds.size > 0;
  const queueResumeSelected = $('#queue-resume-selected');
  const queuePauseSelected = $('#queue-pause-selected');
  const queueDeleteSelected = $('#queue-delete-selected');
  if (queueResumeSelected) queueResumeSelected.hidden = !hasSelection;
  if (queuePauseSelected) queuePauseSelected.hidden = !hasSelection;
  if (queueDeleteSelected) queueDeleteSelected.hidden = !hasSelection;

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

function categorySvg(cat) {
  switch (cat) {
    case 'Programs':
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 12v9"/></svg>';
    case 'Documents':
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    case 'Video':
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    case 'Audio':
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    case 'Archives':
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  }
}

/* Render Dashboard Download Queue Cards */
function renderDashboardQueue() {
  const container = $('#dashboard-queue-list');
  if (!container) return;

  const activeDownloads = state.downloads.filter(d => statusOf(d) !== 'completed' && statusOf(d) !== 'cancelled');
  const queueDownloads = activeDownloads.length ? activeDownloads : state.downloads.filter(d => statusOf(d) !== 'cancelled');
  const queueCountLabel = $('#queue-count-label');
  if (queueCountLabel) queueCountLabel.textContent = `Downloading file (${activeDownloads.length || queueDownloads.length})`;

  if (!queueDownloads.length) {
    container.innerHTML = `
      <div class="queue-empty-state">
        <span>No downloads in queue.</span>
        <p>Click <strong>Add URL</strong> above or start video capture from your browser.</p>
      </div>`;
    return;
  }

  container.replaceChildren(...queueDownloads.slice(0, 10).map(d => {
    const status = statusOf(d);
    const percent = percentage(d);
    const cat = categoryOf(d);
    const iconClass = iconClassForCategory(cat);
    const isSelected = selectedIds.has(d.id);

    const row = element('div', `queue-row${isSelected ? ' selected' : ''}`);
    row.dataset.id = d.id;
    row.dataset.status = status;

    // Multi-select Checkbox on the left
    const chk = element('span', `row-checkbox${isSelected ? ' checked' : ''}`);
    chk.setAttribute('role', 'checkbox');
    chk.setAttribute('aria-checked', String(isSelected));
    chk.title = isSelected ? 'Deselect file' : 'Select file';
    chk.appendChild(element('span', 'checkbox-icon', '✓'));
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedIds.has(d.id)) {
        selectedIds.delete(d.id);
      } else {
        selectedIds.add(d.id);
      }
      selectedId = selectedIds.has(d.id) ? d.id : (selectedIds.values().next().value || null);
      paintSelection();
    });

    // File icon
    const icon = element('div', `queue-icon ${iconClass}`);
    icon.innerHTML = categorySvg(cat);

    // Info (name & size)
    const info = element('div', 'queue-info');
    const name = element('span', 'queue-name', d.filename || 'Preparing download…');
    name.title = d.filename || d.url;
    const size = element('span', 'queue-size', sizeLabel(d));
    info.append(name, size);

    // Progress Column (Bar on top, stats below)
    const progCol = element('div', 'queue-progress-col');

    const barWrap = element('div', 'queue-progress-bar-wrap');
    const barFill = element('div', 'queue-progress-bar-fill');
    barFill.style.width = `${percent || (status === 'completed' ? 100 : 0)}%`;
    barWrap.append(barFill);

    const progSub = element('div', 'queue-progress-sub');
    const statusText = status === 'completed' ? 'Complete' :
      status === 'downloading' ? (percent !== null ? `Downloading ${percent.toFixed(0)}%` : 'Receiving data…') :
      status === 'connecting' ? 'Connecting…' :
      status === 'paused' ? `Paused ${percent ? percent.toFixed(0) + '%' : ''}` :
      status === 'assembling' ? 'Finalizing…' : status;
    const statusSpan = element('span', 'queue-status-text', statusText);

    let metaText = '';
    if (status === 'downloading') {
      metaText = `${bytes(d.downloaded)} of ${sizeLabel(d)}${d.speed ? ` | ${bytes(d.speed)}/s` : ''}`;
    } else if (status === 'completed') {
      metaText = sizeLabel(d);
    } else {
      metaText = `${bytes(d.downloaded)} of ${sizeLabel(d)}`;
    }
    const metaSpan = element('span', 'queue-meta-text', metaText);

    progSub.append(statusSpan, metaSpan);
    progCol.append(barWrap, progSub);

    // Actions
    const actions = element('div', 'queue-actions');

    // Circular Play / Pause button
    const isDownloading = canPause(d);
    const circleBtn = element('button', `queue-circle-btn ${isDownloading ? 'pause-circle' : 'resume-circle'}`);
    circleBtn.title = isDownloading ? 'Pause download' : 'Resume download';
    circleBtn.innerHTML = isDownloading
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1.5"></rect><rect x="14" y="4" width="4" height="16" rx="1.5"></rect></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="7 4 19 12 7 20 7 4"></polygon></svg>';
    circleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performAction(d, isDownloading ? 'pause' : 'resume');
    });

    // Cancel / Delete button
    const cancelBtn = element('button', 'queue-action-icon-btn cancel-btn');
    cancelBtn.title = 'Cancel/Delete download';
    cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performAction(d, 'remove');
    });

    // Open Folder button
    const folderBtn = element('button', 'queue-action-icon-btn folder-btn');
    folderBtn.title = 'Open download folder';
    folderBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      performAction(d, 'reveal');
    });

    actions.append(circleBtn, cancelBtn, folderBtn);
    row.append(chk, icon, info, progCol, actions);

    row.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.row-checkbox')) return;
      if (e.ctrlKey || e.metaKey) {
        if (selectedIds.has(d.id)) selectedIds.delete(d.id);
        else selectedIds.add(d.id);
        selectedId = selectedIds.has(d.id) ? d.id : (selectedIds.values().next().value || null);
      } else {
        if (selectedIds.has(d.id) && selectedIds.size === 1) {
          selectedIds.delete(d.id);
          selectedId = null;
        } else {
          selectedIds.clear();
          selectedIds.add(d.id);
          selectedId = d.id;
        }
      }
      paintSelection();
    });

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

/* Helper: Filter downloads by timeframe */
function getFilteredDownloads(timeframe) {
  const now = new Date();
  if (timeframe === 'week') {
    const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Mon, 6 = Sun
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek, 0, 0, 0);
    return state.downloads.filter(d => {
      const dt = new Date(d.completedAt || d.createdAt || 0);
      return dt >= startOfWeek;
    });
  } else if (timeframe === 'month') {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    return state.downloads.filter(d => {
      const dt = new Date(d.completedAt || d.createdAt || 0);
      return dt >= startOfMonth;
    });
  }
  return state.downloads;
}

/* Helper: Generate nice Y-Axis labels */
function generateYAxis(maxVal, isCount) {
  if (isCount) {
    const top = Math.max(5, Math.ceil(maxVal / 5) * 5);
    const step = top / 5;
    return [
      String(top),
      String(Math.round(step * 4)),
      String(Math.round(step * 3)),
      String(Math.round(step * 2)),
      String(Math.round(step * 1)),
      '0'
    ];
  }

  if (maxVal <= 0) {
    return ['100 MB', '75 MB', '50 MB', '25 MB', '10 MB', '0 MB'];
  }

  const power = Math.min(4, Math.floor(Math.log(maxVal) / Math.log(1024)));
  const unitSize = 1024 ** power;
  const valInUnit = maxVal / unitSize;
  const niceMultipliers = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000];
  const topUnitVal = niceMultipliers.find(m => m >= valInUnit) || (Math.ceil(valInUnit / 10) * 10);
  const topBytes = topUnitVal * unitSize;

  const fractions = [1, 0.75, 0.5, 0.25, 0.1, 0];
  return fractions.map(f => f === 0 ? '0 MB' : bytes(topBytes * f));
}

/* Render Download Analytics Chart */
function renderAnalyticsChart() {
  const barsContainer = $('#analytics-bars');
  const yAxisContainer = $('#analytics-y-axis');
  if (!barsContainer) return;

  const downloads = getFilteredDownloads(analyticsTimeframe);
  const now = new Date();
  const currentDayOfWeek = (now.getDay() + 6) % 7;

  let buckets = [];
  const isCount = analyticsMode === 'count';

  if (analyticsMode === 'type') {
    const categories = ['Video', 'Audio', 'Documents', 'Archives', 'Programs', 'Other'];
    const shortLabels = ['Video', 'Audio', 'Docs', 'Arch', 'Prog', 'Other'];
    const dataMap = {};
    for (const cat of categories) {
      dataMap[cat] = { size: 0, count: 0 };
    }
    for (const d of downloads) {
      const cat = categoryOf(d);
      if (dataMap[cat]) {
        dataMap[cat].size += numeric(d.downloaded) || numeric(d.total);
        dataMap[cat].count += 1;
      }
    }
    buckets = categories.map((cat, i) => ({
      label: shortLabels[i],
      fullName: cat,
      value: dataMap[cat].size,
      count: dataMap[cat].count,
      formattedValue: bytes(dataMap[cat].size),
      tooltip: `${cat}<br><strong>${bytes(dataMap[cat].size)}</strong> (${dataMap[cat].count} files)`
    }));
  } else if (analyticsTimeframe === 'week') {
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dayFullNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const values = [0, 0, 0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0, 0, 0];

    for (const d of downloads) {
      const dt = new Date(d.completedAt || d.createdAt || 0);
      const dayIdx = (dt.getDay() + 6) % 7;
      values[dayIdx] += numeric(d.downloaded) || numeric(d.total);
      counts[dayIdx] += 1;
    }

    buckets = dayLabels.map((label, i) => {
      const val = isCount ? counts[i] : values[i];
      const tipVal = isCount ? `${counts[i]} ${counts[i] === 1 ? 'download' : 'downloads'}` : bytes(values[i]);
      return {
        label,
        fullName: dayFullNames[i],
        value: val,
        count: counts[i],
        formattedValue: tipVal,
        tooltip: `${dayFullNames[i]}<br><strong>${tipVal}</strong>`
      };
    });
  } else if (analyticsTimeframe === 'month') {
    const weekLabels = ['W1', 'W2', 'W3', 'W4'];
    const weekFullNames = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
    const values = [0, 0, 0, 0];
    const counts = [0, 0, 0, 0];

    for (const d of downloads) {
      const dt = new Date(d.completedAt || d.createdAt || 0);
      const dom = dt.getDate();
      const weekIdx = Math.min(3, Math.floor((dom - 1) / 7));
      values[weekIdx] += numeric(d.downloaded) || numeric(d.total);
      counts[weekIdx] += 1;
    }

    buckets = weekLabels.map((label, i) => {
      const val = isCount ? counts[i] : values[i];
      const tipVal = isCount ? `${counts[i]} ${counts[i] === 1 ? 'download' : 'downloads'}` : bytes(values[i]);
      return {
        label,
        fullName: weekFullNames[i],
        value: val,
        count: counts[i],
        formattedValue: tipVal,
        tooltip: `${weekFullNames[i]}<br><strong>${tipVal}</strong>`
      };
    });
  } else {
    // 'all' time -> Group by past 6 months
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pastMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      pastMonths.push({ year: d.getFullYear(), month: d.getMonth(), label: monthNames[d.getMonth()] });
    }

    const values = [0, 0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0, 0];

    for (const d of downloads) {
      const dt = new Date(d.completedAt || d.createdAt || 0);
      const dy = dt.getFullYear(), dm = dt.getMonth();
      const idx = pastMonths.findIndex(m => m.year === dy && m.month === dm);
      if (idx !== -1) {
        values[idx] += numeric(d.downloaded) || numeric(d.total);
        counts[idx] += 1;
      }
    }

    buckets = pastMonths.map((m, i) => {
      const val = isCount ? counts[i] : values[i];
      const tipVal = isCount ? `${counts[i]} ${counts[i] === 1 ? 'download' : 'downloads'}` : bytes(values[i]);
      return {
        label: m.label,
        fullName: `${m.label} ${m.year}`,
        value: val,
        count: counts[i],
        formattedValue: tipVal,
        tooltip: `${m.label} ${m.year}<br><strong>${tipVal}</strong>`
      };
    });
  }

  // Calculate maximum value for Y-axis scale
  const maxVal = Math.max(0, ...buckets.map(b => b.value));
  let topScale = maxVal;
  if (isCount) {
    topScale = Math.max(5, Math.ceil(maxVal / 5) * 5);
  } else if (maxVal > 0) {
    const power = Math.min(4, Math.floor(Math.log(maxVal) / Math.log(1024)));
    const unitSize = 1024 ** power;
    const valInUnit = maxVal / unitSize;
    const niceMultipliers = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000];
    const topUnitVal = niceMultipliers.find(m => m >= valInUnit) || (Math.ceil(valInUnit / 10) * 10);
    topScale = topUnitVal * unitSize;
  }

  // Render Y-Axis
  if (yAxisContainer) {
    const yLabels = generateYAxis(maxVal, isCount);
    yAxisContainer.innerHTML = yLabels.map(l => `<span>${l}</span>`).join('');
  }

  // Determine active highlight index
  let highlightIdx = selectedBarIndex;
  if (highlightIdx === null || highlightIdx >= buckets.length) {
    if (analyticsTimeframe === 'week' && analyticsMode !== 'type') {
      highlightIdx = currentDayOfWeek;
    } else {
      let maxIdx = 0;
      for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].value > buckets[maxIdx].value) maxIdx = i;
      }
      highlightIdx = maxIdx;
    }
  }

  // Render Bars
  barsContainer.innerHTML = '';
  buckets.forEach((bucket, idx) => {
    const isHighlighted = idx === highlightIdx;
    const heightPercent = topScale > 0 && bucket.value > 0
      ? Math.min(100, Math.max(8, (bucket.value / topScale) * 100))
      : 6;

    const col = element('div', `bar-col${isHighlighted ? ' highlighted' : ''}`);
    col.dataset.index = String(idx);
    col.dataset.label = bucket.label;

    const tooltip = element('div', 'bar-tooltip');
    tooltip.innerHTML = bucket.tooltip;
    col.appendChild(tooltip);

    const fill = element('div', `bar-fill${isHighlighted ? ' lime-fill' : ''}`);
    fill.style.height = `${heightPercent.toFixed(1)}%`;
    col.appendChild(fill);

    const label = element('span', 'bar-label', bucket.label);
    col.appendChild(label);

    col.addEventListener('click', () => {
      selectedBarIndex = idx;
      renderAnalyticsChart();
    });

    barsContainer.appendChild(col);
  });
}

/* Update Limitation & Gauge Widgets */
function updateLimitationStats() {
  const downloads = getFilteredDownloads(limitationTimeframe);
  const totalDownloaded = downloads.reduce((acc, d) => acc + numeric(d.downloaded), 0);

  let limitBytes;
  let limitLabel;
  let captionLabel;
  if (limitationTimeframe === 'week') {
    limitBytes = 100 * 1024 * 1024 * 1024; // 100 GB
    limitLabel = '100GB';
    captionLabel = 'of weekly limit';
  } else if (limitationTimeframe === 'month') {
    limitBytes = 500 * 1024 * 1024 * 1024; // 500 GB
    limitLabel = '500GB';
    captionLabel = 'of monthly limit';
  } else {
    limitBytes = 1024 * 1024 * 1024 * 1024; // 1 TB
    limitLabel = '1 TB';
    captionLabel = 'of total limit';
  }

  // Left: Semicircle Gauge
  const gaugeVal = $('#gauge-stat-value');
  if (gaugeVal) {
    const size = numeric(totalDownloaded);
    if (!size) {
      gaugeVal.textContent = '0GB';
    } else {
      const power = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
      const val = size / (1024 ** power);
      const formatted = val >= 10 || Number.isInteger(val) ? val.toFixed(0) : val.toFixed(1);
      gaugeVal.textContent = `${formatted}${['B', 'KB', 'MB', 'GB', 'TB'][power]}`;
    }
  }

  const gaugeCaption = $('#gauge-caption');
  if (gaugeCaption) gaugeCaption.textContent = `of ${limitationTimeframe === 'all' ? '1 TB' : limitLabel} Limit download`;

  const gaugeArc = $('#gauge-arc');
  if (gaugeArc) {
    const totalCircumference = 125.66;
    const ratio = Math.min(1, totalDownloaded / limitBytes);
    const offset = totalCircumference * (1 - ratio);
    gaugeArc.style.strokeDashoffset = String(offset.toFixed(2));
  }

  // Right: Quota Meter
  const quotaUsed = $('#quota-used');
  if (quotaUsed) {
    let usedFormatted = bytes(totalDownloaded);
    if (totalDownloaded >= 1024 * 1024 * 1024) {
      usedFormatted = (totalDownloaded / (1024 ** 3)).toFixed(0);
    }
    quotaUsed.innerHTML = `<span class="quota-highlight">${usedFormatted}</span>/${limitLabel}`;
  }

  const quotaCaption = $('#quota-caption');
  if (quotaCaption) quotaCaption.textContent = captionLabel;

  const quotaBar = $('#quota-bar-fill');
  if (quotaBar) {
    const percent = Math.min(100, (totalDownloaded / limitBytes) * 100);
    const displayPercent = totalDownloaded > 0 ? Math.max(4, percent) : 0;
    quotaBar.style.width = `${displayPercent.toFixed(1)}%`;
  }
}

/* Render Table Row for File Management */
function rowFor(d) {
  const status = statusOf(d), percent = percentage(d);
  const isSelected = selectedIds.has(d.id);
  const row = element('tr', 'download-row');
  row.dataset.id = d.id;
  row.dataset.status = status;
  row.classList.toggle('selected', isSelected);
  row.setAttribute('aria-selected', String(isSelected));

  const nameCell = element('td');
  nameCell.title = d.filename || d.url;
  const name = element('span', 'file-name');

  // Custom rounded checkbox matching screenshot
  const chk = element('span', `row-checkbox${isSelected ? ' checked' : ''}`);
  chk.setAttribute('role', 'checkbox');
  chk.setAttribute('aria-checked', String(isSelected));
  chk.title = isSelected ? 'Deselect file' : 'Select file';
  const checkIcon = element('span', 'checkbox-icon', '✓');
  chk.appendChild(checkIcon);

  chk.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedIds.has(d.id)) {
      selectedIds.delete(d.id);
    } else {
      selectedIds.add(d.id);
    }
    selectedId = selectedIds.has(d.id) ? d.id : (selectedIds.values().next().value || null);
    paintSelection();
  });

  const fileTitle = element('span', 'file-title', d.filename || 'Preparing file…');
  name.append(chk, fileTitle);
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
    if (event.target.closest('.row-checkbox')) return;
    if (event.ctrlKey || event.metaKey) {
      if (selectedIds.has(d.id)) selectedIds.delete(d.id);
      else selectedIds.add(d.id);
      selectedId = selectedIds.has(d.id) ? d.id : (selectedIds.values().next().value || null);
    } else if (event.shiftKey && selectedId) {
      const ids = visibleDownloads.map(x => x.id);
      const from = ids.indexOf(selectedId);
      const to = ids.indexOf(d.id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        for (let i = start; i <= end; i++) selectedIds.add(ids[i]);
      } else {
        selectedIds.add(d.id);
      }
      selectedId = d.id;
    } else {
      selectDownload(d.id, { additive: false, toggle: false });
    }
    paintSelection();
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
  const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
  const count = selectedList.length;
  const anyBusy = selectedList.some(d => pending.has(d.id));
  const setDisabled = (id, val) => { const el = $(id); if (el) el.disabled = Boolean(val); };

  const canResumeAny = selectedList.some(d => canResume(d) || d?.needsReview);
  const canPauseAny = selectedList.some(canPause);

  setDisabled('#resume-selected', count === 0 || !canResumeAny || anyBusy);
  setDisabled('#stop-selected', count === 0 || !canPauseAny || anyBusy);
  setDisabled('#remove-selected', count === 0 || anyBusy);

  const d = selected();
  setDisabled('#open-selected', count !== 1 || !d || statusOf(d) !== 'completed');
  setDisabled('#reveal-selected', count === 0 || !d);
  setDisabled('#details-selected', count !== 1 || !d);

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
  renderAnalyticsChart();
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

const EXT_CATEGORIES = {
  Video: /\.(mp4|webm|mkv|mov|avi|m4v|flv|wmv|ts)$/i,
  Audio: /\.(mp3|m4a|aac|flac|ogg|wav|wma|opus)$/i,
  Archives: /\.(zip|7z|rar|tar|gz|iso|bz2|xz)$/i,
  Documents: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|epub|rtf)$/i,
  Programs: /\.(exe|msi|msix|bat|cmd|apk)$/i
};

function categoryForName(name) {
  return Object.entries(EXT_CATEGORIES).find(([, re]) => re.test(name))?.[0] || 'Other';
}

let autoSuggestTimer = null;
let lastAutoSuggestedUrl = '';

function inferFilenameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    const isYt = host === 'youtu.be' || ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host);
    if (isYt) {
      const yId = host === 'youtu.be'
        ? parsed.pathname.slice(1)
        : (parsed.pathname === '/watch' ? parsed.searchParams.get('v') : /^\/(shorts|embed)\/([^/]+)$/.exec(parsed.pathname)?.[2]);
      if (yId && /^[\w-]{11}$/.test(yId)) {
        return { filename: `YouTube_${yId}.mp4`, category: 'Video', isYouTube: true, canonicalUrl: `https://www.youtube.com/watch?v=${yId}` };
      }
    }

    for (const param of ['filename', 'file_name', 'file', 'title', 'name']) {
      const val = parsed.searchParams.get(param);
      if (val && val.length > 1 && !/^(true|false|null|undefined|\d+)$/i.test(val)) {
        try {
          let clean = decodeURIComponent(val).trim();
          if (clean) {
            if (!/\.[a-z0-9]{2,5}$/i.test(clean)) clean += (/\.m3u8(?:[?#]|$)/i.test(rawUrl) ? '.mp4' : '');
            return { filename: clean, category: categoryForName(clean) };
          }
        } catch {}
      }
    }

    const segments = parsed.pathname.split('/').filter(Boolean).map(s => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    const last = segments.pop() || '';
    const genericRe = /^(videoplayback|watch|video|audio|media|download|file|stream|play|manifest|master|index|playlist|segment|fragment|chunk|get_video|player|output)(?:\.[a-z0-9]{2,4})?$/i;

    let candidate = last;
    if (!candidate || genericRe.test(candidate)) {
      const prev = segments.reverse().find(s => !genericRe.test(s) && !/^(api|v\d+|rest|v1|v2|v3|player|static|assets|media|content|hls)$/i.test(s));
      if (prev) candidate = prev;
    }

    if (!candidate || genericRe.test(candidate)) {
      candidate = parsed.hostname.replace(/^www\./, '').split('.')[0] || 'download';
    }

    if (!/\.[a-z0-9]{2,5}$/i.test(candidate)) {
      if (/\.m3u8(?:[?#]|$)/i.test(rawUrl)) candidate += '.mp4';
    }

    return { filename: candidate, category: categoryForName(candidate) };
  } catch {
    return null;
  }
}

async function handleUrlInputSuggest() {
  const urlsVal = $('#download-urls')?.value || '';
  const lines = urlsVal.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
  if (lines.length !== 1) return;
  const firstUrl = lines[0];
  if (firstUrl === lastAutoSuggestedUrl) return;
  lastAutoSuggestedUrl = firstUrl;

  const info = inferFilenameFromUrl(firstUrl);
  if (!info) return;

  const fnInput = $('#download-filename');
  const catInput = $('#download-category');
  if (fnInput && (!fnInput.value || fnInput.dataset.autoFilled === 'true')) {
    fnInput.value = info.filename;
    fnInput.dataset.autoFilled = 'true';
  }
  if (catInput && (!catInput.value || catInput.dataset.autoFilled === 'true')) {
    catInput.value = info.category || '';
    catInput.dataset.autoFilled = 'true';
    const rem = $('#remember-category-path');
    if (rem) rem.disabled = !catInput.value;
  }

  if (info.isYouTube && info.canonicalUrl) {
    try {
      const formats = await call('formats', { url: info.canonicalUrl });
      if (formats && formats.length && formats[0].title) {
        if (fnInput && fnInput.dataset.autoFilled === 'true') {
          fnInput.value = `${formats[0].title}.${formats[0].outputFormat || 'mp4'}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
        }
      }
    } catch {}
  }
}

function openAdd(text = '', scheduled = '') {
  pendingReviewId = null;
  lastAutoSuggestedUrl = '';
  const addErr = $('#add-error');
  if (addErr) addErr.hidden = true;
  const urls = $('#download-urls');
  if (urls) { urls.value = text; urls.readOnly = false; }
  const fn = $('#download-filename'); if (fn) { fn.value = ''; delete fn.dataset.autoFilled; }
  const desc = $('#download-description'); if (desc) desc.value = '';
  const cat = $('#download-category'); if (cat) { cat.value = ''; delete cat.dataset.autoFilled; }
  const rem = $('#remember-category-path'); if (rem) { rem.checked = false; rem.disabled = true; }
  const sch = $('#download-schedule'); if (sch) sch.value = scheduled;
  const dir = $('#add-directory'); if (dir) dir.value = state.settings.defaultDirectory || '';
  if (text) setTimeout(handleUrlInputSuggest, 10);
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
  const title = $('#details-title');
  if (title) {
    title.textContent = percent !== null ? `Downloading ${Math.floor(percent)}%` : status === 'completed' ? 'Download Complete' : status === 'paused' ? 'Download Paused' : (d.filename || 'Download status');
  }
  const src = $('#transfer-source'); if (src) { src.textContent = d.url || ''; src.title = d.url || ''; }

  const cat = categoryOf(d);
  const iconEl = $('#detail-file-icon');
  if (iconEl) {
    iconEl.className = `detail-file-icon ${iconClassForCategory(cat)}`;
    iconEl.innerHTML = categorySvg(cat);
  }

  const fnEl = $('#detail-filename'); if (fnEl) { fnEl.textContent = d.filename || 'download_file'; fnEl.title = d.filename || ''; }
  const fsEl = $('#detail-filesize'); if (fsEl) fsEl.textContent = sizeLabel(d);

  const fillEl = $('#detail-progress-bar-fill');
  if (fillEl) fillEl.style.width = `${percent || 0}%`;

  const pillEl = $('#detail-progress-pill');
  if (pillEl) {
    pillEl.textContent = percent !== null ? `${percent.toFixed(1)}%` : '';
    pillEl.style.display = percent !== null && percent > 0 ? 'inline-block' : 'none';
  }

  const bytesEl = $('#detail-metric-bytes');
  if (bytesEl) bytesEl.textContent = `${bytes(d.downloaded)} of ${sizeLabel(d)}`;

  const timeEl = $('#detail-metric-time');
  if (timeEl) timeEl.textContent = status === 'downloading' ? timeLeft(d) || 'Estimating…' : status === 'completed' ? 'Finished' : '—';

  const speedEl = $('#detail-metric-speed');
  if (speedEl) speedEl.textContent = status === 'downloading' ? `${bytes(d.speed)}/sec` : '0 B/sec';

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
    const segmentStatus = segment.status === 'complete' || segment.status === 'completed' ? 'Completed' : segment.status || (status === 'downloading' ? 'Receiving data…' : names[status] || status);
    const total = numeric(segment.total);
    const segPercent = total ? Math.min(100, Math.round(numeric(segment.downloaded) / total * 100)) : (segment.status === 'complete' ? 100 : 0);

    const colNum = element('td', 'seg-num', String(index + 1));
    const colBytes = element('td', 'seg-bytes', bytes(segment.downloaded));
    const colStatus = element('td', 'seg-status', segmentStatus);
    const colProgress = element('td', 'seg-progress');
    const track = element('div', 'seg-mini-track');
    const fill = element('div', 'seg-mini-fill');
    fill.style.width = `${segPercent}%`;
    track.append(fill);
    colProgress.append(track);

    row.append(colNum, colBytes, colStatus, colProgress);
    if (bars) bars.append(row);

    const bar = element('progress');
    bar.max = 100;
    bar.value = segPercent;
    bar.setAttribute('aria-label', `Connection ${index + 1} progress`);
    if (!total && status === 'downloading') bar.removeAttribute('value');
    if (map) map.append(bar);
  }

  const note = $('#segment-note'); if (note) note.textContent = segments.length ? `${segments.length} active connection(s)` : status === 'completed' ? 'Download completed.' : 'Connection progress appears when the transfer starts.';
  const err = $('#detail-error'); if (err) { err.textContent = d.error || ''; err.hidden = !d.error; }

  const setDisabled = (id, val) => { const el = $(id); if (el) el.disabled = Boolean(val); };
  setDisabled('#detail-open', status !== 'completed');
  setDisabled('#detail-resume', !canResume(d) || pending.has(d.id));
  setDisabled('#detail-stop', !canPause(d) || pending.has(d.id));
  setDisabled('#detail-cancel', ['completed', 'cancelled'].includes(status) || pending.has(d.id));

  const isPaused = ['paused', 'queued', 'scheduled', 'failed', 'cancelled'].includes(status);
  const btnResume = $('#detail-resume');
  const btnStop = $('#detail-stop');
  const btnCancel = $('#detail-cancel');
  const transferBtns = $('.transfer-buttons');
  const completeActions = $('#download-complete-actions');

  if (status === 'completed') {
    if (transferBtns) transferBtns.hidden = true;
    if (completeActions) completeActions.hidden = false;
  } else {
    if (transferBtns) transferBtns.hidden = false;
    if (completeActions) completeActions.hidden = true;

    if (btnResume && btnStop) {
      if (isPaused) {
        btnResume.hidden = false;
        btnStop.hidden = true;
      } else {
        btnResume.hidden = true;
        btnStop.hidden = false;
      }
    }
    if (btnCancel) {
      btnCancel.hidden = false;
    }
  }

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

  $('#queue-resume-selected')?.addEventListener('click', async () => {
    const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
    const resumable = selectedList.filter(canResume);
    for (const d of resumable) await performAction(d, 'resume');
  });

  $('#queue-pause-selected')?.addEventListener('click', async () => {
    const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
    const pausable = selectedList.filter(canPause);
    for (const d of pausable) await performAction(d, 'pause');
  });

  $('#queue-delete-selected')?.addEventListener('click', async () => {
    const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
    if (!selectedList.length) return;
    const msg = selectedList.length === 1
      ? `Delete “${selectedList[0].filename || 'this download'}”?`
      : `Delete ${selectedList.length} downloads?`;
    if (!window.confirm(msg)) return;
    for (const d of selectedList) {
      await call('action', { id: d.id, action: 'remove' });
    }
    selectedIds.clear();
    await refresh();
  });

  // Filetype Category Cards click
  $$('.filetype-item[data-category]').forEach(card => {
    card.addEventListener('click', () => {
      setNavView('files');
      setView('all', card.dataset.category);
    });
  });

  // Dropdown helper
  function closeAllDropdowns() {
    $$('.dropdown-menu').forEach(menu => menu.setAttribute('hidden', ''));
    $$('.dropdown-trigger').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('click', closeAllDropdowns);

  // Analytics Chart Tabs: Size File, Total Download, Type File
  $$('.chart-tab[data-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      $$('.chart-tab[data-tab]').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      analyticsMode = tabBtn.dataset.tab;
      selectedBarIndex = null;
      renderAnalyticsChart();
    });
  });

  // Analytics Timeframe Dropdown
  const analyticsBtn = $('#analytics-timeframe-btn');
  const analyticsMenu = $('#analytics-timeframe-menu');
  const analyticsLabel = $('#analytics-timeframe-label');
  if (analyticsBtn && analyticsMenu) {
    analyticsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = analyticsMenu.hasAttribute('hidden');
      closeAllDropdowns();
      if (isHidden) {
        analyticsMenu.removeAttribute('hidden');
        analyticsBtn.setAttribute('aria-expanded', 'true');
      }
    });

    analyticsMenu.querySelectorAll('.dropdown-item[data-timeframe]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        analyticsTimeframe = item.dataset.timeframe;
        analyticsMenu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        if (analyticsLabel) {
          analyticsLabel.textContent = analyticsTimeframe === 'week' ? 'Week' : analyticsTimeframe === 'month' ? 'Month' : 'All Time';
        }
        analyticsMenu.setAttribute('hidden', '');
        analyticsBtn.setAttribute('aria-expanded', 'false');
        selectedBarIndex = null;
        renderAnalyticsChart();
      });
    });
  }

  // Limitation Timeframe Dropdown
  const limitationBtn = $('#limitation-timeframe-btn');
  const limitationMenu = $('#limitation-timeframe-menu');
  const limitationLabel = $('#limitation-timeframe-label');
  if (limitationBtn && limitationMenu) {
    limitationBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = limitationMenu.hasAttribute('hidden');
      closeAllDropdowns();
      if (isHidden) {
        limitationMenu.removeAttribute('hidden');
        limitationBtn.setAttribute('aria-expanded', 'true');
      }
    });

    limitationMenu.querySelectorAll('.dropdown-item[data-timeframe]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        limitationTimeframe = item.dataset.timeframe;
        limitationMenu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        if (limitationLabel) {
          limitationLabel.textContent = limitationTimeframe === 'week' ? 'Week' : limitationTimeframe === 'month' ? 'Month' : 'All Time';
        }
        limitationMenu.setAttribute('hidden', '');
        limitationBtn.setAttribute('aria-expanded', 'false');
        updateLimitationStats();
      });
    });
  }

  // Master Select-All Checkbox
  $('#select-all-checkbox')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const visibleIds = visibleDownloads.map(d => d.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
    if (allSelected) {
      visibleIds.forEach(id => selectedIds.delete(id));
      selectedId = null;
    } else {
      visibleIds.forEach(id => selectedIds.add(id));
      selectedId = visibleIds[0] || null;
    }
    paintSelection();
  });

  // Table action buttons (Multi-select enabled)
  $('#resume-selected')?.addEventListener('click', async () => {
    const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
    if (selectedList.length === 1 && selectedList[0].needsReview) {
      openReview(selectedList[0].id);
      return;
    }
    const resumable = selectedList.filter(d => canResume(d) || d.needsReview);
    if (!resumable.length) return;
    for (const d of resumable) {
      if (d.needsReview) { openReview(d.id); break; }
      await performAction(d, ['failed', 'cancelled'].includes(statusOf(d)) ? 'retry' : 'resume');
    }
  });

  $('#stop-selected')?.addEventListener('click', async () => {
    const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
    const pausable = selectedList.filter(canPause);
    for (const d of pausable) {
      await performAction(d, 'pause');
    }
  });

  $('#remove-selected')?.addEventListener('click', async () => {
    const selectedList = state.downloads.filter(d => selectedIds.has(d.id));
    if (!selectedList.length) return;
    const msg = selectedList.length === 1
      ? `Delete “${selectedList[0].filename || 'this download'}” from the download list?\n\nThe downloaded file will remain on your PC.`
      : `Delete ${selectedList.length} downloads from the download list?\n\nThe downloaded files will remain on your PC.`;
    if (!window.confirm(msg)) return;

    for (const d of selectedList) pending.add(d.id);
    updateControls();
    try {
      for (const d of selectedList) {
        await call('action', { id: d.id, action: 'remove' });
      }
      selectedIds.clear();
      selectedId = null;
      await refresh();
      notify(`Removed ${selectedList.length} ${selectedList.length === 1 ? 'download' : 'downloads'}.`);
    } catch (error) {
      notify(messageOf(error), true);
    } finally {
      for (const d of selectedList) pending.delete(d.id);
      updateControls();
    }
  });

  $('#open-selected')?.addEventListener('click', () => performAction(selected(), 'open'));
  $('#reveal-selected')?.addEventListener('click', () => {
    const d = selected();
    if (d) performAction(d, 'reveal');
  });
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
  $('#download-urls')?.addEventListener('input', () => {
    clearTimeout(autoSuggestTimer);
    autoSuggestTimer = setTimeout(handleUrlInputSuggest, 150);
  });
  $('#download-filename')?.addEventListener('input', () => {
    const fn = $('#download-filename');
    if (fn) delete fn.dataset.autoFilled;
  });
  $('#download-category')?.addEventListener('change', () => {
    const cat = $('#download-category');
    if (cat) delete cat.dataset.autoFilled;
  });

  $('#paste-button')?.addEventListener('click', async () => {
    try {
      const urls = $('#download-urls');
      if (urls) {
        urls.value = await call('clipboard');
        urls.focus();
        setTimeout(handleUrlInputSuggest, 20);
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
    $('#toggle-details').textContent = details.hidden ? 'Show Details' : 'Hide Details';
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
      if (event.button !== 0 || event.target.closest('thead') || event.target.closest('button') || event.target.closest('.row-checkbox')) return;
      const point = tablePoint(event), row = event.target.closest('.download-row');
      selectionDrag = { pointerId: event.pointerId, startX: point.x, startY: point.y, row, base: (event.ctrlKey || event.metaKey) ? new Set(selectedIds) : new Set(), moved: false };
      if (!row) {
        tableScroll.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
    });

    tableScroll.addEventListener('pointermove', event => {
      if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
      const point = tablePoint(event), dx = point.x - selectionDrag.startX, dy = point.y - selectionDrag.startY;
      if (!selectionDrag.moved && Math.hypot(dx, dy) < 6) return;
      if (!selectionDrag.moved) {
        selectionDrag.moved = true;
        try { tableScroll.setPointerCapture(event.pointerId); } catch {}
      }
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
