'use strict';

const query = (selector, root = document) => root.querySelector(selector);
const queryAll = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.downloader;
const isMac = api.platform === 'darwin';
const progressMode = new URLSearchParams(window.location.search).get('progress');

if (progressMode) {
  document.body.classList.add('progress-window');
}

let state = { downloads: [], settings: {}, integration: {} };
let selectedId = null;
let detailId = null;
let filter = 'all';
let category = '';
let searchTerm = '';
let sort = 'createdAt';
let ascending = false;
let visibleDownloads = [];
let toastTimer;
let unsubscribe;
let unsubscribeCommands;
const selectedIds = new Set();
const pending = new Set();
let pendingReviewId = null;
let selectionDrag = null;
let suppressRowClick = false;
const dismissedReviews = new Set();

const iconPaths = {
  add: ['M5 9h8l2-3h6l2 3h6v20H5z', 'M17 13v12M11 19h12'],
  resume: ['M16 2a14 14 0 1 0 0 28a14 14 0 0 0 0-28', 'M16 8v16M10 18l6 6 6-6'],
  stop: [
    'M9 17V8a2 2 0 0 1 4 0v8V4a2 2 0 0 1 4 0v12V6a2 2 0 0 1 4 0v11V10a2 2 0 0 1 4 0v12q0 8-9 8h-1q-4 0-7-5L3 18q-2-4 2-4z',
  ],
  stopall: [
    'M9 17V8a2 2 0 0 1 4 0v8V4a2 2 0 0 1 4 0v12V6a2 2 0 0 1 4 0v11V10a2 2 0 0 1 4 0v12q0 8-9 8h-1q-4 0-7-5L3 18q-2-4 2-4z',
  ],
  delete: ['M5 7h22M12 7V3h8v4M7 10l2 20h14l2-20M13 12v14M19 12v14'],
  clear: ['M5 6h22l-2 24H7zM12 6V3h8v3', 'M10 17l5 5 8-11'],
  options: [
    'M16 3l2 4 4 1 4-2 4 6-3 3v4l3 3-4 6-4-2-4 1-2 4h-7l-2-4-4-1-4 2-4-6 3-3v-4l-3-3 4-6 4 2 4-1 2-4z',
    'M16 11a5 5 0 1 0 0 10a5 5 0 0 0 0-10',
  ],
  clock: ['M16 4a13 13 0 1 0 0 26a13 13 0 0 0 0-26', 'M6 5 3 2M26 5l3-3M16 9v8l6-6'],
  startqueue: ['M2 2h23v24H2zM7 7h23v23H7z', 'M22 12v18M16 24l6 6 6-6'],
  stopqueue: ['M2 2h23v24H2zM7 7h23v23H7z', 'M19 18h12v13H19z'],
  browser: [
    'M16 3a13 13 0 1 0 0 26a13 13 0 0 0 0-26',
    'M3 16h26M16 3c-8 8-8 18 0 26M16 3c8 8 8 18 0 26M6 8h20M6 24h20',
  ],
};

for (const button of queryAll('[data-icon]')) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 34 34');
  svg.setAttribute('aria-hidden', 'true');

  for (const data of iconPaths[button.dataset.icon] || []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }

  button.prepend(svg);
}

if (isMac) {
  for (const node of queryAll('[title*="Ctrl+"]')) {
    node.title = node.title.replaceAll('Ctrl+', '⌘');
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

// Browser registration stays local and is performed by the trusted desktop bridge.
const registrationForm = element('form', 'registration-form');
const registrationFieldset = element('fieldset');
registrationFieldset.append(element('legend', '', 'Connect browser'));
const browserLine = element('div', 'form-line');
const browserLabel = element('label', '', 'Browser:');
browserLabel.htmlFor = 'register-browser';
const browserSelect = element('select');
browserSelect.id = 'register-browser';

for (const browser of ['Chrome', 'Edge', 'Firefox']) {
  browserSelect.append(element('option', '', browser));
}

browserLine.append(browserLabel, browserSelect);
const idLine = element('div', 'form-line');
const idLabel = element('label', '', 'Extension ID:');
idLabel.htmlFor = 'register-extension-id';
const idInput = element('input');
idInput.id = 'register-extension-id';
idInput.required = true;
idInput.spellcheck = false;
idLine.append(idLabel, idInput);
const registerButton = element('button', 'button', 'Connect');
registerButton.type = 'submit';
const registrationResult = element('p', 'registration-result');
registrationResult.id = 'registration-result';
registrationResult.setAttribute('role', 'status');
registrationFieldset.append(browserLine, idLine, registerButton, registrationResult);
registrationForm.append(registrationFieldset);
query('.setup-steps').after(registrationForm);

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  registerButton.disabled = true;
  registrationResult.textContent = '';

  try {
    const result = await call('registerBrowser', {
      browser: browserSelect.value,
      extensionId: idInput.value.trim(),
    });

    if (result?.extensionPath) {
      query('#extension-path').value = result.extensionPath;
    }

    registrationResult.dataset.error = 'false';

    registrationResult.textContent =
      'Browser connected. Reload the extension, then try a download.';
  } catch (error) {
    registrationResult.dataset.error = 'true';
    registrationResult.textContent = messageOf(error);
  } finally {
    registerButton.disabled = false;
  }
});

const rememberLabel = element('label', 'checkbox-label');
const rememberInput = element('input');
rememberInput.type = 'checkbox';
rememberInput.id = 'remember-category-path';
rememberInput.disabled = true;

rememberLabel.append(
  rememberInput,
  document.createTextNode('Remember this folder for the selected category'),
);

query('#add-directory').closest('.form-line').after(rememberLabel);
const integrationHelp = queryAll('.field-help', query('#integration-dialog'));

if (integrationHelp.length) {
  integrationHelp[integrationHelp.length - 1].textContent =
    'Video choices open Download File Info, then a separate progress window. Supported HLS videos can be saved as MP4, including separate audio tracks. MP3 is offered when an audio track is detected.';
}

const manualConnection = element('details');

manualConnection.append(
  element('summary', '', 'Manual connection command'),
  query('#registration-command'),
);

const connectionStep = queryAll('.setup-steps li')[2];

connectionStep.replaceChildren(
  document.createTextNode(
    'Copy the extension ID shown by your browser and enter it below. Click Connect, then reload the extension.',
  ),
);

