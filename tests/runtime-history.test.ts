import assert from 'node:assert/strict';
import test from 'node:test';
import { Runtime } from '../src/codex/runtime.ts';

test('browser history and SSE omit inline image bytes while native history stays intact',async t=>{
  const {runtime}=setup(t),data='a'.repeat(1_000_000),url='data:image/png;base64,'+data;
  const items=[
    {id:'user',type:'userMessage',content:[{type:'text',text:'Keep my prompt'},{type:'image',url},{type:'localImage',path:'/uploads/image.png'}]},
    {id:'tool',type:'mcpToolCall',status:'completed',result:{content:[{type:'text',text:'Keep tool text'},{type:'image',mimeType:'image/png',data}],_meta:{'codex/toolSurface':{screenshot:{url}}}}},
    {id:'generated',type:'imageGeneration',status:'completed',result:data,revisedPrompt:'Draw a diagram',savedPath:'/private/generated.png'},
    {id:'generated-url',type:'imageGeneration',status:'completed',result:url},
  ];
  const turns=[{id:'first',status:'completed',items},{id:'last',status:'completed',items:[]}];
  t.mock.method(runtime as any,'readThread',async()=>({id:'thread',status:{type:'idle'},turns:structuredClone(turns)}));
  const snapshot=await runtime.snapshot('thread',{window:true});
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<10_000,'Inline images inflated browser snapshot');
  const history=await runtime.history('thread','last');
  assert.ok(Buffer.byteLength(JSON.stringify(history))<10_000,'Inline images inflated history page');
  const user=snapshot.thread.turns[0].items[0];
  assert.equal(user.imagePreviews.length,1);
  assert.match(user.imagePreviews[0].id,/^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.thread.turns[0].items[1].imagePreviews,user.imagePreviews,'Duplicate tool screenshot must be deduplicated');
  for(const generated of snapshot.thread.turns[0].items.slice(2)){
    assert.deepEqual(generated.imagePreviews,user.imagePreviews);
    assert.equal(generated.result,'[图片单独加载]');
  }
  assert.equal(user.content[0].text,'Keep my prompt');
  assert.equal(user.content[2].path,'/uploads/image.png');
  assert.equal(snapshot.thread.turns[0].items[1].result.content[0].text,'Keep tool text');
  assert.deepEqual((await runtime.snapshot('thread')).thread.turns[0].items,items);
  const changes:any[]=[];runtime.on('change',change=>changes.push(change));
  for(const item of items)(runtime as any).onNotification({method:'item/completed',params:{threadId:'thread',turnId:'active',item}});
  assert.ok(changes.length>=2);
  assert.ok(changes.every(change=>change.kind!=='resync'&&Buffer.byteLength(JSON.stringify(change))<10_000));
  assert.equal(items[0].content![1].url,url);
});

test('native image lookup stays scoped to its thread, turn and item',async t=>{
  const {runtime,calls}=setup(t),data=Buffer.from('test image').toString('base64');
  const item={id:'picture',type:'userMessage',content:[{type:'image',url:'data:image/png;base64,'+data}]};
  t.mock.method(runtime as any,'readThread',async()=>({id:'thread',status:{type:'idle'},turns:[{id:'first',status:'completed',items:[item]}]}));
  const imageId=(await runtime.snapshot('thread',{window:true})).thread.turns[0].items[0].imagePreviews[0].id;
  t.mock.method(runtime as any,'readTurnBodies',async(threadId:string,turns:any[],itemId:string)=>{
    assert.equal(threadId,'thread');assert.equal(turns[0].id,'first');assert.equal(itemId,'picture');turns[0].items=[structuredClone(item)];
  });
  assert.deepEqual(await runtime.image('thread','first','picture',imageId),Buffer.from('test image'));
  await assert.rejects(runtime.image('thread','first','picture','0'.repeat(64)),(error:any)=>error.statusCode===404);
  assert.equal(calls.length,0);
});

