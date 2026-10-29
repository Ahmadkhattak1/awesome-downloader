const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function noPublishedRelease(error) {
  const message = error?.message || String(error || '');
  return /unable to find latest version on github/i.test(message) || (/releases\/latest/i.test(message) && /(?:HTTPError:\s*)?(?:404|406)\b/i.test(message));
}

function friendlyUpdateError(error) {
  const message = error?.message || String(error || '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|offline/i.test(message)) return 'Could not reach GitHub Releases. Check your internet connection and try again.';
  return 'GitHub Releases returned an unexpected response. Please try again later.';
}

function createUpdateController({ autoUpdater, app, dialog, getWindow, activeDownloadCount = () => 0, notify = () => {}, installUpdate }) {
  let checkMode = null;
  let checking = false;
  let promptOpen = false;
  let available = null;
  let lastError = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = app.getVersion().includes('-');

  const messageBox = options => {
    const parent = getWindow?.();
    return parent && !parent.isDestroyed?.() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  };
  const showCurrentVersion = () => messageBox({ type: 'info', title: 'No updates available', message: 'Awesome Downloader is up to date.', detail: `You are using version ${app.getVersion()}.`, buttons: ['Close'] });
  const showError = async (error, requestedMode = checkMode) => {
    if (error === lastError) return;
    lastError = error;
    checking = false;
    checkMode = null;
    const interactive = requestedMode === 'manual';
    if (noPublishedRelease(error)) {
      if (interactive) await showCurrentVersion();
      return;
    }
    if (!interactive) return;
    await messageBox({ type: 'error', title: 'Could not check for updates', message: 'Awesome Downloader could not check for updates.', detail: friendlyUpdateError(error), buttons: ['Close'] });
  };
  const promptForAvailableUpdate = async info => {
    if (promptOpen) return;
    promptOpen = true;
    try {
      const result = await messageBox({ type: 'info', title: 'Update available', message: `Awesome Downloader ${info.version} is available.`, detail: 'Download it now? You can continue using the app while it downloads.', buttons: ['Download update', 'Later'], defaultId: 0, cancelId: 1, noLink: true });
      if (result.response === 0) await autoUpdater.downloadUpdate();
    } catch (error) { await showError(error, 'manual'); }
    finally { promptOpen = false; }
  };

  autoUpdater.on('update-available', info => {
    const requestedMode = checkMode;
    checking = false;
    checkMode = null;
    available = info;
    if (requestedMode === 'manual') promptForAvailableUpdate(info);
    else notify('Awesome Downloader update available', `Version ${info.version} is ready to download.`, () => promptForAvailableUpdate(info));
  });
  autoUpdater.on('update-not-available', async () => {
    const requestedMode = checkMode;
    checking = false;
    checkMode = null;
    if (requestedMode === 'manual') await showCurrentVersion();
  });
  autoUpdater.on('update-downloaded', async info => {
    const active = activeDownloadCount();
    const detail = active ? `${active} download${active === 1 ? ' is' : 's are'} active. Choose Later to let them finish before restarting.` : 'Restart Awesome Downloader to install the update. Your download history and settings will be kept.';
    const result = await messageBox({ type: 'info', title: 'Update ready', message: `Awesome Downloader ${info.version} is ready to install.`, detail, buttons: ['Restart and install', 'Later'], defaultId: active ? 1 : 0, cancelId: 1, noLink: true });
    if (result.response === 0) await installUpdate();
  });
  autoUpdater.on('error', error => showError(error, checkMode));

  const check = async ({ manual = false } = {}) => {
    if (!app.isPackaged) {
      if (manual) await messageBox({ type: 'info', title: 'Updates are unavailable in development', message: 'Update checks run in installed builds.', buttons: ['Close'] });
      return;
    }
    if (available) {
      if (manual) await promptForAvailableUpdate(available);
      return;
    }
    if (checking) return;
    const requestedMode = manual ? 'manual' : 'background';
    checkMode = requestedMode;
    checking = true;
    lastError = null;
    try { await autoUpdater.checkForUpdates(); }
    catch (error) { await showError(error, requestedMode); }
  };
  const start = () => {
    const recurring = setInterval(() => check(), CHECK_INTERVAL_MS);
    recurring.unref?.();
    return () => clearInterval(recurring);
  };
  return { check, start, promptForAvailableUpdate };
}

module.exports = { createUpdateController, noPublishedRelease, friendlyUpdateError, CHECK_INTERVAL_MS };
