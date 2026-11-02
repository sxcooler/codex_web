import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/codex/runtime.ts';
import {applyChange} from '../src/web/sessionSync.ts';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/runtime-server.mjs', import.meta.url));

test('reasoning streams indexed parts through snapshots, replay and authoritative completion',async t=>{
  const runtime=start(t),{threadId,turnId}=await runtime.create({cwd,clientRequestId:'reasoning',prompt:'hold'});
  let browser:any=await runtime.snapshot(threadId);const cursor=browser.syncCursor,changes:any[]=[];
  runtime.on('change',event=>{changes.push(event);browser=applyChange(browser,event);assert.ok(browser,'delta must extend browser baseline');});
  const notify=(method:string,extra:any)=>(runtime as any).onNotification({method,params:{threadId,turnId,itemId:'reason',...extra}});
  notify('item/reasoning/summaryPartAdded',{summaryIndex:0});
  notify('item/reasoning/summaryTextDelta',{summaryIndex:0,delta:'检查'});
  notify('item/reasoning/summaryTextDelta',{summaryIndex:0,delta:'接口'});
  notify('item/reasoning/summaryTextDelta',{summaryIndex:1,delta:'验证行为'});
  notify('item/reasoning/textDelta',{contentIndex:0,delta:'接口提供的说明'});
  const item=()=>browser.thread.turns.find((turn:any)=>turn.id===turnId).items.find((item:any)=>item.id==='reason');
  assert.deepEqual(item()?.summary,['检查接口','验证行为']);assert.deepEqual(item()?.content,['接口提供的说明']);
  assert.deepEqual(changes.filter(e=>e.patch.delta?.text).map(e=>e.patch.delta.offset),[0,2,0,0]);
  assert.ok(changes.every(e=>JSON.stringify(e).length<1500));assert.deepEqual(runtime.replay(threadId,cursor).events,changes);
  const full=await runtime.snapshot(threadId);assert.deepEqual(full.thread.turns.find((turn:any)=>turn.id===turnId).items.find((item:any)=>item.id==='reason').summary,item().summary);
  const count=changes.length;notify('item/reasoning/summaryTextDelta',{summaryIndex:-1,delta:'invalid'});notify('item/reasoning/textDelta',{contentIndex:1.5,delta:'invalid'});assert.equal(changes.length,count);
  notify('item/completed',{item:{type:'reasoning',id:'reason',summary:['最终摘要'],content:[]}});
  notify('item/reasoning/summaryTextDelta',{summaryIndex:0,delta:'late'});assert.deepEqual(item().summary,['最终摘要']);
  const thread=structuredClone(browser.thread);thread.turns.find((turn:any)=>turn.id===turnId).items=[{type:'reasoning',id:'reason',summary:['检查接'],content:[]}];
  (runtime as any).mergeSnapshotPatch(thread,{delta:{turnId,itemId:'reason',field:'summary',index:0,offset:2,text:'接口'}});
  assert.deepEqual(thread.turns.find((turn:any)=>turn.id===turnId).items[0].summary,['检查接口']);
});

test('snapshot waits for a stopping runtime before capturing its history epoch',async t=>{
  const runtime=start(t,'pagination');const gate=Promise.withResolvers<void>();
  (runtime as any).stopping=gate.promise.finally(()=>{(runtime as any).stopping=undefined;});
  const loading=runtime.snapshot('existing');gate.resolve();
  assert.equal((await loading).thread.id,'existing');
  assert.equal((await runtime.history('existing','recent')).turns[0].id,'old');
});
test('history still rejects an actual runtime change during native pagination',async t=>{
  const runtime=start(t);await runtime.diagnostics();
  t.mock.method(runtime as any,'loadThread',async()=>{(runtime as any).epoch='changed';return {id:'existing',turns:[]};});
  await assert.rejects(runtime.snapshot('existing'),(error:any)=>error.code==='RUNTIME_SYNC_RESTARTED');
});
function start(t: any, mode = 'normal') {
  const runtime = new Runtime({ executable: process.execPath, args: [fixture, mode], cwd, idleMs: 60000 });
  t.after(() => runtime.close());
  return runtime;
}

