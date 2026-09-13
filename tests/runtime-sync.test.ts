import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/codex/runtime.ts';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/runtime-server.mjs', import.meta.url));
function start(t: any, mode = 'normal') {
  const runtime = new Runtime({ executable: process.execPath, args: [fixture, mode], cwd, idleMs: 60000 });
  t.after(() => runtime.close());
  return runtime;
}
test('snapshot cursor replays compact text changes and authoritative completion', async t => {
  const runtime = start(t), changes: any[] = [];
  const { threadId } = await runtime.create({cwd,clientRequestId:'create'});
  const baseline = await runtime.snapshot(threadId);
  assert.equal(typeof baseline.syncCursor, 'string');
  runtime.on('change', event => changes.push(event));
  await runtime.send(threadId,{text:'stream-complete',clientRequestId:'stream'});
  await runtime.snapshot(threadId);
  const delta = changes.find(event => event.kind === 'delta');
  assert.deepEqual(delta.patch.delta, {turnId:'turn-1',itemId:'item-turn-1',field:'text',offset:0,text:'partial'});
  assert.ok(JSON.stringify(delta).length < 1500);
  assert.equal(delta.patch.turn, undefined);
  const item = changes.find(event => event.patch?.item?.completed);
  assert.equal(item.patch.item.item.text, 'final');
  assert.ok(changes.some(event => event.patch?.turn?.status === 'completed'));
  assert.deepEqual(runtime.replay(threadId,baseline.syncCursor).events,changes);
  assert.deepEqual(changes.map(event=>event.revision), changes.map((_,i)=>baseline.revision+i+1));
});
test('snapshot keeps completion delivered after stale terminal history was read', async t => {
  const runtime = start(t);
  const {threadId,turnId} = await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
  const gate = Promise.withResolvers<any>();
  t.mock.method(runtime as any,'readThread',()=>gate.promise);
  const loading = runtime.snapshot(threadId);
  (runtime as any).onNotification({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{id:'final',type:'agentMessage',text:'new final'}]}}});
  gate.resolve({id:threadId,status:{type:'idle'},turns:[{id:turnId,status:'completed',items:[{id:'old',type:'agentMessage',text:'stale'}]}]});
  const snapshot = await loading;
  assert.equal(snapshot.thread.turns[0].items.find((i:any)=>i.id==='final')?.text,'new final');
  assert.equal(runtime.replay(threadId,snapshot.syncCursor).events.length,0);
});
test('status checks reuse terminal history and detect external changes',async t=>{
  const runtime=start(t,'sync-history');
  const {threadId}=await runtime.create({cwd,clientRequestId:'create',prompt:'done'});
  const snapshot=await runtime.snapshot(threadId);
  const before=await (runtime as any).call('fixture/stats',{});
  for(let i=0;i<3;i++) assert.deepEqual(await (runtime as any).status(threadId,snapshot.epoch),{resync:false});
  const after=await (runtime as any).call('fixture/stats',{});
  assert.equal(after.itemLists,before.itemLists);
  await (runtime as any).call('fixture/external-change',{threadId});
  assert.deepEqual(await (runtime as any).status(threadId,snapshot.epoch),{resync:true});
  assert.deepEqual(await (runtime as any).status(threadId,'old-epoch'),{resync:true});
});

test('oversized changes demand resync and never enter the byte bounded replay journal', async t => {
  const runtime=start(t);
  const {threadId,turnId}=await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
  const baseline=await runtime.snapshot(threadId);
  const changes:any[]=[];runtime.on('change',event=>changes.push(event));
  (runtime as any).onNotification({method:'item/completed',params:{threadId,turnId,item:{id:'huge',type:'agentMessage',text:'x'.repeat(100000)}}});
  assert.equal(changes[0].kind,'resync');
  assert.ok(JSON.stringify(changes[0]).length<1000);
  assert.equal(runtime.replay(threadId,baseline.syncCursor).events[0].kind,'resync');
});
test('snapshot text overlap and oversized final items retain the watermarked content',async t=>{
  const runtime=start(t);
  const {threadId,turnId}=await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
  const gate=Promise.withResolvers<any>();t.mock.method(runtime as any,'readThread',()=>gate.promise);
  const loading=runtime.snapshot(threadId);
  const notify=(method:string,extra:any)=> (runtime as any).onNotification({method,params:{threadId,turnId,...extra}});
  notify('item/started',{item:{id:'text',type:'agentMessage',text:''}});
  notify('item/agentMessage/delta',{itemId:'text',delta:'hello'});
  notify('item/agentMessage/delta',{itemId:'text',delta:' world'});
  notify('item/completed',{item:{id:'huge',type:'agentMessage',text:'x'.repeat(100000)}});
  notify('turn/completed',{turn:{id:turnId,status:'completed',items:[{id:'text',type:'agentMessage',text:'hello world'},{id:'huge',type:'agentMessage',text:'x'.repeat(100000)}]}});
  gate.resolve({id:threadId,status:{type:'idle'},turns:[{id:turnId,status:'completed',items:[]}]});
  const snapshot=await loading;
  assert.equal(snapshot.thread.turns[0].items.find((item:any)=>item.id==='text')?.text,'hello world');
  assert.equal(snapshot.thread.turns[0].items.find((item:any)=>item.id==='huge')?.text.length,100000);
});