registrationForm.after(manualConnection);
registrationForm.hidden = true;
manualConnection.hidden = true;
query('.setup-steps').hidden = true;
const automaticConnection = element('p', 'connection-status', 'Checking installed browsers…');
automaticConnection.id = 'automatic-connection';
registrationForm.before(automaticConnection);
const retryConnection = element('button', 'button', 'Refresh browsers');
retryConnection.type = 'button';
retryConnection.addEventListener('click', () => openIntegration());
automaticConnection.after(retryConnection);
const installHelp = element('section');

installHelp.append(
  element(
    'p',
    '',
    'The browser extension adds “Download this video” buttons to web videos. It is included with Awesome Downloader. Follow these steps once for each browser you use.',
  ),
);

const setupActions = element('div', 'transfer-buttons');

for (const browser of ['Chrome', 'Edge']) {
  const button = element('button', 'button', `Open ${browser} extensions`);
  button.type = 'button';

  button.addEventListener('click', async () => {
    try {
      await call('browserSetup', { action: 'open', browser });
    } catch (error) {
      notify(messageOf(error), true);
    }
  });

  setupActions.append(button);
}

installHelp.append(setupActions);
const steps = element('ol');

for (const text of [
  'Here in Awesome Downloader, click Copy extension folder path above. This copies the location of the included browser extension, not your download folder.',
  'Click Open Chrome extensions or Open Edge extensions above. Your browser opens its Extensions page.',
  'On that browser page, turn on Developer mode. In Edge, you may need to expand the left menu to find it.',
  ...(isMac
    ? [
        'Click Load unpacked on the Extensions page. A Finder folder selection window opens.',
        'In that folder selection window, press ⌘⇧G to open Go to Folder. Press ⌘V to paste the copied extension folder path, then press Return. Do not paste into the browser’s web address bar or the Search box.',
        'Click Select in the Finder window. Select the extension folder itself; do not select an individual file or its icons subfolder.',
      ]
    : [
        'Click Load unpacked on the Extensions page. A Windows folder selection window opens.',
        'In that folder selection window, press Ctrl+L to select its address bar at the top. Press Ctrl+V to paste the copied extension folder path, then press Enter. Do not paste into the browser’s web address bar or the Search box.',
        'Click Select Folder (or Select) in the Windows window. Select the extension folder itself; do not select an individual file or its icons subfolder.',
      ]),
  'Check that Awesome Downloader Integration appears on the browser’s Extensions page and is switched on. Return here and wait for the connection message, then refresh your video page and play the video.',
]) {
  steps.append(element('li', '', text));
}

const extensionFolderLabel = element('label', '', 'Included browser extension folder:');
extensionFolderLabel.htmlFor = 'extension-path';
const extensionFolderInput = query('#extension-path');
const folderActions = element('div', 'transfer-buttons');

for (const [label, action] of [
  ['Copy extension folder path', 'copy'],
  ['Show extension folder', 'folder'],
]) {
  const button = element('button', 'button', label);
  button.type = 'button';

  button.addEventListener('click', async () => {
    try {
      await call('browserSetup', { action });

      if (action === 'copy') {
        notify(
          isMac
            ? 'Extension folder path copied. In the Finder window opened by Load unpacked, press ⌘⇧G, ⌘V, then Return.'
            : 'Extension folder path copied. In the Windows window opened by Load unpacked, press Ctrl+L, Ctrl+V, then Enter.',
        );
      }
    } catch (error) {
      notify(messageOf(error), true);
    }
  });

  folderActions.append(button);
}

installHelp.classList.add('browser-setup-guide');
installHelp.append(extensionFolderLabel, extensionFolderInput, folderActions, setupActions, steps);
retryConnection.after(installHelp);
let setupPolling = false;

const setupPoll = setInterval(async () => {
  if (progressMode || !query('#integration-dialog').open || setupPolling) {
    return;
  }

  setupPolling = true;

  try {
    const info = await call('integration');
    query('#extension-path').value = info.extensionPath || '';

    if (info.connectionError) {
      automaticConnection.textContent = `Setup needs attention: ${info.connectionError}`;
    } else if (info.connectedBrowsers?.length) {
      automaticConnection.textContent = `${info.connectedBrowsers.map((connection) => connection.browser).join(', ')} connected. Refresh your video page to see Download this video.`;
    } else {
      automaticConnection.textContent =
        'Waiting for you to add the extension. We will connect it automatically.';
    }
  } catch (error) {
    automaticConnection.textContent = messageOf(error);
  } finally {
    setupPolling = false;
  }
}, 3000);

window.addEventListener('beforeunload', () => clearInterval(setupPoll));
const completionActions = element('div', 'transfer-buttons');
completionActions.id = 'download-complete-actions';
completionActions.hidden = true;

for (const [label, action] of [
  ['Open', 'open'],
  ['Open with…', 'openWith'],
  ['Open folder', 'reveal'],
  ['Close', 'close'],
]) {
  const button = element('button', 'button', label);
  button.type = 'button';

  button.addEventListener('click', () =>
    action === 'close' ? query('#details-dialog').close() : performAction(detailDownload(), action),
  );

  completionActions.append(button);
}

const completedPanel = element('section', 'completed-panel');
const completedSummary = element('div', 'completed-summary');
completedPanel.append(completedSummary);
const completedFields = {};

for (const [key, label] of [
  ['url', 'Address'],
  ['path', 'The file saved as'],
]) {
  const fieldLabel = element('label', 'completed-field', label);
  const input = element('input');
  input.readOnly = true;
  input.setAttribute('aria-label', label);
  fieldLabel.append(input);
  completedPanel.append(fieldLabel);
  completedFields[key] = input;
}

completedPanel.append(completionActions);
const suppressLabel = element('label', 'checkbox-label');
const suppressCompletion = element('input');
suppressCompletion.type = 'checkbox';
suppressLabel.append(suppressCompletion, document.createTextNode("Don't show this dialog again"));
completedPanel.append(suppressLabel);

suppressCompletion.addEventListener('change', async () => {
  try {
    await call('settings', { hideCompletionDialog: suppressCompletion.checked });
  } catch (error) {
    suppressCompletion.checked = !suppressCompletion.checked;
    notify(messageOf(error), true);
  }
});

query('#details-dialog').append(completedPanel);