test('terminal history cannot lock a turn after newer same-ID live activity', async t => {
  const runtime=start(t),{threadId,turnId}=await runtime.create({cwd,clientRequestId:'history-race',prompt:'hold'});
  const gate=Promise.withResolvers<any>();
  t.mock.method(runtime as any,'readThread',()=>gate.promise);
  const loading=runtime.snapshot(threadId);
  (runtime as any).onNotification({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'live',delta:'new activity'}});
  // The read-only verification sees an internally contradictory native page.
  const calls:string[]=[];
  t.mock.method(runtime as any,'loadThread',async()=>{calls.push('read');return {id:threadId,status:{type:'active'},turns:[{id:turnId,status:'interrupted',items:[]}]};});
  gate.resolve({id:threadId,status:{type:'idle'},turns:[{id:turnId,status:'interrupted',items:[]}]});
  const snapshot=await loading;
  assert.equal(snapshot.activeTurnId,turnId);
  assert.equal(snapshot.thread.turns[0].status,'inProgress');
  assert.equal(snapshot.syncConflict,true);
  assert.equal((runtime as any).state(threadId).completedTurns.has(turnId),false);
  assert.equal(calls.length,1);
  let event:any;runtime.on('change',change=>event=change);
  (runtime as any).onNotification({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'live',delta:' continues'}});
  assert.equal(event.patch.delta.text,' continues');
  assert.equal(event.patch.state.syncConflict,true);
});

test('terminal verification is single-flight, retains unresolved evidence, and retries only after new activity',async t=>{
  const runtime=start(t),{threadId,turnId}=await runtime.create({cwd,clientRequestId:'single-check',prompt:'hold'});
  const native={id:threadId,status:{type:'active'},turns:[{id:turnId,status:'interrupted',items:[]}]};
  t.mock.method(runtime as any,'readThread',async()=>structuredClone(native));
  const gate=Promise.withResolvers<any>(),entered=Promise.withResolvers<void>();let checks=0;
  t.mock.method(runtime as any,'loadThread',()=>{checks++;entered.resolve();return gate.promise;});
  const first=runtime.snapshot(threadId),second=runtime.snapshot(threadId);
  await entered.promise;gate.resolve(structuredClone(native));
  const snapshots=await Promise.all([first,second]);
  assert.ok(snapshots.every(s=>s.syncConflict&&s.activeTurnId===turnId&&s.thread.turns[0].status==='inProgress'));
  assert.equal(checks,1);
  assert.equal((await runtime.snapshot(threadId)).syncConflict,true);
  assert.equal(checks,1,'same conflict must not start another automatic probe');
  await assert.rejects(runtime.send(threadId,{text:'duplicate',clientRequestId:'blocked-check'}),{code:'RUNTIME_THREAD_BUSY'});
  await assert.rejects(runtime.send(threadId,{text:'steer',expectedTurnId:turnId,clientRequestId:'blocked-steer'}),{code:'RUNTIME_STEER_CONFLICT'});
  await assert.rejects(runtime.release(threadId),{code:'RUNTIME_THREAD_BUSY'});
  assert.equal(checks,1,'release must share the unresolved verification and stay blocked');
  (runtime as any).onNotification({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'live',delta:'new evidence'}});
  assert.equal((await runtime.snapshot(threadId)).syncConflict,true);assert.equal(checks,2);
  const stats=await (runtime as any).call('fixture/stats',{});
  assert.equal(stats.turnStarts,1);assert.equal(stats.resumes,0);assert.equal(stats.interrupts,0);assert.equal(stats.unsubscribes,0);
});

