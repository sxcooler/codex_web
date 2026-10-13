import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {registerApi} from '../src/server/api.ts';
import {Projects} from '../src/projects.ts';
import {get} from 'node:http';
import {Runtime} from '../src/codex/runtime.ts';
import {DatabaseSync} from 'node:sqlite';
import {AccountUsage} from '../src/server/account-usage.ts';
import {SharedClientState} from '../src/server/shared-client-state.ts';
import {MetadataStore} from '../src/server/metadata.ts';

test('API close releases its actual metadata database when runtime close rejects',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'api close failure ')),error=Error('native-close-failure');let store:MetadataStore|undefined;
 const knownForks=MetadataStore.prototype.knownForks;
 t.mock.method(MetadataStore.prototype,'knownForks',function(this:MetadataStore,...args:Parameters<typeof knownForks>){store=this;return knownForks.apply(this,args);});
 const runtime=Object.assign(new EventEmitter(),{list:async()=>({data:[],nextCursor:null}),close:async()=>{throw error;}}),app=Fastify();
 registerApi(app,{dataDir:dir,runtime:runtime as any,projects:new Projects(dir),authenticated:()=>()=>true});
 try{
  assert.equal((await app.inject('/api/sessions')).statusCode,200);assert.ok(store);assert.ok(store.db.prepare('SELECT 1').get());
  await assert.rejects(app.close(),cause=>cause===error);assert.throws(()=>store!.db.prepare('SELECT 1'),/not open|closed/i);
 }finally{await app.close().catch(()=>{});try{store?.close();}catch{}await rm(dir,{recursive:true,force:true});}
});

function sharedFixture(t:TestContext){
  const runtime=Object.assign(new EventEmitter(),{identity:'account-a',identities:0,reads:0,lists:0,accountIdentity:async()=>{runtime.identities++;return {identity:runtime.identity,resetProtocol:true};},readAccountUsage:async()=>{runtime.reads++;runtime.emit('accountChanged',{method:'account/rateLimits/updated'});return {accountId:runtime.identity,rateLimits:{primary:{usedPercent:25}}};}});
  const db=new DatabaseSync(':memory:'),usage=new AccountUsage(runtime as any,db),state=new SharedClientState(runtime as any,usage,async(query,signal)=>{signal.throwIfAborted();runtime.lists++;return {data:[{id:query.searchTerm||'thread-1',name:'Title'}],nextCursor:null};});
  t.after(()=>{state.close();usage.close();db.close();});
  const query={sortKey:'updated_at' as const,archived:false,includeHidden:false,searchTerm:''};return {runtime,usage,state,query};
}
const flush=async()=>{for(let step=0;step<8;step++)await new Promise(resolve=>setImmediate(resolve));};

async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'shared-state-'));await mkdir(join(dir,'work'));
  const runtime=Object.assign(new EventEmitter(),{listCalls:[] as any[],list:async(cursor?:string,archived?:boolean,sort?:string,search?:string)=>{runtime.listCalls.push({cursor,archived,sort,search});return {data:[{id:search||'thread-1',name:search||'Title',createdAt:1,updatedAt:2}],nextCursor:null};},forkListHeader:async()=>null,close:async()=>{},invalidateForkHeader:()=>{},rename:async()=>{},archive:async()=>({archived:true})});
  let valid=true;
  const app=Fastify();const api=registerApi(app,{dataDir:dir,runtime:runtime as any,projects:new Projects(join(dir,'work')),authenticated:()=>()=>valid});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return {app,runtime,api,dir,setValid:(value:boolean)=>{valid=value;}};
}

test('completed session responses are shared and explicit refresh bypasses the snapshot',async t=>{
  const {app,runtime}=await fixture(t);
  const first=(await app.inject('/api/sessions')).json();
  for(let tab=0;tab<6;tab++)assert.deepEqual((await app.inject('/api/sessions')).json(),first);
  assert.equal(runtime.listCalls.length,1);
  assert.equal((await app.inject('/api/sessions?refresh=true')).statusCode,200);
  assert.equal(runtime.listCalls.length,2);
});

