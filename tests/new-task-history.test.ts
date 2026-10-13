import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../src/codex/runtime.ts';
import Fastify from 'fastify';
import {registerApi} from '../src/server/api.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const cwd=process.cwd(),threadId='d5f13aa2-13c1-4119-a795-0006b4e326a6';
const notReady=()=>Object.assign(Error(`thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`),{code:-32600});
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
async function fixture(t:any){
 const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());
 const policy={mode:'custom',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};
 t.mock.method(internal,'resolvePermissions',async()=>policy);t.mock.method(internal,'validateTurnOptions',async()=>{});
 let starts=0;t.mock.method(internal,'mutation',async(method:string)=>{if(method==='turn/start'){starts++;return {turn:{id:'first',status:'inProgress',items:[]}};}return {thread:{id:threadId,cwd,projectId:'project',name:'Task',status:{type:'idle'},turns:[]},cwd,model:'fixture',approvalPolicy:'never',approvalsReviewer:'user',sandbox:policy.sandbox};});
 t.mock.method(internal,'getServer',async()=>({}));
 const created=await runtime.create({cwd,nativeProjectId:'project',clientRequestId:'create-task',prompt:'fake prompt'});
 return {runtime,internal,created,starts:()=>starts};
}
test('accepted create hands off browser snapshot without reading history or resending the first turn',async t=>{
 const {created,runtime,starts}=await fixture(t);
 assert.equal(created.initialSnapshot.thread.id,threadId);assert.equal(created.initialSnapshot.thread.projectId,'project');
 assert.equal(created.initialSnapshot.phase,'RUNNING');assert.equal(created.initialSnapshot.activeTurnId,'first');assert.equal(created.initialSnapshot.historyPending,true);
 assert.equal(created.initialSnapshot.thread.turns[0].id,'first');assert.ok(created.initialSnapshot.permissions);assert.match(created.initialSnapshot.syncCursor,new RegExp('^'+created.initialSnapshot.epoch+':'));
 assert.deepEqual(await runtime.create({cwd,nativeProjectId:'project',clientRequestId:'create-task',prompt:'fake prompt'}),created);assert.equal(starts(),1);
});
test('only the verified code method message and thread identify unmaterialized history',async t=>{
 const {internal}=await fixture(t);
 assert.equal(internal.mapError(notReady(),'thread/turns/list',{threadId}).code,'RUNTIME_HISTORY_NOT_MATERIALIZED');
 for(const [error,method,id] of [[Object.assign(notReady(),{code:-32603}),'thread/turns/list',threadId],[notReady(),'thread/read',threadId],[notReady(),'thread/turns/list','other']])assert.equal(internal.mapError(error,method,{threadId:id}).code,'RUNTIME_UNAVAILABLE');
 assert.equal(internal.mapError(Object.assign(Error('list_turns is not supported yet'),{code:-32601}),'thread/turns/list',{threadId}).code,'RUNTIME_HISTORY_UNSUPPORTED');
});
test('new first-turn history reads coalesce and preserve activity through a 7.7 second materialization delay',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const {runtime,internal,starts}=await fixture(t);let reads=0;
 t.mock.method(internal,'loadThread',async()=>{reads++;if(reads<6)throw internal.mapError(notReady(),'thread/turns/list',{threadId});return {id:threadId,cwd,status:{type:'idle'},turns:[{id:'first',status:'inProgress',items:[]}]};});
 const first=runtime.snapshot(threadId,{window:true}),second=runtime.snapshot(threadId,{window:true});await flush();
 for(const delay of [200,500,1000,2000,4000]){t.mock.timers.tick(delay);await flush();}
 const [a,b]=await Promise.all([first,second]);assert.equal(reads,6);assert.equal(a.historyPending,false);assert.equal(b.activeTurnId,'first');assert.equal(a.phase,'RUNNING');assert.equal(starts(),1);
});
test('empty successful history cannot claim first-turn history readiness or unlock confirmed activity',async t=>{
 const {runtime,internal,starts}=await fixture(t);t.mock.method(internal,'loadThread',async()=>({id:threadId,cwd,status:{type:'idle'},turns:[]}));
 const value=await runtime.snapshot(threadId,{window:true});assert.equal(value.historyPending,true);assert.equal(value.activeTurnId,'first');assert.equal(value.phase,'RUNNING');assert.equal(value.thread.turns[0].id,'first');
 await assert.rejects(runtime.send(threadId,{text:'must not start another turn',clientRequestId:'blocked'}),{code:'RUNTIME_THREAD_BUSY'});assert.equal(starts(),1);
});
test('the first stuck native history RPC is limited by the complete 15 second recovery budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const {runtime,internal}=await fixture(t);let timeout:number|undefined,reads=0;
 const server={request:async(_method:string,_params:any,budget:number)=>{reads++;timeout=budget;return new Promise(()=>{});}};
 t.mock.method(internal,'getServer',async()=>server);
 const waiting=runtime.snapshot(threadId,{window:true}),rejected=assert.rejects(waiting,{code:'RUNTIME_HISTORY_NOT_MATERIALIZED'});await flush();
 assert.ok(timeout!>0&&timeout!<=15000);t.mock.timers.tick(15000);await rejected;assert.equal(reads,1);assert.equal(internal.state(threadId).activeTurnId,'first');
});
test('one canceled reader leaves another shared reader alive, and all readers leaving ignore late history',async t=>{
 const {runtime,internal}=await fixture(t);const gate=Promise.withResolvers<any>();let reads=0;
 t.mock.method(internal,'loadThread',async()=>{reads++;return gate.promise;});
 const a=new AbortController(),b=new AbortController(),first=runtime.snapshot(threadId,{window:true,signal:a.signal}),second=runtime.snapshot(threadId,{window:true,signal:b.signal});await flush();
 const rejectedA=assert.rejects(first,{name:'AbortError'});a.abort();await rejectedA;assert.equal(internal.state(threadId).historyRead.controller.signal.aborted,false);
 const rejectedB=assert.rejects(second,{name:'AbortError'});b.abort();await rejectedB;gate.resolve({id:threadId,cwd,status:{type:'idle'},turns:[{id:'first',status:'completed',items:[]}]});await flush();
 assert.equal(reads,1);assert.equal(internal.state(threadId).activeTurnId,'first');assert.equal(internal.state(threadId).initialHistory.turnId,'first');
});
for(const code of ['RUNTIME_UNAVAILABLE','RUNTIME_HISTORY_UNSUPPORTED'])test(`new startup does not retry ${code}`,async t=>{
 const {runtime,internal}=await fixture(t);let reads=0;t.mock.method(internal,'loadThread',async()=>{reads++;throw Object.assign(Error('safe failure'),{code,statusCode:503});});
 await assert.rejects(runtime.snapshot(threadId,{window:true}),{code});assert.equal(reads,1);
});
test('changing native epoch cancels recovery and never merges a late completed first turn',async t=>{
 const {runtime,internal}=await fixture(t),gate=Promise.withResolvers<any>();t.mock.method(internal,'loadThread',async()=>gate.promise);
 const reading=runtime.snapshot(threadId,{window:true}),rejected=assert.rejects(reading,{code:'RUNTIME_SYNC_RESTARTED'});await flush();
 internal.epoch='new-epoch';internal.state(threadId).historyRead.controller.abort(Object.assign(Error('changed'),{code:'RUNTIME_SYNC_RESTARTED'}));await rejected;
 gate.resolve({id:threadId,cwd,status:{type:'idle'},turns:[{id:'first',status:'completed',items:[]}]});await flush();assert.equal(internal.state(threadId).activeTurnId,'first');
});
test('API decorates the accepted create snapshot with its workspace and metadata without a history RPC',async t=>{
 const {runtime,created}=await fixture(t),dir=await mkdtemp(join(tmpdir(),'new-task-api-'));
 const project={id:'workspace',name:'project',path:cwd},projects:any={root:cwd,list:async()=>[project],resolve:async()=>project};
 t.mock.method(runtime,'assertProjectContext',()=>{});t.mock.method(runtime,'projectContext',async()=>({home:dir,epoch:created.initialSnapshot.epoch}));t.mock.method(runtime,'listProjects',async()=>[{id:'project',name:'native',roots:[{path:cwd}]}]);
 t.mock.method(runtime,'snapshot',async()=>{throw Error('create must not read complete history');});
 const app=Fastify();registerApi(app,{dataDir:dir,runtime,projects,authenticated:()=>()=>true});
 try{const response=await app.inject({method:'POST',url:'/api/sessions',payload:{projectId:project.id,nativeProjectId:'project',clientRequestId:'create-task',prompt:'fake prompt'}});
 assert.equal(response.statusCode,200,response.body);const value=response.json().initialSnapshot;assert.equal(value.thread.id,threadId);assert.equal(value.project.id,project.id);assert.equal(value.metadata.thread_id,threadId);assert.deepEqual(value.inputAnswers,{});assert.equal(value.historyPending,true);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('a deadline during startup backoff preserves the public recovery reason',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});const {runtime,internal}=await fixture(t),gate=Promise.withResolvers<any>();let reads=0;
 t.mock.method(internal,'loadThread',async()=>{reads++;return gate.promise;});
 const reading=runtime.snapshot(threadId,{window:true}),failed=assert.rejects(reading,{code:'RUNTIME_HISTORY_NOT_MATERIALIZED'});await flush();
 t.mock.timers.tick(14_900);gate.reject(internal.mapError(notReady(),'thread/turns/list',{threadId}));await flush();t.mock.timers.tick(100);await failed;
 assert.equal(reads,1);assert.equal(internal.state(threadId).activeTurnId,'first');assert.equal(internal.state(threadId).initialHistory.turnId,'first');
});
test('automatic reads after all waiters leave retain the original deadline and only manual recovery restarts it',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});const {runtime,internal}=await fixture(t);let reads=0;let gate=Promise.withResolvers<any>();
 t.mock.method(internal,'loadThread',async()=>{reads++;return gate.promise;});
 const a=new AbortController(),first=runtime.snapshot(threadId,{window:true,signal:a.signal}),cancelled=assert.rejects(first,{name:'AbortError'});await flush();t.mock.timers.tick(10_000);a.abort();await cancelled;await flush();
 let secondError:any;const second=runtime.snapshot(threadId,{window:true}),settled=second.catch(error=>{secondError=error;});await flush();t.mock.timers.tick(5000);await flush();assert.equal(secondError?.code,'RUNTIME_HISTORY_NOT_MATERIALIZED','automatic reopening must expire at the original total 15 seconds');await settled;assert.equal(reads,2);
 gate=Promise.withResolvers<any>();const manual=runtime.snapshot(threadId,{window:true,restartHistory:true} as any);await flush();t.mock.timers.tick(10);gate.resolve({id:threadId,cwd,status:{type:'idle'},turns:[{id:'first',status:'inProgress',items:[]}]});assert.equal((await manual).historyPending,false);assert.equal(reads,3);
});
test('an intentionally empty same-epoch thread keeps its existing lightweight status contract',async t=>{
 const {runtime,internal}=await fixture(t),thread={id:threadId,cwd,status:{type:'idle'},turns:[]},state=internal.state(threadId);
 state.activeTurnId=undefined;state.initialHistory=undefined;state.emptyThreadEpoch=internal.epoch;internal.rememberSync(state,thread);
 t.mock.method(internal,'call',async(method:string)=>{if(method==='thread/read')return {thread};throw internal.mapError(notReady(),method,{threadId});});
 assert.equal((await runtime.status(threadId,internal.epoch)).resync,false);
});
test('matching native name notices and local acknowledgement cause a single name invalidation',async t=>{
 const {runtime,internal}=await fixture(t);let names=0;runtime.on('change',(event:any)=>{if(event.kind==='name')names++;});
 t.mock.method(internal,'mutation',async()=>{internal.onNotification({method:'thread/name/updated',params:{threadId,threadName:'New title'}});return {};});
 await runtime.rename(threadId,'New title');internal.onNotification({method:'thread/name/updated',params:{threadId,threadName:'New title'}});assert.equal(names,1);
 internal.onNotification({method:'thread/name/updated',params:{threadId,threadName:'Different title'}});assert.equal(names,2);
});

