const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {offerStoreSetup, STORE_URL, EXTENSION_ID} = require('../desktop/extension-store.cjs');

test('first interactive packaged launch offers the published Chrome extension once', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-store-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const calls = [];
  const options = {packaged:true,background:false,connected:false,directory,browsers:[{name:'Chrome',installed:true}],open:async browser=>calls.push(browser)};
  for (const override of [{packaged:false},{background:true},{connected:true},{browsers:[]}]) assert.equal(await offerStoreSetup({...options,...override}),false);
  assert.deepEqual(calls,[]);
  assert.equal(await offerStoreSetup(options),true);
  assert.equal(await offerStoreSetup(options),false);
  assert.deepEqual(calls,['Chrome']);
  assert.equal(STORE_URL,`https://chromewebstore.google.com/detail/${EXTENSION_ID}`);
});

test('failed store launch remains retryable and never records successful setup', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-store-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const options = {packaged:true,background:false,connected:false,directory,browsers:[{name:'Chrome',installed:true}],open:async()=>{throw new Error('launch failed');}};
  await assert.rejects(offerStoreSetup(options),/launch failed/);
  assert.deepEqual(await fs.readdir(directory),[]);
  assert.equal(await offerStoreSetup({...options,open:async()=>{}}),true);
});
