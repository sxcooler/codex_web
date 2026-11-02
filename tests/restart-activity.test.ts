import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Runtime} from '../src/codex/runtime.ts';

const cwd=fileURLToPath(new URL('..',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url));
function setup(t:any,mode='normal'){
 const events:any[]=[];
 const runtime=new Runtime({executable:process.execPath,args:[fixture,mode],cwd,idleMs:60_000,diagnostic:event=>events.push(event)});
 t.after(()=>runtime.close().catch(()=>{}));return {runtime,events};
}
const native=(runtime:Runtime,id:string,type:string,extra:any={})=>(runtime as any).call('fixture/native-thread',{threadId:id,status:{type},thread:extra});
const running=(id:string)=>({id,status:'inProgress',items:[]});

test('restart inspection of a stopped runtime never starts a child',async t=>{
 const {runtime}=setup(t),report=await runtime.inspectRestart();
 assert.equal(report.complete,true);assert.equal(report.canRestart,true);assert.equal(report.canForce,false);
 assert.deepEqual(report.sessions,[]);assert.equal((runtime as any).server,undefined);
});

test('restart inspection collects all native pages including hidden and local pending work',async t=>{
 const {runtime}=setup(t);await runtime.models();
 await native(runtime,'first','active',{name:'First task',cwd,turns:[running('turn-first')]});
 await native(runtime,'child','active',{name:'Child task',parentThreadId:'first',turns:[running('turn-child')]});
 await native(runtime,'temporary','active',{ephemeral:true,turns:[running('turn-temp')]});
 const state=(runtime as any).state('first');state.loaded=true;state.activeTurnId='turn-first';
 state.pending.set('ask',{method:'item/tool/requestUserInput',turnId:'turn-first'});
 const report=await runtime.inspectRestart();
 assert.equal(report.complete,true);assert.equal(report.canRestart,false);assert.equal(report.canForce,true);
 assert.deepEqual(report.sessions.map(s=>s.threadId).sort(),['child','first','temporary']);
 assert.equal(report.sessions.find(s=>s.threadId==='first')?.kind,'input');
 assert.equal(report.sessions.find(s=>s.threadId==='first')?.name,'First task');
 assert.equal(report.sessions.find(s=>s.threadId==='child')?.category,'subagent');
 assert.equal(report.sessions.find(s=>s.threadId==='temporary')?.category,'temporary');
 assert.equal(report.sessions.find(s=>s.threadId==='temporary')?.turnId,'turn-temp');
 assert.ok(report.version);
});

test('confirmed terminal systemError permits restart while keeping the native history intact',async t=>{
 const {runtime}=setup(t);await runtime.models();
 await native(runtime,'finished','systemError',{turns:[{id:'done',status:'failed',items:[],error:{message:'original error'}}]});
 const state=(runtime as any).state('finished');state.loaded=true;state.nativeStatus={type:'systemError'};
 const report=await runtime.inspectRestart();
 assert.equal(report.complete,true);assert.equal(report.canRestart,true);assert.deepEqual(report.sessions,[]);
 await runtime.assertNativeIdle();
 const original=await (runtime as any).call('thread/read',{threadId:'finished',includeTurns:true});
 assert.equal(original.thread.status.type,'systemError');assert.equal(original.thread.turns[0].error.message,'original error');
 assert.equal((await (runtime as any).call('fixture/stats',{})).unsubscribes,0);
});

for(const existing of [false,true])test(`terminal systemError subagent permits restart with notification-only state ${existing}`,async t=>{
 const {runtime}=setup(t);await runtime.models();
 const thread={id:'finished-child',parentThreadId:'parent',turns:[{id:'done',status:'failed',items:[],error:{message:'original error'}}]};
 await native(runtime,thread.id,'systemError',thread);
 if(existing){
  (runtime as any).onNotification({method:'thread/started',params:{thread}});
  (runtime as any).onNotification({method:'thread/status/changed',params:{threadId:thread.id,status:{type:'systemError'}}});
 }
 const state=(runtime as any).states.get(thread.id);assert.equal(state?.loaded,existing?false:undefined);
 const server=(runtime as any).server,request=server.request.bind(server),methods:string[]=[];
 t.mock.method(server,'request',(method:string,...args:any[])=>{methods.push(method);return request(method,...args);});
 const report=await runtime.inspectRestart();
 assert.equal(report.complete,true);assert.equal(report.canRestart,true);assert.deepEqual(report.sessions,[]);
 await runtime.assertNativeIdle();
 assert.strictEqual((runtime as any).states.get(thread.id),state);assert.equal(state?.loaded,existing?false:undefined);
 const original=await server.request('thread/read',{threadId:thread.id,includeTurns:true});
 assert.equal(original.thread.status.type,'systemError');assert.equal(original.thread.turns[0].error.message,'original error');
 assert.ok(methods.every(method=>['thread/loaded/list','thread/read','thread/turns/list'].includes(method)),'inspection must not resume, unload or interrupt native work');
});

