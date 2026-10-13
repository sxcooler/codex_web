import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {SharedClientState,type SessionQuery} from '../src/server/shared-client-state.ts';
import type {DiagnosticEvent} from '../src/server/diagnostics.ts';

const query:SessionQuery={sortKey:'updated_at',archived:false,includeHidden:false,searchTerm:''};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const soft=(runtime:EventEmitter,kind='status')=>runtime.emit('change',{kind,threadId:'synthetic-thread',...(kind==='turn'?{patch:{turn:{id:'synthetic-turn',status:'completed'}}}:{})});
function fixture(t:TestContext,load:(query:SessionQuery,signal:AbortSignal)=>Promise<any>,diagnostic?:(event:DiagnosticEvent)=>void){
 const runtime=new EventEmitter(),usage=Object.assign(new EventEmitter(),{snapshot:()=>({}),refreshBackground:async()=>({}),read:async()=>({})});
 const state=new SharedClientState(runtime as any,usage as any,load,diagnostic);t.after(()=>state.close());return {runtime,state};
}

test('soft event bursts during one load settle normally then coalesce a latest sorted release snapshot',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});
 const release=Promise.withResolvers<void>(),diagnostics:DiagnosticEvent[]=[];let calls=0,latest=false,publications=0;
 const {runtime,state}=fixture(t,async()=>{const row=latest?{data:[{id:'b',updatedAt:110,release:{requested:true}},{id:'a',updatedAt:100}],nextCursor:'next'}:{data:[{id:'a',updatedAt:100},{id:'b',updatedAt:90}],nextCursor:'next'};if(++calls===1)await release.promise;return row;},event=>diagnostics.push(event));
 state.subscribe(()=>true,kind=>{if(kind==='sessions')publications++;});
 const first=state.readSessions(query);latest=true;for(let i=0;i<100;i++)soft(runtime,['status','turn','release'][i%3]);
 assert.equal(diagnostics.filter(event=>event.event==='shared_sessions_invalidation'&&event.kind==='soft').length,1,'a coalesced dirty burst must record one soft invalidation');
 t.mock.timers.tick(100);await flush();assert.equal(calls,1,'scheduled soft refresh must join the in-flight load');release.resolve();await first;await flush();
 t.mock.timers.tick(100);await flush();const current=await state.readSessions(query);
 assert.deepEqual(current.data.map((row:any)=>row.id),['b','a']);assert.equal(current.data[0].release.requested,true);assert.equal(current.nextCursor,'next');assert.equal(calls,2,'one follow-up must cover the entire burst');assert.equal(publications,2);
});

test('without subscribers a soft-dirty in-flight result is accepted and the next read refreshes each page',async t=>{
 const release=Promise.withResolvers<void>();let calls=0,latest=false;
 const {runtime,state}=fixture(t,async q=>{const version=latest?'latest':'original';if(++calls===1)await release.promise;return {data:[{id:version+(q.cursor??'first')}],nextCursor:q.cursor?null:'next'};});
 const first=state.readSessions(query);latest=true;soft(runtime);soft(runtime,'turn');release.resolve();assert.equal((await first).data[0].id,'originalfirst');
 assert.equal((await state.readSessions(query)).data[0].id,'latestfirst');await state.readSessions({...query,cursor:'next'});const before=calls;soft(runtime,'release');
 await state.readSessions(query);await state.readSessions({...query,cursor:'next'});assert.equal(calls,before+2,'every cached page must consume soft dirty on its next read');
});

test('continuous runtime notifications do not reject successful reads through version exhaustion',async t=>{
 let calls=0;const {runtime,state}=fixture(t,async()=>{calls++;await Promise.resolve();soft(runtime);return {data:[{id:'successful-'+calls}],nextCursor:null};});
 assert.equal((await state.readSessions(query)).data[0].id,'successful-1');assert.equal(calls,1);
 assert.equal((await state.readSessions(query)).data[0].id,'successful-2');assert.equal(calls,2);
});

