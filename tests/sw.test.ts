import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';

function routeClient(creationThread:string,currentThread:string,options:any={}){
 return {id:options.id??creationThread,frameType:'top-level',url:'https://codex.example/sessions/'+creationThread,
 focus:options.focus??(async()=>{}),
 postMessage:(message:any,ports:any[])=>{
  if(message.type==='codex-notification-route')ports[0].postMessage({type:'codex-notification-route',threadId:currentThread});
  else if(message.target?.threadId===currentThread){options.delivered?.(message.target);ports[0].postMessage({type:'codex-notification-accepted',target:message.target});}
 }};
}

function notificationClock(){
 let now=0,nextId=0;const timers=new Map<number,{at:number,callback:()=>void}>();
 const flush=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));};
 return {performance:{now:()=>now},jump:(ms:number)=>{now+=ms;},setTimeout:(callback:()=>void,delay:number)=>{const id=++nextId;timers.set(id,{at:now+delay,callback});return id;},clearTimeout:(id:number)=>{timers.delete(id);},
  advance:async(ms:number)=>{const end=now+ms;await flush();for(;;){const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].callback();await flush();}now=end;await flush();}};
}

for(const scenario of [
 {name:'a 1.5-second route reply reuses the existing tab',routeDelay:1500,acceptDelay:1000,matchDelay:0,current:'target',focusAt:2500,openAt:null},
 {name:'target acceptance receives only the remaining click budget',routeDelay:1500,acceptDelay:3501,matchDelay:0,current:'target',focusAt:null,openAt:5000},
 {name:'client enumeration consumes the click budget',routeDelay:0,acceptDelay:3500,matchDelay:2000,current:'target',focusAt:null,openAt:5000},
 {name:'a silent page falls back at the click deadline',routeDelay:null,acceptDelay:0,matchDelay:0,current:'target',focusAt:null,openAt:5000},
 {name:'a route reply after the deadline cannot focus a tab',routeDelay:5001,acceptDelay:0,matchDelay:0,current:'target',focusAt:null,openAt:5000},
 {name:'an explicit route mismatch falls back immediately',routeDelay:0,acceptDelay:0,matchDelay:0,current:'other',focusAt:null,openAt:0},
])test(scenario.name,async()=>{
 const clock=notificationClock(),listeners:any={},focused:number[]=[],opened:{at:number,url:string}[]=[];let pending:Promise<any>;
 const client={...routeClient('creation',scenario.current),focus:async()=>{focused.push(clock.performance.now());},postMessage:(message:any,ports:any[])=>{
  if(message.type==='codex-notification-route'){if(scenario.routeDelay!==null)clock.setTimeout(()=>ports[0].postMessage({type:'codex-notification-route',threadId:scenario.current}),scenario.routeDelay);}
  else clock.setTimeout(()=>ports[0].postMessage({type:'codex-notification-accepted',target:message.target}),scenario.acceptDelay);
 }};
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:()=>new Promise(resolve=>clock.setTimeout(()=>resolve([client]),scenario.matchDelay)),openWindow:async(url:string)=>{opened.push({at:clock.performance.now(),url});}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,...clock});
 listeners.notificationclick({notification:{data:{threadId:'target',itemId:'item:1'},close:()=>{}},waitUntil:(p:any)=>pending=p});
 await clock.advance(4999);
 const beforeDeadline={focused:[...focused],opened:opened.map(item=>item.at)};
 await clock.advance(2);await clock.advance(5000);await pending!;
 assert.deepEqual(beforeDeadline.focused,scenario.focusAt===null?[]:[scenario.focusAt]);
 assert.deepEqual(beforeDeadline.opened,scenario.openAt===0?[0]:[],'no premature fallback');
 assert.deepEqual(opened.map(item=>item.at),scenario.openAt===null?[]:[scenario.openAt]);
 if(opened.length){const url=new URL(opened[0].url);assert.equal(url.pathname,'/sessions/target');assert.equal(url.searchParams.get('itemId'),'item:1');}
 assert.deepEqual(focused,scenario.focusAt===null?[]:[scenario.focusAt]);
});

test('activation queue time does not grant a newer click a fresh acceptance budget',async()=>{
 const clock=notificationClock(),listeners:any={},focused:string[]=[],opened:{at:number,url:string}[]=[],delivered:string[]=[];let first:Promise<any>,second:Promise<any>,release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),clients=[routeClient('A','A',{focus:async()=>{await gate;focused.push('A');}}),routeClient('B','B',{focus:async()=>focused.push('B'),delivered:()=>delivered.push('B')})];
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>clients,openWindow:async(url:string)=>{opened.push({at:clock.performance.now(),url});}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,...clock});
 const click=(threadId:string,waitUntil:any)=>listeners.notificationclick({notification:{data:{threadId},close:()=>{}},waitUntil});
 click('A',(p:any)=>first=p);await clock.advance(0);click('B',(p:any)=>second=p);await clock.advance(5001);release();await clock.advance(0);await Promise.all([first!,second!]);
 assert.deepEqual(focused,['A']);assert.deepEqual(delivered,[]);assert.equal(opened.length,1);assert.equal(opened[0].at,5001);assert.equal(new URL(opened[0].url).pathname,'/sessions/B');
});