function setup(t: any) {
  const runtime = new Runtime({ executable: process.execPath, cwd: process.cwd() });
  t.after(() => runtime.close());
  const turns = Array.from({ length: 45 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', itemsView: 'notLoaded', items: [] }));
  const output = '大'.repeat(40000);
  const item = (id: string) => ({ id: `command-${id}`, type: 'commandExecution', status: 'completed', aggregatedOutput: output });
  const calls: any[] = [];
  t.mock.method(runtime as any, 'getServer', async () => ({}));
  t.mock.method(runtime as any, 'call', async (method: string, args: any) => {
    calls.push({ method, ...args });
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' }, turns: [] } };
    if (method === 'thread/turns/list') {
      const start = Number(args.cursor ?? 0);
      return { data: structuredClone(turns.slice(start, start + 15)), nextCursor: start + 15 < turns.length ? String(start + 15) : null };
    }
    if (method === 'thread/items/list') return { data: [{ turnId: args.turnId, item: item(args.turnId) }], nextCursor: null };
    throw Error(method);
  });
  return { runtime, turns, output, calls, item };
}

test('window history reads only selected bodies and keeps the full lightweight status baseline', async t => {
  const { runtime, turns, output, calls } = setup(t);
  const snapshot = await runtime.snapshot('thread', { window: true });
  assert.deepEqual(snapshot.thread.turns.map((turn: any) => turn.id), turns.slice(-3).map(turn => turn.id));
  assert.equal(snapshot.history.nextCursor, 'turn-42');
  assert.deepEqual(calls.filter(call => call.method === 'thread/items/list').map(call => call.turnId), turns.slice(-3).map(turn => turn.id));
  const command = snapshot.thread.turns[0].items[0];
  assert.equal(command.aggregatedOutput, output.slice(0, 2048));
  assert.equal(command.outputChars, output.length);
  assert.equal(command.outputBytes, Buffer.byteLength(output));
  assert.equal(command.outputDeferred, true);
  assert.deepEqual(await runtime.status('thread', snapshot.epoch), { resync: false });
  const state = (runtime as any).state('thread'), baseline = structuredClone(state.syncTurns), revision = state.revision;
  const first = await runtime.history('thread', snapshot.history.nextCursor);
  assert.equal(first.turns.length,20,'Explicit history loading keeps its existing page size');
  const second = await runtime.history('thread', first.nextCursor!);
  const last = await runtime.history('thread', second.nextCursor!);
  assert.equal(last.nextCursor, null);
  assert.deepEqual([...last.turns, ...second.turns, ...first.turns, ...snapshot.thread.turns].map(turn => turn.id), turns.map(turn => turn.id));
  assert.equal(first.turns[0].items[0].outputDeferred, true);
  assert.deepEqual(state.syncTurns, baseline);
  assert.equal(state.revision, revision);
  assert.deepEqual(await runtime.status('thread', snapshot.epoch), { resync: false });
  const count = calls.filter(call => call.method === 'thread/items/list').length;
  await assert.rejects(runtime.history('thread', 'missing'), (error: any) => error.statusCode === 409 && error.code === 'RUNTIME_HISTORY_CURSOR_INVALID');
  assert.equal(calls.filter(call => call.method === 'thread/items/list').length, count);
  assert.equal((await runtime.snapshot('thread')).thread.turns[0].items[0].aggregatedOutput, output);
});

test('output reads only its requested turn and rejects a missing command', async t => {
  const { runtime, output, calls } = setup(t);
  assert.deepEqual(await runtime.output('thread', 'turn-2', 'command-turn-2'), { output });
  assert.deepEqual(calls.map(call => call.method), ['thread/items/list']);
  assert.equal(calls[0].turnId, 'turn-2');
  await assert.rejects(runtime.output('thread', 'turn-2', 'missing'), (error: any) => error.statusCode === 404);
});

test('large terminal events are compact while live streams and snapshot journal retain full output', async t => {
  const { runtime, output, item } = setup(t);
  const gate = Promise.withResolvers<any>();
  t.mock.method(runtime as any, 'readThread', () => gate.promise);
  const loading = runtime.snapshot('thread');
  const changes: any[] = [];
  runtime.on('change', change => changes.push(change));
  const command = item('new');
  (runtime as any).onNotification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'new', item: command } });
  (runtime as any).onNotification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'new', status: 'completed', items: [command] } } });
  gate.resolve({ id: 'thread', status: { type: 'idle' }, turns: [] });
  assert.equal((await loading).thread.turns[0].items[0].aggregatedOutput, output);
  assert.equal(changes[0].kind, 'item');
  assert.equal(changes[0].patch.item.item.outputDeferred, true);
  assert.equal(changes[1].patch.turn.items[0].aggregatedOutput.length, 2048);
  const streaming = { ...command, status: 'inProgress', id: 'running' };
  (runtime as any).onNotification({ method: 'item/started', params: { threadId: 'thread', turnId: 'active', item: { ...streaming, aggregatedOutput: 'x'.repeat(9000) } } });
  assert.equal(changes.at(-1).patch.item.item.aggregatedOutput.length, 9000);
  assert.equal(changes.at(-1).patch.item.item.outputDeferred, undefined);
});