test('read-only terminal verification expires within ten seconds without unlocking the composer',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('bounded');state.loaded=true;
  (runtime as any).onNotification({method:'turn/started',params:{threadId:'bounded',turn:{id:'turn',status:'inProgress',items:[]}}});
  t.mock.method(runtime as any,'readThread',async()=>({id:'bounded',status:{type:'active'},turns:[{id:'turn',status:'interrupted',items:[]}]}));
  const entered=Promise.withResolvers<void>();let remaining=0;
  t.mock.method(runtime as any,'loadThread',(_id:any,_window:any,_signal:any,deadline:number)=>{remaining=deadline-Date.now();entered.resolve();return new Promise(()=>{});});
  t.mock.method(runtime as any,'mutation',()=>{assert.fail('verification may not write');});
  t.mock.timers.enable({apis:['setTimeout']});
  const loading=runtime.snapshot('bounded');await entered.promise;
  assert.ok(remaining>0&&remaining<=10_000);t.mock.timers.tick(10_000);
  const snapshot=await loading;
  assert.equal(snapshot.syncConflict,true);assert.equal(snapshot.activeTurnId,'turn');assert.notEqual(snapshot.phase,'IDLE');
  assert.equal(state.completedTurns.has('turn'),false);
});

test('authoritative verification recovers current activity and subsequent deltas through the client reducer',async t=>{
  const runtime=start(t),{threadId,turnId}=await runtime.create({cwd,clientRequestId:'verified-active',prompt:'hold'});
  t.mock.method(runtime as any,'readThread',async()=>({id:threadId,status:{type:'active'},turns:[{id:turnId,status:'interrupted',items:[]}]}));
  t.mock.method(runtime as any,'loadThread',async()=>({id:threadId,status:{type:'active'},turns:[{id:turnId,status:'inProgress',items:[]}]}));
  let browser=await runtime.snapshot(threadId);
  assert.equal(browser.syncConflict,false);assert.equal(browser.activeTurnId,turnId);assert.equal(browser.thread.turns[0].status,'inProgress');
  runtime.on('change',event=>{browser=applyChange(browser,event);assert.ok(browser);});
  (runtime as any).onNotification({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'verified',delta:'continued output'}});
  assert.equal(browser.thread.turns[0].items.find((i:any)=>i.id==='verified').text,'continued output');
});

test('consecutive conflicting snapshots reuse a successful verification without relatching conflict',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('verified-cache');state.loaded=true;
  (runtime as any).onNotification({method:'turn/started',params:{threadId:'verified-cache',turn:{id:'turn',status:'inProgress',items:[]}}});
  t.mock.method(runtime as any,'readThread',async()=>({id:'verified-cache',status:{type:'active'},turns:[{id:'turn',status:'interrupted',items:[]}]}));
  let probes=0;
  t.mock.method(runtime as any,'loadThread',async()=>{probes++;return {id:'verified-cache',status:{type:'active'},turns:[{id:'turn',status:'inProgress',items:[]}]};});
  const first=await runtime.snapshot('verified-cache');
  assert.equal(first.syncConflict,false);
  const second=await runtime.snapshot('verified-cache');
  assert.equal(second.syncConflict,false);
  assert.equal(second.activeTurnId,'turn');assert.equal(second.thread.turns[0].status,'inProgress');assert.equal(probes,1);
});

test('consistent idle terminal history remains authoritative without concurrent activity',async t=>{
  for(const status of ['completed','interrupted','failed']){
    const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
    const state=(runtime as any).state('consistent-terminal');state.loaded=true;
    (runtime as any).onNotification({method:'turn/started',params:{threadId:'consistent-terminal',turn:{id:'turn',status:'inProgress',items:[]}}});
    t.mock.method(runtime as any,'readThread',async()=>({id:'consistent-terminal',status:{type:'idle'},turns:[{id:'turn',status,items:[]}]}));
    t.mock.method(runtime as any,'loadThread',()=>assert.fail('consistent terminal history needs no conflict probe'));
    const snapshot=await runtime.snapshot('consistent-terminal');
    assert.equal(snapshot.syncConflict,false);assert.equal(snapshot.activeTurnId,null);assert.equal(snapshot.thread.turns[0].status,status);
    assert.equal(state.completedTurns.has('turn'),true);
  }
});