for(const phase of ['route','target'])test(`a ${phase} ready signal after the deadline cannot resend while its timeout is queued`,async()=>{
 const clock=notificationClock(),listeners:any={},messages:string[]=[],opened:string[]=[],focused:string[]=[];let pending:Promise<any>;
 const client={...routeClient('creation','target'),focus:async()=>{focused.push('target');},postMessage:(message:any,ports:any[])=>{messages.push(message.type);if(phase==='target'&&message.type==='codex-notification-route')ports[0].postMessage({type:'codex-notification-route',threadId:'target'});}};
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async(url:string)=>{opened.push(url);}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,MessageChannel,...clock});
 listeners.notificationclick({notification:{data:{threadId:'target'},close:()=>{}},waitUntil:(p:any)=>pending=p});await clock.advance(0);
 clock.jump(5000);listeners.message({data:{type:'codex-notification-ready'},source:{id:client.id,url:client.url}});await clock.advance(0);await pending!;
 assert.deepEqual(messages,phase==='route'?['codex-notification-route']:['codex-notification-route','codex-notification-target']);assert.deepEqual(focused,[]);assert.equal(opened.length,1);
});

for(const [creation,current] of [['target','other'],['other','target']])test(`notification uses current route ${current} instead of creation URL ${creation}`,async()=>{
 const listeners:any={},focused:string[]=[],opened:string[]=[];let pending:Promise<any>|undefined;
 const client=routeClient(creation,current,{focus:async()=>focused.push(current)});
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout:(callback:any)=>setTimeout(callback,50),clearTimeout});
 listeners.notificationclick({notification:{data:{threadId:'target',turnId:'turn:1'},close:()=>{}},waitUntil:(p:any)=>pending=p});await pending;
 assert.deepEqual(focused,current==='target'?['target']:[]);assert.equal(opened.length,current==='target'?0:1);
});

test('a newer cross-session click retains final focus after an older focus resolves late',async()=>{
 const listeners:any={},focused:string[]=[];let first:Promise<any>,second:Promise<any>,release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),focusStarted=new Promise<void>(resolve=>started=resolve);
 const clients=[routeClient('A','A',{focus:async()=>{started();await gate;focused.push('A');}}),routeClient('B','B',{focus:async()=>focused.push('B')})];
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>clients,openWindow:async()=>{throw Error('matched pages must not duplicate');}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout,clearTimeout});
 const click=(threadId:string,waitUntil:any)=>listeners.notificationclick({notification:{data:{threadId},close:()=>{}},waitUntil});
 click('A',(p:any)=>first=p);await focusStarted;click('B',(p:any)=>second=p);await new Promise(resolve=>setTimeout(resolve,20));release();await Promise.all([first!,second!]);
 assert.equal(focused.at(-1),'B');
});

test('route probes run in parallel and ignore foreign origins and non-top-level frames',async()=>{
 const listeners:any={},probed:string[]=[],delivered:string[]=[],focused:string[]=[],opened:string[]=[];let pending:Promise<any>;
 const blocked=()=>{probed.push('untrusted');throw Error('untrusted client must never be probed');};
 const silent={...routeClient('silent','silent'),postMessage:()=>probed.push('silent')};
 const ready=routeClient('creation','target',{delivered:()=>delivered.push('target'),focus:async()=>focused.push('target')}),post=ready.postMessage;ready.postMessage=(...args:any[])=>{probed.push(args[0].type);post(args[0],args[1]);};
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[silent,{...routeClient('target','target'),frameType:'nested',postMessage:blocked},{...routeClient('target','target'),url:'https://foreign.example/',postMessage:blocked},ready],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout,clearTimeout});
 listeners.notificationclick({notification:{data:{threadId:'target'},close:()=>{}},waitUntil:(p:any)=>pending=p});await pending!;
 assert.deepEqual(probed,['silent','codex-notification-route','codex-notification-target']);assert.deepEqual(delivered,['target']);assert.deepEqual(focused,['target']);assert.deepEqual(opened,[]);
});