// Transfer details, plus the completion summary once the download has finished.
function renderDetails() {
  renderTransferDetails();
  const download = detailDownload();

  if (!download || statusOf(download) !== 'completed') {
    return;
  }

  completedSummary.replaceChildren(
    element('span', 'completed-icon', '✓'),
    element(
      'div',
      '',
      `Download complete\nDownloaded ${bytes(download.total || download.downloaded)} (${Math.round(download.total || download.downloaded || 0)} Bytes)`,
    ),
  );

  completedFields.url.value = download.url || '';
  completedFields.path.value = download.path || '';
  suppressCompletion.checked = state.settings.hideCompletionDialog === true;
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function statusOf(download) {
  const value = String(download.status || 'queued').toLowerCase();
  return (
    {
      active: 'downloading',
      running: 'downloading',
      probing: 'connecting',
      complete: 'completed',
      done: 'completed',
      error: 'failed',
      canceled: 'cancelled',
      pending: 'queued',
    }[value] || value
  );
}

function categoryOf(download) {
  const value = String(download.category || '').toLowerCase();

  if (/video/.test(value)) {
    return 'Video';
  }

  if (/audio|music/.test(value)) {
    return 'Audio';
  }

  if (/doc|text/.test(value)) {
    return 'Documents';
  }

  if (/arch|compress/.test(value)) {
    return 'Archives';
  }

  if (/program/.test(value)) {
    return 'Programs';
  }

  return 'Other';
}

function bytes(value) {
  const size = numeric(value);

  if (!size) {
    return '0 B';
  }

  const power = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** power).toFixed(power ? 2 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][power]}`;
}

function date(value) {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function timeLeft(download) {
  const total = numeric(download.total) || numeric(download.streamProgress?.estimatedBytes);

  if (!total || !numeric(download.speed)) {
    return '';
  }

  const seconds = Math.max(
    0,
    Math.ceil((total - numeric(download.downloaded)) / numeric(download.speed)),
  );

  return (!download.total || download.estimated ? '≈ ' : '') + duration(seconds);
}

function sizeLabel(download) {
  if (numeric(download.total)) {
    return (download.estimated ? '≈ ' : '') + bytes(download.total);
  }

  if (download.streamProgress?.estimatedBytes) {
    return `≈ ${bytes(download.streamProgress.estimatedBytes)}`;
  }

  return download.kind === 'hls' ? 'Calculating from segments…' : 'Not supplied by server';
}

function duration(seconds) {
  if (seconds < 60) {
    return `${Math.ceil(seconds)} sec`;
  }

  if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)} min`;
  }

  return `${Math.floor(seconds / 3600)} hr ${Math.floor((seconds % 3600) / 60)} min`;
}

function percentage(download) {
  if (statusOf(download) === 'completed') {
    return 100;
  }

  if (numeric(download.total)) {
    return Math.min(100, (numeric(download.downloaded) / numeric(download.total)) * 100);
  }

  if (download.streamProgress?.total) {
    return (download.streamProgress.completed / download.streamProgress.total) * 100;
  }

  return null;
}

function messageOf(error) {
  return error?.message || String(error || 'The operation failed.');
}

function notify(message, error = false) {
  clearTimeout(toastTimer);
  query('#toast-text').textContent = message;
  query('#toast').dataset.error = String(error);
  query('#toast').hidden = false;

  toastTimer = setTimeout(
    () => {
      query('#toast').hidden = true;
    },
    error ? 14000 : 7000,
  );
}

async function call(method, ...args) {
  if (!api || typeof api[method] !== 'function') {
    throw new Error('The download service is unavailable. Restart Awesome Downloader.');
  }

  const result = await api[method](...args);

  if (result?.error && !result.downloads) {
    throw new Error(
      typeof result.error === 'string'
        ? result.error
        : result.error.message || 'The request failed.',
    );
  }

  return result;
}

function acceptSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.downloads)) {
    return;
  }

  state = {
    downloads: snapshot.downloads,
    settings: snapshot.settings || state.settings,
    integration: snapshot.integration || state.integration,
  };

  const valid = new Set(state.downloads.map((download) => download.id));

  for (const id of selectedIds) {
    if (!valid.has(id)) {
      selectedIds.delete(id);
    }
  }

  if (!valid.has(selectedId)) {
    selectedId = selectedIds.values().next().value || null;
  }

  query('#download-list').setAttribute('aria-busy', 'false');
  query('#connection-label').textContent = 'Connected';
  render();

  if (!queryAll('dialog[open]').length) {
    const review = state.downloads.find(
      (download) => download.needsReview && !dismissedReviews.has(download.id),
    );

    if (review) {
      openReview(review.id);
    }
  }
}

async function refresh() {
  acceptSnapshot(await call('snapshot'));
}

function selected() {
  return state.downloads.find((download) => download.id === selectedId);
}

function canResume(download) {
  return (
    download &&
    !download.needsReview &&
    ['paused', 'queued', 'scheduled', 'failed', 'cancelled'].includes(statusOf(download))
  );
}

function canPause(download) {
  return (
    download &&
    !download.needsReview &&
    ['downloading', 'connecting', 'queued', 'scheduled', 'assembling'].includes(statusOf(download))
  );
}

function matches(download) {
  const status = statusOf(download);

  if (filter === 'completed' && status !== 'completed') {
    return false;
  }

  if (filter === 'unfinished' && status === 'completed') {
    return false;
  }

  if (filter === 'queued' && !['queued', 'scheduled', 'paused'].includes(status)) {
    return false;
  }

  if (category && categoryOf(download) !== category) {
    return false;
  }

  return (
    !searchTerm ||
    `${download.filename || ''} ${download.url || ''}`.toLowerCase().includes(searchTerm)
  );
}

function paintSelection() {
  queryAll('.download-row').forEach((row) => {
    const active = selectedIds.has(row.dataset.id);
    row.classList.toggle('selected', active);
    row.setAttribute('aria-selected', String(active));
  });

  updateControls();
}

function selectDownload(id, { additive = false, toggle = false } = {}) {
  if (!additive) {
    selectedIds.clear();
  }

  if (toggle && selectedIds.has(id)) {
    selectedIds.delete(id);
  } else if (id) {
    selectedIds.add(id);
  }

  selectedId = selectedIds.has(id) ? id : selectedIds.values().next().value || null;
  paintSelection();
}