test('final session cache keeps metadata and filter/pagination keys isolated',async t=>{
  const {app,runtime}=await fixture(t);
  runtime.list=async(cursor,archived,sort,search)=>{runtime.listCalls.push({cursor,archived,sort,search});return {data:[{id:cursor?'thread-2':'thread-1',name:search||'Title',createdAt:1,updatedAt:2}],nextCursor:cursor?null:'native-page-2'};};
  const first=(await app.inject('/api/sessions')).json(),page='/api/sessions?cursor='+encodeURIComponent(first.nextCursor);
  assert.equal((await app.inject(page)).json().data[0].id,'thread-2');
  await app.inject('/api/sessions?sortKey=created_at');await app.inject('/api/sessions?archived=true');await app.inject('/api/sessions?includeHidden=true');await app.inject('/api/sessions?searchTerm=needle');
  assert.equal(runtime.listCalls.length,6);
  await app.inject(page);assert.equal(runtime.listCalls.length,6);
  await app.inject({method:'POST',url:'/api/sessions/thread-1/metadata',payload:{favorite:true,hidden:true}});
  assert.equal((await app.inject('/api/sessions?includeHidden=true')).json().data[0].metadata.favorite,true);
  assert.equal((await app.inject('/api/sessions')).json().data.some((row:any)=>row.id==='thread-1'),false);
  assert.equal((await app.inject('/api/sessions?sortKey=created_at&cursor='+encodeURIComponent(first.nextCursor))).statusCode,400);
});

test('token deltas leave the cache intact while native names and completed turns invalidate it',async t=>{
  const {app,runtime}=await fixture(t);await app.inject('/api/sessions');
  for(let token=0;token<100;token++)runtime.emit('change',{kind:'delta',threadId:'thread-1',patch:{}});
  await app.inject('/api/sessions');assert.equal(runtime.listCalls.length,1);
  runtime.emit('change',{kind:'name',threadId:'thread-1',patch:{thread:{name:'New'}}});
  await app.inject('/api/sessions');assert.equal(runtime.listCalls.length,2);
  runtime.emit('change',{kind:'turn',threadId:'thread-1',patch:{turn:{id:'turn-1',status:'completed'}}});
  await app.inject('/api/sessions');assert.equal(runtime.listCalls.length,3);
});

test('one shared 60-second scheduler serves many clients and stops after the final disconnect',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,state,query}=sharedFixture(t),events:any[][]=[];
  await state.readSessions(query);
  const disconnect=Array.from({length:8},(_,tab)=>{events[tab]=[];return state.subscribe(()=>true,(kind,data)=>events[tab].push({kind,data}));});
  await flush();assert.equal(runtime.reads,1);assert.equal(runtime.identities,2);
  t.mock.timers.tick(60_000);await flush();assert.equal(runtime.reads,2);assert.equal(runtime.lists,2);assert.equal(runtime.identities,4);
  assert.ok(events.every(rows=>rows.filter(row=>row.kind==='usage').length===2));
  for(const close of disconnect)close();t.mock.timers.tick(180_000);await flush();assert.equal(runtime.reads,2);assert.equal(runtime.lists,2);
  state.close();assert.equal(runtime.listenerCount('change'),0);assert.equal(runtime.listenerCount('accountChanged'),1); // AccountUsage owns the remaining identity listener until its close.
});

test('periodic refresh shares a fresh ordinary read already in flight instead of sending a second native read',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage,state}=sharedFixture(t);await usage.read();
  t.mock.timers.tick(500);state.subscribe(()=>true,()=>{});
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  runtime.readAccountUsage=async()=>{runtime.reads++;if(runtime.reads===2){started.resolve();await release.promise;}return {accountId:'account-a',rateLimits:{primary:{usedPercent:25}}};};
  t.mock.timers.tick(59_500);const ordinary=state.readUsage();await started.promise;
  t.mock.timers.tick(500);await flush();assert.equal(runtime.reads,2,'the scheduled cycle must initially share the active RPC');
  release.resolve();await ordinary;await flush();assert.equal(runtime.reads,2,'completion of the active fresh read must also finish the background cycle');
});