for(const condition of ['ordinary-unowned','empty-history','native-active','local-active','pending','external-writer','activity-change','state-replaced','new-state'])test(`terminal subagent restart exception stays closed for ${condition}`,async t=>{
 const {runtime}=setup(t);await runtime.models();
 await native(runtime,'uncertain-child','systemError',{...(condition==='ordinary-unowned'?{}:{parentThreadId:'parent'}),turns:condition==='empty-history'?[]:[{id:'done',status:condition==='native-active'?'inProgress':'completed',items:[]}]});
 const state=condition==='new-state'?undefined:(runtime as any).state('uncertain-child');
 if(state){
  state.nativeStatus={type:'systemError'};
  if(condition==='local-active')state.activeTurnId='new-turn';
  if(condition==='pending')state.pending.set('ask',{method:'item/tool/requestUserInput',turnId:'done'});
  if(condition==='external-writer')state.externalWriter=true;
 }
 const server=(runtime as any).server,request=server.request.bind(server);
 t.mock.method(server,'request',async(method:string,...args:any[])=>{
  const result=await request(method,...args);
  if(method==='thread/turns/list'){
   if(condition==='activity-change')state.activityRevision++;
   if(condition==='state-replaced')(runtime as any).states.delete('uncertain-child');
   if(condition==='state-replaced'||condition==='new-state')(runtime as any).state('uncertain-child');
  }
  return result;
 });
 const report=await runtime.inspectRestart();
 assert.equal(report.canRestart,false);assert.equal(report.canForce,false);assert.equal(report.complete,false);
 assert.ok(report.issues.some(issue=>issue.threadId==='uncertain-child'));
});

for(const condition of ['empty-history','external-writer'])test(`systemError inspection stays closed for ${condition}`,async t=>{
 const {runtime}=setup(t);await runtime.models();
 await native(runtime,'uncertain','systemError',{turns:condition==='empty-history'?[]:[{id:'done',status:'failed',items:[]}]});
 const state=(runtime as any).state('uncertain');state.loaded=true;state.externalWriter=condition==='external-writer';
 const report=await runtime.inspectRestart();
 assert.equal(report.canRestart,false);assert.equal(report.canForce,false);assert.equal(report.complete,false);
 assert.ok(report.issues.some(issue=>issue.threadId==='uncertain'));
});

test('a failed thread read preserves its cause and does not hide another active session',async t=>{
 const {runtime,events}=setup(t);await runtime.models();
 await native(runtime,'bad','idle');await native(runtime,'good','active',{turns:[running('good-turn')]});
 const server=(runtime as any).server,request=server.request.bind(server);
 t.mock.method(server,'request',(method:string,params:any,...args:any[])=>{
  if(method==='thread/read'&&params.threadId==='bad')throw Object.assign(Error('fixture status read failed'),{code:123});
  return request(method,params,...args);
 });
 const report=await runtime.inspectRestart();
 assert.equal(report.complete,false);assert.equal(report.canRestart,false);assert.equal(report.canForce,false);
 assert.ok(report.sessions.some(s=>s.threadId==='good'));
 assert.ok(report.issues.some(issue=>issue.threadId==='bad'&&issue.stage==='thread/read'&&issue.message==='fixture status read failed'));
 assert.ok(events.some(event=>event.event==='restart_inspection'&&event.threadId==='bad'&&event.stage==='thread/read'));
});

test('invalid native pagination is incomplete with a specific reason',async t=>{
 const {runtime}=setup(t,'loaded-bad-cursor');await runtime.models();await native(runtime,'first','idle');
 const report=await runtime.inspectRestart();
 assert.equal(report.complete,false);assert.equal(report.canForce,false);
 assert.ok(report.issues.some(issue=>issue.stage==='thread/loaded/list'&&/cursor/i.test(issue.message)));
});