function rowFor(download) {
  const status = statusOf(download);
  const percent = percentage(download);
  const row = element('tr', 'download-row');
  row.dataset.id = download.id;
  row.dataset.status = status;
  row.classList.toggle('selected', selectedIds.has(download.id));
  row.setAttribute('aria-selected', String(selectedIds.has(download.id)));
  const nameCell = element('td');
  nameCell.title = download.filename || download.url;
  const name = element('span', 'file-name');

  name.append(
    element('span', 'file-type-icon', { completed: '✓', failed: '!' }[status] || '↓'),
    element('span', '', download.filename || 'Preparing file…'),
  );

  nameCell.append(name);

  const names = {
    completed: 'Complete',
    downloading: percent === null ? 'Receiving data…' : `${percent.toFixed(2)}%`,
    connecting: 'Connecting…',
    assembling: 'Finalizing…',
    queued: 'Queued',
    scheduled: 'Scheduled',
    paused: 'Stopped',
    cancelled: 'Cancelled',
    failed: 'Error',
  };

  const statusCell = element('td', `row-status ${status}`, names[status] || status);
  statusCell.title = download.error || names[status] || status;

  const description =
    download.description ||
    download.error ||
    (download.scheduledAt && status === 'scheduled' ? `Starts ${date(download.scheduledAt)}` : '');

  const descriptionCell = element('td', '', description);
  descriptionCell.title = description;

  row.append(
    nameCell,
    element('td', '', ['queued', 'scheduled', 'paused'].includes(status) ? '✓' : ''),
    element('td', '', sizeLabel(download)),
    statusCell,
    element('td', '', status === 'downloading' ? timeLeft(download) : ''),
    element('td', '', status === 'downloading' ? `${bytes(download.speed)}/sec` : ''),
    element('td', '', date(download.lastTry || download.createdAt)),
    descriptionCell,
  );

  row.addEventListener('click', (event) => {
    if (suppressRowClick) {
      return;
    }

    selectDownload(download.id, {
      additive: event.ctrlKey || event.metaKey,
      toggle: event.ctrlKey || event.metaKey,
    });
  });

  row.addEventListener('dblclick', () => showDetails(download.id));

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    selectDownload(download.id);
    showDetails(download.id);
  });

  return row;
}

function updateControls() {
  const download = selected();
  const busy = download && pending.has(download.id);
  query('#resume-selected').disabled = (!canResume(download) && !download?.needsReview) || busy;
  query('#stop-selected').disabled = !canPause(download) || busy;
  query('#remove-selected').disabled = !download || busy;
  query('#open-selected').disabled = !download || statusOf(download) !== 'completed';
  query('#reveal-selected').disabled = !download;
  query('#details-selected').disabled = !download;
  query('#pause-all').disabled = !state.downloads.some(canPause);
  query('#stop-queue').disabled = query('#pause-all').disabled;
  query('#resume-all').disabled = !state.downloads.some(canResume);

  query('#remove-completed').disabled = !state.downloads.some(
    (item) => statusOf(item) === 'completed',
  );

  query('#scheduler-start').disabled = query('#resume-all').disabled;
  query('#scheduler-stop').disabled = query('#pause-all').disabled;
}

function compareBy(key, first, second) {
  if (key === 'total') {
    return numeric(first.total) - numeric(second.total);
  }

  if (key === 'createdAt') {
    return new Date(first.createdAt || 0) - new Date(second.createdAt || 0);
  }

  return String(first[key] || '').localeCompare(String(second[key] || ''));
}

function render() {
  visibleDownloads = state.downloads.filter(matches).sort((first, second) => {
    const result = compareBy(sort, first, second);
    return ascending ? result : -result;
  });

  query('#download-list').replaceChildren(...visibleDownloads.map(rowFor));
  query('#empty-state').hidden = visibleDownloads.length > 0;

  query('#empty-message').textContent = searchTerm
    ? 'No downloads match your search.'
    : 'No downloads to display.';

  const complete = state.downloads.filter((download) => statusOf(download) === 'completed').length;

  query('#list-count').textContent =
    `${visibleDownloads.length} ${visibleDownloads.length === 1 ? 'download' : 'downloads'}${state.downloads.length !== visibleDownloads.length ? ` of ${state.downloads.length}` : ''} (${complete} completed)`;

  query('#status-summary').textContent =
    `${bytes(state.downloads.reduce((sum, download) => sum + numeric(download.speed), 0))}/sec`;

  updateControls();

  if (query('#details-dialog').open) {
    renderDetails();
  }

  if (query('#scheduler-dialog').open) {
    renderScheduler();
  }
}

async function performAction(download, action) {
  if (!download || pending.has(download.id)) {
    return;
  }

  if (
    action === 'remove' &&
    // eslint-disable-next-line no-alert -- the native confirmation dialog is intended here
    !window.confirm(
      `Delete “${download.filename || 'this download'}” from the download list?\n\nThe downloaded file will remain on your PC.`,
    )
  ) {
    return;
  }

  pending.add(download.id);
  updateControls();

  try {
    await call('action', { id: download.id, action });
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  } finally {
    pending.delete(download.id);
    updateControls();

    if (query('#details-dialog').open) {
      renderDetails();
    }
  }
}

async function bulkAction(action) {
  const downloads = state.downloads.filter(action === 'pause' ? canPause : canResume);

  const results = await Promise.allSettled(
    downloads.map((download) =>
      call('action', {
        id: download.id,
        action:
          action === 'resume' && ['failed', 'cancelled'].includes(statusOf(download))
            ? 'retry'
            : action,
      }),
    ),
  );

  const failures = results.filter((outcome) => outcome.status === 'rejected');

  if (failures.length) {
    notify(`${failures.length} operation(s) failed: ${messageOf(failures[0].reason)}`, true);
  }

  try {
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  }
}

async function removeCompleted() {
  const downloads = state.downloads.filter((download) => statusOf(download) === 'completed');

  if (
    !downloads.length ||
    // eslint-disable-next-line no-alert -- the native confirmation dialog is intended here
    !window.confirm(
      `Delete ${downloads.length} completed download(s) from the list?\n\nThe downloaded files will remain on your PC.`,
    )
  ) {
    return;
  }

  const results = await Promise.allSettled(
    downloads.map((download) => call('action', { id: download.id, action: 'remove' })),
  );

  const failures = results.filter((outcome) => outcome.status === 'rejected');

  if (failures.length) {
    notify(messageOf(failures[0].reason), true);
  }

  try {
    await refresh();
  } catch (error) {
    notify(messageOf(error), true);
  }
}