test('snapshot GET validates the explicit manual recovery bridge',async t=>{
 const {runtime,created}=await fixture(t),dir=await mkdtemp(join(tmpdir(),'history-bridge-'));const seen:any[]=[];const project={id:'workspace',name:'project',path:cwd};
 t.mock.method(runtime,'projectContext',async()=>({home:dir,epoch:created.initialSnapshot.epoch}));t.mock.method(runtime,'listProjects',async()=>[]);
 t.mock.method(runtime,'snapshot',async(_id,options)=>{seen.push(options);return created.initialSnapshot;});const app=Fastify();registerApi(app,{dataDir:dir,runtime,projects:{root:cwd,list:async()=>[project],resolve:async()=>project} as any,authenticated:()=>()=>true});
 try{for(const query of ['', '?restartHistory=true'])assert.equal((await app.inject('/api/sessions/'+threadId+query)).statusCode,200);assert.deepEqual(seen.map(x=>x.restartHistory),[false,true]);for(const query of ['?restartHistory=false','?restartHistory=1'])assert.equal((await app.inject('/api/sessions/'+threadId+query)).statusCode,400,query);assert.equal(seen.length,2);}finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('manual recovery at an expired absolute deadline replaces an active handle before its timer fires',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const {runtime,internal}=await fixture(t);let reads=0;const gate=Promise.withResolvers<any>();t.mock.method(internal,'loadThread',async()=>{reads++;return reads===1?gate.promise:{id:threadId,cwd,status:{type:'idle'},turns:[{id:'first',status:'inProgress',items:[]}]};});
 const first=runtime.snapshot(threadId,{window:true}),rejected=assert.rejects(first,{code:'RUNTIME_HISTORY_NOT_MATERIALIZED'});await flush();const deadline=internal.state(threadId).initialHistory.deadline;const joined=runtime.snapshot(threadId,{window:true,restartHistory:true});const joinedRejected=assert.rejects(joined,{code:'RUNTIME_HISTORY_NOT_MATERIALIZED'});await flush();assert.equal(reads,1);assert.equal(internal.state(threadId).initialHistory.deadline,deadline);t.mock.timers.tick(15000);assert.equal((await runtime.snapshot(threadId,{window:true,restartHistory:true})).historyPending,false);await rejected;await joinedRejected;assert.equal(reads,2);gate.resolve({});
});