test('ordinary progress and names do not change restart activity versions',async t=>{
 const {runtime}=setup(t);await runtime.models();
 await native(runtime,'active','active',{name:'Before',turns:[running('same-turn')]});
 const first=await runtime.inspectRestart();
 await native(runtime,'active','active',{name:'After',turns:[{...running('same-turn'),items:[{id:'progress',type:'agentMessage',text:'more output'}]}]});
 assert.equal((await runtime.inspectRestart()).version,first.version);
 await native(runtime,'active','active',{turns:[running('new-turn')]});
 assert.notEqual((await runtime.inspectRestart()).version,first.version);
});

test('a reply from a replaced runtime cannot reconcile the current state as idle',async t=>{
 const {runtime}=setup(t);await runtime.models();await native(runtime,'changing','idle');
 const state=(runtime as any).state('changing');state.nativeStatus={type:'active'};
 const server=(runtime as any).server,request=server.request.bind(server);
 t.mock.method(server,'request',async(method:string,...args:any[])=>{const result=await request(method,...args);if(method==='thread/read')(runtime as any).epoch='replaced';return result;});
 assert.equal((await runtime.inspectRestart()).complete,false);
 assert.equal(state.nativeStatus.type,'active');
});

test('force restart requires a checked version and never silently expands its activity scope',async t=>{
 const {runtime}=setup(t);await runtime.models();await native(runtime,'task','active',{turns:[running('first-turn')]});
 await assert.rejects(runtime.reloadModels({mode:'force'}),{code:'RUNTIME_INVALID_INPUT'});
 const report=await runtime.inspectRestart();
 await native(runtime,'task','active',{turns:[running('second-turn')]});
 await assert.rejects(runtime.reloadModels({mode:'force',version:report.version}),(error:any)=>error.code==='RUNTIME_RESTART_CHANGED'&&error.inspection?.sessions[0].turnId==='second-turn');
 assert.equal((runtime as any).server.child.exitCode,null);
});

test('force restart interrupts the confirmed task and replaces only its owned child',async t=>{
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 t.after(()=>{if(unrelated.exitCode===null&&unrelated.signalCode===null)unrelated.kill();});
 const {runtime}=setup(t);await runtime.models();await native(runtime,'task','active',{turns:[running('running-turn')]});
 const before=(runtime as any).server,request=before.request.bind(before),methods:string[]=[];
 t.mock.method(before,'request',(method:string,...args:any[])=>{methods.push(method);return request(method,...args);});
 const report=await runtime.inspectRestart();
 const result=await runtime.reloadModels({mode:'force',version:report.version});
 assert.ok(result.data.length);assert.notStrictEqual((runtime as any).server,before);
 assert.notEqual(before.child.exitCode,null);assert.ok(methods.includes('turn/interrupt'));
 assert.equal((await (runtime as any).call('fixture/stats',{})).turnStarts,0,'new child does not replay any task');
 assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
});

test('force restart remains bounded when the native interrupt receives no reply',async t=>{
 const {runtime}=setup(t,'ignore-restart-interrupt');await runtime.models();await native(runtime,'task','active',{turns:[running('turn')]});
 const before=(runtime as any).server,report=await runtime.inspectRestart();
 await runtime.reloadModels({mode:'force',version:report.version});
 assert.notStrictEqual((runtime as any).server,before);assert.notEqual(before.child.exitCode,null);
});

test('normal confirmation reports activity changes instead of becoming a forced restart',async t=>{
 const {runtime}=setup(t);await runtime.models();const before=(runtime as any).server,report=await runtime.inspectRestart();
 await native(runtime,'new-task','active',{turns:[running('new-turn')]});
 await assert.rejects(runtime.reloadModels({mode:'normal',version:report.version}),{code:'RUNTIME_RESTART_CHANGED'});
 assert.strictEqual((runtime as any).server,before);
});

