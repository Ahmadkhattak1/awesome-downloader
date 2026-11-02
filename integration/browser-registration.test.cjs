const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {BROWSERS,browserSpec,connectInstalledBrowsers}=require('../desktop/browser-registration.cjs');

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
  const result=await connectInstalledBrowsers({dataDirectory:path.join(root,'data'),integrationRoot,localAppData:local,roamingAppData:roaming},{register:async input=>{calls.push(input);return {manifestPath:'unused'};}});
  assert.deepEqual(result.map(value=>value.browser),['Chrome','Edge','Brave','Opera']);
  assert.deepEqual(Object.fromEntries(calls.map(value=>[value.browser,value.extensionId])),ids);
});

test('published extension is discovered with relative Chrome paths but disabled entries are excluded',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-store-profile-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const integrationRoot=path.join(root,'app'),local=path.join(root,'local');
  await fs.mkdir(path.join(integrationRoot,'extension'),{recursive:true});
  const profile=path.join(local,BROWSERS.Chrome.data,'Default');
  await fs.mkdir(profile,{recursive:true});
  const {EXTENSION_ID}=require('../desktop/extension-store.cjs');
  const calls=[];
  const scan=()=>connectInstalledBrowsers({dataDirectory:path.join(root,'data'),integrationRoot,localAppData:local},{register:async input=>calls.push(input)});
  const write=entry=>fs.writeFile(path.join(profile,'Preferences'),JSON.stringify({extensions:{settings:{[EXTENSION_ID]:entry}}}));
  await write({path:EXTENSION_ID+'/0.1.1_0',state:1});
  assert.deepEqual(await scan(),[{browser:'Chrome',connected:true,profiles:1}]);
  assert.deepEqual(calls,[{browser:'Chrome',extensionId:EXTENSION_ID}]);
  for(const entry of [{path:EXTENSION_ID+'/0.1.1_0',state:0},{path:EXTENSION_ID+'/0.1.1_0',state:1,disable_reasons:[1]},{path:path.join(integrationRoot,'extension'),state:0},{path:EXTENSION_ID+'/0.1.1_0',state:1,disable_reasons:1}]){
    await write(entry);assert.deepEqual(await scan(),[]);
  }
});

test('Firefox add-on discovery registers its fixed native messaging identity',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-firefox-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const integrationRoot=path.join(root,'app'), extension=path.join(integrationRoot,'extension');
  await fs.mkdir(extension,{recursive:true});
  const profile=path.join(root,'roaming',BROWSERS.Firefox.data,'profile.default');
  await fs.mkdir(profile,{recursive:true});
  await fs.writeFile(path.join(profile,'extensions.json'),JSON.stringify({addons:[{id:'awesome-downloader@morluto.local',active:true,appDisabled:false}]}));
  const calls=[];
  const result=await connectInstalledBrowsers({dataDirectory:path.join(root,'data'),integrationRoot,localAppData:path.join(root,'local'),roamingAppData:path.join(root,'roaming')},{register:async input=>{calls.push(input);return {manifestPath:'unused'};}});
  assert.deepEqual(result,[{browser:'Firefox',connected:true,profiles:1}]);
  assert.deepEqual(calls,[{browser:'Firefox',extensionId:'awesome-downloader@morluto.local'}]);
});

test('modern store installs connect without a legacy state field and one connected browser is enough',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-modern-store-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const integrationRoot=path.join(root,'app'),local=path.join(root,'local');
  await fs.mkdir(path.join(integrationRoot,'extension'),{recursive:true});
  const {EXTENSION_ID}=require('../desktop/extension-store.cjs');
  for(const [browser,reasons] of [['Chrome',[]],['Edge',[8192]],['Brave',[1]]]) {
    const profile=path.join(local,BROWSERS[browser].data,'Default');
    await fs.mkdir(profile,{recursive:true});
    await fs.writeFile(path.join(profile,'Secure Preferences'),JSON.stringify({extensions:{settings:{[EXTENSION_ID]:{path:EXTENSION_ID+'/0.1.1_0',manifest:{version:'0.1.1'},disable_reasons:reasons}}}}));
  }
  const calls=[];
  const result=await connectInstalledBrowsers({dataDirectory:path.join(root,'data'),integrationRoot,localAppData:local},{register:async input=>calls.push(input),includeSetupState:true});
  assert.deepEqual(result,[{browser:'Chrome',connected:true,profiles:1},{browser:'Edge',connected:false,profiles:0,setupState:'approval'},{browser:'Brave',connected:false,profiles:0,setupState:'disabled'}]);
  assert.deepEqual(calls,[{browser:'Chrome',extensionId:EXTENSION_ID}]);
});

test('removed extension tombstone overrides stale enabled preferences without modifying browser files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-removed-store-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const integrationRoot=path.join(root,'app'),local=path.join(root,'local');
  await fs.mkdir(path.join(integrationRoot,'extension'),{recursive:true});
  const profile=path.join(local,BROWSERS.Chrome.data,'Default');await fs.mkdir(profile,{recursive:true});
  const {EXTENSION_ID}=require('../desktop/extension-store.cjs');
  const regular=JSON.stringify({extensions:{settings:{[EXTENSION_ID]:{state:1,path:EXTENSION_ID+'/0.1.1_0'}},external_uninstalls:[EXTENSION_ID]}});
  const secure=JSON.stringify({extensions:{settings:{[EXTENSION_ID]:{}}}});
  await fs.writeFile(path.join(profile,'Preferences'),regular);
  await fs.writeFile(path.join(profile,'Secure Preferences'),secure);
  const calls=[];
  const result=await connectInstalledBrowsers({dataDirectory:path.join(root,'data'),integrationRoot,localAppData:local},{register:async input=>calls.push(input),includeSetupState:true});
  assert.deepEqual(result,[{browser:'Chrome',connected:false,profiles:0,setupState:'removed'}]);
  assert.deepEqual(calls,[]);
  assert.equal(await fs.readFile(path.join(profile,'Preferences'),'utf8'),regular);
  assert.equal(await fs.readFile(path.join(profile,'Secure Preferences'),'utf8'),secure);
});
