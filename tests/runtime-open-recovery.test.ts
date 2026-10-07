import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/codex/runtime.ts';

async function staleCompletion(t:any,source='history'){
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url)),'steering'],cwd:fileURLToPath(new URL('..',import.meta.url)),sandbox:'danger-full-access'});
  t.after(()=>runtime.close());
  const {threadId,turnId}=await runtime.create({cwd:fileURLToPath(new URL('..',import.meta.url)),clientRequestId:'create',prompt:'hold'});
  const native=(await runtime.snapshot(threadId)).thread;
  const read=t.mock.method(runtime as any,'readThread',async()=>({...structuredClone(native),turns:native.turns.map((turn:any)=>({...turn,status:'completed'}))}));
  if(source==='history')await runtime.snapshot(threadId);
  else {
    (runtime as any).onNotification({method:'turn/completed',params:{threadId,turn:{...native.turns[0],status:'completed'}}});
    (runtime as any).onNotification({method:'thread/status/changed',params:{threadId,status:{type:'active',activeFlags:[]}}});
  }
  read.mock.mockImplementation(async()=>({...structuredClone(native),turns:[]}));
  await assert.rejects(runtime.open(threadId),{message:'Native thread activity could not be reconciled'});
  read.mock.restore();
  return {runtime,threadId,turnId,native};
}

for(const source of ['history','notification'])for(const entry of ['open','snapshot','release'])test(`${entry} reconciles a cached ${source} completion against fresh owned active history`,async t=>{
  const {runtime,threadId,turnId}=await staleCompletion(t,source);
  if(entry==='open')assert.equal((await runtime.open(threadId)).phase,'RUNNING');
  if(entry==='release')await assert.rejects(runtime.release(threadId),{code:'RUNTIME_THREAD_BUSY'});
  const snapshot=await runtime.snapshot(threadId);
  assert.equal(snapshot.phase,'RUNNING');
  assert.equal(snapshot.activeTurnId,turnId);
  assert.equal(snapshot.error,undefined);
  assert.equal(snapshot.thread.turns.at(-1).status,'inProgress');
  let delta:any;
  runtime.on('change',event=>{if(event.patch.delta)delta=event.patch.delta;});
  (runtime as any).onNotification({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'after-recovery',delta:'still running'}});
  assert.equal(delta?.text,'still running');
  assert.equal((await runtime.send(threadId,{text:'continue',clientRequestId:'steer',expectedTurnId:turnId})).status,'steered');
  const stats=await (runtime as any).call('fixture/stats',{});
  assert.equal(stats.turnStarts,1);assert.equal(stats.resumes,0);assert.equal(stats.interrupts,0);assert.equal(stats.unsubscribes,0);
});

test('a completion delivered during open cannot be resurrected by its earlier active history',async t=>{
  const {runtime,threadId,turnId,native}=await staleCompletion(t);
  const gate=Promise.withResolvers<any>(),entered=Promise.withResolvers<void>();
  t.mock.method(runtime as any,'readThread',()=>{entered.resolve();return gate.promise;});
  const opening=runtime.open(threadId);
  await entered.promise;
  (runtime as any).onNotification({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
  gate.resolve(native);
  await assert.rejects(opening,{code:'RUNTIME_THREAD_BUSY'});
  assert.equal((runtime as any).state(threadId).activeTurnId,null);
});

test('active recovery refuses external, released and ambiguous history and preserves unrelated errors',async t=>{
  for(const mode of ['external','released','multiple','other-error']){
    const {runtime,threadId,turnId,native}=await staleCompletion(t);
    const state=(runtime as any).state(threadId);
    if(mode==='external')state.externalWriter=true;
    if(mode==='released')state.released=true;
    if(mode==='multiple'){
      native.turns.push({...native.turns[0],id:'another-active-turn'});
      t.mock.method(runtime as any,'readThread',async()=>native);
    }
    if(mode==='other-error')state.error='Codex requested an unsupported interaction';
    const snapshot=await runtime.snapshot(threadId);
    assert.equal(snapshot.activeTurnId,mode==='other-error'?turnId:null);
    if(mode==='other-error'){
      assert.equal(snapshot.error,'Codex requested an unsupported interaction');
      await assert.rejects(runtime.send(threadId,{text:'blocked',clientRequestId:'blocked',expectedTurnId:turnId}),{code:'RUNTIME_STEER_CONFLICT'});
    }else assert.notEqual(snapshot.phase,'RUNNING');
  }
});

test('reopening during send and after turn start preserves one native turn',async t=>{
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url)),'steering'],cwd:fileURLToPath(new URL('..',import.meta.url)),sandbox:'danger-full-access'});
  t.after(()=>runtime.close());
  const {threadId}=await runtime.create({cwd:fileURLToPath(new URL('..',import.meta.url)),clientRequestId:'create'});
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  const mutation=(runtime as any).mutation.bind(runtime);
  t.mock.method(runtime as any,'mutation',async(method:string,params:any)=>{if(method==='turn/start'){entered.resolve();await gate.promise;}return mutation(method,params);});
  const sending=runtime.send(threadId,{text:'hold',clientRequestId:'original'});
  await entered.promise;
  assert.equal((await runtime.open(threadId)).phase,'RUNNING');
  gate.resolve();const started=await sending;
  assert.equal((await runtime.open(threadId)).phase,'RUNNING');
  const snapshot=await runtime.snapshot(threadId);
  assert.equal(snapshot.activeTurnId,started.turnId);
  assert.deepEqual(snapshot.thread.turns.flatMap((turn:any)=>turn.items.map((item:any)=>item.clientId)),['original']);
  assert.equal((await (runtime as any).call('fixture/stats',{})).turnStarts,1);
});