test('many account and native metadata notifications are merged without read-notification feedback',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,state,query}=sharedFixture(t),events:any[]=[];await state.readSessions(query);state.subscribe(()=>true,(kind,data)=>events.push({kind,data}));await flush();
  for(let change=0;change<100;change++){runtime.emit('change',{kind:'name'});runtime.emit('accountChanged',{method:'account/rateLimits/updated'});}
  t.mock.timers.tick(100);await flush();assert.equal(runtime.reads,2);assert.equal(runtime.lists,2);
  t.mock.timers.tick(1000);await flush();assert.equal(runtime.reads,2,'native read notifications cannot schedule an endless refresh');
  runtime.identity='account-b';runtime.emit('accountChanged',{method:'account/updated'});
  assert.equal(events.at(-1).kind,'usage-invalidated');
  t.mock.timers.tick(100);await flush();assert.equal(runtime.reads,3);assert.notEqual(events.find(row=>row.kind==='usage').data.accountId,events.at(-1).data.accountId);
});

test('identity failures invalidate old account data while same-account usage failures retain a successful timestamp',async t=>{
  const {runtime,usage,state}=sharedFixture(t),events:any[]=[];state.subscribe(()=>true,(kind,data)=>events.push({kind,data}));await flush();
  const successful=usage.snapshot()!;
  runtime.readAccountUsage=async()=>{throw Error('private upstream failure');};
  await assert.rejects(state.readUsage(true));assert.equal(events.at(-1).kind,'usage-error');assert.doesNotMatch(events.at(-1).data.message,/private/);
  assert.equal(usage.snapshot()!.updatedAt,successful.updatedAt);
  runtime.accountIdentity=async()=>{throw Error('identity cannot be verified');};
  await assert.rejects(state.readUsage(true),{code:'ACCOUNT_CHANGED'});assert.equal(usage.snapshot(),undefined);
  assert.deepEqual(events.slice(-2).map(row=>row.kind),['usage-invalidated','usage-error']);
});

test('ordinary tabs share a usage failure until the next cycle instead of repeating identity reads',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage}=sharedFixture(t);await usage.read();t.mock.timers.tick(60_000);
  runtime.readAccountUsage=async()=>{throw Error('temporarily unavailable');};
  await assert.rejects(usage.read());const checks=runtime.identities;
  for(let tab=0;tab<8;tab++)await assert.rejects(usage.read());assert.equal(runtime.identities,checks);
  await assert.rejects(usage.read(true));assert.equal(runtime.identities,checks+1,'explicit refresh still bypasses the failure snapshot');
});

test('identity-read failure clears every client and cannot schedule its own infinite refresh loop',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,state}=sharedFixture(t),events:any[]=[];state.subscribe(()=>true,(kind,data)=>events.push({kind,data}));await flush();
  runtime.accountIdentity=async()=>{runtime.identities++;throw Error('cannot confirm identity');};
  runtime.emit('accountChanged',{method:'account/updated'});t.mock.timers.tick(100);await flush();const checks=runtime.identities;
  for(let tick=0;tick<10;tick++){t.mock.timers.tick(100);await flush();}assert.equal(runtime.identities,checks);
  assert.deepEqual(events.slice(-2).map(row=>row.kind),['usage-invalidated','usage-error']);
});