test('a completed turn is verified before an older interrupted history page can replace it',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('terminal-correction');state.loaded=true;state.subagent=false;
  const reply={id:'reply',type:'agentMessage',phase:'final_answer',text:'Completed answer'};
  (runtime as any).onNotification({method:'turn/completed',params:{threadId:'terminal-correction',turn:{id:'turn',status:'completed',items:[reply],startedAt:1,completedAt:2,durationMs:1000}}});
  t.mock.method(runtime as any,'readThread',async()=>({id:'terminal-correction',status:{type:'idle'},turns:[{id:'turn',status:'interrupted',items:[reply],startedAt:1,completedAt:2,durationMs:1000}]}));
  let checks=0;
  t.mock.method(runtime as any,'loadThread',async()=>{checks++;return {id:'terminal-correction',status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[],itemsView:'notLoaded',startedAt:1,completedAt:2,durationMs:1000}]};});
  t.mock.method(runtime as any,'mutation',()=>assert.fail('terminal reconciliation must remain read-only'));
  const snapshot=await runtime.snapshot('terminal-correction');
  assert.equal(snapshot.thread.turns[0].status,'completed');
  assert.equal(snapshot.thread.turns[0].items[0].text,'Completed answer');
  assert.equal(snapshot.syncConflict,false);assert.equal(snapshot.phase,'IDLE');assert.equal(snapshot.activeTurnId,null);
  assert.equal(checks,1);
});

test('late terminal notifications request resync instead of replacing a confirmed completed result',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('late-terminal');state.loaded=true;state.subagent=false;
  const native={id:'late-terminal',status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[{id:'reply',type:'agentMessage',phase:'final_answer',text:'Completed answer'}]}]};
  t.mock.method(runtime as any,'readThread',async()=>structuredClone(native));
  const browser=await runtime.snapshot('late-terminal');let event:any;
  runtime.on('change',change=>event=change);
  (runtime as any).onNotification({method:'turn/completed',params:{threadId:'late-terminal',turn:{id:'turn',status:'interrupted',items:[]}}});
  assert.equal(event.id.split(':')[0],browser.epoch);assert.equal(event.revision,browser.revision+1);
  assert.equal(applyChange(browser,event),null,'a conflicting terminal event needs authoritative resync');
  assert.equal((await runtime.snapshot('late-terminal')).thread.turns[0].status,'completed');
  assert.equal(browser.thread.turns[0].items[0].text,'Completed answer');
});

test('terminal correction trusts fresh interrupted and failed history even when a final answer exists',async t=>{
  for(const status of ['interrupted','failed']){
    const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
    const state=(runtime as any).state('verified-terminal');state.loaded=true;state.subagent=false;
    const reply={id:'reply',type:'agentMessage',phase:'final_answer',text:'Preserved answer'};
    (runtime as any).onNotification({method:'turn/completed',params:{threadId:'verified-terminal',turn:{id:'turn',status:'completed',items:[reply]}}});
    const native={id:'verified-terminal',status:{type:'idle'},turns:[{id:'turn',status,items:[reply],error:status==='failed'?{message:'Native failure'}:null}]};
    t.mock.method(runtime as any,'readThread',async()=>structuredClone(native));
    let checks=0;t.mock.method(runtime as any,'loadThread',async()=>{checks++;return structuredClone(native);});
    const snapshot=await runtime.snapshot('verified-terminal');
    assert.equal(snapshot.thread.turns[0].status,status);assert.equal(snapshot.thread.turns[0].items[0].text,'Preserved answer');
    assert.equal(snapshot.syncConflict,false);assert.equal(snapshot.phase,'IDLE');assert.equal(checks,1);
    if(status==='failed')assert.equal(snapshot.thread.turns[0].error.message,'Native failure');
  }
});

