import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/codex/runtime.ts';

const fixture = fileURLToPath(new URL('./fixtures/runtime-server.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));
const input = { lastTurnId:'first', clientRequestId:'fork-request-1' };
const turns = [{id:'first',status:'completed',items:[]},{id:'future',status:'completed',items:[]}];

async function start(t:any, mode='normal', history=turns, source:any={}) {
  const runtime = new Runtime({executable:process.execPath,args:[fixture,mode],cwd,idleMs:60_000});
  t.after(()=>runtime.close().catch(()=>{}));
  await (runtime as any).call('fixture/native-thread',{threadId:'source',status:{type:'notLoaded'},thread:{cwd,turns:history,...source}});
  return runtime;
}
const stats = (runtime:Runtime) => (runtime as any).call('fixture/stats',{});

test('native fork keeps only the selected completed prefix without touching the source', async t=>{
  const runtime=await start(t);
  const result=await runtime.fork('source',input);
  assert.deepEqual({threadId:result.threadId,status:result.status,cwd:result.cwd},{threadId:'fork-1',status:'idle',cwd});
  assert.equal(result.header.id,'fork-1');assert.equal(result.header.forkedFromId,'source');assert.equal(result.header.turns,undefined);
  const before=await stats(runtime);
  assert.deepEqual(before.lastFork,{threadId:'source',lastTurnId:'first',excludeTurns:true});
  assert.equal(before.resumes,0);assert.equal(before.turnStarts,0);assert.equal(before.itemLists,0);
  assert.deepEqual((await (runtime as any).readThread('fork-1',{headersOnly:true})).turns.map((turn:any)=>turn.id),['first']);
  assert.deepEqual((await (runtime as any).readThread('source',{headersOnly:true})).turns.map((turn:any)=>turn.id),['first','future']);
  assert.ok((await runtime.list()).data.some(thread=>thread.id==='fork-1'));
  assert.equal((await runtime.snapshot('fork-1')).phase,'IDLE');
  await runtime.open('fork-1');
  assert.equal((await stats(runtime)).resumes,0,'fork effective state must already be registered');
});

for(const [name,history,code,statusCode] of [
  ['missing',[], 'RUNTIME_NOT_FOUND',404],
  ['inProgress',[{id:'first',status:'inProgress',items:[]}],'RUNTIME_FORK_TURN_INCOMPLETE',409],
  ['failed',[{id:'first',status:'failed',items:[]}],'RUNTIME_FORK_TURN_INCOMPLETE',409],
] as const) test(`fork rejects a ${name} target before mutation`,async t=>{
  const runtime=await start(t,'normal',history as any);
  await assert.rejects(runtime.fork('source',input),{code,statusCode});
  assert.equal((await stats(runtime)).forks,0);assert.equal((await stats(runtime)).resumes,0);
});

test('fork rejects subagent sources without creating a branch',async t=>{
  const runtime=await start(t,'normal',turns,{parentThreadId:'parent'});
  await assert.rejects(runtime.fork('source',input),{code:'RUNTIME_SUBAGENT_THREAD',statusCode:404});
  assert.equal((await stats(runtime)).forks,0);
});

test('concurrent fork requests share one mutation and conflict on changed content',async t=>{
  const runtime=await start(t);
  const first=runtime.fork('source',input),duplicate=runtime.fork('source',{...input});
  assert.strictEqual(first,duplicate);
  assert.deepEqual(await first,await duplicate);
  await assert.rejects(runtime.fork('source',{...input,lastTurnId:'future'}),{code:'RUNTIME_IDEMPOTENCY_CONFLICT',statusCode:409});
  await assert.rejects(runtime.fork('other',input),{code:'RUNTIME_IDEMPOTENCY_CONFLICT',statusCode:409});
  assert.equal((await stats(runtime)).forks,1);
});

for(const [mode,code,statusCode,partial] of [
  ['fork-unsupported','RUNTIME_FORK_UNSUPPORTED',409,false],
  ['fork-source-id','RUNTIME_RESULT_UNKNOWN',504,false],
  ['fork-missing-thread','RUNTIME_RESULT_UNKNOWN',504,false],
  ['fork-missing-cwd','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-missing-model','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-missing-reasoningEffort','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-missing-approvalPolicy','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-future','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-readback-malformed','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-active','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-wrong-cwd','RUNTIME_RESULT_UNKNOWN',504,true],
  ['fork-permission','RUNTIME_PERMISSION_MISMATCH',503,true],
] as const) test(`${mode} never claims fork success or sends a second mutation`,async t=>{
  const runtime=await start(t,mode);
  const pending=runtime.fork('source',input);
  await assert.rejects(pending,(error:any)=>{assert.equal(error.code,code);assert.equal(error.statusCode,statusCode);assert.deepEqual(error.partial,partial?{threadId:'fork-1'}:undefined);return true;});
  assert.strictEqual(runtime.fork('source',input),pending);
  assert.equal((await stats(runtime)).forks,1);
});

for(const mode of ['fork-timeout','fork-disconnect']) test(`${mode} is unknown and cached without retry`,async t=>{
  const runtime=await start(t,mode);
  (runtime as any).server.timeoutMs=100;
  const pending=runtime.fork('source',input);
  await assert.rejects(pending,{code:'RUNTIME_RESULT_UNKNOWN',statusCode:504});
  assert.strictEqual(runtime.fork('source',input),pending);
  if(mode==='fork-timeout')assert.equal((await stats(runtime)).forks,1);
});

test('fork readback disconnect retains the created ID without retrying mutation',async t=>{
  const runtime=await start(t,'fork-readback-disconnect');
  const pending=runtime.fork('source',input);
  await assert.rejects(pending,(error:any)=>{assert.equal(error.code,'RUNTIME_RESULT_UNKNOWN');assert.equal(error.statusCode,504);assert.deepEqual(error.partial,{threadId:'fork-1'});return true;});
  assert.strictEqual(runtime.fork('source',input),pending);
});

for(const mode of ['fork-missing-approvalPolicy','fork-missing-model','fork-missing-cwd','fork-permission']) test(`${mode} partial opens with verified native config and can send`,async t=>{
  const runtime=await start(t,mode);
  const pending=runtime.fork('source',input);
  await assert.rejects(pending,(error:any)=>{assert.deepEqual(error.partial,{threadId:'fork-1'});return true;});
  assert.equal((await stats(runtime)).resumes,0,'failed fork must not resume the source');
  assert.deepEqual(await runtime.open('fork-1'),{phase:'IDLE'});
  const opened=await stats(runtime);
  assert.equal(opened.resumes,1,'partial thread must acquire effective config before becoming owned');
  assert.deepEqual(opened.lastResume,{threadId:'fork-1',excludeTurns:true});
  const sent=await runtime.send('fork-1',{text:'continue partial',clientRequestId:'partial-send-1'});
  assert.equal(sent.threadId,'fork-1');assert.equal(sent.turnId,'turn-1');
  const after=await stats(runtime);
  assert.equal(after.forks,1);assert.equal(after.resumes,1);assert.equal(after.turnStarts,1);
  assert.equal(after.lastTurn.approvalPolicy,'on-request');
  assert.equal(after.lastTurn.approvalsReviewer,'user');
  assert.deepEqual(after.lastTurn.sandboxPolicy,{type:'dangerFullAccess'});
  assert.strictEqual(runtime.fork('source',input),pending,'opening partial must preserve the original idempotency result');
  assert.deepEqual((await (runtime as any).readThread('source',{headersOnly:true})).turns.map((turn:any)=>turn.id),['first','future']);
});