test('known fork recency changes refresh ordering without clearing the last successful snapshot',async t=>{
 let fail=false,calls=0;const {state}=fixture(t,async()=>{calls++;if(fail)throw Error('unavailable');return {data:[{id:'fork',updatedAt:calls}],nextCursor:null};});
 await state.readSessions(query);state.refreshSessions('fork');assert.equal((await state.readSessions(query)).data[0].updatedAt,2);fail=true;state.refreshSessions('fork');await assert.rejects(state.readSessions(query));assert.equal((await state.readSessions(query)).stale,true);
});

test('soft refresh failure keeps a marked old snapshot and repeated soft events preserve the negative cache',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});let calls=0,fail=false;
 const {runtime,state}=fixture(t,async()=>{calls++;if(fail)throw Error('private upstream failure');return {data:[{id:'last-good'}],nextCursor:null};});
 await state.readSessions(query);fail=true;soft(runtime);await assert.rejects(state.readSessions(query));
 for(let i=0;i<20;i++)soft(runtime,'turn');const stale=await state.readSessions(query);assert.equal(stale.stale,true);assert.equal(stale.data[0].id,'last-good');assert.doesNotMatch(stale.error.message,/private/);assert.equal(calls,2);
 t.mock.timers.tick(59_999);await state.readSessions(query);assert.equal(calls,2);fail=false;t.mock.timers.tick(1);assert.equal((await state.readSessions(query)).data[0].id,'last-good');assert.equal(calls,3);
});

for(const kind of ['metadata','archive','name','thread','resync'])test(`${kind} hard invalidation after a soft failure cannot return pre-mutation data`,async t=>{
 let fail=false;const {runtime,state}=fixture(t,async()=>{if(fail)throw Error('unavailable');return {data:[{id:'old-visible',metadata:{hidden:false}}],nextCursor:null};});
 await state.readSessions(query);fail=true;soft(runtime);await assert.rejects(state.readSessions(query));assert.equal((await state.readSessions(query)).stale,true);
 if(kind==='metadata')state.invalidateSessions();else runtime.emit('change',{kind,threadId:'old-visible'});
 await assert.rejects(state.readSessions(query));await assert.rejects(state.readSessions(query));
});

test('hard visibility changes reject an obsolete in-flight result even amidst soft notifications',async t=>{
 const release=Promise.withResolvers<void>();let calls=0,hidden=false;
 const {runtime,state}=fixture(t,async()=>{const data=hidden?[]:[{id:'now-hidden'}];if(++calls===1)await release.promise;return {data,nextCursor:null};});
 const reading=state.readSessions(query);soft(runtime);hidden=true;state.invalidateSessions();soft(runtime,'release');release.resolve();assert.deepEqual((await reading).data,[]);assert.equal(calls,2);
});

test('two hard mutations return pending without publishing obsolete data or a negative failure cache',async t=>{
 const gates=[Promise.withResolvers<void>(),Promise.withResolvers<void>()],starts=[Promise.withResolvers<void>(),Promise.withResolvers<void>()];let calls=0;
 const {runtime,state}=fixture(t,async()=>{const i=calls++;starts[i].resolve();await gates[i].promise;return {data:[{id:'obsolete'}],nextCursor:null};});
 const reading=state.readSessions(query);await starts[0].promise;state.invalidateSessions();gates[0].resolve();await starts[1].promise;runtime.emit('change',{kind:'archive'});gates[1].resolve();assert.deepEqual(await reading,{pending:true});
 soft(runtime);assert.deepEqual(await state.readSessions(query),{pending:true});assert.equal(calls,2);
});

