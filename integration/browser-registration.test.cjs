const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {BROWSERS,browserSpec,registerBrowser,connectInstalledBrowsers,prepareNativeHost}=require('../desktop/browser-registration.cjs');

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
async function macFixture(t){
  // Spaces mirror "/Applications/Awesome Downloader.app" and "Application Support".
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mac registration '));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),dataDirectory=path.join(root,'data dir'),integrationRoot=path.join(root,'Browser Integration');
  await fs.mkdir(path.join(integrationRoot,'integration'),{recursive:true});
  await fs.mkdir(path.join(integrationRoot,'extension'),{recursive:true});
  await fs.writeFile(path.join(integrationRoot,'extension','manifest.firefox.json'),'{}');
  await fs.writeFile(path.join(integrationRoot,'integration','native-host.cjs'),'process.stdout.write(JSON.stringify({node:process.env.ELECTRON_RUN_AS_NODE,script:process.argv[1]}))');
  await prepareNativeHost(integrationRoot,process.execPath,'darwin');
  return {home,dataDirectory,integrationRoot,support:path.join(home,'Library','Application Support')};
}
const macHostManifest=(support,folder)=>path.join(support,folder,'NativeMessagingHosts','com.awesome.downloader.json');

test('every supported browser has a macOS Application Support folder',()=>{
  assert.deepEqual(Object.fromEntries(Object.entries(BROWSERS).map(([name,spec])=>[name,spec.mac])),{
    Chrome:'Google/Chrome',Edge:'Microsoft Edge',Brave:'BraveSoftware/Brave-Browser',Opera:'com.operasoftware.Opera',Firefox:'Mozilla'
  });
});
test('macOS native host launcher runs the app runtime as Node from a path with spaces',{skip:process.platform==='win32'},async t=>{
  const {integrationRoot}=await macFixture(t);
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