function showDialog(id) {
  const dialog = query(id);

  if (!dialog.open) {
    dialog.showModal();
  }
}

function openAdd(text = '', scheduled = '') {
  pendingReviewId = null;
  query('#add-error').hidden = true;
  query('#download-urls').value = text;
  query('#download-urls').readOnly = false;
  query('#download-filename').value = '';
  query('#download-description').value = '';
  query('#download-category').value = '';
  rememberInput.checked = false;
  rememberInput.disabled = true;
  query('#download-schedule').value = scheduled;
  query('#add-directory').value = state.settings.defaultDirectory || '';
  showDialog('#add-dialog');
  query('#download-urls').focus();
}

function openReview(id) {
  if (progressMode) {
    return;
  }

  const download = state.downloads.find((item) => item.id === id && item.needsReview);

  if (!download || dismissedReviews.has(id)) {
    return;
  }

  openAdd(download.url || '');
  pendingReviewId = id;
  query('#download-urls').readOnly = true;
  query('#download-filename').value = download.filename || '';
  query('#download-description').value = download.description || '';
  query('#download-category').value = download.category || '';
  rememberInput.disabled = !query('#download-category').value;
  query('#add-directory').value = download.directory || state.settings.defaultDirectory || '';
}

async function dismissReview() {
  if (!pendingReviewId) {
    return;
  }

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
  if (state.downloads.find((download) => download.id === id)?.needsReview) {
    openReview(id);
    return;
  }

  if (!progressMode) {
    call('openProgress', { id }).catch((error) => notify(messageOf(error), true));
    return;
  }

  detailId = id;
  query('#detail-speed-limit').value = state.settings.speedLimitKbps || 0;
  query('#notify-complete').checked = state.settings.notifyOnComplete !== false;
  query('#reveal-complete').checked = state.settings.revealOnComplete === true;
  query('#completion-result').textContent = '';
  setDetailTab('status');
  renderDetails();
  showDialog('#details-dialog');
}

function renderTransferDetails() {
  const download = state.downloads.find((item) => item.id === detailId);

  if (!download) {
    query('#details-dialog').close();
    return;
  }

  const status = statusOf(download);
  const percent = percentage(download);
  const content = query('#details-content');

  query('#details-title').textContent =
    `${percent !== null ? `${Math.floor(percent)}% ` : ''}${download.filename || 'Download status'}`;

  query('#transfer-source').textContent = download.url || '';
  query('#transfer-source').title = download.url || '';

  const names = {
    completed: 'Complete',
    downloading: 'Receiving data…',
    connecting: 'Connecting…',
    paused: 'Stopped',
    queued: 'Queued',
    scheduled: 'Scheduled',
    failed: 'Error',
    cancelled: 'Cancelled',
    assembling: 'Finalizing…',
  };

  const rows = [
    ['Status', names[status] || status],
    ['File size', sizeLabel(download)],
    [
      'Downloaded',
      `${bytes(download.downloaded)}${percent !== null ? ` (${percent.toFixed(2)}%)` : ''}`,
    ],
    ['Transfer rate', status === 'downloading' ? `${bytes(download.speed)}/sec` : '0 B/sec'],
    ['Time left', status === 'downloading' ? timeLeft(download) || 'Estimating…' : '—'],
    ['Resume capability', { true: 'Yes', false: 'No' }[download.resumable] || 'Checking…'],
  ];

  if (numeric(download.duration)) {
    rows.splice(1, 0, [
      'Video duration',
      `${Math.floor(download.duration / 60)} min ${Math.floor(download.duration % 60)} sec`,
    ]);
  }

  if (download.streamProgress?.total && status !== 'completed') {
    rows.push([
      'Segments',
      `${download.streamProgress.completed} / ${download.streamProgress.total}`,
    ]);
  }

  if (download.scheduledAt && status === 'scheduled') {
    rows.push(['Start at', date(download.scheduledAt)]);
  }

  content.replaceChildren();

  for (const [label, value] of rows) {
    content.append(element('dt', '', label), element('dd', '', value));
  }

  const progress = query('#detail-progress');

  if (percent === null && ['downloading', 'connecting'].includes(status)) {
    progress.removeAttribute('value');
  } else {
    progress.value = percent || 0;
  }

  const segments = Array.isArray(download.connectionsProgress) ? download.connectionsProgress : [];
  const bars = query('#segment-bars');
  const map = query('#segment-map');
  bars.replaceChildren();
  map.replaceChildren();

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const row = element('tr');

    const segmentStatus =
      segment.status === 'complete' || segment.status === 'completed'
        ? 'Completed.'
        : segment.status ||
          (status === 'downloading' ? 'Receiving data…' : names[status] || status);

    row.append(
      element('td', '', String(index + 1)),
      element('td', '', bytes(segment.downloaded)),
      element('td', '', segmentStatus),
    );

    bars.append(row);
    const bar = element('progress');
    bar.max = 100;
    const total = numeric(segment.total);
    bar.value = total ? Math.min(100, (numeric(segment.downloaded) / total) * 100) : 0;
    bar.setAttribute('aria-label', `Connection ${index + 1} progress`);

    if (!total && status === 'downloading') {
      bar.removeAttribute('value');
    }

    map.append(bar);
  }

  let note = 'Connection progress appears when the transfer starts.';

  if (segments.length) {
    note = `${segments.length} connection(s)`;
  } else if (status === 'completed') {
    note = 'Download completed.';
  }

  query('#segment-note').textContent = note;
  query('#detail-error').textContent = download.error || '';
  query('#detail-error').hidden = !download.error;
  query('#detail-open').disabled = status !== 'completed';
  query('#detail-resume').disabled = !canResume(download) || pending.has(download.id);
  query('#detail-stop').disabled = !canPause(download) || pending.has(download.id);

  query('#detail-cancel').disabled =
    ['completed', 'cancelled'].includes(status) || pending.has(download.id);

  query('.transfer-buttons').hidden = status === 'completed';
  query('#download-complete-actions').hidden = status !== 'completed';
  query('#details-dialog').classList.toggle('is-complete', status === 'completed');
}