test('a page that changes route after probing receives no focus and falls back safely',async()=>{
 const clock=notificationClock(),listeners:any={},opened:string[]=[],focused:string[]=[],delivered:string[]=[];let pending:Promise<any>;
 const client={...routeClient('creation','target'),focus:async()=>focused.push('wrong'),postMessage:(message:any,ports:any[])=>{delivered.push(message.type);if(message.type==='codex-notification-route')ports[0].postMessage({type:'codex-notification-route',threadId:'target'});}};
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,MessageChannel,...clock});
 listeners.notificationclick({notification:{data:{threadId:'target',itemId:'item:1'},close:()=>{}},waitUntil:(p:any)=>pending=p});await clock.advance(5000);await pending!;
 assert.deepEqual(delivered,['codex-notification-route','codex-notification-target']);assert.deepEqual(focused,[]);assert.equal(new URL(opened[0]).pathname,'/sessions/target');assert.equal(new URL(opened[0]).searchParams.get('itemId'),'item:1');
});

test('a loading page ready signal resends its pending route probe despite a stale creation URL',async()=>{
 const listeners:any={},focused:string[]=[],opened:string[]=[];let pending:Promise<any>,probes=0;
 const client=routeClient('creation','target',{id:'loading',focus:async()=>focused.push('target')}),post=client.postMessage;
 client.postMessage=(message:any,ports:any[])=>{if(message.type==='codex-notification-route'&&++probes===1){setImmediate(()=>listeners.message({data:{type:'codex-notification-ready'},source:{id:client.id,url:client.url}}));return;}post(message,ports);};
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout,clearTimeout});
 listeners.notificationclick({notification:{data:{threadId:'target'},close:()=>{}},waitUntil:(p:any)=>pending=p});await pending!;
 assert.equal(probes,2);assert.deepEqual(focused,['target']);assert.deepEqual(opened,[]);
});

test('latest click cancels route probes and closes every channel and timer',async()=>{
 const listeners:any={},timers=new Set<any>();let first:Promise<any>,second:Promise<any>,created=0,closed=0,calls=0;
 class TrackedChannel extends MessageChannel{constructor(){super();created+=2;for(const port of [this.port1,this.port2]){const close=port.close.bind(port);port.close=()=>{closed++;close();};}}}
 const silent={...routeClient('A','A'),postMessage:()=>{}},ready=routeClient('B','B');
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>++calls===1?[silent]:[ready],openWindow:async()=>{throw Error('cancelled click must not open');}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel:TrackedChannel,setTimeout:(callback:any,ms:number)=>{const timer=setTimeout(callback,ms);timers.add(timer);return timer;},clearTimeout:(timer:any)=>{timers.delete(timer);clearTimeout(timer);}});
 const click=(threadId:string,waitUntil:any)=>listeners.notificationclick({notification:{data:{threadId},close:()=>{}},waitUntil});
 click('A',(p:any)=>first=p);await new Promise(resolve=>setImmediate(resolve));click('B',(p:any)=>second=p);await Promise.all([first!,second!]);
 assert.equal(timers.size,0);assert.equal(closed,created);
});

test('a newer click activates last after an older openWindow resolves late',async()=>{
 const listeners:any={},activation:string[]=[];let first:Promise<any>,second:Promise<any>,release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),opening=new Promise<void>(resolve=>started=resolve),client=routeClient('B','B',{focus:async()=>activation.push('B')});
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async()=>{started();await gate;activation.push('A');}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout,clearTimeout});
 const click=(threadId:string,waitUntil:any)=>listeners.notificationclick({notification:{data:{threadId},close:()=>{}},waitUntil});
 click('A',(p:any)=>first=p);await opening;click('B',(p:any)=>second=p);await new Promise(resolve=>setTimeout(resolve,20));release();await Promise.all([first!,second!]);
 assert.deepEqual(activation,['A','B']);
});
test('push renders generic notification and clicks only a validated local thread URL',async()=>{
 const listeners:any={},notifications:any[]=[],opened:string[]=[];let pending:Promise<any>|undefined;
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,registration:{showNotification:async(title:string,options:any)=>notifications.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance});
 listeners.push({data:{json:()=>({threadId:'../../evil',title:'bad'})},waitUntil:(p:any)=>pending=p});assert.equal(notifications.length,0);
 listeners.push({data:{json:()=>({threadId:'thread-1',title:'private prompt',url:'https://evil.example'})},waitUntil:(p:any)=>pending=p});await pending;
 assert.equal(notifications[0].title,'Codex 通知');assert.equal(notifications[0].body,'点击打开会话');
 listeners.notificationclick({notification:{data:notifications[0].data,close:()=>{}},waitUntil:(p:any)=>pending=p});await pending;
 assert.deepEqual(opened,['https://codex.example/sessions/thread-1']);
});

