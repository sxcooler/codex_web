import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { Runtime } from '../src/codex/runtime.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';
import {Projects} from '../src/projects.ts';
import {MetadataStore} from '../src/server/metadata.ts';

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

test('fork names only the new native thread inside the idempotent operation',async t=>{
  const runtime=await start(t,'normal',turns,{name:'Navigation'});let namingCalls=0;
  const name=(source:any)=>{namingCalls++;assert.equal(source.name,'Navigation');return 'Navigation（1）';};
  const pending=runtime.fork('source',input,name);
  assert.strictEqual(runtime.fork('source',input,name),pending);
  const result=await pending;
  assert.equal(result.header.name,'Navigation（1）');assert.equal(namingCalls,1);
  assert.equal((await (runtime as any).readThread('fork-1',{headersOnly:true})).name,'Navigation（1）');
  assert.equal((await (runtime as any).readThread('source',{headersOnly:true})).name,'Navigation');
  assert.equal((await stats(runtime)).forks,1);
});

test('fork naming failure retains the created ID and never repeats native fork on retry',async t=>{
  const runtime=await start(t,'fork-name-fail');let namingCalls=0;
  const name=()=>{namingCalls++;return 'Navigation（1）';};
  const pending=runtime.fork('source',input,name);
  await assert.rejects(pending,(error:any)=>{assert.equal(error.code,'RUNTIME_RESULT_UNKNOWN');assert.deepEqual(error.partial,{threadId:'fork-1'});return true;});
  assert.strictEqual(runtime.fork('source',input,name),pending);
  assert.equal((await stats(runtime)).forks,1);assert.equal(namingCalls,1);
});