test('failed terminal verification stays unresolved across repeated stale snapshots',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('terminal-unresolved');state.loaded=true;state.subagent=false;
  (runtime as any).onNotification({method:'turn/completed',params:{threadId:'terminal-unresolved',turn:{id:'turn',status:'completed',items:[]}}});
  let status='interrupted',checks=0;
  t.mock.method(runtime as any,'readThread',async()=>({id:'terminal-unresolved',status:{type:'idle'},turns:[{id:'turn',status,items:[]}]}));
  t.mock.method(runtime as any,'loadThread',async()=>{checks++;throw Error('Read failed');});
  for(let i=0;i<2;i++){
    const snapshot=await runtime.snapshot('terminal-unresolved');
    assert.equal(snapshot.syncConflict,true);assert.notEqual(snapshot.phase,'IDLE');
    assert.equal(state.liveTurns.get('turn').status,'completed');
  }
  assert.equal(checks,1,'unchanged stale evidence must not cause a probe loop');
  await assert.rejects(runtime.send('terminal-unresolved',{text:'duplicate',clientRequestId:'blocked-terminal'}),{code:'RUNTIME_THREAD_BUSY'});
  status='completed';const recovered=await runtime.snapshot('terminal-unresolved');
  assert.equal(recovered.syncConflict,false);assert.equal(recovered.phase,'IDLE');assert.equal(recovered.thread.turns[0].status,'completed');
});

test('explicit history resync retries failed terminal correction without requiring new activity',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('terminal-retry');state.loaded=true;state.subagent=false;
  (runtime as any).onNotification({method:'turn/completed',params:{threadId:'terminal-retry',turn:{id:'turn',status:'interrupted',items:[]}}});
  const native={id:'terminal-retry',status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[{id:'reply',type:'agentMessage',phase:'final_answer',text:'Recovered final answer'}]}]};
  t.mock.method(runtime as any,'readThread',async()=>structuredClone(native));
  let checks=0;t.mock.method(runtime as any,'loadThread',async()=>{if(++checks===1)throw Error('Temporary read failure');return structuredClone(native);});
  assert.equal((await runtime.snapshot('terminal-retry')).syncConflict,true);
  assert.equal((await runtime.snapshot('terminal-retry')).syncConflict,true);assert.equal(checks,1);
  const recovered=await runtime.snapshot('terminal-retry',{window:true,restartHistory:true});
  assert.equal(recovered.syncConflict,false);assert.equal(recovered.phase,'IDLE');assert.equal(recovered.thread.turns[0].status,'completed');
  assert.equal(recovered.thread.turns[0].items[0].text,'Recovered final answer');assert.equal(checks,2);
});

test('an older concurrent snapshot cannot replace a newer accepted terminal result',async t=>{
  for(const status of ['completed','interrupted','failed']){
    const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
    const state=(runtime as any).state('terminal-overlap');state.loaded=true;state.subagent=false;
    (runtime as any).onNotification({method:'turn/completed',params:{threadId:'terminal-overlap',turn:{id:'turn',status,items:[]}}});
    const fresh={id:'terminal-overlap',status:{type:'idle'},turns:[{id:'turn',status,items:[]}]};
    const gate=Promise.withResolvers<any>(),entered=Promise.withResolvers<void>();let reads=0;
    t.mock.method(runtime as any,'readThread',()=>{if(++reads===1){entered.resolve();return gate.promise;}return Promise.resolve(structuredClone(fresh));});
    const older=runtime.snapshot('terminal-overlap');await entered.promise;
    const newer=await runtime.snapshot('terminal-overlap');assert.equal(newer.thread.turns[0].status,status);
    gate.resolve({id:'terminal-overlap',status:{type:'idle'},turns:[{id:'turn',status:status==='completed'?'interrupted':'completed',items:[]}]});
    await assert.rejects(older,{code:'RUNTIME_SYNC_RESTARTED'});
    assert.equal((await runtime.snapshot('terminal-overlap')).thread.turns[0].status,status);
  }
});