test('window snapshots merge in-flight completion without trimming internal state or losing the watermark', async t => {
  const { runtime, output, item, turns } = setup(t);
  const gate = Promise.withResolvers<any>();
  t.mock.method(runtime as any, 'readThread', () => gate.promise);
  const loading = runtime.snapshot('thread', { window: true });
  const command = item('new');
  (runtime as any).onNotification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'new', status: 'completed', items: [command] } } });
  gate.resolve({ id: 'thread', status: { type: 'idle' }, turns });
  const result = await loading;
  assert.equal(result.thread.turns.at(-1).items[0].aggregatedOutput, output.slice(0, 2048));
  assert.equal(result.thread.turns.at(-1).status, 'completed');
  assert.equal(result.phase, 'IDLE');
  assert.equal(result.activeTurnId, null);
  assert.equal(runtime.replay('thread', result.syncCursor).events.length, 0);
  assert.equal((runtime as any).state('thread').syncTurns.size, 46);
});


test('project binding reads only native cwd without loading or reconciling history',async t=>{
  const {runtime,calls}=setup(t);
  const state=(runtime as any).state('thread'),before=structuredClone({revision:state.revision,syncHeader:state.syncHeader,syncTurns:state.syncTurns});
  t.mock.method(runtime as any,'call',async(method:string,args:any)=>{calls.push({method,...args});return {thread:{cwd:process.cwd()}};});
  assert.equal(await runtime.threadCwd('thread'),process.cwd());
  assert.deepEqual(calls,[{method:'thread/read',threadId:'thread',includeTurns:false}]);
  assert.deepEqual({revision:state.revision,syncHeader:state.syncHeader,syncTurns:state.syncTurns},before);
  t.mock.method(runtime as any,'call',async()=>({thread:{}}));
  assert.equal(await runtime.threadCwd('thread'),null);
  t.mock.method(runtime as any,'call',async()=>({}));
  await assert.rejects(runtime.threadCwd('thread'),(e:any)=>e.statusCode===503);
  t.mock.method(runtime as any,'call',async()=>{throw Object.assign(new Error('missing'),{statusCode:404});});
  await assert.rejects(runtime.threadCwd('thread'),(e:any)=>e.statusCode===404);
});


test('release reads turn status headers without loading item bodies',async t=>{
  const {runtime,calls}=setup(t);
  t.mock.method(runtime as any,'mutation',async(method:string)=>{assert.equal(method,'thread/unsubscribe');return {status:'unsubscribed'};});
  t.mock.method(runtime as any,'closeIdleServer',async()=>false);
  const released=await runtime.release('thread');
  assert.equal(released.status,'released');
  assert.ok(calls.some(call=>call.method==='thread/turns/list'));
  assert.ok(calls.every(call=>call.method!=='thread/items/list'&&call.itemsView!=='full'),'Release loaded conversation bodies');
});

test('release refuses a running header without loading its body',async t=>{
  const {runtime,turns,calls}=setup(t);turns.at(-1)!.status='inProgress';
  t.mock.method(runtime as any,'mutation',async()=>{assert.fail('Must not unsubscribe a running turn');});
  await assert.rejects(runtime.release('thread'),(e:any)=>e.code==='RUNTIME_THREAD_BUSY');
  assert.ok(calls.every(call=>call.method!=='thread/items/list'&&call.itemsView!=='full'));
});

test('sync header extraction never traverses discarded conversation bodies',async t=>{
  const {runtime}=setup(t);let reads=0;
  const thread={id:'thread',status:{type:'idle'},turns:[{get items(){reads++;return [{text:'large body'}];}}]};
  const header=(runtime as any).threadHeader(thread);header.status.type='active';
  assert.equal(reads,0);assert.equal(thread.status.type,'idle');assert.equal('turns' in header,false);
});

test('test report command lookup stays scoped to its native turn and item',async t=>{
  const {runtime,calls}=setup(t);
  const command=await runtime.command('thread','turn-30','command-turn-30');
  assert.equal(command.id,'command-turn-30');assert.equal(command.type,'commandExecution');
  assert.ok(calls.every(call=>call.method==='thread/items/list'&&call.turnId==='turn-30'));
  await assert.rejects(runtime.command('thread','turn-29','command-turn-30'),(e:any)=>e.statusCode===404);
});