test('session loads are single-flight and their lifecycle is independent of a disconnected subscriber',async t=>{
  const {runtime,usage,query}=sharedFixture(t),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
  const state=new SharedClientState(runtime as any,usage,async(_query,signal)=>{calls++;started.resolve();await release.promise;signal.throwIfAborted();return {data:[{id:'shared'}],nextCursor:null};});t.after(()=>state.close());
  const closeFirst=state.subscribe(()=>true,()=>{}),events:any[]=[];state.subscribe(()=>true,(kind,data)=>events.push({kind,data}));
  const first=state.readSessions(query);await started.promise;const second=state.readSessions(query);closeFirst();release.resolve();
  assert.deepEqual(await Promise.all([first,second]),[{data:[{id:'shared'}],nextCursor:null},{data:[{id:'shared'}],nextCursor:null}]);assert.equal(calls,1);assert.ok(events.some(row=>row.kind==='sessions'));
});

test('session cache is bounded and idle queries do not participate in background cycles',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,state,query}=sharedFixture(t);
  for(let term=0;term<33;term++)await state.readSessions({...query,searchTerm:String(term)});
  assert.equal(runtime.lists,33);await state.readSessions({...query,searchTerm:'0'});assert.equal(runtime.lists,34,'least-used completed entry must be evicted');
  t.mock.timers.tick(300_000);state.subscribe(()=>true,()=>{});await flush();t.mock.timers.tick(60_000);await flush();assert.equal(runtime.lists,34,'expired queries must not be refreshed');
});

test('close aborts an internally owned session deadline and prevents late publication',async t=>{
  const {runtime,usage,query}=sharedFixture(t),release=Promise.withResolvers<void>(),events:any[]=[];
  const state=new SharedClientState(runtime as any,usage,async()=>{await release.promise;return {data:[{id:'late'}],nextCursor:null};});state.subscribe(()=>true,(kind,data)=>events.push({kind,data}));
  const waiting=state.readSessions(query);state.close();await assert.rejects(waiting,{code:'SHARED_STATE_UNAVAILABLE'});release.resolve();await flush();assert.equal(events.some(row=>row.kind==='sessions'),false);
});

test('a failed list refresh retains a marked stale snapshot and does not flood native reads',async t=>{
  const {runtime,usage,query}=sharedFixture(t);let calls=0,fail=false;
  const state=new SharedClientState(runtime as any,usage,async()=>{calls++;if(fail)throw Error('private upstream');return {data:[{id:'last-success'}],nextCursor:null};});t.after(()=>state.close());
  await state.readSessions(query);fail=true;await assert.rejects(state.readSessions(query,true));
  const stale=await state.readSessions(query);assert.equal(stale.data[0].id,'last-success');assert.equal(stale.stale,true);assert.match(stale.error.message,/更新/);assert.doesNotMatch(stale.error.message,/private/);
  for(let tab=0;tab<8;tab++)await state.readSessions(query);assert.equal(calls,2);
});

test('an invalidated list cannot serve old metadata when a hide or archive refresh fails',async t=>{
  const {runtime,usage,query}=sharedFixture(t);let fail=false;
  const state=new SharedClientState(runtime as any,usage,async()=>{if(fail)throw Error('unavailable');return {data:[{id:'now-hidden',metadata:{hidden:false}}],nextCursor:null};});t.after(()=>state.close());
  await state.readSessions(query);fail=true;state.invalidateSessions();
  await assert.rejects(state.readSessions(query));await assert.rejects(state.readSessions(query));
});

test('a failed metadata refresh notifies every tab and their error reads use the negative cache',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage,query}=sharedFixture(t);let fail=false,calls=0;
  const state=new SharedClientState(runtime as any,usage,async()=>{calls++;if(fail)throw Error('unavailable');return {data:[{id:'now-hidden',metadata:{hidden:false}}],nextCursor:null};});t.after(()=>state.close());
  await state.readSessions(query);const failures:number[]=[],events:any[]=[];
  for(let tab=0;tab<2;tab++)state.subscribe(()=>true,(kind,data)=>{if(kind==='sessions'){events.push({tab,revision:data.revision});void state.readSessions(query).catch(()=>failures.push(tab));}});
  await flush();fail=true;state.invalidateSessions();t.mock.timers.tick(100);await flush();
  assert.deepEqual(failures.sort(),[0,1],'all tabs must receive an update failure after metadata invalidation');assert.equal(events.length,2);assert.equal(calls,2);
  for(let tab=0;tab<8;tab++)await assert.rejects(state.readSessions(query));assert.equal(calls,2,'reading the error event must not start a recursive native refresh');
  t.mock.timers.tick(1000);await flush();assert.equal(calls,2);
});

