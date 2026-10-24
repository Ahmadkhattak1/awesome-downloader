import test from 'node:test';
import assert from 'node:assert/strict';
import windows from '../desktop/progress-window.cjs';
test('opening a minimized transfer restores it before showing and focusing',()=>{
  const calls=[];
  const window={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
  windows.showProgress(window);assert.deepEqual(calls,['restore','show','focus']);
});
test('cancel closes progress, but completion keeps its completion actions visible',()=>{
  let closed=0;const window={isDestroyed:()=>false,close:()=>closed++};
  assert.equal(windows.closeCancelledProgress(window,{status:'complete'}),false);
  assert.equal(windows.closeCancelledProgress(window,{status:'downloading'}),false);
  assert.equal(windows.closeCancelledProgress(window,{status:'cancelled'}),true);
  assert.equal(closed,1);
});
