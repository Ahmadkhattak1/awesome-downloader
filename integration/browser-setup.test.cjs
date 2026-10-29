const test=require('node:test');
const assert=require('node:assert/strict');
const {openExtensions}=require('../desktop/browser-setup.cjs');

test('macOS opens the browser extensions page by application name',async()=>{
  const calls=[];
  const run=async(...args)=>{calls.push(args);return {stdout:''};};
  for(const browser of ['Chrome','Edge','Brave','Opera'])await openExtensions(browser,{platform:'darwin',run});
  assert.deepEqual(calls,[
    ['open',['-a','Google Chrome','chrome://extensions/']],
    ['open',['-a','Microsoft Edge','edge://extensions/']],
    ['open',['-a','Brave Browser','brave://extensions/']],
    ['open',['-a','Opera','opera://extensions/']]
  ]);
});
test('macOS reports a browser that is not installed',async()=>{
  const run=async()=>{throw Object.assign(new Error('Unable to find application named'),{code:1});};
  await assert.rejects(openExtensions('Brave',{platform:'darwin',run}),/Brave was not found\. Open brave:\/\/extensions\/ in your browser manually\./);
  await assert.rejects(openExtensions('Safari',{platform:'darwin',run}),/Choose Chrome, Edge, Brave, or Opera/);
});
