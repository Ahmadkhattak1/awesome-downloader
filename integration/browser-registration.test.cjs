const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {BROWSERS,browserSpec,registerBrowser,connectInstalledBrowsers,prepareNativeHost,unregisterNativeHosts}=require('../desktop/browser-registration.cjs');

test('supported browsers use distinct native-host roots except Opera Chrome compatibility',()=>{
  assert.equal(browserSpec('Chrome').registry,'Google\\Chrome');
  assert.equal(browserSpec('Opera').registry,'Google\\Chrome');
  assert.equal(browserSpec('Edge').registry,'Microsoft\\Edge');
  assert.equal(browserSpec('Brave').registry,'BraveSoftware\\Brave-Browser');
  assert.equal(browserSpec('Firefox').firefox,true);
  assert.throws(()=>browserSpec('Unknown'),/Choose Chrome, Edge, Brave, Opera, or Firefox/);
});

test('automatic discovery connects every installed Chromium browser and profile',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-browsers-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const local=path.join(root,'local'),roaming=path.join(root,'roaming'),integrationRoot=path.join(root,'app');
  const extension=path.join(integrationRoot,'extension');
  await fs.mkdir(extension,{recursive:true});
  const ids={Chrome:'a'.repeat(32),Edge:'b'.repeat(32),Brave:'c'.repeat(32),Opera:'d'.repeat(32)};
  for(const browser of ['Chrome','Edge','Brave']){
    const folder=path.join(local,BROWSERS[browser].data,'Default');await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'Preferences'),JSON.stringify({extensions:{settings:{[ids[browser]]:{path:extension}}}}));
  }
  const opera=path.join(roaming,BROWSERS.Opera.data);await fs.mkdir(opera,{recursive:true});
  await fs.writeFile(path.join(opera,'Preferences'),JSON.stringify({extensions:{settings:{[ids.Opera]:{path:extension}}}}));
  const calls=[];
  const result=await connectInstalledBrowsers({dataDirectory:path.join(root,'data'),integrationRoot,localAppData:local,roamingAppData:roaming,platform:'win32'},{register:async input=>{calls.push(input);return {manifestPath:'unused'};}});
  assert.deepEqual(result.map(value=>value.browser),['Chrome','Edge','Brave','Opera']);
  assert.deepEqual(Object.fromEntries(calls.map(value=>[value.browser,value.extensionId])),ids);
});

const id='abcdefghijklmnopabcdefghijklmnop';
async function macFixture(t,{appRuntime=false}={}){
  // Spaces mirror "/Applications/Awesome Downloader.app" and "Application Support".
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mac registration '));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),dataDirectory=path.join(root,'data dir'),integrationRoot=path.join(root,'Browser Integration');
  await fs.mkdir(path.join(integrationRoot,'integration'),{recursive:true});
  await fs.mkdir(path.join(integrationRoot,'extension'),{recursive:true});
  await fs.writeFile(path.join(integrationRoot,'extension','manifest.firefox.json'),'{}');
  await fs.writeFile(path.join(integrationRoot,'integration','native-host.cjs'),'process.stdout.write(JSON.stringify({node:process.env.ELECTRON_RUN_AS_NODE,script:process.argv[1]}))');
  let runtime=process.execPath;
  if(appRuntime){
    // Stand-in for the app's own executable inside an app bundle whose name has spaces.
    runtime=path.join(root,'Applications','Awesome Downloader.app','Contents','MacOS','Awesome Downloader');
    await fs.mkdir(path.dirname(runtime),{recursive:true});
    await fs.symlink(process.execPath,runtime);
  }
  await prepareNativeHost(integrationRoot,runtime,'darwin');
  return {root,home,dataDirectory,integrationRoot,runtime,support:path.join(home,'Library','Application Support')};
}
// Writes the Chromium preference entries a browser keeps for loaded extensions.
// Opera keeps them under extensions.opsettings; its extensions.settings is empty.
async function macProfiles(support,integrationRoot,profiles){
  for(const [browser,profile,ids] of profiles){
    const folder=path.join(support,BROWSERS[browser].mac,profile);await fs.mkdir(folder,{recursive:true});
    const settings=Object.fromEntries(ids.map(id=>[id,{path:path.join(integrationRoot,'extension')}]));
    await fs.writeFile(path.join(folder,'Preferences'),JSON.stringify({extensions:browser==='Opera'?{settings:{},opsettings:settings}:{settings}}));
  }
}
// Another product's host in the same folders; nothing here may change or remove it.
async function otherHosts(support){
  const files={};
  for(const folder of ['Google/Chrome','Microsoft Edge','BraveSoftware/Brave-Browser','Mozilla']){
    const file=path.join(support,folder,'NativeMessagingHosts','com.example.other.json');
    await fs.mkdir(path.dirname(file),{recursive:true});
    files[file]=JSON.stringify({name:'com.example.other',path:'/Applications/Other.app/host',type:'stdio',allowed_origins:['chrome-extension://'+'e'.repeat(32)+'/']});
    await fs.writeFile(file,files[file]);
  }
  return async()=>{for(const [file,content] of Object.entries(files))assert.equal(await fs.readFile(file,'utf8'),content);};
}
const macHostManifest=(support,folder)=>path.join(support,folder,'NativeMessagingHosts','com.awesome.downloader.json');