test('Web fork API persists native numbered names, retries once and flattens descendant forks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'numbered-fork-api-'));
  const runtime=new Runtime({executable:process.execPath,args:[fixture],cwd:dir,idleMs:60_000});
  let app:any;
  try{
    await initializeAuth(dir,'fork-api-password-long');
    app=await buildServer({dataDir:dir,origin:'http://localhost:3000',projects:new Projects(dir),runtime});
    await (runtime as any).call('fixture/native-thread',{threadId:'source',status:{type:'notLoaded'},thread:{cwd:dir,name:'Navigation',turns}});
    const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
    const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:csrf.headers['set-cookie'].split(';')[0]};
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'fork-api-password-long'}});
    headers.cookie+='; '+login.headers['set-cookie'].split(';')[0];
    const fork=(source:string,clientRequestId:string)=>app.inject({method:'POST',url:`/api/sessions/${source}/fork`,headers,payload:{lastTurnId:'first',clientRequestId}});
    const first=await fork('source','numbered-request-1');assert.equal(first.statusCode,200,first.body);
    assert.equal((await fork('source','numbered-request-1')).json().threadId,first.json().threadId);
    const child=await fork(first.json().threadId,'numbered-request-2');assert.equal(child.statusCode,200,child.body);
    assert.equal((await (runtime as any).readThread(first.json().threadId,{headersOnly:true})).name,'Navigation（1）');
    assert.equal((await (runtime as any).readThread(child.json().threadId,{headersOnly:true})).name,'Navigation（2）');
    assert.equal((await (runtime as any).readThread('source',{headersOnly:true})).name,'Navigation');
    assert.equal((await stats(runtime)).forks,2);
    const metadata=new MetadataStore(join(dir,'metadata.sqlite'));
    try{assert.deepEqual(metadata.knownForks().map(row=>row.header.name),['Navigation（2）','Navigation（1）']);}finally{metadata.close();}
  }finally{await app?.close();await runtime.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('native fork keeps only the selected completed prefix without touching the source', async t=>{
  const runtime=await start(t);
  const result=await runtime.fork('source',input);
  assert.deepEqual({threadId:result.threadId,status:result.status,cwd:result.cwd},{threadId:'fork-1',status:'idle',cwd});
  assert.equal(result.header.id,'fork-1');assert.equal(result.header.forkedFromId,'source');assert.equal(result.header.turns,undefined);
  const before=await stats(runtime);
  assert.deepEqual(before.lastFork,{threadId:'source',lastTurnId:'first',excludeTurns:true,model:'fixture'});
  assert.equal(before.resumes,0);assert.equal(before.turnStarts,0);assert.equal(before.itemLists,0);
  assert.deepEqual((await (runtime as any).readThread('fork-1',{headersOnly:true})).turns.map((turn:any)=>turn.id),['first']);
  assert.deepEqual((await (runtime as any).readThread('source',{headersOnly:true})).turns.map((turn:any)=>turn.id),['first','future']);
  assert.ok((await runtime.list()).data.some(thread=>thread.id==='fork-1'));
  assert.equal((await runtime.snapshot('fork-1')).phase,'IDLE');
  await runtime.open('fork-1');
  assert.equal((await stats(runtime)).resumes,0,'fork effective state must already be registered');
});

test('fork inherits saved non-default settings without resuming the source and keeps them for its first turn',async t=>{
  const runtime=await start(t,'normal',turns,{model:'gpt-6-astra',reasoningEffort:'max'});
  const result=await runtime.fork('source',input);
  const snapshot=await runtime.snapshot(result.threadId);
  assert.equal(snapshot.model,'gpt-6-astra');assert.equal(snapshot.reasoningEffort,'max');
  const before=await stats(runtime);
  assert.deepEqual(before.lastFork,{threadId:'source',lastTurnId:'first',excludeTurns:true,model:'gpt-6-astra',config:{model_reasoning_effort:'max'}});
  assert.equal(before.resumes,0);assert.equal(before.turnStarts,0);
  await runtime.send(result.threadId,{text:'continue',clientRequestId:'inherited-settings-turn'});
  const continued=await runtime.snapshot(result.threadId);
  assert.equal(continued.model,'gpt-6-astra');assert.equal(continued.reasoningEffort,'max');
  const after=await stats(runtime);
  assert.equal(after.lastTurn.model,undefined);assert.equal(after.lastTurn.effort,undefined);assert.equal(after.resumes,0);
  const source=await (runtime as any).readThread('source',{headersOnly:true});
  assert.equal(source.model,'gpt-6-astra');assert.equal(source.reasoningEffort,'max');
});

test('fork reads current native settings instead of stale Web state and descendant forks keep them',async t=>{
  const runtime=await start(t);
  await runtime.open('source');
  await (runtime as any).call('fixture/native-thread',{threadId:'source',status:{type:'idle'},thread:{cwd,turns,model:'gpt-6-astra',reasoningEffort:'max'}});
  const first=await runtime.fork('source',input);
  const child=await runtime.fork(first.threadId,{...input,clientRequestId:'settings-descendant'});
  for(const id of [first.threadId,child.threadId]){
    const snapshot=await runtime.snapshot(id);
    assert.equal(snapshot.model,'gpt-6-astra');assert.equal(snapshot.reasoningEffort,'max');
    assert.deepEqual(snapshot.thread.turns.map((turn:any)=>turn.id),['first']);
  }
  assert.equal((await stats(runtime)).resumes,1,'forks must not resume their sources');
});

for(const reasoningEffort of [null,undefined]) test(`fork leaves ${reasoningEffort} effort unset instead of using stale Web settings`,async t=>{
  const runtime=await start(t);
  await runtime.open('source');
  (runtime as any).state('source').reasoningEffort='high';
  await (runtime as any).call('fixture/native-thread',{threadId:'source',status:{type:'idle'},thread:{cwd,turns,model:'gpt-6-astra',reasoningEffort},omit:reasoningEffort===undefined?['reasoningEffort']:[]});
  const result=await runtime.fork('source',input);
  assert.deepEqual((await stats(runtime)).lastFork,{threadId:'source',lastTurnId:'first',excludeTurns:true,model:'gpt-6-astra'});
  assert.equal((await runtime.snapshot(result.threadId)).reasoningEffort,null);
});

for(const model of [null,undefined]) test(`fork leaves ${model} model unset instead of using stale Web settings`,async t=>{
  const runtime=await start(t);
  await runtime.open('source');
  (runtime as any).state('source').model='stale-model';
  await (runtime as any).call('fixture/native-thread',{threadId:'source',status:{type:'idle'},thread:{cwd,turns,model},omit:model===undefined?['model']:[]});
  const result=await runtime.fork('source',input);
  assert.deepEqual((await stats(runtime)).lastFork,{threadId:'source',lastTurnId:'first',excludeTurns:true});
  assert.equal((await runtime.snapshot(result.threadId)).model,'fixture');
});

for(const mode of ['fork-model-mismatch','fork-effort-mismatch']) test(`${mode} preserves the partial result and never repeats the fork`,async t=>{
  const runtime=await start(t,mode,turns,{model:'gpt-6-astra',reasoningEffort:'max'});
  const pending=runtime.fork('source',input);
  await assert.rejects(pending,(error:any)=>{assert.equal(error.code,'RUNTIME_RESULT_UNKNOWN');assert.deepEqual(error.partial,{threadId:'fork-1'});return true;});
  assert.strictEqual(runtime.fork('source',input),pending);
  assert.equal((await stats(runtime)).forks,1);
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
  const openedState=await runtime.open('fork-1');
  assert.deepEqual(openedState,{phase:'IDLE',epoch:(runtime as any).epoch});
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