test('close promptly settles a pending usage read and prevents its late successful cache write',async t=>{
  const {runtime,usage}=sharedFixture(t),release=Promise.withResolvers<void>();
  runtime.readAccountUsage=async()=>{await release.promise;return {accountId:'account-a',rateLimits:{primary:{usedPercent:25}}};};
  const waiting=usage.read();await flush();usage.close();
  assert.equal(await Promise.race([waiting.then(()=>false,()=>true),new Promise(resolve=>setImmediate(()=>resolve(false)))]),true);
  release.resolve();await flush();assert.equal(usage.snapshot(),undefined);
});

test('late metadata reads after cache invalidation cannot overwrite the current final response',async t=>{
  const {runtime,usage,query}=sharedFixture(t),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
  const state=new SharedClientState(runtime as any,usage,async()=>{calls++;if(calls===1){started.resolve();await release.promise;return {data:[{id:'old'}],nextCursor:null};}return {data:[{id:'current'}],nextCursor:null};});t.after(()=>state.close());
  const waiting=state.readSessions(query);await started.promise;state.invalidateSessions();release.resolve();
  assert.equal((await waiting).data[0].id,'current');assert.equal(calls,2);
});

test('continuous successful list invalidations return pending and share a bounded followup instead of a failure cache',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage,query}=sharedFixture(t),first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>();let calls=0;
  await usage.read();
  const state=new SharedClientState(runtime as any,usage,async()=>{const call=++calls;if(call===1)await first.promise;else if(call===2)await second.promise;return {data:[{id:'current-'+call}],nextCursor:null};});t.after(()=>state.close());
  const reading=state.readSessions(query);runtime.emit('change',{kind:'thread',threadId:'thread-1'});state.invalidateSessions('metadata');first.resolve();await flush();assert.equal(calls,2);
  runtime.emit('change',{kind:'name',threadId:'thread-1',patch:{thread:{name:'Title'}}});runtime.emit('change',{kind:'name',threadId:'thread-1',patch:{thread:{name:'Title'}}});second.resolve();
  assert.deepEqual(await reading,{pending:true});
  for(let tab=0;tab<8;tab++)assert.deepEqual(await state.readSessions(query),{pending:true});assert.equal(calls,2);
  t.mock.timers.tick(100);await flush();assert.equal(calls,3);assert.deepEqual((await state.readSessions(query)).data,[{id:'current-3'}]);
});

test('dirty background refresh applies genuine name and archive invalidations without a forced read',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage,query}=sharedFixture(t);let calls=0,name='original',archived=false;
  await usage.read();
  const state=new SharedClientState(runtime as any,usage,async()=>{calls++;return {data:archived?[]:[{id:'thread-1',name}],nextCursor:null};});t.after(()=>state.close());
  await state.readSessions(query);const events:number[]=[];state.subscribe(()=>true,(kind,data)=>{if(kind==='sessions')events.push(data.revision);});
  name='renamed';runtime.emit('change',{kind:'name',threadId:'thread-1'});t.mock.timers.tick(100);await flush();
  assert.deepEqual((await state.readSessions(query)).data,[{id:'thread-1',name:'renamed'}]);assert.equal(calls,2);
  archived=true;runtime.emit('change',{kind:'archive',threadId:'thread-1'});t.mock.timers.tick(100);await flush();
  assert.deepEqual((await state.readSessions(query)).data,[]);assert.equal(calls,3);assert.equal(events.length,2);
});