test('every supported browser has a macOS Application Support folder',()=>{
  assert.deepEqual(Object.fromEntries(Object.entries(BROWSERS).map(([name,spec])=>[name,spec.mac])),{
    Chrome:'Google/Chrome',Edge:'Microsoft Edge',Brave:'BraveSoftware/Brave-Browser',Opera:'com.operasoftware.Opera',Firefox:'Mozilla'
  });
});
test('macOS native host launcher runs the app runtime as Node from a path with spaces',{skip:process.platform==='win32'},async t=>{
  const {integrationRoot,runtime}=await macFixture(t,{appRuntime:true});
  assert.equal(await fs.readFile(path.join(integrationRoot,'integration','runtime-path.txt'),'utf8'),runtime);
  const launcher=path.join(integrationRoot,'integration','native-host');
  assert.equal((await fs.stat(launcher)).mode&0o111,0o111);
  const {stdout}=await promisify(execFile)(launcher,['chrome-extension://'+id+'/']);
  const result=JSON.parse(stdout);
  assert.equal(result.node,'1');
  assert.equal(await fs.realpath(result.script),await fs.realpath(path.join(integrationRoot,'integration','native-host.cjs')));
});
test('macOS registration writes the per-user manifest and backs up a changed one',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const manifestPath=macHostManifest(support,'Google/Chrome');
  await fs.mkdir(path.dirname(manifestPath),{recursive:true});
  await fs.writeFile(manifestPath,'{"stale":true}');
  const result=await registerBrowser({browser:'Chrome',extensionId:id},{dataDirectory,integrationRoot,platform:'darwin',home});
  assert.equal(result.manifestPath,manifestPath);
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  assert.equal(manifest.path,path.join(integrationRoot,'integration','native-host'));
  assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${id}/`]);
  const backups=await fs.readdir(path.join(dataDirectory,'NativeMessaging'));
  assert.equal(backups.filter(name=>name.endsWith('.bak')).length,1);
  assert.deepEqual(await fs.readdir(path.dirname(manifestPath)),['com.awesome.downloader.json']);
});
test('macOS Firefox registration writes its manifest under Mozilla',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const result=await registerBrowser({browser:'Firefox',extensionId:'downloader@example.com'},{dataDirectory,integrationRoot,platform:'darwin',home});
  assert.equal(result.manifestPath,macHostManifest(support,'Mozilla'));
  assert.deepEqual(JSON.parse(await fs.readFile(result.manifestPath,'utf8')).allowed_extensions,['downloader@example.com']);
});
test('macOS browser scan connects every Chromium browser from its Application Support folder',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const ids={Chrome:'a'.repeat(32),Edge:'b'.repeat(32),Brave:'c'.repeat(32),Opera:'d'.repeat(32)};
  // Opera keeps its preferences in the root of its folder rather than in a profile.
  for(const [browser,profile] of [['Chrome','Default'],['Edge','Profile 1'],['Brave','Default'],['Opera','.']]){
    const folder=path.join(support,BROWSERS[browser].mac,profile);await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'Preferences'),JSON.stringify({extensions:{settings:{[ids[browser]]:{path:path.join(integrationRoot,'extension')}}}}));
  }
  const results=await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  assert.deepEqual(results.map(value=>value.browser),['Chrome','Edge','Brave','Opera']);
  const origins=async folder=>JSON.parse(await fs.readFile(macHostManifest(support,folder),'utf8')).allowed_origins;
  assert.deepEqual(await origins('Microsoft Edge'),[`chrome-extension://${ids.Edge}/`]);
  assert.deepEqual(await origins('BraveSoftware/Brave-Browser'),[`chrome-extension://${ids.Brave}/`]);
  // Opera shares Chrome's host folder, so both IDs end up in one allow-list.
  assert.deepEqual(await origins('Google/Chrome'),[`chrome-extension://${ids.Chrome}/`,`chrome-extension://${ids.Opera}/`]);
  await assert.rejects(fs.access(path.join(support,'com.operasoftware.Opera','NativeMessagingHosts')));
});
test('macOS launcher relays a framed native message from a path with spaces to the desktop bridge',{skip:process.platform==='win32'},async t=>{
  const {home,integrationRoot}=await macFixture(t,{appRuntime:true});
  await fs.copyFile(path.join(__dirname,'native-host.cjs'),path.join(integrationRoot,'integration','native-host.cjs'));
  const token='bridge-token-with-enough-characters';
  const received=[];
  const server=require('node:http').createServer((request,response)=>{
    let body='';request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{received.push({path:request.url,authorization:request.headers.authorization,body:JSON.parse(body)});response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true,id:'download-1'}));});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  await fs.mkdir(path.join(home,'.awesome-downloader'),{recursive:true});
  await fs.writeFile(path.join(home,'.awesome-downloader','bridge.json'),JSON.stringify({port:server.address().port,token}));
  const {encodeMessage,MessageDecoder}=require('./native-host.cjs');
  // Browsers start the host with their own environment; HOME selects this fixture's bridge.
  const child=require('node:child_process').spawn(path.join(integrationRoot,'integration','native-host'),['chrome-extension://'+id+'/'],{env:{HOME:home,PATH:'/usr/bin:/bin'}});
  const decoder=new MessageDecoder(),replies=[];decoder.on('data',value=>replies.push(value));
  child.stdout.pipe(decoder);
  child.stdin.end(encodeMessage({action:'download',url:'https://example.com/file name.zip',filename:'file name.zip'}));
  const [code]=await require('node:events').once(child,'exit');
  assert.equal(code,0);
  assert.deepEqual(replies,[{ok:true,id:'download-1'}]);
  assert.equal(received.length,1);
  assert.equal(received[0].path,'/downloads');
  assert.equal(received[0].authorization,'Bearer '+token);
  assert.equal(received[0].body.filename,'file name.zip');
});
test('macOS allow-list holds exactly the extension IDs found and survives a browser or app restart',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const unchanged=await otherHosts(support);
  const manifestPath=macHostManifest(support,'Google/Chrome');
  const stale='f'.repeat(32),current='a'.repeat(32),second='b'.repeat(32);
  await fs.writeFile(manifestPath,JSON.stringify({name:'com.awesome.downloader',path:path.join(integrationRoot,'integration','native-host'),type:'stdio',allowed_origins:[`chrome-extension://${stale}/`]}));
  await macProfiles(support,integrationRoot,[['Chrome','Default',[current]],['Chrome','Profile 2',[second]]]);
  // Unrelated extensions with absolute paths, such as Chrome's built-in ones, must not stop the scan.
  const builtIn=path.join(support,'Built In');await fs.mkdir(builtIn,{recursive:true});
  const prefs=path.join(support,'Google/Chrome','Default','Preferences');
  const data=JSON.parse(await fs.readFile(prefs,'utf8'));
  await fs.writeFile(prefs,JSON.stringify({extensions:{settings:{['g'.repeat(32)]:{path:builtIn},...data.extensions.settings}}}));
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  const first=await fs.readFile(manifestPath,'utf8');
  assert.deepEqual(JSON.parse(first).allowed_origins,[`chrome-extension://${current}/`,`chrome-extension://${second}/`]);
  const backups=async()=>(await fs.readdir(path.join(dataDirectory,'NativeMessaging'))).filter(name=>name.endsWith('.bak'));
  assert.equal((await backups()).length,1);
  // Restarting either side only rescans: the same manifest stays in place, untouched.
  const {mtimeMs}=await fs.stat(manifestPath);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  assert.equal(await fs.readFile(manifestPath,'utf8'),first);
  assert.equal((await fs.stat(manifestPath)).mtimeMs,mtimeMs);
  assert.equal((await backups()).length,1);
  await fs.access(JSON.parse(first).path);
  await unchanged();
});
test('macOS scan that cannot read a preference file keeps IDs it did not see',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const kept='f'.repeat(32),current='a'.repeat(32);
  const manifestPath=macHostManifest(support,'Google/Chrome');
  await fs.mkdir(path.dirname(manifestPath),{recursive:true});
  await fs.writeFile(manifestPath,JSON.stringify({name:'com.awesome.downloader',path:path.join(integrationRoot,'integration','native-host'),type:'stdio',allowed_origins:[`chrome-extension://${kept}/`]}));
  await macProfiles(support,integrationRoot,[['Chrome','Default',[current]]]);
  // A browser rewriting its preferences mid-scan leaves a partial file.
  await fs.mkdir(path.join(support,'Google/Chrome','Profile 1'));
  await fs.writeFile(path.join(support,'Google/Chrome','Profile 1','Preferences'),'{"extensions":');
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath,'utf8')).allowed_origins,[`chrome-extension://${kept}/`,`chrome-extension://${current}/`]);
  // With the extension gone, an incomplete scan must not remove the host either.
  await macProfiles(support,integrationRoot,[['Chrome','Default',[]]]);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  await fs.access(manifestPath);
});
test('macOS removes its own manifest once the extension is no longer installed and leaves other hosts alone',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const unchanged=await otherHosts(support);
  await macProfiles(support,integrationRoot,[['Chrome','Default',['a'.repeat(32)]],['Edge','Default',['b'.repeat(32)]],['Opera','.',['d'.repeat(32)]]]);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  await fs.access(macHostManifest(support,'Google/Chrome'));
  await fs.access(macHostManifest(support,'Microsoft Edge'));
  // Removing the extension from Edge removes Edge's host only.
  await macProfiles(support,integrationRoot,[['Edge','Default',[]]]);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  await assert.rejects(fs.access(macHostManifest(support,'Microsoft Edge')),{code:'ENOENT'});
  // Chrome's host is shared with Opera, so it stays until neither has the extension.
  await macProfiles(support,integrationRoot,[['Chrome','Default',[]]]);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  assert.deepEqual(JSON.parse(await fs.readFile(macHostManifest(support,'Google/Chrome'),'utf8')).allowed_origins,['chrome-extension://'+'d'.repeat(32)+'/']);
  await macProfiles(support,integrationRoot,[['Opera','.',[]]]);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  await assert.rejects(fs.access(macHostManifest(support,'Google/Chrome')),{code:'ENOENT'});
  // A host with our name that another copy of the app points elsewhere is not ours to remove.
  const elsewhere=JSON.stringify({name:'com.awesome.downloader',path:'/Applications/Awesome Downloader.app/native-host',type:'stdio',allowed_origins:['chrome-extension://'+'c'.repeat(32)+'/']});
  await fs.writeFile(macHostManifest(support,'BraveSoftware/Brave-Browser'),elsewhere);
  await connectInstalledBrowsers({dataDirectory,integrationRoot,platform:'darwin',home});
  assert.equal(await fs.readFile(macHostManifest(support,'BraveSoftware/Brave-Browser'),'utf8'),elsewhere);
  await unchanged();
});
test('macOS uninstall step removes only this product\'s manifests and generated launcher files',async t=>{
  const {home,support,dataDirectory,integrationRoot}=await macFixture(t);
  const unchanged=await otherHosts(support);
  await fs.writeFile(path.join(integrationRoot,'integration','desktop-launch.json'),'{}');
  await registerBrowser({browser:'Chrome',extensionId:id},{dataDirectory,integrationRoot,platform:'darwin',home});
  await registerBrowser({browser:'Firefox',extensionId:'downloader@example.com'},{dataDirectory,integrationRoot,platform:'darwin',home});
  // A file that merely uses our file name for a different host is left in place.
  await fs.writeFile(macHostManifest(support,'Microsoft Edge'),'{"name":"com.example.other"}');
  const removed=await unregisterNativeHosts({integrationRoot,platform:'darwin',home});
  const integration=name=>path.join(integrationRoot,'integration',name);
  assert.deepEqual(removed,[macHostManifest(support,'Google/Chrome'),macHostManifest(support,'Mozilla'),integration('native-host'),integration('runtime-path.txt'),integration('desktop-launch.json')]);
  await fs.access(integration('native-host.cjs'));
  await fs.access(macHostManifest(support,'Microsoft Edge'));
  assert.deepEqual(await unregisterNativeHosts({integrationRoot,platform:'darwin',home}),[]);
  await assert.rejects(unregisterNativeHosts({integrationRoot,platform:'win32',home}),/macOS only/);
  await unchanged();
});
test('Windows registration still writes its manifest and calls reg.exe with the same arguments',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'win registration '));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dataDirectory=path.join(root,'data'),integrationRoot=path.join(root,'app');
  await fs.mkdir(path.join(integrationRoot,'integration'),{recursive:true});
  await fs.writeFile(path.join(integrationRoot,'integration','native-host.exe'),'');
  const folder=path.join(dataDirectory,'NativeMessaging');
  const key=registry=>`HKCU\\Software\\${registry}\\NativeMessagingHosts\\com.awesome.downloader`;
  const options={windowsHide:true};
  let registered={};
  const calls=[];
  const run=async(file,args,opts)=>{
    calls.push([file,args,opts]);
    if(args[0]==='QUERY'){
      if(!registered[args[1]])throw Object.assign(new Error('not found'),{code:1});
      return {stdout:`\r\n${args[1]}\r\n    (Default)    REG_SZ    ${registered[args[1]]}\r\n`};
    }
    registered[args[1]]=args[args.indexOf('/d')+1];return {stdout:''};
  };
  const result=await registerBrowser({browser:'Edge',extensionId:id},{dataDirectory,integrationRoot,platform:'win32',run});
  const manifestPath=path.join(folder,'Edge.json');
  assert.equal(result.manifestPath,manifestPath);
  assert.deepEqual(calls,[
    ['reg.exe',['QUERY',key('Microsoft\\Edge'),'/ve'],options],
    ['reg.exe',['ADD',key('Microsoft\\Edge'),'/ve','/t','REG_SZ','/d',manifestPath,'/f'],options]
  ]);
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  assert.equal(manifest.path,path.join(integrationRoot,'integration','native-host.exe'));
  assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${id}/`]);
  // Registering again only queries; the key already points at this manifest.
  calls.length=0;
  await registerBrowser({browser:'Edge',extensionId:id},{dataDirectory,integrationRoot,platform:'win32',run});
  assert.deepEqual(calls,[['reg.exe',['QUERY',key('Microsoft\\Edge'),'/ve'],options]]);
  // Opera shares Chrome's key and manifest; a key owned by another path is backed up first.
  registered={[key('Google\\Chrome')]:'C:\\Other\\host.json'};
  calls.length=0;
  const other='b'.repeat(32);
  await registerBrowser({browser:'Chrome',extensionId:other},{dataDirectory,integrationRoot,platform:'win32',run});
  await registerBrowser({browser:'Opera',extensionId:id},{dataDirectory,integrationRoot,platform:'win32',run});
  const chromeManifest=path.join(folder,'Chrome.json');
  assert.deepEqual(calls,[
    ['reg.exe',['QUERY',key('Google\\Chrome'),'/ve'],options],
    ['reg.exe',['ADD',key('Google\\Chrome'),'/ve','/t','REG_SZ','/d',chromeManifest,'/f'],options],
    ['reg.exe',['QUERY',key('Google\\Chrome'),'/ve'],options]
  ]);
  assert.equal((await fs.readdir(folder)).filter(name=>name.startsWith('Chrome.')&&name.endsWith('.registry-backup.txt')).length,1);
  // Windows keeps adding IDs to the shared allow-list, as before.
  assert.deepEqual(JSON.parse(await fs.readFile(chromeManifest,'utf8')).allowed_origins,[`chrome-extension://${other}/`,`chrome-extension://${id}/`]);
});