function setDetailTab(name) {
  for (const tab of ['status', 'speed', 'completion']) {
    const active = tab === name;
    query(`#tab-${tab}`).classList.toggle('active-tab', active);
    query(`#tab-${tab}`).setAttribute('aria-selected', String(active));
    query(`#${tab}-panel`).hidden = !active;
  }
}

function setView(nextFilter, nextCategory = '') {
  filter = nextFilter;
  category = nextCategory;

  queryAll('[data-filter],[data-category]').forEach((button) => {
    const active = nextCategory
      ? button.dataset.category === nextCategory
      : button.dataset.filter === nextFilter;

    button.classList.toggle('selected', active);

    if (active) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });

  render();
}

function openSettings() {
  const { settings } = state;
  query('#default-directory').value = settings.defaultDirectory || '';
  query('#max-concurrent').value = settings.maxConcurrent || 3;
  query('#connections').value = settings.connections || 8;
  query('#speed-limit').value = settings.speedLimitKbps || 0;
  query('#settings-error').hidden = true;
  showDialog('#settings-dialog');
}

function renderScheduler() {
  const downloads = state.downloads
    .filter((download) => statusOf(download) === 'scheduled')
    .sort((first, second) => new Date(first.scheduledAt) - new Date(second.scheduledAt));

  const list = query('#scheduled-list');
  list.replaceChildren();

  if (!downloads.length) {
    list.append(element('p', 'field-help', 'No scheduled downloads.'));
  }

  for (const download of downloads) {
    const row = element('div', 'scheduled-item');
    const name = element('span', '', download.filename);
    name.title = download.filename;
    row.append(name, element('time', '', date(download.scheduledAt)));
    list.append(row);
  }
}

function openScheduler() {
  renderScheduler();
  showDialog('#scheduler-dialog');
}

async function openIntegration() {
  try {
    const info = (await call('integration')) || state.integration;
    query('#extension-path').value = info.extensionPath || '';

    if (info.connectionError) {
      automaticConnection.textContent = `Browser setup needs attention: ${info.connectionError}`;
    } else if (info.connectedBrowsers?.length) {
      automaticConnection.textContent = `${info.connectedBrowsers.map((connection) => connection.browser).join(', ')} connected automatically. Click Download this video in your browser to choose a file.`;
    } else {
      automaticConnection.textContent =
        'Ready to connect automatically when the browser extension is installed.';
    }

    query('#integration-port').value = info.port ? 'Ready' : 'Unavailable';
    showDialog('#integration-dialog');
  } catch (error) {
    notify(messageOf(error), true);
  }
}

const commands = {
  add: () => openAdd(),
  paste: async () => {
    try {
      openAdd(await call('clipboard'));
    } catch (error) {
      notify(messageOf(error), true);
    }
  },
  find: () => query('#search').focus(),
  settings: openSettings,
  integration: openIntegration,
  scheduler: openScheduler,
  pauseAll: () => bulkAction('pause'),
  resumeAll: () => bulkAction('resume'),
  removeCompleted,
};

commands.find = () => {
  query('.list-search').classList.add('visible');
  query('#search').focus();
};

commands.details = () => {
  if (selectedId) {
    showDetails(selectedId);
  }
};

commands.remove = () => performAction(selected(), 'remove');
commands.all = () => setView('all');

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    commands.find();
  }

  if (event.key === 'Escape') {
    query('.list-search').classList.remove('visible');
  }
});

query('#new-download').addEventListener('click', commands.add);
query('#settings-button').addEventListener('click', openSettings);
query('#integration-button').addEventListener('click', openIntegration);
query('#scheduler-button').addEventListener('click', openScheduler);
query('#pause-all').addEventListener('click', commands.pauseAll);
query('#stop-queue').addEventListener('click', commands.pauseAll);
query('#resume-all').addEventListener('click', commands.resumeAll);
query('#remove-completed').addEventListener('click', removeCompleted);

query('#resume-selected').addEventListener('click', () => {
  const download = selected();

  if (download?.needsReview) {
    openReview(download.id);
    return;
  }

  performAction(
    download,
    download && ['failed', 'cancelled'].includes(statusOf(download)) ? 'retry' : 'resume',
  );
});

query('#stop-selected').addEventListener('click', () => performAction(selected(), 'pause'));
query('#remove-selected').addEventListener('click', () => performAction(selected(), 'remove'));
query('#open-selected').addEventListener('click', () => performAction(selected(), 'open'));
query('#reveal-selected').addEventListener('click', () => performAction(selected(), 'reveal'));

query('#details-selected').addEventListener('click', () => {
  if (selectedId) {
    showDetails(selectedId);
  }
});

function detailDownload() {
  return state.downloads.find((download) => download.id === detailId);
}

query('#detail-open').addEventListener('click', () => performAction(detailDownload(), 'open'));
query('#detail-folder').addEventListener('click', () => performAction(detailDownload(), 'reveal'));
query('#detail-stop').addEventListener('click', () => performAction(detailDownload(), 'pause'));
query('#detail-cancel').addEventListener('click', () => performAction(detailDownload(), 'cancel'));

query('#detail-resume').addEventListener('click', () => {
  const download = detailDownload();

  performAction(
    download,
    download && ['failed', 'cancelled'].includes(statusOf(download)) ? 'retry' : 'resume',
  );
});

query('#toggle-details').addEventListener('click', async () => {
  const details = query('#connection-details');
  details.hidden = !details.hidden;
  document.body.classList.toggle('details-collapsed', details.hidden);
  query('#toggle-details').textContent = details.hidden ? '>> Show details' : '<< Hide details';

  if (progressMode) {
    try {
      await call('resizeProgress', { expanded: !details.hidden });
    } catch (error) {
      notify(messageOf(error), true);
    }
  }
});

for (const tab of ['status', 'speed', 'completion']) {
  query(`#tab-${tab}`).addEventListener('click', () => setDetailTab(tab));
}

query('#detail-speed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  query('#detail-speed-error').hidden = true;

  try {
    await call('settings', { speedLimitKbps: Number(query('#detail-speed-limit').value) });
    await refresh();
    notify('Global speed limit saved.');
  } catch (error) {
    query('#detail-speed-error').textContent = messageOf(error);
    query('#detail-speed-error').hidden = false;
  }
});

query('#completion-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await call('settings', {
      notifyOnComplete: query('#notify-complete').checked,
      revealOnComplete: query('#reveal-complete').checked,
    });

    await refresh();
    query('#completion-result').textContent = ' Saved.';
  } catch (error) {
    query('#completion-result').textContent = ` ${messageOf(error)}`;
  }
});