test('name invalidation keeps same-query history while pending but never publishes obsolete fresh results',async t=>{
 const {runtime,usage,query}=sharedFixture(t);let calls=0,conflict=false;
 const state=new SharedClientState(runtime as any,usage,async()=>{calls++;if(conflict)state.invalidateSessions('name');return {data:[{id:'row',name:'name-'+calls}],nextCursor:null};});t.after(()=>state.close());
 await state.readSessions(query);conflict=true;state.invalidateSessions('name');
 assert.deepEqual(await state.readSessions(query),{pending:true});assert.equal(calls,3);
 assert.deepEqual(await state.readSessions({...query,searchTerm:'other'}),{pending:true});
 conflict=false;assert.equal((await state.readSessions(query,true)).data[0].name,'name-6');
});

test('an ordinary loader failure from an invalidated version cannot poison the current cache',async t=>{
  const {runtime,usage,query}=sharedFixture(t),old=Promise.withResolvers<any>();let calls=0;
  const state=new SharedClientState(runtime as any,usage,async()=>{calls++;return calls===1?old.promise:{data:[{id:'current'}],nextCursor:null};});t.after(()=>state.close());
  const reading=state.readSessions(query),failed=assert.rejects(reading,/obsolete native failure/);
  runtime.emit('change',{kind:'name',threadId:'thread-1'});old.reject(Error('obsolete native failure'));await failed;
  assert.deepEqual((await state.readSessions(query)).data,[{id:'current'}]);assert.equal(calls,2);
});

test('Runtime forwards account notification kinds while legacy listeners still receive both events',async()=>{
  const runtime=new Runtime({executable:process.execPath,cwd:process.cwd()}),events:any[]=[];let legacy=0;
  runtime.on('accountChanged',event=>events.push(event));runtime.on('accountChanged',()=>legacy++);
  (runtime as any).onNotification({method:'account/updated',params:{}});(runtime as any).onNotification({method:'account/rateLimits/updated',params:{}});
  assert.deepEqual(events,[{method:'account/updated'},{method:'account/rateLimits/updated'}]);assert.equal(legacy,2);await runtime.close();
});

test('global state also flows through a thread SSE and each kind of stream releases its shared subscription',async t=>{
  const {app,runtime}=await fixture(t);
  Object.assign(runtime,{accountIdentity:async()=>({identity:'a',resetProtocol:true}),readAccountUsage:async()=>({accountId:'a',rateLimits:{primary:{usedPercent:25}}}),replay:()=>({reset:false,events:[]})});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const connect=async(path:string)=>{
    const response:any=await new Promise(resolve=>get(address+path,resolve));let text='';response.on('data',(data:Buffer)=>{text+=data.toString();});
    t.after(()=>response.destroy());return {response,text:()=>text};
  };
  const thread=await connect('/api/sessions/thread-1/events'),global=await connect('/api/state/events');await flush();
  await app.inject('/api/sessions');await flush();
  assert.match(thread.text(),/event: ready/);assert.match(global.text(),/event: ready/);assert.match(thread.text(),/event: usage/);assert.match(global.text(),/event: sessions/);
  runtime.emit('change',{kind:'delta',threadId:'thread-1',patch:{}});await flush();assert.match(thread.text(),/event: change/);assert.doesNotMatch(global.text(),/event: change/);
  thread.response.destroy();global.response.destroy();await flush();assert.equal(runtime.listenerCount('change'),1);
  await app.close();assert.equal(runtime.listenerCount('change'),0);assert.equal(runtime.listenerCount('accountChanged'),0);
});

