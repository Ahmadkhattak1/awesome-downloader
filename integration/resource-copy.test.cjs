const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { copyIfChanged } = require('../desktop/resource-copy.cjs');
test('cold start does not overwrite an identical running connector', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-copy-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const source=path.join(root,'source.exe'), target=path.join(root,'target.exe');
  await fs.writeFile(source,'connector-v1');
  assert.equal(await copyIfChanged(source,target),true);
  await fs.writeFile(target,'connector-v1');
  assert.equal(await copyIfChanged(source,target),false);
  await fs.writeFile(source,'connector-v2');
  assert.equal(await copyIfChanged(source,target),true);
  assert.equal(await copyIfChanged(root,path.join(root,'new')),true);
});