test('notification click focuses one existing thread tab and delivers its explicit target without navigating other work',async()=>{
 const listeners:any={},notifications:any[]=[],opened:string[]=[],actions:any[]=[];let pending:Promise<any>|undefined;
 const target={threadId:'thread-1',turnId:'turn:1',itemId:'item_1',kind:'complete'};
 const clients=[{...routeClient('other','other'),navigate:()=>{throw Error('must not leave another thread');}},
 routeClient('thread-1?view=history','thread-1',{focus:async()=>actions.push('focus'),delivered:(value:any)=>actions.push({type:'codex-notification-target',target:value})}),
 routeClient('thread-1','thread-1',{focus:async()=>actions.push('duplicate')})];
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,registration:{showNotification:async(title:string,options:any)=>notifications.push({title,...options})},clients:{matchAll:async()=>clients,openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout,clearTimeout});
 listeners.push({data:{json:()=>({...target,title:'任务完成',text:'PRIVATE',url:'https://evil.example'})},waitUntil:(p:any)=>pending=p});await pending;
 assert.equal(notifications[0].requireInteraction,true);assert.equal(notifications[0].body,'点击查看本轮答复');
 assert.deepEqual(JSON.parse(JSON.stringify(notifications[0].data)),target);
 listeners.notificationclick({notification:{data:notifications[0].data,close:()=>actions.push('close')},waitUntil:(p:any)=>pending=p});await pending;
 assert.deepEqual(JSON.parse(JSON.stringify(actions)),['close',{type:'codex-notification-target',target},'focus']);assert.deepEqual(opened,[]);
});

test('an unready same-thread page uses the remaining click budget before opening a safe fallback window',async()=>{
 const clock=notificationClock(),listeners:any={},opened:string[]=[],delivered:string[]=[];let pending:Promise<any>|undefined;
 const client={...routeClient('thread-1','thread-1'),postMessage:(message:any,ports:any[])=>{delivered.push(message.type);if(message.type==='codex-notification-route')ports[0].postMessage({type:'codex-notification-route',threadId:'thread-1'});}};
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,MessageChannel,...clock});
 listeners.notificationclick({notification:{data:{threadId:'thread-1',turnId:'turn:1'},close:()=>{}},waitUntil:(p:any)=>pending=p});await clock.advance(4999);
 assert.deepEqual(delivered,['codex-notification-route','codex-notification-target']);assert.deepEqual(opened,[]);
 await clock.advance(1);await pending;
 assert.equal(new URL(opened[0]).searchParams.get('turnId'),'turn:1');assert.equal(opened.length,1);
});

test('new notification window encodes only validated local target fields and legacy notifications still work',async()=>{
 const listeners:any={},opened:string[]=[];let pending:Promise<any>|undefined;
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[{url:'https://evil.example/sessions/thread-1',focus:()=>{throw Error('foreign');}}],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance});
 const click=async(data:any)=>{listeners.notificationclick({notification:{data,close:()=>{}},waitUntil:(p:any)=>pending=p});await pending;};
 await click({threadId:'thread-1',turnId:'turn:1',requestId:'request:1',kind:'approval',url:'https://evil.example'});
 const url=new URL(opened[0]);assert.equal(url.origin,self.location.origin);assert.equal(url.pathname,'/sessions/thread-1');assert.equal(url.searchParams.get('turnId'),'turn:1');assert.equal(url.searchParams.get('requestId'),'request:1');
 await click({threadId:'thread-1',itemId:'../../bad'});assert.equal(opened.length,1,'invalid target must not partially navigate');
 await click({threadId:'thread-legacy'});assert.equal(opened[1],'https://codex.example/sessions/thread-legacy');
});

test('a delayed older click cannot overwrite the newer notification target',async()=>{
 const listeners:any={},delivered:string[]=[];let first:Promise<any>,second:Promise<any>,release!:()=>void,started!:()=>void,focusCalls=0;
 const gate=new Promise<void>(resolve=>release=resolve),focusStarted=new Promise<void>(resolve=>started=resolve),client=routeClient('thread-1','thread-1',{id:'client',focus:async()=>{if(++focusCalls===1){started();await gate;}},delivered:(target:any)=>delivered.push(target.itemId)});
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,clients:{matchAll:async()=>[client],openWindow:async()=>{throw Error('ready same-thread client must not duplicate');}}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,performance,MessageChannel,setTimeout,clearTimeout});
 listeners.notificationclick({notification:{data:{threadId:'thread-1',turnId:'turn:1',itemId:'old'},close:()=>{}},waitUntil:(p:any)=>first=p});await focusStarted;
 listeners.notificationclick({notification:{data:{threadId:'thread-1',turnId:'turn:1',itemId:'new'},close:()=>{}},waitUntil:(p:any)=>second=p});release();await Promise.all([first!,second!]);
 assert.deepEqual(delivered,['old','new']);
});