test('global SSE shares expiry, write-backpressure and close handling without affecting normal HTTP',async t=>{
  const {app,runtime,api,setValid}=await fixture(t);let stream:any;
  Object.assign(runtime,{accountIdentity:async()=>({identity:'a',resetProtocol:true}),readAccountUsage:async()=>({accountId:'a',rateLimits:{primary:{usedPercent:25}}})});
  app.addHook('onRequest',async(request,reply)=>{if(request.url==='/api/state/events')stream=reply.raw;});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const connect=()=>new Promise<any>(resolve=>get(address+'/api/state/events',resolve));
  const first=await connect();first.resume();const ended=Promise.withResolvers<void>();first.once('end',()=>ended.resolve());
  setValid(false);api.closeInvalid();await ended.promise;first.destroy();
  setValid(true);const second=await connect();second.resume();const stopped=Promise.withResolvers<void>();second.once('end',()=>stopped.resolve());
  Object.defineProperty(stream,'writableLength',{value:300*1024,configurable:true});
  runtime.emit('accountChanged',{method:'account/updated'});await stopped.promise;second.destroy();
  assert.equal((await app.inject('/api/sessions')).statusCode,200);await app.close();assert.equal(runtime.listenerCount('change'),0);assert.equal(runtime.listenerCount('accountChanged'),0);
});

test('owned usage and session deadlines expire without late cache writes or further native reads',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage,query}=sharedFixture(t),release=Promise.withResolvers<void>();
  runtime.readAccountUsage=async()=>{runtime.reads++;await release.promise;return {accountId:'account-a',rateLimits:{primary:{usedPercent:25}}};};
  const state=new SharedClientState(runtime as any,usage,async()=>{await release.promise;return {data:[{id:'late'}],nextCursor:null};});t.after(()=>state.close());
  const reading=usage.read(),listing=state.readSessions(query);await flush();const rejectedUsage=assert.rejects(reading,{code:'ACCOUNT_CHANGED'}),rejectedList=assert.rejects(listing,{code:'SHARED_STATE_UNAVAILABLE'});
  t.mock.timers.tick(30_000);await Promise.all([rejectedUsage,rejectedList]);release.resolve();await flush();assert.equal(usage.snapshot(),undefined);assert.equal(runtime.identities,1,'expired usage must not send a late after-identity request');
});

test('an expired identity RPC failing late cannot invalidate a newer successful account snapshot',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
  const {runtime,usage}=sharedFixture(t),old=Promise.withResolvers<any>();let calls=0;
  runtime.accountIdentity=async()=>{calls++;if(calls===1)return old.promise;return {identity:'new-account',resetProtocol:true};};
  runtime.readAccountUsage=async()=>({accountId:'new-account',rateLimits:{primary:{usedPercent:25}}});
  const first=usage.read(),rejected=assert.rejects(first,{code:'ACCOUNT_CHANGED'});t.mock.timers.tick(30_000);await rejected;
  const current=await usage.read(true);old.reject(Error('old RPC failed late'));await flush();
  assert.equal(usage.snapshot()?.accountId,current.accountId);
});

test('disconnecting the first HTTP reader cannot cancel another tab sharing the session job',async t=>{
  const {app,runtime}=await fixture(t),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
  runtime.list=async()=>{calls++;started.resolve();await release.promise;return {data:[{id:'shared-result'}],nextCursor:null};};
  const address=await app.listen({host:'127.0.0.1',port:0}),client=get(address+'/api/sessions');client.on('error',()=>{});
  await started.promise;const second=app.inject('/api/sessions');client.destroy();release.resolve();
  const result=await second;assert.equal(result.statusCode,200,result.body);assert.equal(result.json().data[0].id,'shared-result');assert.equal(calls,1);
});

test('API pre-close ends an active shared usage read before waiting for HTTP connections',async t=>{
  const {app,runtime}=await fixture(t),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  Object.assign(runtime,{accountIdentity:async()=>({identity:'a',resetProtocol:true}),readAccountUsage:async()=>{started.resolve();await release.promise;return {accountId:'a',rateLimits:{primary:{usedPercent:25}}};}});
  const address=await app.listen({host:'127.0.0.1',port:0}),client=get(address+'/api/account/usage',{agent:false},response=>response.resume());client.on('error',()=>{});await started.promise;
  const closing=app.close();const settled=await Promise.race([closing.then(()=>true),new Promise(resolve=>{setTimeout(()=>resolve(false),200).unref();})]);
  release.resolve();client.destroy();await closing;assert.equal(settled,true);
});
