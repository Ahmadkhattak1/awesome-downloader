// Real end-to-end chain: native host message -> native host -> HTTP bridge -> engine.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {sanitizeRequest,submitDownload,readBridge}=require('./native-host.cjs');
test('status and control travel from the native host to the engine and back',async t=>{
  const {DownloadEngine}=await import('../core/engine.mjs'), {startBridge}=await import('../core/bridge.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-e2e-'));
  const engine=await new DownloadEngine({dataDirectory:path.join(root,'d'),downloadDirectory:path.join(root,'dl'),tickMs:60000}).init();
  const bridge=await startBridge(engine,{dataDirectory:path.join(root,'b'),port:0});
  t.after(async()=>{await bridge.close();await engine.close?.();await fs.rm(root,{recursive:true,force:true});});
  const config=readBridge(path.join(root,'b','bridge.json'));
  const [id]=await engine.add({url:'https://example.com/file.zip',queueOnly:true});
  const status=await submitDownload(sanitizeRequest({action:'status'}),config);
  assert.equal(status.ok,true);assert.equal(status.items[0].id,id);assert.equal(status.settings.watchClipboard,true);
  await submitDownload(sanitizeRequest({action:'control',id,control:'retry'}),config);
  assert.notEqual(engine.downloads.find(d=>d.id===id).status,'paused');
  await submitDownload(sanitizeRequest({action:'control',id,control:'cancel'}),config);
  assert.equal(engine.downloads.find(d=>d.id===id).status,'cancelled');
  await assert.rejects(submitDownload(sanitizeRequest({action:'control',id:'nope',control:'pause'}),config),/not found/i);
});
