const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function harness({manifest={content_scripts:[]},scripting}={}) {
  const events={}, nativeRequests=[], data={};
  const event=name=>({addListener(fn){events[name]=fn;}});
  const storage={async get(key){return structuredClone({[key]:data[key]});},async set(value){Object.assign(data,structuredClone(value));},async remove(key){delete data[key];}};
  const browser={runtime:{id:'extension-id',getManifest:()=>manifest,onMessage:event('message'),onInstalled:event('installed'),
    async sendNativeMessage(host,payload){nativeRequests.push(structuredClone(payload));return payload.action==='status'?{ok:true,items:[{id:'a',filename:'a.zip',status:'downloading',percent:10,speed:1024}]}:{ok:true};}},
    storage:{session:storage,local:storage},webRequest:{onHeadersReceived:event('response'),onBeforeRequest:event('beforeRequest'),onBeforeSendHeaders:event('requestHeaders')},
    tabs:{onRemoved:event('removed'),onUpdated:event('updated')},contextMenus:{onClicked:event('context'),async removeAll(){},create(){}},downloads:{onCreated:event('download')},action:{},scripting};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),{browser,URL,URLSearchParams,Uint8Array,btoa:v=>Buffer.from(v,'binary').toString('base64'),youtubeMedia:require('./youtube-media.js')});
  return {events,data,nativeRequests,request(message,sender){return new Promise(resolve=>{const accepted=events.message(message,sender,resolve);if(accepted!==true)resolve(undefined);});}};
}
test('popup can read desktop status and send validated controls',async()=>{
  const h=harness(), popup={id:'extension-id'};
  const status=await h.request({action:'status'},popup);
  assert.equal(status.ok,true);assert.equal(status.items[0].filename,'a.zip');
  assert.deepEqual(h.nativeRequests[0],{action:'status'});
  const control=await h.request({action:'control',id:'a',control:'pause'},popup);
  assert.equal(control.ok,true);
  assert.deepEqual(h.nativeRequests[1],{action:'control',id:'a',control:'pause'});
});
test('web page content scripts cannot read status or control downloads',async()=>{
  const h=harness(), page={id:'extension-id',tab:{id:1,url:'https://evil.example/'}};
  for(const message of [{action:'status'},{action:'control',id:'a',control:'cancel'}]){
    const result=await h.request(message,page);
    assert.equal(result.ok,false);
  }
  assert.equal(h.nativeRequests.length,0);
});
test('legacy manifests register the YouTube main-world scripts dynamically, modern ones do not',async()=>{
  const registered=[];
  const scripting={async getRegisteredContentScripts(){return [];},async registerContentScripts(scripts){registered.push(...scripts);}};
  harness({manifest:{content_scripts:[{matches:['https://*/*'],js:['content.js']}]},scripting});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(registered.length,1);
  assert.equal(registered[0].world,'MAIN');
  assert.deepEqual(Array.from(registered[0].js),['youtube-media.js','youtube-page.js']);
  const modern=[];
  harness({manifest:{content_scripts:[{world:'MAIN',js:['youtube-media.js']}]},scripting:{async getRegisteredContentScripts(){return [];},async registerContentScripts(s){modern.push(...s);}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(modern.length,0);
});
test('legacy manifest is valid, has no world:MAIN and keeps every other content script',()=>{
  const legacy=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.legacy.json'),'utf8'));
  const modern=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  assert.ok(!JSON.stringify(legacy).includes('"world"'));
  assert.ok(legacy.permissions.includes('scripting'));
  assert.equal(legacy.content_scripts.length,modern.content_scripts.length-1);
  assert.equal(legacy.manifest_version,3);
  for(const script of legacy.content_scripts) for(const file of script.js) assert.ok(fs.existsSync(path.join(__dirname,file)),file);
});