test('delayed force authorization permits completed work but refuses a newly active turn',async t=>{
 const {runtime}=setup(t);await runtime.models();await native(runtime,'task','active',{turns:[running('approved-turn')]});
 const report=await runtime.inspectRestart(),scope=await runtime.authorizeRestart({mode:'force',version:report.version});
 assert.ok(scope);
 await native(runtime,'task','active',{turns:[running('unapproved-turn')]});
 await assert.rejects(runtime.prepareRestart(scope),{code:'RUNTIME_RESTART_CHANGED'});
 await native(runtime,'task','idle',{turns:[{id:'approved-turn',status:'completed',items:[]}]});
 const before=(runtime as any).server;await runtime.prepareRestart(scope);
 assert.notEqual(before.child.exitCode,null);
 await assert.rejects(runtime.models(),{code:'RUNTIME_UPDATING'});
});

test('a force authorization cannot stop a replacement native instance',async t=>{
 const {runtime}=setup(t);await runtime.models();await native(runtime,'task','active',{turns:[running('approved-turn')]});
 const scope=await runtime.authorizeRestart({mode:'force',version:(await runtime.inspectRestart()).version});
 (runtime as any).epoch='new-instance';
 await assert.rejects(runtime.prepareRestart(scope),{code:'RUNTIME_RESTART_CHANGED'});
 assert.equal((runtime as any).server.child.exitCode,null);
});

test('forced exit settles local activity and interactions even when interrupt is ignored',async t=>{
 const {runtime}=setup(t,'ignore-restart-interrupt');await runtime.models();await native(runtime,'task','active',{turns:[running('turn')]});
 const state=(runtime as any).state('task');state.loaded=true;state.activeTurnId='turn';state.recoverOnIdle=true;
 const waiter=(runtime as any).waiter(),completion=(runtime as any).completion();state.waiter=waiter;state.completion=completion;
 (runtime as any).onRequest({id:987,method:'item/tool/requestUserInput',params:{threadId:'task',turnId:'turn',questions:[]}});
 const changes:any[]=[];runtime.on('change',event=>changes.push(event));
 const report=await runtime.inspectRestart();await runtime.reloadModels({mode:'force',version:report.version});
 assert.equal(state.activeTurnId,null);assert.equal(state.pending.size,0);assert.equal((runtime as any).nativeRequests.size,0);
 assert.equal(state.recoverOnIdle,false);assert.match(state.error,/unknown result/i);
 assert.equal(await waiter.promise,'failed');await completion.promise;
 assert.ok(changes.some(change=>change.threadId==='task'&&change.patch.state?.activeTurnId===null&&change.patch.state?.pending.length===0));
 assert.equal((await runtime.inspectRestart()).canRestart,true);await runtime.assertNativeIdle();
 assert.equal((await (runtime as any).call('fixture/stats',{})).turnStarts,0);
});

for(const existing of [false,true])test(`new activity while reading an idle header stays unverified with existing state ${existing}`,async t=>{
 const {runtime}=setup(t);await runtime.models();await native(runtime,'task','idle');
 if(existing)(runtime as any).state('task');
 const server=(runtime as any).server,request=server.request.bind(server);
 t.mock.method(server,'request',async(method:string,...args:any[])=>{
  const result=await request(method,...args);
  if(method==='thread/read')(runtime as any).onNotification({method:'thread/status/changed',params:{threadId:'task',status:{type:'active',activeFlags:[]}}});
  return result;
 });
 const report=await runtime.inspectRestart();
 assert.equal(report.canRestart,false);assert.equal(report.canForce,false);assert.equal(report.complete,false);
 assert.equal(report.sessions[0]?.threadId,'task');assert.equal(report.sessions[0]?.kind,'unknown');
 assert.ok(report.issues.some(issue=>issue.threadId==='task'));
});

test('unconfirmed forced close retains ownership and prevents a replacement instance',async t=>{
 const {runtime}=setup(t);await runtime.models();await native(runtime,'task','active',{turns:[running('turn')]});
 const server=(runtime as any).server,scope=await runtime.authorizeRestart({mode:'force',version:(await runtime.inspectRestart()).version});
 const close=t.mock.method(server,'close',async()=>{throw Error('fixture exit unconfirmed');});
 try{
  await assert.rejects(runtime.prepareRestart(scope),/fixture exit unconfirmed/);
  assert.strictEqual((runtime as any).server,server);
  await assert.rejects(runtime.models(),{code:'RUNTIME_UPDATING'});
 }finally{close.mock.restore();await server.close(true);}
});
