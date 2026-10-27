// libuv's default 4-thread pool throttles parallel disk writes and DNS lookups; must be set before first use.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '32';
const path = require('node:path');
const {showProgress,closeCancelledProgress}=require('./progress-window.cjs');

if (process.argv.includes('--native-host')) {
  require('../integration/native-host.cjs').runNativeHost();
} else {
  const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');
  app.setName('Awesome Downloader');
  // AppData writes can be virtualized when launched by an MSIX development app.
  // Chrome launched normally must see the same connector, bridge, and history.
  const sharedDataDirectory = path.join(app.getPath('home'), '.awesome-downloader');
  require('node:fs').mkdirSync(sharedDataDirectory, {recursive:true});
  app.setPath('userData', sharedDataDirectory);
  const locked = app.requestSingleInstanceLock();
  let window, engine, bridge, tray, quitting = false;
  const progressWindows = new Map();
  const progressWindowSizes = new WeakMap();
  if (!locked) app.quit();
  else {
    app.on('second-instance', () => { window?.show(); window?.focus(); });
    app.whenReady().then(async () => {
      const fs = require('node:fs/promises');
      const history = path.join(sharedDataDirectory, 'downloads.json');
      try {
        await fs.copyFile(path.join(app.getPath('appData'), 'Awesome Downloader', 'downloads.json'), history, require('node:fs').constants.COPYFILE_EXCL);
      } catch (error) { if (!['ENOENT','EEXIST'].includes(error.code)) throw error; }
      const { DownloadEngine } = await import('../core/engine.mjs');
      const { startBridge } = await import('../core/bridge.mjs');
      engine = await new DownloadEngine({ dataDirectory: app.getPath('userData'), downloadDirectory: app.getPath('downloads') }).init();
      let desktopReady;
      const readyForDownloads = new Promise(resolve => { desktopReady = resolve; });
      try { bridge = await startBridge(engine, { dataDirectory: app.getPath('userData'), onDownload: async payload => {
        await readyForDownloads;
        const reviewOnly = payload.startNow !== true && engine.settings.confirmBrowserDownloads;
        const ids = await engine.add({ ...payload, reviewOnly, reuseActive:true });
        const needsReview=engine.downloads.find(d=>d.id===ids[0])?.needsReview;
        if (!needsReview) await handlers.openProgress({id:ids[0]});
        if (needsReview && window && !window.isDestroyed()) {
          showProgress(window);
          window.webContents.send('downloader:command', { command: 'reviewDownload', id: ids[0] });
        }
        return ids;
      } }); }
      catch (error) { dialog.showErrorBox('Browser connection unavailable', error.message); }
      const root = path.join(__dirname, '..');
      const appIconPath = path.join(root, 'assets', 'app-icon.png');
      let integrationRoot = root;
      if (app.isPackaged) {
        const fs = require('node:fs/promises');
        integrationRoot = path.join(sharedDataDirectory, 'BrowserIntegration');
        await fs.mkdir(integrationRoot, { recursive: true });
        // Extensions must be real files on disk, not paths inside the application's ASAR.
        await fs.cp(path.join(process.resourcesPath, 'browser', 'extension'), path.join(integrationRoot, 'extension'), { recursive: true });
        await fs.cp(path.join(process.resourcesPath, 'browser', 'integration'), path.join(integrationRoot, 'integration'), {
          recursive: true,
          // The native launcher may be running this very startup. Windows locks
          // executable files: do not overwrite an already identical connector.
          filter: require('./resource-copy.cjs').copyIfChanged
        });
        const quoteBatch = value => String(value).replaceAll('%', '%%');
        await fs.writeFile(path.join(integrationRoot, 'integration', 'native-host.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${quoteBatch(app.getPath('exe'))}" "%~dp0native-host.cjs"\r\n`);
      }
      // Use the bundled runtime even in development; browsers need not inherit Node's PATH.
      if (!app.isPackaged) {
        const fs = require('node:fs/promises');
        await fs.writeFile(path.join(integrationRoot, 'integration', 'native-host.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${app.getPath('exe').replaceAll('%', '%%')}" "%~dp0native-host.cjs"\r\n`);
      }
      let connectedBrowsers = [], connectionError = '';
      let nativeHostError = '';
      try { await require('./browser-registration.cjs').prepareNativeHost(integrationRoot, app.getPath('exe')); }
      catch (error) { nativeHostError = error.message; }
      await require('node:fs/promises').writeFile(path.join(integrationRoot, 'integration', 'desktop-launch.json'), JSON.stringify({executable:app.getPath('exe'),args:app.isPackaged ? [] : [root]}));
      const connectBrowsers = async () => {
        if (nativeHostError) { connectionError = nativeHostError; return; }
        try { connectedBrowsers = await require('./browser-registration.cjs').connectInstalledBrowsers({ dataDirectory: app.getPath('userData'), integrationRoot }); connectionError = ''; }
        catch (error) { connectionError = error.message; }
      };
      await connectBrowsers();
      const browserScan = setInterval(connectBrowsers, 15000);
      browserScan.unref();
      const integration = async () => { await connectBrowsers(); return integrationInfo(); };
      const integrationInfo = () => ({ port: bridge?.port || null, connectedBrowsers, connectionError, extensionPath: path.join(integrationRoot, 'extension'), integrationPath: path.join(integrationRoot, 'integration'), packaged: app.isPackaged, executable: app.getPath('exe') });
      const snapshot = () => ({ ...engine.snapshot(), integration: integrationInfo() });
      const handlers = {
        snapshot,
        openProgress: async ({id}) => {
          const d=engine.downloads.find(d=>d.id===id); if(!d)throw new Error('Download not found.');
          if(progressWindows.has(id)){showProgress(progressWindows.get(id));return;}
          const progress=new BrowserWindow({width:565,height:485,minWidth:540,minHeight:440,title:d.filename,icon:appIconPath,backgroundColor:'#f0f0f0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
          progress.setMenu(null);progressWindows.set(id,progress);progressWindowSizes.set(progress,{expanded:{width:565,height:485}});
          if(d.status==='complete'){progress.setMinimumSize(470,270);progress.setSize(480,280);progress.setTitle('Download complete');}
          progress.on('closed',()=>progressWindows.delete(id));
          progress.webContents.setWindowOpenHandler(()=>({action:'deny'}));
          progress.webContents.on('will-navigate',event=>event.preventDefault());
          await progress.loadFile(path.join(root,'renderer','index.html'),{query:{progress:id}});
          showProgress(progress);
        },
        add: data => engine.add(data),
        review: data => engine.reviewDownload(data),
        action: async ({ id, action }) => {
          const d = engine.downloads.find(d => d.id === id);
          if (!d) throw new Error('Download not found.');
          if (action === 'open') {
            if (d.status !== 'complete' || !d.path) throw new Error('This download has not finished.');
            // Opening a potentially executable file always requires an explicit user action.
            const result = await shell.openPath(d.path); if (result) throw new Error(result);
          } else if (action === 'openWith') {
            if (d.status !== 'complete' || !d.path) throw new Error('This download has not finished.');
            await new Promise((resolve,reject)=>require('node:child_process').execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','OpenWith.exe'),[d.path],{windowsHide:true},error=>error?reject(error):resolve()));
          } else if (action === 'reveal') { if (d.path) shell.showItemInFolder(d.path); else await shell.openPath(d.directory); }
          else return engine.action(id, action);
        },
        settings: data => engine.updateSettings(data),
        chooseDirectory: async () => {
          const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
          return result.canceled ? null : result.filePaths[0];
        },
        clipboard: () => clipboard.readText(),
        integration
      };
      handlers.registerBrowser = data => require('./browser-registration.cjs').registerBrowser(data, { dataDirectory: app.getPath('userData'), integrationRoot });
      handlers.browserSetup = async ({ action, browser } = {}) => {
        if (action === 'open') return require('./browser-setup.cjs').openExtensions(browser);
        if (action === 'copy') { clipboard.writeText(path.join(integrationRoot, 'extension')); return; }
        if (action === 'folder') {
          const error = await shell.openPath(path.join(integrationRoot, 'extension'));
          if (error) throw new Error(error);
          return;
        }
        throw new Error('Unknown browser setup action.');
      };
      for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`downloader:${name}`, (event, data) => {
        if (![window,...progressWindows.values()].some(w=>!w.isDestroyed()&&event.senderFrame===w.webContents.mainFrame)) throw new Error('Untrusted renderer.');
        return handler(data);
      });
      ipcMain.handle('downloader:closeProgress',event=>{for(const progress of progressWindows.values())if(event.senderFrame===progress.webContents.mainFrame){progress.close();break;}});
      ipcMain.handle('downloader:resizeProgress',(event,{expanded}={})=>{for(const progress of progressWindows.values())if(event.senderFrame===progress.webContents.mainFrame){const remembered=progressWindowSizes.get(progress)||{expanded:{width:565,height:485}},[width,height]=progress.getSize();if(expanded){progress.setMinimumSize(540,440);progress.setSize(Math.max(540,remembered.expanded.width),Math.max(440,remembered.expanded.height),true);}else{if(height>360)remembered.expanded={width,height};progressWindowSizes.set(progress,remembered);progress.setMinimumSize(540,325);progress.setSize(Math.max(540,width),340,true);}return;}});
      window = new BrowserWindow({ width: 805, height: 465, minWidth: 760, minHeight: 450,
        title: 'Awesome Downloader', icon: appIconPath, backgroundColor: '#f0f0f0', autoHideMenuBar: false,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadFile(path.join(root, 'renderer', 'index.html'));
      desktopReady();
      const command = name => () => window.webContents.send('downloader:command', name);
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'Tasks', submenu: [ { label: 'Add new download…', accelerator: 'CmdOrCtrl+N', click: command('add') }, { label: 'Add batch download…', click: command('add') }, { label: 'Add batch download from clipboard', click: command('paste') }, { type: 'separator' },
          { label: 'Export', submenu: [{ label: 'To text file…', click: async () => {
            const result = await dialog.showSaveDialog(window, { defaultPath: 'downloads.txt', filters: [{ name: 'URL list', extensions: ['txt'] }] });
            if (result.canceled) return;
            try { await require('node:fs/promises').writeFile(result.filePath, engine.downloads.map(d => d.url).join('\r\n'), 'utf8'); } catch (e) { dialog.showErrorBox('Could not export downloads', e.message); }
          } }] },
          { label: 'Import', submenu: [{ label: 'From text file…', click: async () => {
            const result = await dialog.showOpenDialog(window, { filters: [{ name: 'URL list', extensions: ['txt'] }], properties: ['openFile'] });
            if (result.canceled) return;
            try {
              const fs = require('node:fs/promises');
              if ((await fs.stat(result.filePaths[0])).size > 2 * 1024 * 1024) throw new Error('URL list must be smaller than 2 MiB.');
              const urls = (await fs.readFile(result.filePaths[0], 'utf8')).split(/\r?\n/).map(u => u.trim()).filter(Boolean);
              await engine.add({ urls, queueOnly: true });
              await dialog.showMessageBox(window, { message: `Imported ${urls.length} downloads.`, detail: 'The imported downloads are paused. Select Start Queue to begin.' });
            } catch (e) { dialog.showErrorBox('Could not import downloads', e.message); }
          } }] },
          { type: 'separator' }, { label: 'Monitor clipboard for download links', type: 'checkbox', checked: engine.settings.watchClipboard === true, click: item => { Promise.resolve().then(() => engine.updateSettings({ watchClipboard: item.checked })).catch(e => dialog.showErrorBox('Could not change setting', e.message)); } },
          { type: 'separator' }, { label: 'Exit', click: () => app.quit() } ] },
        { label: 'File', submenu: [ { label: 'Download properties…', click: command('details') }, { label: 'Remove selected', accelerator: 'Delete', click: command('remove') }, { label: 'Remove completed downloads', click: command('removeCompleted') } ] },
        { label: 'Downloads', submenu: [ { label: 'Pause all', click: command('pauseAll') }, { label: 'Stop all', click: command('pauseAll') }, { type: 'separator' }, { label: 'Delete all completed', click: command('removeCompleted') }, { type: 'separator' }, { label: 'Find', accelerator: 'CmdOrCtrl+F', click: command('find') }, { type: 'separator' }, { label: 'Scheduler…', click: command('scheduler') }, { label: 'Start queue', click: command('resumeAll') }, { label: 'Stop queue', click: command('pauseAll') }, { label: 'Speed limiter…', click: command('settings') }, { type: 'separator' }, { label: 'Options…', click: command('settings') } ] },
        { label: 'View', submenu: [ { label: 'All downloads', click: command('all') }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' } ] },
        { label: 'Help', submenu: [ { label: 'Browser integration…', click: command('integration') }, { label: 'About Awesome Downloader', click: () => dialog.showMessageBox(window, { title: 'About Awesome Downloader', message: 'Awesome Downloader 0.1.0', detail: 'Windows download manager with browser integration. Original implementation inspired by IDM. Full IDM feature parity is in development.' }) } ] }
      ]));
      engine.on('change', () => {
        const data=snapshot();
        if (!window.isDestroyed()) window.webContents.send('downloader:change',data);
        for(const [id,progress] of progressWindows){
          const d=data.downloads.find(d=>d.id===id);
          if(closeCancelledProgress(progress,d))continue;
          progress.setTitle(d.status==='complete'?'Download complete':`${d.total?Math.floor(d.downloaded/d.total*100)+'% ':''}${d.filename}`);
          progress.webContents.send('downloader:change',data);
        }
      });
      engine.on('complete', d => {
        const progress=progressWindows.get(d.id);
        if(progress&&!progress.isDestroyed()){if(engine.settings.hideCompletionDialog)progress.close();else{progress.setMinimumSize(470,270);progress.setSize(480,280);progress.setTitle('Download complete');}}
        if (engine.settings.notifyOnComplete && Notification.isSupported()) new Notification({ title: 'Download complete', body: d.filename }).show();
        if (engine.settings.revealOnComplete && d.path) shell.showItemInFolder(d.path);
      });
      // Optional clipboard link monitor: off by default, never downloads without a click.
      let lastClipboard = clipboard.readText();
      const clipboardTimer = setInterval(() => {
        try {
          if (!engine.settings.watchClipboard) { lastClipboard = clipboard.readText(); return; }
          const text = clipboard.readText().trim();
          if (!text || text === lastClipboard) return;
          lastClipboard = text;
          if (text.length > 2048 || /\s/.test(text) || !/^https?:\/\/[^/]+\/.+\.(zip|7z|rar|iso|exe|msi|pdf|mp4|mkv|webm|mp3|m4a|flac|wav|docx?|xlsx?|pptx?|apk|dmg|gz|tar|torrent)(?:[?#].*)?$/i.test(text)) return;
          if (!Notification.isSupported()) return;
          const note = new Notification({ title: 'Download link copied', body: 'Click to add it to Awesome Downloader.' });
          note.on('click', () => { if (window.isDestroyed()) return; window.show(); window.focus(); window.webContents.send('downloader:command', 'paste'); });
          note.show();
        } catch { /* clipboard can be locked by another application */ }
      }, 1500);
      clipboardTimer.unref();
      const icon = nativeImage.createFromPath(appIconPath).resize({width:16,height:16});
      tray = new Tray(icon);
      tray.setToolTip('Awesome Downloader');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show downloads', click: () => window.show() }, { label: 'Quit', click: () => app.quit() }]));
      tray.on('double-click', () => window.show());
      window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
      app.on('activate', () => window.show());
    }).catch(error => { dialog.showErrorBox('Awesome Downloader could not start', error.stack || error.message); quitting = true; app.quit(); });
    app.on('before-quit', event => {
      if (quitting) return;
      event.preventDefault(); quitting = true;
      Promise.resolve().then(() => bridge?.close()).then(() => engine?.close()).catch(error => process.stderr.write(`${error.message}\n`)).finally(() => app.quit());
    });
  }
}