test('a new running turn invalidates terminal verification without being unlocked or overwritten',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('terminal-race');state.loaded=true;state.subagent=false;
  (runtime as any).onNotification({method:'turn/completed',params:{threadId:'terminal-race',turn:{id:'old',status:'completed',items:[]}}});
  const stale={id:'terminal-race',status:{type:'idle'},turns:[{id:'old',status:'interrupted',items:[]}]};
  t.mock.method(runtime as any,'readThread',async()=>structuredClone(stale));
  const gate=Promise.withResolvers<any>(),entered=Promise.withResolvers<void>();
  t.mock.method(runtime as any,'loadThread',()=>{entered.resolve();return gate.promise;});
  const loading=runtime.snapshot('terminal-race');
  await Promise.race([entered.promise,loading.then(()=>assert.fail('terminal disagreement must be verified before accepting history'))]);
  (runtime as any).onNotification({method:'turn/started',params:{threadId:'terminal-race',turn:{id:'new',status:'inProgress',items:[]}}});
  gate.resolve({id:'terminal-race',status:{type:'idle'},turns:[{id:'old',status:'completed',items:[]}]});
  const snapshot=await loading;
  assert.equal(snapshot.activeTurnId,'new');assert.equal(snapshot.phase,'RUNNING');
  assert.equal(snapshot.thread.turns.find((turn:any)=>turn.id==='new').status,'inProgress');
  await assert.rejects(runtime.send('terminal-race',{text:'duplicate',clientRequestId:'blocked-race'}),{code:'RUNTIME_THREAD_BUSY'});
});

test('genuine terminal notifications reject late turn and item events while a different turn can run',async t=>{
  for(const terminal of ['completed','interrupted','failed']){
    const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
    const state=(runtime as any).state('ordered');state.subagent=false;
    const notify=(method:string,params:any)=>(runtime as any).onNotification({method,params:{threadId:'ordered',...params}});
    notify('turn/completed',{turn:{id:'old',status:terminal,items:[]}});
    // Emulate normal history reconciliation dropping its already completed live body.
    state.liveTurns.delete('old');
    notify('turn/started',{turn:{id:'old',status:'inProgress',items:[]}});
    notify('item/started',{turnId:'old',item:{id:'late',type:'agentMessage',text:'late'}});
    notify('item/agentMessage/delta',{turnId:'old',itemId:'late',delta:'late'});
    assert.equal(state.activeTurnId,null);assert.equal(state.liveTurns.has('old'),false);
    notify('turn/started',{turn:{id:'new',status:'inProgress',items:[]}});
    t.mock.method(runtime as any,'readThread',async()=>({id:'ordered',status:{type:'active'},turns:[{id:'old',status:terminal,items:[]},{id:'new',status:'inProgress',items:[]}]}));
    const snapshot=await runtime.snapshot('ordered');
    assert.equal(snapshot.activeTurnId,'new');assert.equal(snapshot.thread.turns[0].status,terminal);assert.equal(snapshot.syncConflict,false);
  }
});

test('runtime epoch replacement during terminal verification rejects the old baseline',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd});t.after(()=>runtime.close());
  const state=(runtime as any).state('epoch-check');state.loaded=true;
  (runtime as any).onNotification({method:'turn/started',params:{threadId:'epoch-check',turn:{id:'turn',status:'inProgress',items:[]}}});
  t.mock.method(runtime as any,'readThread',async()=>({id:'epoch-check',status:{type:'active'},turns:[{id:'turn',status:'interrupted',items:[]}]}));
  const gate=Promise.withResolvers<any>(),entered=Promise.withResolvers<void>();
  t.mock.method(runtime as any,'loadThread',()=>{entered.resolve();return gate.promise;});
  const loading=runtime.snapshot('epoch-check');await entered.promise;
  (runtime as any).epoch='replacement';
  gate.resolve({id:'epoch-check',status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[]}]});
  await assert.rejects(loading,{code:'RUNTIME_SYNC_RESTARTED'});
  assert.equal(state.completedTurns.has('turn'),false);
});