test('native active text seeds delta offsets and status stays light across local completion',async t=>{
  const runtime=start(t,'sync-history');
  const {threadId,turnId}=await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
  const baseline=await runtime.snapshot(threadId);
  assert.deepEqual(await runtime.status(threadId,baseline.epoch),{resync:false});
  await runtime.abort(threadId);
  assert.deepEqual(await runtime.status(threadId,baseline.epoch),{resync:false});
  assert.deepEqual(await runtime.status(threadId,baseline.epoch),{resync:false});
  const native={id:'external',status:{type:'active'},turns:[{id:'active',status:'inProgress',items:[{id:'message',type:'agentMessage',text:'prefix'}]}]};
  t.mock.method(runtime as any,'readThread',async()=>structuredClone(native));
  await runtime.snapshot('external');
  let event:any;runtime.on('change',value=>event=value);
  (runtime as any).onNotification({method:'item/agentMessage/delta',params:{threadId:'external',turnId:'active',itemId:'message',delta:' suffix'}});
  assert.equal(event.patch.delta.offset,6);
});
test('steering sends the accepted native item without reloading historical turns',async t=>{
  const runtime=start(t,'steering');
  const {threadId,turnId}=await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
  const baseline=await runtime.snapshot(threadId), events:any[]=[];
  runtime.on('change',event=>events.push(event));
  await runtime.send(threadId,{text:'continue with this',expectedTurnId:turnId,clientRequestId:'steer-sync'});
  const item=events.find(event=>event.patch?.item?.item?.clientId==='steer-sync');
  assert.equal(item?.patch.item.item.type,'userMessage');
  assert.ok(!events.some(event=>event.kind==='resync'));
  assert.equal(runtime.replay(threadId,baseline.syncCursor).events.length,events.length);
});

test('status preserves the same-epoch unmaterialized empty-thread fallback',async t=>{
  for(const mode of ['unmaterialized-current','unsupported-empty']){
    const runtime=start(t,mode);
    const {threadId}=await runtime.create({cwd,clientRequestId:'empty'});
    const snapshot=await runtime.snapshot(threadId);
    assert.equal(snapshot.unmaterialized,true);
    assert.deepEqual(await runtime.status(threadId,snapshot.epoch),{resync:false});
    await runtime.send(threadId,{text:'hold',clientRequestId:'first-message'});
    await assert.rejects(runtime.status(threadId,snapshot.epoch),(error:any)=>error.code==='RUNTIME_HISTORY_UNSUPPORTED');
  }
});

test('bounded status baselines evict to authoritative resync instead of stale cache reuse',async t=>{
  const runtime=start(t);
  await runtime.diagnostics();
  t.mock.method(runtime as any,'readThread',async(id:string)=>({id,status:{type:'idle'},turns:[{id:'old',status:'completed',error:{message:'x'.repeat(1100000)},items:[]}]}));
  const oldest=await runtime.snapshot('history-0');
  for(let i=1;i<9;i++) await runtime.snapshot('history-'+i);
  t.mock.method(runtime as any,'call',async(method:string,params:any)=>method==='thread/read'?{thread:{id:params.threadId,status:{type:'idle'},turns:[]}}:{data:[{id:'old',status:'completed',error:{message:'x'.repeat(1100000)}}],nextCursor:null});
  assert.deepEqual(await runtime.status('history-0',oldest.epoch),{resync:true});
  assert.equal((await runtime.snapshot('history-0')).thread.turns[0].error.message.length,1100000);
});

test('sparse terminal history preserves captured items while native replacements remain authoritative',async t=>{
  for(const nativeItems of [[],[{id:'msg',type:'agentMessage',text:'authoritative final'}]]){
    const runtime=start(t);
    const {threadId,turnId}=await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
    const gate=Promise.withResolvers<any>();t.mock.method(runtime as any,'readThread',()=>gate.promise);
    const loading=runtime.snapshot(threadId);
    const notify=(method:string,extra:any)=>(runtime as any).onNotification({method,params:{threadId,turnId,...extra}});
    notify('item/started',{item:{id:'msg',type:'agentMessage',text:''}});
    notify('item/agentMessage/delta',{itemId:'msg',delta:'captured text'});
    notify('turn/completed',{turn:{id:turnId,status:'interrupted',items:[]}});
    gate.resolve({id:threadId,status:{type:'idle'},turns:[{id:turnId,status:'interrupted',items:nativeItems}]});
    const snapshot=await loading;
    assert.equal(snapshot.thread.turns[0].items[0]?.text,nativeItems.length?'authoritative final':'captured text');
    assert.equal(runtime.replay(threadId,snapshot.syncCursor).events.length,0);
  }
});
