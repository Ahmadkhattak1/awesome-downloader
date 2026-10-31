const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function harness(file,mode){
  const events=new Map(),observers=[],intersections=[],hosts=[],callbacks=new Set(),messages=[],dispatched=[];
  let calls=0,id='test-extension',removed=0,document;
  const runtime={get id(){return id;},sendMessage(message){calls++;messages.push(message);if(mode==='throw')throw new Error('Extension context invalidated.');if(mode==='reject')return Promise.reject(new Error('Extension context invalidated.'));if(message.action==='listForFrame')return Promise.resolve({ok:true,items:[{url:'https://example.test/video.mp4',quality:'720p',format:'MP4',audioState:'Audio'},{url:'https://example.test/video-low.mp4',quality:'480p',format:'MP4',audioState:'Audio'},{url:'https://example.test/video-private.mp4',quality:'Private',format:'MP4',audioState:'Audio',unsupported:true,reason:'Expired https://cdn.example.test/video?signature=secret'}]});return Promise.resolve({ok:true});},onMessage:{addListener(fn){callbacks.add(fn);},removeListener(fn){callbacks.delete(fn);}}};
  const addEventListener=(name,fn,options={})=>{events.set(name,fn);options.signal?.addEventListener('abort',()=>events.delete(name));};
  class Observer{constructor(fn){this.fn=fn;observers.push(this);}observe(){}unobserve(){}disconnect(){this.disconnected=true;}}
  class Intersection extends Observer{constructor(fn){super(fn);intersections.push(this);}emit(target,intersectionRect,isIntersecting=true){this.fn([{target,intersectionRect,isIntersecting}]);}}
  class Element{
    constructor(tag){this.tagName=tag.toUpperCase();this.style={};this.children=[];this.listeners={};this.attributes={};this.disabled=false;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    setAttribute(name,value){this.attributes[name]=String(value);}
    getAttribute(name){return this.attributes[name];}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);if(node.className==='chooser')this.chooser=node;}}
    remove(){if(this.parentNode?.children)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);if(this.parentNode?.chooser===this)delete this.parentNode.chooser;if(this.isHost)removed++;this.parentNode=null;}
    focus(){document.activeElement=this;}
    trigger(name,event={}){return this.listeners[name]?.({preventDefault(){},stopPropagation(){},...event});}
    getBoundingClientRect(){const top=Number.parseFloat(this.style.top)||0,left=Number.parseFloat(this.style.left)||0;return {top,left,right:left+180,bottom:top+27,width:180,height:27};}
    querySelector(selector){if(selector==='.row:not(:disabled)')return this.children.find(node=>node.className==='row'&&!node.disabled)||null;return null;}
    querySelectorAll(selector){return selector==='.row:not(:disabled)'?this.children.filter(node=>node.className==='row'&&!node.disabled):[];}
    attachShadow(){this.isHost=true;const shadow=new Element('shadow');shadow.download=new Element('button');shadow.dismiss=new Element('button');shadow.querySelector=selector=>selector==='.download'?shadow.download:selector==='.dismiss'?shadow.dismiss:selector==='.chooser'?shadow.chooser||null:null;this.shadow=shadow;return shadow;}
  }
  const video={currentSrc:'https://example.test/video.mp4',src:'',querySelectorAll(){return[];},addEventListener, isConnected:true,getBoundingClientRect(){return {top:50,bottom:400,left:0,right:600,width:600,height:350};}};
  document={title:'Video',activeElement:null,documentElement:{appendChild(host){host.parentNode=this;}},querySelectorAll(selector){return selector==='video'?[video]:[];},addEventListener,
    createElement(tag){const element=new Element(tag);if(tag==='div'&&!hosts.length)hosts.push(element);return element;}};
  const location={href:'https://www.youtube.com/watch?v=wLdZWyLOJCI',origin:'https://www.youtube.com',hostname:'www.youtube.com'};
  const context={chrome:{runtime},document,location,window:{},URL,AbortController,ResizeObserver:Observer,IntersectionObserver:Intersection,MutationObserver:Observer,addEventListener,removeEventListener(name){events.delete(name);},requestAnimationFrame(){return 1;},cancelAnimationFrame(){},setTimeout,clearTimeout,dispatchEvent(event){dispatched.push(event.type);},Event,Uint8Array,btoa:value=>Buffer.from(value,'binary').toString('base64'),innerHeight:800,innerWidth:1200,mediaChoices:items=>items,awesomeMenuResult:(response,handlers)=>response?.ok===false?handlers.rejected(response.error):handlers.accepted()};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context);
  return {context,events,observers,intersections,callbacks,hosts,video,messages,dispatched,get calls(){return calls;},get removed(){return removed;},invalidate(){id=undefined;}};
}
for(const mode of ['throw','reject']){
  test(`content script cleans up after ${mode} from invalidated messaging`,async()=>{
    const h=harness('content.js',mode);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.calls,1);assert.equal(h.removed,1);
    assert.ok(h.observers.every(observer=>observer.disconnected));
    assert.equal(h.callbacks.size,0);assert.equal(h.events.size,0);
    h.observers.forEach(observer=>observer.fn(h.intersections.includes(observer)?[]:undefined));
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
test('YouTube relay turns on page SABR relaying only when asked, and forwards the body as base64',async()=>{
  const h=harness('youtube-relay.js','success'),callback=[...h.callbacks][0];
  assert.deepEqual(h.dispatched,['awesome-request-player']);
  let reply;callback({action:'relaySabr'},{id:'test-extension'},value=>{reply=value;});
  assert.deepEqual(h.dispatched,['awesome-request-player','awesome-relay-sabr']);assert.equal(reply.ok,true);
  const url='https://r1.googlevideo.com/videoplayback?id=asset&sabr=1';
  await h.events.get('message')({source:h.context.window,origin:h.context.location.origin,data:{type:'awesome-sabr-request',url,body:Uint8Array.from([1,2,3])}});
  await h.events.get('message')({source:h.context.window,origin:h.context.location.origin,data:{type:'awesome-sabr-request',url,body:new Uint8Array(262145)}});
  assert.equal(JSON.stringify(h.messages),JSON.stringify([{action:'sabrRequest',url,requestBody:'AQID'}]));
});
test('missing runtime ID retires page scripts without sending again',()=>{
  const h=harness('content.js','success');h.invalidate();h.events.get('scroll')();
  assert.equal(h.calls,1);assert.equal(h.removed,1);assert.equal(h.callbacks.size,0);
});

test('page scrolling dismisses chooser and does not pin an offscreen video button',async()=>{
  const h=harness('content.js','success'),host=h.hosts[0];
  host.shadow.chooser={remove(){delete host.shadow.chooser;}};
  h.events.get('scroll')({composedPath:()=>[]});
  assert.equal(host.shadow.chooser,undefined);assert.equal(host.style.display,'none');
  h.video.getBoundingClientRect=()=>({top:-400,bottom:-50,left:0,right:600,width:600,height:350});
  await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(host.style.display,'none');
  h.invalidate();h.events.get('resize')();
});

test('video controls follow the visible clipped area instead of the raw video bounds',()=>{
  const h=harness('content.js','success'),host=h.hosts[0],observer=h.intersections[0];
  observer.emit(h.video,{top:0,bottom:120,left:20,right:620,width:600,height:120});
  assert.equal(host.style.display,'block');
  assert.equal(host.style.left,'432px');
  observer.emit(h.video,{top:0,bottom:40,left:20,right:620,width:600,height:40});
  assert.equal(host.style.display,'none');
});

test('SPA navigation resets dismissal and closes choices for the previous video',async()=>{
  const h=harness('content.js','success'),host=h.hosts[0],button=host.shadow.download;
  await button.trigger('click');
  assert.ok(host.shadow.chooser);
  host.shadow.dismiss.trigger('click');
  assert.equal(host.style.display,'none');
  h.context.location.href='https://www.youtube.com/watch?v=abcdefghijk';
  h.events.get('yt-navigate-finish')();
  assert.equal(host.shadow.chooser,undefined);
  assert.equal(host.style.display,'block');
});

test('format choices support arrow navigation and Escape restores button focus',async()=>{
  const h=harness('content.js','success'),host=h.hosts[0],button=host.shadow.download;
  await button.trigger('click');
  const chooser=host.shadow.chooser,rows=chooser.querySelectorAll('.row:not(:disabled)');
  assert.equal(rows.length,2);assert.equal(h.context.document.activeElement,rows[0]);
  assert.equal(chooser.children.find(node=>node.disabled).title,'');
  chooser.trigger('keydown',{key:'ArrowDown'});
  assert.equal(h.context.document.activeElement,rows[1]);
  h.events.get('keydown')({key:'Escape'});
  assert.equal(host.shadow.chooser,undefined);assert.equal(h.context.document.activeElement,button);
  assert.equal(button.getAttribute('aria-expanded'),'false');
});
