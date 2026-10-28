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