query('#scheduler-start').addEventListener('click', commands.resumeAll);
query('#scheduler-stop').addEventListener('click', commands.pauseAll);

query('#schedule-new').addEventListener('click', () => {
  query('#scheduler-dialog').close();
  const future = new Date(Date.now() + 3600000);

  openAdd(
    '',
    new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16),
  );
});

query('#grabber-button').addEventListener('click', () =>
  notify(
    'Website grabber projects are not available in this build. Use Add URL to add direct download links.',
  ),
);

queryAll('[data-filter]').forEach((button) =>
  button.addEventListener('click', () => setView(button.dataset.filter)),
);

queryAll('[data-category]').forEach((button) =>
  button.addEventListener('click', () => setView('all', button.dataset.category)),
);

queryAll('[data-sort]').forEach((button) =>
  button.addEventListener('click', () => {
    const next = button.dataset.sort;
    ascending = sort === next ? !ascending : true;
    sort = next;
    render();
  }),
);

query('#search').addEventListener('input', (event) => {
  searchTerm = event.target.value.trim().toLowerCase();
  render();
});

const categoryExpander = query('.tree-expander[aria-controls]');

function setCategoryTreeExpanded(expanded) {
  const children = query(`#${categoryExpander.getAttribute('aria-controls')}`);
  children.hidden = !expanded;
  categoryExpander.textContent = expanded ? '⊟' : '⊞';
  categoryExpander.setAttribute('aria-expanded', String(expanded));

  categoryExpander.setAttribute(
    'aria-label',
    `${expanded ? 'Collapse' : 'Expand'} All Downloads categories`,
  );
}

categoryExpander.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setCategoryTreeExpanded(categoryExpander.getAttribute('aria-expanded') !== 'true');
});

categoryExpander.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  setCategoryTreeExpanded(categoryExpander.getAttribute('aria-expanded') !== 'true');
});

const tableScroll = query('#table-scroll');
const selectionRectangle = query('#selection-rectangle');

const tablePoint = (event) => {
  const bounds = tableScroll.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left + tableScroll.scrollLeft,
    y: event.clientY - bounds.top + tableScroll.scrollTop,
  };
};

tableScroll.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('thead') || event.target.closest('button')) {
    return;
  }

  const point = tablePoint(event);
  const row = event.target.closest('.download-row');

  selectionDrag = {
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
    row,
    toggle: event.ctrlKey || event.metaKey,
    base: event.ctrlKey || event.metaKey ? new Set(selectedIds) : new Set(),
    moved: false,
  };

  tableScroll.setPointerCapture(event.pointerId);
  // preventDefault stops text selection during a drag, but also the click's usual focus;
  // focus the list so the arrow, Home and End keys work after a click.
  event.preventDefault();
  tableScroll.focus({ preventScroll: true });
});

tableScroll.addEventListener('pointermove', (event) => {
  if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) {
    return;
  }

  const point = tablePoint(event);
  const dx = point.x - selectionDrag.startX;
  const dy = point.y - selectionDrag.startY;

  if (!selectionDrag.moved && Math.hypot(dx, dy) < 4) {
    return;
  }

  selectionDrag.moved = true;
  const left = Math.min(selectionDrag.startX, point.x);
  const top = Math.min(selectionDrag.startY, point.y);
  const right = Math.max(selectionDrag.startX, point.x);
  const bottom = Math.max(selectionDrag.startY, point.y);

  Object.assign(selectionRectangle.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.max(1, right - left)}px`,
    height: `${Math.max(1, bottom - top)}px`,
  });

  selectionRectangle.hidden = false;
  selectedIds.clear();

  for (const id of selectionDrag.base) {
    selectedIds.add(id);
  }

  const viewport = tableScroll.getBoundingClientRect();

  for (const row of queryAll('.download-row')) {
    const rect = row.getBoundingClientRect();
    const rowLeft = rect.left - viewport.left + tableScroll.scrollLeft;
    const rowTop = rect.top - viewport.top + tableScroll.scrollTop;

    if (
      rowLeft < right &&
      rowLeft + rect.width > left &&
      rowTop < bottom &&
      rowTop + rect.height > top
    ) {
      selectedIds.add(row.dataset.id);
    }
  }

  selectedId = selectedIds.values().next().value || null;
  paintSelection();
  event.preventDefault();
});

function finishMarquee(event) {
  if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) {
    return;
  }

  const { moved, row, toggle } = selectionDrag;

  try {
    tableScroll.releasePointerCapture(event.pointerId);
  } catch {
    // The capture may already have ended with the pointer.
  }

  selectionDrag = null;
  selectionRectangle.hidden = true;

  // With the pointer captured, Chromium delivers the following click to the list rather
  // than the row, so a plain click selects its row here and the row's own handler is skipped.
  if (moved || row) {
    if (!moved) {
      selectDownload(row.dataset.id, { additive: toggle, toggle });
    }

    suppressRowClick = true;

    setTimeout(() => {
      suppressRowClick = false;
    }, 0);
  } else {
    selectDownload(null);
  }
}

// The double-click reaches the list for the same reason; find the row under the pointer.
tableScroll.addEventListener('dblclick', (event) => {
  if (event.target.closest('.download-row')) {
    return;
  }

  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('.download-row');

  if (row) {
    showDetails(row.dataset.id);
  }
});

tableScroll.addEventListener('pointerup', finishMarquee);
tableScroll.addEventListener('pointercancel', finishMarquee);

query('#table-scroll').addEventListener('keydown', (event) => {
  if (!visibleDownloads.length) {
    return;
  }

  const index = visibleDownloads.findIndex((download) => download.id === selectedId);

  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const last = visibleDownloads.length - 1;
    let next = Math.max(0, Math.min(last, index + (event.key === 'ArrowDown' ? 1 : -1)));

    if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    }

    selectDownload(visibleDownloads[next].id);

    queryAll('.download-row')
      .find((row) => row.dataset.id === selectedId)
      ?.scrollIntoView({ block: 'nearest' });
  }

  if (event.key === 'Enter' && selectedId) {
    showDetails(selectedId);
  }

  if (event.key === 'Delete' || (isMac && event.metaKey && event.key === 'Backspace')) {
    performAction(selected(), 'remove');
  }
});

query('#dismiss-toast').addEventListener('click', () => {
  query('#toast').hidden = true;
});

queryAll('[data-close]').forEach((button) =>
  button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    dialog.close();

    if (dialog.id === 'add-dialog') {
      dismissReview();
    }
  }),
);

query('#add-dialog').addEventListener('cancel', () => dismissReview());

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();

    if (!queryAll('dialog[open]').length) {
      openAdd();
    }
  }

  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'f' &&
    !queryAll('dialog[open]').length
  ) {
    event.preventDefault();
    query('#search').focus();
  }
});

query('#paste-button').addEventListener('click', async () => {
  try {
    query('#download-urls').value = await call('clipboard');
    query('#download-urls').focus();
  } catch (error) {
    query('#add-error').textContent = messageOf(error);
    query('#add-error').hidden = false;
  }
});

query('#add-browse').addEventListener('click', async () => {
  try {
    const path = await call('chooseDirectory');

    if (typeof path === 'string' && path) {
      query('#add-directory').value = path;
    }
  } catch (error) {
    query('#add-error').textContent = messageOf(error);
    query('#add-error').hidden = false;
  }
});

query('#download-category').addEventListener('change', (event) => {
  const folder = state.settings.categoryDirectories?.[event.target.value];

  if (folder) {
    query('#add-directory').value = folder;
  }

  rememberInput.disabled = !event.target.value;

  if (rememberInput.disabled) {
    rememberInput.checked = false;
  }
});

query('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = query('#add-error');
  errorElement.hidden = true;

  const urls = query('#download-urls')
    .value.split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);

  const filename = query('#download-filename').value.trim();
  const scheduled = query('#download-schedule').value;

  try {
    if (!urls.length) {
      throw new Error('Enter at least one download address.');
    }

    for (const url of urls) {
      let parsed;

      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Invalid address: ${url}`);
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Download addresses must begin with http:// or https://.');
      }
    }

    if (filename && urls.length !== 1) {
      throw new Error('A custom file name can only be used for a single address.');
    }

    const scheduledAt = scheduled ? new Date(scheduled).toISOString() : undefined;

    if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
      throw new Error('Choose a future start time or leave Start at empty.');
    }

    query('#add-submit').disabled = true;
    query('#add-later').disabled = true;
    const directory = query('#add-directory').value;
    const selectedCategory = query('#download-category').value;
    const description = query('#download-description').value.trim();

    if (rememberInput.checked && selectedCategory && directory) {
      await call('settings', {
        categoryDirectories: {
          ...state.settings.categoryDirectories,
          [selectedCategory]: directory,
        },
      });
    }

    const data = {
      ...(filename ? { filename } : {}),
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(directory ? { directory } : {}),
      ...(selectedCategory ? { category: selectedCategory } : {}),
      description,
      queueOnly: event.submitter?.dataset.queueOnly === 'true',
    };

    const ids = pendingReviewId
      ? await call('review', { id: pendingReviewId, ...data })
      : await call('add', { urls, ...data });

    pendingReviewId = null;
    query('#add-dialog').close();
    setView('all');
    await refresh();

    if (!data.queueOnly && !scheduledAt && ids?.length === 1) {
      selectDownload(ids[0]);
      showDetails(ids[0]);
    }
  } catch (error) {
    errorElement.textContent = messageOf(error);
    errorElement.hidden = false;
  } finally {
    query('#add-submit').disabled = false;
    query('#add-later').disabled = false;
  }
});