test('abandoned snapshot and earlier-history reads stop scheduling native pages',async t=>{
  for(const earlier of [false,true]){
    const {runtime,calls}=setup(t),controller=new AbortController(),call=(runtime as any).call.bind(runtime);
    t.mock.method(runtime as any,'call',async(method:string,args:any)=>{const result=await call(method,args);if(method==='thread/items/list')controller.abort();return result;});
    const pending=earlier?runtime.history('thread','turn-30',controller.signal):runtime.snapshot('thread',{window:true,signal:controller.signal});
    await assert.rejects(pending,(e:any)=>e.name==='AbortError');
    assert.equal(calls.filter(call=>call.method==='thread/items/list').length,1,'Canceled read kept loading other turns');
    assert.equal(runtime.listenerCount('snapshotChange'),0);assert.equal((runtime as any).reads,0);
    assert.equal((runtime as any).state('thread').syncHeader,undefined,'Canceled history must not replace sync state');
  }
});

test('generated image bytes use the scoped native image lookup without reading savedPath or remote URLs',async t=>{
  const {runtime}=setup(t),bytes=Buffer.from('generated image'),data=bytes.toString('base64');
  const item={id:'generated',type:'imageGeneration',status:'completed',result:data,savedPath:'/must/not/read.png'};
  const items=[item,{...item,id:'empty',result:''},{...item,id:'remote',result:'https://example.invalid/image.png'},{...item,id:'oversize',result:'a'.repeat(14_000_000)}];
  t.mock.method(runtime as any,'readThread',async()=>({id:'thread',status:{type:'idle'},turns:[{id:'turn',status:'completed',items}]}));
  const safe=(await runtime.snapshot('thread',{window:true})).thread.turns[0].items;
  assert.ok(JSON.stringify(safe).length<2000);
  const imageId=safe[0].imagePreviews[0].id;
  assert.ok(safe.slice(1).every((entry:any)=>!entry.imagePreviews));
  assert.equal(safe[2].result,items[2].result);
  t.mock.method(runtime as any,'readTurnBodies',async(threadId:string,turns:any[],itemId:string)=>{assert.equal(threadId,'thread');assert.equal(turns[0].id,'turn');turns[0].items=items.filter(entry=>entry.id===itemId);});
  assert.deepEqual(await runtime.image('thread','turn','generated',imageId),bytes);
  await assert.rejects(runtime.image('thread','turn','remote',imageId),(error:any)=>error.statusCode===404);
  await assert.rejects(runtime.image('thread','turn','missing',imageId),(error:any)=>error.statusCode===404);
});

test('small initial window still detects active turns outside its body window', async t => {
  const { runtime, turns, calls } = setup(t);
  turns[0].status = 'inProgress';
  const call = (runtime as any).call.bind(runtime);
  t.mock.method(runtime as any, 'call', async (method: string, args: any) => {
    const result = await call(method, args);
    if (method === 'thread/read') result.thread.status = { type: 'active' };
    return result;
  });
  const snapshot = await runtime.snapshot('thread', { window: true });
  assert.equal(snapshot.phase, 'EXTERNAL');
  assert.equal(snapshot.activeTurnId, null, 'Native activity is not a locally owned turn');
  assert.equal(snapshot.thread.turns.length, 3);
  assert.equal((runtime as any).state('thread').syncTurns.size, 45);
  assert.equal(calls.filter(call => call.method === 'thread/items/list').length, 3);
});

test('cancellation also stops both legacy full-turn fallback paths',async t=>{
  for(const seek of [false,true]){
    const {runtime}=setup(t),controller=new AbortController();let bodies=0;
    t.mock.method(runtime as any,'call',async(method:string,args:any)=>{
      if(method==='thread/items/list')throw Object.assign(new Error('legacy'),{code:'RUNTIME_ITEMS_UNSUPPORTED'});
      if(args.itemsView==='full'){bodies++;controller.abort();return {data:[{id:'target',itemsView:'full',items:[{id:'command'}]}],nextCursor:'next'};}
      return {data:[{id:'target'},{id:'other'}],nextCursor:null};
    });
    const turns=[{id:'target',itemsView:'notLoaded'},{id:'other',itemsView:'notLoaded'}];
    await assert.rejects((runtime as any).readTurnBodies('thread',turns,undefined,seek,controller.signal),(e:any)=>e.name==='AbortError');
    assert.equal(bodies,1);assert.ok(turns.every(turn=>turn.itemsView==='notLoaded'));
  }
});
