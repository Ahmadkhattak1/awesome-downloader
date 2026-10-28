const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {definitionFor,findBrowserExecutable}=require('../desktop/browser-setup.cjs');

test('browser setup uses each browser internal extensions address',()=>{
  assert.equal(definitionFor('Chrome').url,'chrome://extensions/');
  assert.equal(definitionFor('Edge').url,'edge://extensions/');
  assert.equal(definitionFor('Brave').url,'brave://extensions/');
  assert.equal(definitionFor('Opera').url,'opera://extensions/');
  assert.equal(definitionFor('Firefox').url,'about:debugging#/runtime/this-firefox');
});

test('browser discovery handles per-user and system install locations',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'awesome-browser-paths-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const chrome=path.join(root,'local','Google','Chrome','Application','chrome.exe');
  const firefox=path.join(root,'programs','Mozilla Firefox','firefox.exe');
  await fs.mkdir(path.dirname(chrome),{recursive:true});await fs.writeFile(chrome,'');
  await fs.mkdir(path.dirname(firefox),{recursive:true});await fs.writeFile(firefox,'');
  const environment={LOCALAPPDATA:path.join(root,'local'),ProgramFiles:path.join(root,'programs')};
  assert.equal(await findBrowserExecutable('Chrome',environment),chrome);
  assert.equal(await findBrowserExecutable('Firefox',environment),firefox);
  assert.equal(await findBrowserExecutable('Brave',environment),null);
});
