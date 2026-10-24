const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function harness(file,mode){
  const events=new Map(),observers=[],hosts=[],callbacks=new Set();
  let calls=0,id='test-extension',removed=0;
  const runtime={get id(){return id;},sendMessage(){calls++;if(mode==='throw')throw new Error('Extension context invalidated.');if(mode==='reject')return Promise.reject(new Error('Extension context invalidated.'));return Promise.resolve({ok:true});},onMessage:{addListener(fn){callbacks.add(fn);},removeListener(fn){callbacks.delete(fn);}}};
  const addEventListener=(name,fn,options={})=>{events.set(name,fn);options.signal?.addEventListener('abort',()=>events.delete(name));};
  class Observer{constructor(fn){this.fn=fn;observers.push(this);}observe(){}unobserve(){}disconnect(){this.disconnected=true;}}
  const video={currentSrc:'https://example.test/video.mp4',src:'',querySelectorAll(){return[];},addEventListener, isConnected:true,getBoundingClientRect(){return {top:50,bottom:400,left:0,right:600,width:600,height:350};}};
  const document={title:'Video',documentElement:{appendChild(host){host.parentNode=this;}},querySelectorAll(selector){return selector==='video'?[video]:[];},addEventListener,
    createElement(){const host={style:{},remove(){removed++;},attachShadow(){return {querySelector(selector){return selector==='.chooser'?host.chooser||null:{addEventListener(){}};}};}};hosts.push(host);return host;}};
  const context={chrome:{runtime},document,location:{href:'https://www.youtube.com/watch?v=wLdZWyLOJCI',origin:'https://www.youtube.com'},window:{},URL,AbortController,ResizeObserver:Observer,MutationObserver:Observer,addEventListener,removeEventListener(name){events.delete(name);},requestAnimationFrame(){return 1;},cancelAnimationFrame(){},setTimeout,clearTimeout,dispatchEvent(){},Event,innerHeight:800,innerWidth:1200};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context);
  return {context,events,observers,callbacks,hosts,video,get calls(){return calls;},get removed(){return removed;},invalidate(){id=undefined;}};
}
for(const mode of ['throw','reject']){
  test(`content script cleans up after ${mode} from invalidated messaging`,async()=>{
    const h=harness('content.js',mode);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.calls,1);assert.equal(h.removed,1);
    assert.ok(h.observers.every(observer=>observer.disconnected));
    assert.equal(h.callbacks.size,0);assert.equal(h.events.size,0);
    h.observers.forEach(observer=>observer.fn());
    assert.equal(h.calls,1);
  });
  test(`YouTube relay retires after ${mode} from invalidated messaging`,async()=>{
    const h=harness('youtube-relay.js',mode);
    const callback=[...h.callbacks][0];let reply;
    callback({action:'refreshPlayer'},{id:'test-extension'},value=>{reply=value;});
    await h.events.get('message')({source:h.context.window,origin:h.context.location.origin,data:{type:'awesome-player-response',data:{videoId:'wLdZWyLOJCI',formats:[]}}});
    assert.equal(h.calls,1);assert.equal(h.callbacks.size,0);assert.equal(h.events.size,0);assert.equal(reply.ok,false);
  });
}
test('missing runtime ID retires page scripts without sending again',()=>{
  const h=harness('content.js','success');h.invalidate();h.events.get('scroll')();
  assert.equal(h.calls,1);assert.equal(h.removed,1);assert.equal(h.callbacks.size,0);
});

test('page scrolling dismisses chooser and does not pin an offscreen video button',async()=>{
  const h=harness('content.js','success'),host=h.hosts[0];
  host.chooser={remove(){delete host.chooser;}};
  h.events.get('scroll')({composedPath:()=>[]});
  assert.equal(host.chooser,undefined);assert.equal(host.style.display,'none');
  h.video.getBoundingClientRect=()=>({top:-30,bottom:300,left:0,right:600,width:600,height:330});
  await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(host.style.display,'none');
  h.invalidate();h.events.get('resize')();
});