test('a genuine follow-up failure ends pending and remains visible to passive readers',async t=>{
 let calls=0,fail=false;const {state}=fixture(t,async()=>{calls++;if(fail)throw Error('native read failed');state.invalidateSessions('name');return {data:[{id:'obsolete'}],nextCursor:null};});
 assert.deepEqual(await state.readSessions(query),{pending:true});assert.equal(calls,2);
 fail=true;await assert.rejects(state.readSessions(query,true),/native read failed/);
 await assert.rejects(state.readSessions(query),/native read failed/);assert.equal(calls,3,'a passive read must use the real failure cache, not restart pending');
});

test('an exhausted follow-up ends its deadline and manual recovery receives a new bounded cycle',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1_800_000_000_000});let calls=0,mode='conflict';const gate=Promise.withResolvers<any>();
 const {state}=fixture(t,async()=>{calls++;if(mode==='conflict'){state.invalidateSessions('name');return {data:[],nextCursor:null};}return gate.promise;});
 assert.deepEqual(await state.readSessions(query),{pending:true});
 const entry=[...(state as any).entries.values()][0],deadline=entry.followupDeadline;
 assert.deepEqual(await state.readSessions(query),{pending:true});assert.equal(entry.followupDeadline,deadline,'passive pending reads cannot extend the active cycle');
 t.mock.timers.tick(50);assert.deepEqual(await state.readSessions(query,true),{pending:true});assert.equal(entry.followupDeadline,deadline,'a still-pending follow-up cannot extend the same active cycle');
 mode='held';const followup=state.readSessions(query,true),expired=assert.rejects(followup,{code:'SHARED_STATE_UNAVAILABLE'});t.mock.timers.tick(29_950);await expired;
 const recovery=state.readSessions(query,true),settled=recovery.then(value=>({value}),error=>({error}));t.mock.timers.tick(10);await flush();gate.resolve({data:[{id:'ready'}],nextCursor:null});const result=await settled;
 assert.equal(result.error,undefined,'manual recovery must not inherit a one millisecond expired deadline');assert.deepEqual(result.value.data,[{id:'ready'}]);assert.equal(calls,6);
});
test('a version conflict exactly at the absolute deadline closes pending without poisoning manual recovery',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_800_000_000_000});let calls=0,mode='conflict',boundary=0;
 const {state}=fixture(t,async()=>{calls++;if(mode==='conflict'){state.invalidateSessions('name');if(boundary)t.mock.timers.tick(boundary);return {data:[],nextCursor:null};}await new Promise(resolve=>setTimeout(resolve,10));return {data:[{id:'ready'}],nextCursor:null};});
 assert.deepEqual(await state.readSessions(query),{pending:true});boundary=15_000;
 assert.deepEqual(await state.readSessions(query,true),{pending:true});const entry=[...(state as any).entries.values()][0];
 assert.equal(entry.followupDeadline,undefined,'completion microtasks at deadline must terminate the old cycle before its timer callback');assert.equal(entry.dirty,false);
 mode='ready';const ready=await state.readSessions(query,true);assert.deepEqual(ready.data,[{id:'ready'}]);assert.equal(calls,5);
});

test('diagnostics correlate a shared job and invalidations without query or error text',async t=>{
 const events:DiagnosticEvent[]=[],release=Promise.withResolvers<void>();const {runtime,state}=fixture(t,async()=>{await release.promise;return {data:[],nextCursor:null};},event=>events.push(event));
 const privateQuery={...query,searchTerm:'private-search-content',cursor:'private-cursor-content'};
 const first=state.readSessions(privateQuery,false,true,'req-first'),second=state.readSessions(privateQuery,false,true,'req-second');soft(runtime,'release');release.resolve();await Promise.all([first,second]);
 const start=events.find(row=>row.event==='shared_sessions_start'),join=events.find(row=>row.event==='shared_sessions_join'),end=events.find(row=>row.event==='shared_sessions_end'),invalidation=events.find(row=>row.event==='shared_sessions_invalidation');
 assert.ok(start&&join&&end&&invalidation);assert.equal(start.requestId,'req-first');assert.equal(join.requestId,'req-second');assert.equal(join.readId,start.readId);assert.equal(end.readId,start.readId);assert.equal(end.outcome,'ok');assert.equal(invalidation.kind,'soft');assert.equal(invalidation.reason,'release');assert.equal(invalidation.version,start.version);
 assert.doesNotMatch(JSON.stringify(events),/private-search|private-cursor|synthetic-thread/);
});

