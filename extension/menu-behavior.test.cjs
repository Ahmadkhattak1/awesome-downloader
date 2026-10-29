const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function behavior() {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'menu-behavior.js'), 'utf8'), context);
  return context.globalThis.awesomeMenuResult;
}

test('successful desktop handoff closes the quality menu', () => {
  let closed = 0, error = '';
  const accepted = behavior()({ ok: true }, { accepted: () => { closed += 1; }, rejected: value => { error = value; } });
  assert.equal(accepted, true);
  assert.equal(closed, 1);
  assert.equal(error, '');
});

test('failed desktop handoff keeps the quality menu open and reports the error', () => {
  let closed = 0, error = '';
  const accepted = behavior()({ ok: false, error: 'Connector unavailable.' }, { accepted: () => { closed += 1; }, rejected: value => { error = value; } });
  assert.equal(accepted, false);
  assert.equal(closed, 0);
  assert.equal(error, 'Connector unavailable.');
});