test('live item times survive completion, turn replacement, replay and stale history', async t => {
  const runtime = start(t), { threadId, turnId } = await runtime.create({ cwd, clientRequestId: 'timed-live', prompt: 'hold' });
  let browser: any = await runtime.snapshot(threadId);
  const cursor = browser.syncCursor, startedAtMs = 1791065677672, completedAtMs = startedAtMs + 4321;
  const events: any[] = [];
  runtime.on('change', event => { events.push(event); browser = applyChange(browser, event); assert.ok(browser); });
  const notify = (method: string, params: any) => (runtime as any).onNotification({ method, params: { threadId, turnId, ...params } });
  const item = { id: 'timed-message', type: 'agentMessage', text: 'first' };
  const message = () => browser.thread.turns.find((turn: any) => turn.id === turnId).items.find((entry: any) => entry.id === item.id);
  notify('item/started', { item, startedAtMs });
  assert.equal(message().startedAtMs, startedAtMs);
  notify('item/completed', { item: { ...item, text: 'completed' }, completedAtMs });
  assert.equal(message().startedAtMs, startedAtMs);
  assert.equal(message().completedAtMs, completedAtMs);
  notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [{ ...item, text: 'final replacement' }] } });
  assert.equal(message().text, 'final replacement');
  assert.equal(message().startedAtMs, startedAtMs);
  assert.equal(message().completedAtMs, completedAtMs);
  assert.deepEqual(runtime.replay(threadId, cursor).events, events);
  t.mock.method(runtime as any, 'readThread', async () => ({ id: threadId, status: { type: 'idle' }, turns: [{ id: turnId, status: 'completed', items: [{ ...item, text: 'native final' }] }] }));
  const historical = (await runtime.snapshot(threadId, { window: true })).thread.turns[0].items[0];
  assert.equal(historical.text, 'native final');
  assert.equal(historical.startedAtMs, startedAtMs);
  assert.equal(historical.completedAtMs, completedAtMs);
});
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
  const status=await runtime.status(threadId,snapshot.epoch);
  assert.equal(status.epoch,snapshot.epoch);assert.equal(status.revision,snapshot.revision);
  for(let i=0;i<3;i++) assert.equal((await (runtime as any).status(threadId,snapshot.epoch)).resync,false);
  const after=await (runtime as any).call('fixture/stats',{});
  assert.equal(after.itemLists,before.itemLists);
  await (runtime as any).call('fixture/external-change',{threadId});
  assert.equal((await (runtime as any).status(threadId,snapshot.epoch)).resync,true);
  assert.equal((await (runtime as any).status(threadId,'old-epoch')).resync,true);
});

test('read-only status exposes a queued release version missed by the browser',async t=>{
  const runtime=start(t),{threadId}=await runtime.create({cwd,clientRequestId:'release-version',prompt:'hold'}),baseline=await runtime.snapshot(threadId);
  await runtime.requestRelease(threadId);
  const before=await (runtime as any).call('fixture/stats',{}),status=await runtime.status(threadId,baseline.epoch),after=await (runtime as any).call('fixture/stats',{});
  assert.equal(status.epoch,baseline.epoch);assert.ok(status.revision>baseline.revision);assert.equal(status.resync,false);
  assert.equal(after.resumes,before.resumes);assert.equal(after.unsubscribes,before.unsubscribes);
  const current=await runtime.snapshot(threadId);assert.equal(current.phase,'RUNNING');assert.equal(current.release.requested,true);
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
  assert.equal((await runtime.status(threadId,baseline.epoch)).resync,false);
  await runtime.abort(threadId);
  assert.equal((await runtime.status(threadId,baseline.epoch)).resync,false);
  assert.equal((await runtime.status(threadId,baseline.epoch)).resync,false);
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
    assert.equal((await runtime.status(threadId,snapshot.epoch)).resync,false);
    await runtime.send(threadId,{text:'hold',clientRequestId:'first-message'});
    assert.equal(typeof (await runtime.status(threadId,snapshot.epoch)).resync,'boolean');
  }
});

test('bounded status baselines evict to authoritative resync instead of stale cache reuse',async t=>{
  const runtime=start(t);
  await runtime.diagnostics();
  t.mock.method(runtime as any,'readThread',async(id:string)=>({id,status:{type:'idle'},turns:[{id:'old',status:'completed',error:{message:'x'.repeat(1100000)},items:[]}]}));
  const oldest=await runtime.snapshot('history-0');
  for(let i=1;i<9;i++) await runtime.snapshot('history-'+i);
  t.mock.method(runtime as any,'call',async(method:string,params:any)=>method==='thread/read'?{thread:{id:params.threadId,status:{type:'idle'},turns:[]}}:{data:[{id:'old',status:'completed',error:{message:'x'.repeat(1100000)}}],nextCursor:null});
  assert.equal((await runtime.status('history-0',oldest.epoch)).resync,true);
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