test('diagnostic callback exceptions cannot alter either soft success or hard failure',async t=>{
 let fail=false;const {runtime,state}=fixture(t,async()=>{if(fail)throw Error('expected failure');return {data:[],nextCursor:null};},()=>{throw Error('sink failure');});
 await state.readSessions(query);soft(runtime);assert.deepEqual((await state.readSessions(query)).data,[]);fail=true;state.invalidateSessions();await assert.rejects(state.readSessions(query),/expected failure/);
});

test('owned deadline and close retain final diagnostics and prevent late publication or dirty follow-up',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_800_000_000_000});const events:DiagnosticEvent[]=[],release=Promise.withResolvers<void>();let calls=0,publications=0;
 const {runtime,state}=fixture(t,async()=>{calls++;await release.promise;return {data:[{id:'late'}],nextCursor:null};},event=>events.push(event));state.subscribe(()=>true,kind=>{if(kind==='sessions')publications++;});
 const reading=state.readSessions(query),failure=assert.rejects(reading,{code:'SHARED_STATE_UNAVAILABLE'});soft(runtime);t.mock.timers.tick(30_000);await failure;assert.equal(events.find(row=>row.event==='shared_sessions_end')?.outcome,'deadline');state.close();const count=publications;release.resolve();await flush();t.mock.timers.tick(60_000);await flush();assert.equal(publications,count);assert.equal(calls,1);
});

test('closing a soft-dirty job records its closed outcome and cancels subsequent work',async t=>{
 const events:DiagnosticEvent[]=[],release=Promise.withResolvers<void>();let calls=0,publications=0;
 const {runtime,state}=fixture(t,async()=>{calls++;await release.promise;return {data:[],nextCursor:null};},event=>events.push(event));state.subscribe(()=>true,kind=>{if(kind==='sessions')publications++;});
 const reading=state.readSessions(query),failure=assert.rejects(reading,{code:'SHARED_STATE_UNAVAILABLE'});soft(runtime);state.close();await failure;release.resolve();await flush();
 assert.equal(events.find(row=>row.event==='shared_sessions_end')?.outcome,'closed');assert.equal(calls,1);assert.equal(publications,0);
});

test('passive read before manual refresh cannot hide an expired shared active handle',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});let calls=0;const gate=Promise.withResolvers<any>();const {runtime,state}=fixture(t,async()=>{calls++;if(calls<=2){state.invalidateSessions('name');return {data:[],nextCursor:null};}if(calls===3)return gate.promise;await new Promise(resolve=>setTimeout(resolve,10));return {data:[{id:'ready'}],nextCursor:null};});
 assert.deepEqual(await state.readSessions(query),{pending:true});const expired=state.readSessions(query,true),failed=assert.rejects(expired,{code:'SHARED_STATE_UNAVAILABLE'});await flush();t.mock.timers.tick(30000);const passive=state.readSessions(query).catch(error=>error);await flush();assert.equal(calls,3,'passive read cannot start a new budget');const manual=state.readSessions(query,true),settled=manual.then(value=>({value}),error=>({error}));await flush();assert.equal(calls,4,'manual must start a fresh read after passive observes the expired active job');const result=await settled;assert.equal(result.error,undefined);assert.equal(result.value.data[0].id,'ready');await failed;await passive;assert.equal(calls,4);gate.resolve({data:[],nextCursor:null});await flush();assert.equal((await state.readSessions(query)).data[0].id,'ready');
});