query('#choose-directory').addEventListener('click', async () => {
  try {
    const path = await call('chooseDirectory');

    if (typeof path === 'string' && path) {
      query('#default-directory').value = path;
    }
  } catch (error) {
    query('#settings-error').textContent = messageOf(error);
    query('#settings-error').hidden = false;
  }
});

query('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = query('button[type=submit]', event.target);
  query('#settings-error').hidden = true;
  button.disabled = true;

  try {
    await call('settings', {
      defaultDirectory: query('#default-directory').value.trim(),
      maxConcurrent: Number(query('#max-concurrent').value),
      connections: Number(query('#connections').value),
      speedLimitKbps: Number(query('#speed-limit').value),
    });

    await refresh();
    query('#settings-dialog').close();
  } catch (error) {
    query('#settings-error').textContent = messageOf(error);
    query('#settings-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

async function start() {
  try {
    await refresh();

    if (typeof api.subscribe === 'function') {
      unsubscribe = api.subscribe((snapshot) => {
        if (snapshot?.downloads) {
          acceptSnapshot(snapshot);
        } else {
          refresh().catch((error) => notify(messageOf(error), true));
        }
      });
    }

    if (typeof api.onCommand === 'function') {
      unsubscribeCommands = api.onCommand(async (payload) => {
        const command = typeof payload === 'string' ? payload : payload?.command;

        if (command === 'reviewDownload') {
          try {
            await refresh();

            if (!queryAll('dialog[open]').length) {
              openReview(payload.id);
            }
          } catch (error) {
            notify(messageOf(error), true);
          }

          return;
        }

        if (
          !queryAll('dialog[open]').length ||
          ['pauseAll', 'resumeAll', 'removeCompleted'].includes(command)
        ) {
          commands[command]?.();
        }
      });
    }
  } catch (error) {
    query('#download-list').setAttribute('aria-busy', 'false');
    query('#list-count').textContent = 'Download service unavailable';
    query('#connection-label').textContent = 'Disconnected';
    notify(messageOf(error), true);
  }
}

window.addEventListener('beforeunload', () => {
  if (typeof unsubscribe === 'function') {
    unsubscribe();
  }

  if (typeof unsubscribeCommands === 'function') {
    unsubscribeCommands();
  }
});

if (progressMode) {
  query('#details-dialog').addEventListener('close', () => call('closeProgress'));

  new MutationObserver(() => {
    document.title = query('#details-title').textContent;
  }).observe(query('#details-title'), { childList: true, characterData: true, subtree: true });

  detailId = progressMode;
  showDialog('#details-dialog');
}

start().then(async () => {
  if (progressMode) {
    showDetails(progressMode);
    return;
  }

  if (
    state.integration.packaged &&
    !state.integration.connectedBrowsers?.length &&
    !localStorage.getItem('browser-setup-introduced') &&
    !queryAll('dialog[open]').length
  ) {
    await openIntegration();
    localStorage.setItem('browser-setup-introduced', '1');
  }
});
