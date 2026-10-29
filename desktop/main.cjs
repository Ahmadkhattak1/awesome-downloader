const path = require('node:path');
const {showProgress,closeCancelledProgress,needsCloseChoice,shouldCancelReviewOnClose}=require('./progress-window.cjs');

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
  let window, integrationWindow, optionsWindow, addWindow, schedulerWindow, engine, bridge, tray, updateController, quitting = false, shutdownPromise;
  const progressWindows = new Map();
  const progressWindowSizes = new WeakMap();
  const progressClosing = new WeakSet();
  const progressClosePrompts = new WeakSet();
  if (!locked) app.quit();
  else {
    app.on('second-instance', (_event, argv) => { if (!argv.includes('--browser-download') && !argv.includes('--background')) { window?.show(); window?.restore(); window?.focus(); } });
    app.whenReady().then(async () => {
      const fs = require('node:fs/promises');
      const history = path.join(sharedDataDirectory, 'downloads.json');
      try {
        await fs.copyFile(path.join(app.getPath('appData'), 'Awesome Downloader', 'downloads.json'), history, require('node:fs').constants.COPYFILE_EXCL);
      } catch (error) { if (!['ENOENT','EEXIST'].includes(error.code)) throw error; }
      const { DownloadEngine } = await import('../core/engine.mjs');
      const { startBridge } = await import('../core/bridge.mjs');
      engine = await new DownloadEngine({ dataDirectory: app.getPath('userData'), downloadDirectory: app.getPath('downloads') }).init();
      const syncStartupSetting = () => {
        if (process.platform !== 'win32' || !app.isPackaged) return;
        app.setLoginItemSettings({ openAtLogin: engine.settings.startWithWindows !== false, path: app.getPath('exe'), args: ['--background'] });
      };
      syncStartupSetting();
      const fileIcons = require('./file-icons.cjs').createFileIconProvider({
        getFileIcon: (filePath, options) => app.getFileIcon(filePath, options),
        cacheDirectory: path.join(app.getPath('userData'), 'FileTypeIcons')
      });
      await fileIcons.load(engine.downloads);
      let desktopReady;
      const readyForDownloads = new Promise(resolve => { desktopReady = resolve; });
      try { bridge = await startBridge(engine, { dataDirectory: app.getPath('userData'), onDownload: async payload => {
        await readyForDownloads;
        const reviewOnly = payload.startNow !== true && engine.settings.confirmBrowserDownloads;
        const ids = await engine.add({ ...payload, reviewOnly, reuseActive:true });
        await handlers.openProgress({id:ids[0]});
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
      const browserSetup = require('./browser-setup.cjs');
      let connectedBrowsers = [], browsers = [], connectionError = '';
      await require('./browser-registration.cjs').prepareNativeHost(integrationRoot, app.getPath('exe'));
      // Keep the browser intent in the launch configuration as well as the
      // connector. This lets an upgraded desktop repair an older connector
      // before that connector has been replaced on disk.
      await require('node:fs/promises').writeFile(path.join(integrationRoot, 'integration', 'desktop-launch.json'), JSON.stringify({executable:app.getPath('exe'),args:app.isPackaged ? ['--browser-download'] : [root,'--browser-download']}));
      const connectBrowsers = async () => {
        try {
          connectedBrowsers = await require('./browser-registration.cjs').connectInstalledBrowsers({ dataDirectory: app.getPath('userData'), integrationRoot });
          const connected = new Map(connectedBrowsers.map(item => [item.browser, item]));
          browsers = await Promise.all(Object.keys(browserSetup.DEFINITIONS).map(async name => {
            const executable = await browserSetup.findBrowserExecutable(name);
            let icon = '';
            if (executable) try { icon = (await app.getFileIcon(executable, { size: 'normal' })).toDataURL(); } catch { /* The status remains useful without an icon. */ }
            const connection = connected.get(name);
            return {
              name,
              installed: Boolean(executable),
              connected: Boolean(connection),
              profiles: connection?.profiles || 0,
              icon,
              extensionPage: browserSetup.definitionFor(name).url,
              extensionPath: name === 'Firefox' ? path.join(app.getPath('userData'), 'NativeMessaging', 'firefox-extension') : path.join(integrationRoot, 'extension'),
              support: 'supported'
            };
          }));
          connectionError = '';
        }
        catch (error) { connectionError = error.message; }
      };
      await connectBrowsers();
      const browserScan = setInterval(async () => {
        await connectBrowsers();
        const data = snapshot();
        if (window && !window.isDestroyed()) window.webContents.send('downloader:change', data);
        if (integrationWindow && !integrationWindow.isDestroyed()) integrationWindow.webContents.send('downloader:change', data);
      }, 15000);
      browserScan.unref();
      const integration = async () => { await connectBrowsers(); return integrationInfo(); };
      const integrationInfo = () => ({ port: bridge?.port || null, connectedBrowsers, browsers, connectionError, extensionPath: path.join(integrationRoot, 'extension'), integrationPath: path.join(integrationRoot, 'integration'), packaged: app.isPackaged, executable: app.getPath('exe') });
      const snapshot = () => ({ ...engine.snapshot(), integration: integrationInfo(), fileIcons: fileIcons.snapshot() });
      const shutdownServices = () => shutdownPromise ||= Promise.resolve().then(() => bridge?.close()).then(() => engine?.close());
      const openIntegrationWindow = async () => {
        if (integrationWindow && !integrationWindow.isDestroyed()) { showProgress(integrationWindow); return; }
        integrationWindow = new BrowserWindow({show:false,width:700,height:620,minWidth:620,minHeight:480,title:'Browser integration',icon:appIconPath,backgroundColor:'#f0f0f0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
        integrationWindow.setMenu(null);
        integrationWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        integrationWindow.webContents.on('will-navigate',event=>event.preventDefault());
        integrationWindow.on('closed',()=>{integrationWindow=null;});
        await integrationWindow.loadFile(path.join(root,'renderer','index.html'),{query:{integration:'1'}});
        showProgress(integrationWindow);
      };
      const openOptionsWindow = async () => {
        if (optionsWindow && !optionsWindow.isDestroyed()) { showProgress(optionsWindow); return; }
        optionsWindow = new BrowserWindow({show:false,width:540,height:650,minWidth:500,minHeight:500,title:'Options',icon:appIconPath,backgroundColor:'#f0f0f0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
        optionsWindow.setMenu(null);
        optionsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        optionsWindow.webContents.on('will-navigate',event=>event.preventDefault());
        optionsWindow.on('closed',()=>{optionsWindow=null;});
        await optionsWindow.loadFile(path.join(root,'renderer','index.html'),{query:{options:'1'}});
        showProgress(optionsWindow);
      };
      const openAddWindow = async ({ paste = false, scheduled = '' } = {}) => {
        if (schedulerWindow && !schedulerWindow.isDestroyed()) schedulerWindow.close();
        if (addWindow && !addWindow.isDestroyed()) { showProgress(addWindow); return; }
        addWindow = new BrowserWindow({show:false,width:565,height:430,minWidth:520,minHeight:390,title:'Download File Info',icon:appIconPath,backgroundColor:'#f0f0f0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
        addWindow.setMenu(null);
        addWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        addWindow.webContents.on('will-navigate',event=>event.preventDefault());
        addWindow.on('closed',()=>{addWindow=null;});
        await addWindow.loadFile(path.join(root,'renderer','index.html'),{query:{add:'1',paste:paste?'1':'0',...(scheduled?{scheduled}: {})}});
        showProgress(addWindow);
      };
      const openSchedulerWindow = async () => {
        if (schedulerWindow && !schedulerWindow.isDestroyed()) { showProgress(schedulerWindow); return; }
        schedulerWindow = new BrowserWindow({show:false,width:550,height:430,minWidth:500,minHeight:360,title:'Scheduler',icon:appIconPath,backgroundColor:'#f0f0f0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
        schedulerWindow.setMenu(null);
        schedulerWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        schedulerWindow.webContents.on('will-navigate',event=>event.preventDefault());
        schedulerWindow.on('closed',()=>{schedulerWindow=null;});
        await schedulerWindow.loadFile(path.join(root,'renderer','index.html'),{query:{scheduler:'1'}});
        showProgress(schedulerWindow);
      };
      const handlers = {
        snapshot,
        openProgress: async ({id}) => {
          const d=engine.downloads.find(d=>d.id===id); if(!d)throw new Error('Download not found.');
          if(progressWindows.has(id)){
            const existing=progressWindows.get(id);
            if(!d.needsReview&&existing.getSize()[1]<440){existing.setMinimumSize(540,440);existing.setSize(565,485,true);}
            showProgress(existing);return;
          }
          const reviewWindow=d.needsReview===true;
          const progress=new BrowserWindow({width:565,height:reviewWindow?365:485,minWidth:540,minHeight:reviewWindow?330:440,title:d.filename,icon:appIconPath,backgroundColor:'#f0f0f0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
          progress.setMenu(null);progressWindows.set(id,progress);progressWindowSizes.set(progress,{expanded:{width:565,height:485}});
          if(d.status==='complete'){progress.setMinimumSize(470,270);progress.setSize(480,280);progress.setTitle('Download complete');}
          progress.on('close',async event=>{
            if(progressClosing.has(progress))return;
            if(progressClosePrompts.has(progress)){event.preventDefault();return;}
            const current=engine.downloads.find(item=>item.id===id);
            if(shouldCancelReviewOnClose(current)){
              event.preventDefault();
              progressClosing.add(progress);
              try { await engine.action(id,'remove'); if(!progress.isDestroyed())progress.close(); }
              catch(error){ progressClosing.delete(progress); if(!progress.isDestroyed())await dialog.showMessageBox(progress,{type:'error',title:'Could not close confirmation',message:'Awesome Downloader could not cancel this pending download.',detail:error.message,buttons:['Close']}); }
              return;
            }
            if(!needsCloseChoice(current))return;
            event.preventDefault();
            progressClosePrompts.add(progress);
            try{
              const result=await dialog.showMessageBox(progress,{type:'question',title:'Close download window',message:'What would you like to do?',detail:'Minimize keeps the download running. Cancel download stops it and closes this window.',buttons:['Minimize','Cancel download'],defaultId:0,cancelId:0,noLink:true});
              if(result.response===0){if(!progress.isDestroyed())progress.minimize();return;}
              const latest=engine.downloads.find(item=>item.id===id);
              if(!needsCloseChoice(latest)){progressClosing.add(progress);if(!progress.isDestroyed())progress.close();return;}
              progressClosing.add(progress);
              await engine.action(id,latest?.needsReview?'remove':'cancel');
              if(!progress.isDestroyed())progress.close();
            }catch(error){
              progressClosing.delete(progress);
              if(!progress.isDestroyed())await dialog.showMessageBox(progress,{type:'error',title:'Could not close download',message:'Awesome Downloader could not cancel this download.',detail:error.message,buttons:['Close']});
            }finally{progressClosePrompts.delete(progress);}
          });
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
        settings: async data => { const result = await engine.updateSettings(data); syncStartupSetting(); return result; },
        chooseDirectory: async (_data, senderWindow) => {
          const result = await dialog.showOpenDialog(senderWindow || window, { properties: ['openDirectory', 'createDirectory'] });
          return result.canceled ? null : result.filePaths[0];
        },
        clipboard: () => clipboard.readText(),
        integration,
        openIntegration: openIntegrationWindow,
        openOptions: openOptionsWindow,
        openAdd: openAddWindow,
        openScheduler: openSchedulerWindow
      };
      handlers.registerBrowser = data => require('./browser-registration.cjs').registerBrowser(data, { dataDirectory: app.getPath('userData'), integrationRoot });
      handlers.browserSetup = async ({ action, browser } = {}) => {
        const firefoxPath = path.join(app.getPath('userData'), 'NativeMessaging', 'firefox-extension');
        const extensionPath = browser === 'Firefox' ? firefoxPath : path.join(integrationRoot, 'extension');
        if (action === 'open') return browserSetup.openBrowser(browser);
        if (action === 'prepare' && browser === 'Firefox') {
          await require('./browser-registration.cjs').registerBrowser({ browser, extensionId: 'awesome-downloader@morluto.local' }, { dataDirectory: app.getPath('userData'), integrationRoot });
          await connectBrowsers();
          return { extensionPath };
        }
        if (action === 'copy') { clipboard.writeText(extensionPath); return; }
        if (action === 'folder') {
          if (browser === 'Firefox') {
            try { await require('node:fs/promises').access(extensionPath); }
            catch { await require('./browser-registration.cjs').registerBrowser({ browser, extensionId: 'awesome-downloader@morluto.local' }, { dataDirectory: app.getPath('userData'), integrationRoot }); }
          }
          const error = await shell.openPath(extensionPath);
          if (error) throw new Error(error);
          return;
        }
        throw new Error('Unknown browser setup action.');
      };
      for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`downloader:${name}`, (event, data) => {
        if (![window,integrationWindow,optionsWindow,addWindow,schedulerWindow,...progressWindows.values()].some(w=>w&&!w.isDestroyed()&&event.senderFrame===w.webContents.mainFrame)) throw new Error('Untrusted renderer.');
        return handler(data, BrowserWindow.fromWebContents(event.sender));
      });
      ipcMain.handle('downloader:closeProgress',event=>{if(integrationWindow&&!integrationWindow.isDestroyed()&&event.senderFrame===integrationWindow.webContents.mainFrame){integrationWindow.close();return;}if(optionsWindow&&!optionsWindow.isDestroyed()&&event.senderFrame===optionsWindow.webContents.mainFrame){optionsWindow.close();return;}if(addWindow&&!addWindow.isDestroyed()&&event.senderFrame===addWindow.webContents.mainFrame){addWindow.close();return;}if(schedulerWindow&&!schedulerWindow.isDestroyed()&&event.senderFrame===schedulerWindow.webContents.mainFrame){schedulerWindow.close();return;}for(const progress of progressWindows.values())if(event.senderFrame===progress.webContents.mainFrame){progress.close();break;}});
      ipcMain.handle('downloader:resizeProgress',(event,{expanded}={})=>{for(const progress of progressWindows.values())if(event.senderFrame===progress.webContents.mainFrame){const remembered=progressWindowSizes.get(progress)||{expanded:{width:565,height:485}},[width,height]=progress.getSize();if(expanded){progress.setMinimumSize(540,440);progress.setSize(Math.max(540,remembered.expanded.width),Math.max(440,remembered.expanded.height),true);}else{if(height>360)remembered.expanded={width,height};progressWindowSizes.set(progress,remembered);progress.setMinimumSize(540,325);progress.setSize(Math.max(540,width),340,true);}return;}});
      window = new BrowserWindow({ show: !process.argv.includes('--browser-download') && !process.argv.includes('--background'), width: 805, height: 465, minWidth: 760, minHeight: 450,
        title: 'Awesome Downloader', icon: appIconPath, backgroundColor: '#f0f0f0', autoHideMenuBar: false,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadFile(path.join(root, 'renderer', 'index.html'));
      desktopReady();
      const command = name => () => window.webContents.send('downloader:command', name);
      const dismissBrowserIntegration = () => { if (integrationWindow && !integrationWindow.isDestroyed()) integrationWindow.close(); };
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
          { type: 'separator' }, { label: 'Exit', click: () => app.quit() } ] },
        { label: 'File', submenu: [ { label: 'Download properties…', click: command('details') }, { label: 'Remove selected', accelerator: 'Delete', click: command('remove') }, { label: 'Remove completed downloads', click: command('removeCompleted') } ] },
        { label: 'Downloads', submenu: [ { label: 'Pause all', click: command('pauseAll') }, { label: 'Stop all', click: command('pauseAll') }, { type: 'separator' }, { label: 'Delete all completed', click: command('removeCompleted') }, { type: 'separator' }, { label: 'Find', accelerator: 'CmdOrCtrl+F', click: command('find') }, { type: 'separator' }, { label: 'Scheduler…', click: command('scheduler') }, { label: 'Start queue', click: command('resumeAll') }, { label: 'Stop queue', click: command('pauseAll') }, { label: 'Speed limiter…', click: command('settings') }, { type: 'separator' }, { label: 'Options…', click: command('settings') } ] },
        { label: 'View', submenu: [ { label: 'All downloads', click: command('all') }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' } ] },
        { label: 'Help', submenu: [ { label: 'Browser integration…', click: command('integration') }, { label: 'Check for updates…', click: () => updateController?.check({ manual: true }) }, { type: 'separator' }, { label: 'About Awesome Downloader', click: () => dialog.showMessageBox(window, { title: 'About Awesome Downloader', message: `Awesome Downloader ${app.getVersion()}`, detail: 'Download manager with browser integration. Original implementation inspired by IDM. Full IDM feature parity is in development.' }) } ] }
      ]));
      engine.on('change', async () => {
        await fileIcons.load(engine.downloads);
        const data=snapshot();
        if (!window.isDestroyed()) window.webContents.send('downloader:change',data);
        if (optionsWindow && !optionsWindow.isDestroyed()) optionsWindow.webContents.send('downloader:change',data);
        if (addWindow && !addWindow.isDestroyed()) addWindow.webContents.send('downloader:change',data);
        if (schedulerWindow && !schedulerWindow.isDestroyed()) schedulerWindow.webContents.send('downloader:change',data);
        for(const [id,progress] of progressWindows){
          const d=data.downloads.find(d=>d.id===id);
          if(closeCancelledProgress(progress,d))continue;
          progress.setTitle(d.needsReview?'Download File Info':d.status==='complete'?'Download complete':`${d.total?Math.floor(d.downloaded/d.total*100)+'% ':''}${d.filename}`);
          progress.webContents.send('downloader:change',data);
        }
      });
      engine.on('complete', d => {
        const progress=progressWindows.get(d.id);
        if(progress&&!progress.isDestroyed()){if(engine.settings.hideCompletionDialog)progress.close();else{progress.setMinimumSize(470,270);progress.setSize(480,280);progress.setTitle('Download complete');}}
        if (engine.settings.notifyOnComplete && Notification.isSupported()) new Notification({ title: 'Download complete', body: d.filename }).show();
        if (engine.settings.revealOnComplete && d.path) shell.showItemInFolder(d.path);
      });
      const icon = nativeImage.createFromPath(appIconPath).resize({width:16,height:16});
      tray = new Tray(icon);
      tray.setToolTip('Awesome Downloader');
      const showDashboard = () => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show downloads', click: showDashboard }, { label: 'Quit', click: () => app.quit() }]));
      tray.on('click', showDashboard);
      tray.on('double-click', showDashboard);
      window.on('minimize', dismissBrowserIntegration);
      window.on('close', event => { if (!quitting) { event.preventDefault(); dismissBrowserIntegration(); window.hide(); } });
      app.on('activate', showDashboard);
      const { autoUpdater } = require('electron-updater');
      updateController = require('./updater.cjs').createUpdateController({
        autoUpdater,
        app,
        dialog,
        getWindow: () => window,
        activeDownloadCount: () => engine.downloads.filter(download => ['connecting','downloading','assembling'].includes(download.status)).length,
        notify: (title, body, onClick) => {
          if (!Notification.isSupported()) return;
          const notification = new Notification({ title, body });
          notification.on('click', onClick);
          notification.show();
        },
        installUpdate: async () => {
          quitting = true;
          await shutdownServices();
          autoUpdater.quitAndInstall(false, true);
        }
      });
      updateController.start();
    }).catch(error => { dialog.showErrorBox('Awesome Downloader could not start', error.stack || error.message); quitting = true; app.quit(); });
    app.on('before-quit', event => {
      if (quitting) return;
      event.preventDefault(); quitting = true;
      (shutdownPromise ||= Promise.resolve().then(() => bridge?.close()).then(() => engine?.close())).catch(error => process.stderr.write(`${error.message}\n`)).finally(() => app.quit());
    });
  }
}
