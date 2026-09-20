import assert from 'node:assert/strict';
import test from 'node:test';
import { Runtime } from '../src/codex/runtime.ts';

test('browser history and SSE omit inline image bytes while native history stays intact',async t=>{
  const {runtime}=setup(t),data='a'.repeat(1_000_000),url='data:image/png;base64,'+data;
  const items=[
    {id:'user',type:'userMessage',content:[{type:'text',text:'Keep my prompt'},{type:'image',url},{type:'localImage',path:'/uploads/image.png'}]},
    {id:'tool',type:'mcpToolCall',status:'completed',result:{content:[{type:'text',text:'Keep tool text'},{type:'image',mimeType:'image/png',data}],_meta:{'codex/toolSurface':{screenshot:{url}}}}},
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
  assert.deepEqual(snapshot.thread.turns.map((turn: any) => turn.id), turns.slice(25).map(turn => turn.id));
  assert.equal(snapshot.history.nextCursor, 'turn-25');
  assert.deepEqual(calls.filter(call => call.method === 'thread/items/list').map(call => call.turnId), turns.slice(25).map(turn => turn.id));
  const command = snapshot.thread.turns[0].items[0];
  assert.equal(command.aggregatedOutput, output.slice(0, 2048));
  assert.equal(command.outputChars, output.length);
  assert.equal(command.outputBytes, Buffer.byteLength(output));
  assert.equal(command.outputDeferred, true);
  assert.deepEqual(await runtime.status('thread', snapshot.epoch), { resync: false });
  const state = (runtime as any).state('thread'), baseline = structuredClone(state.syncTurns), revision = state.revision;
  const first = await runtime.history('thread', snapshot.history.nextCursor);
  const last = await runtime.history('thread', first.nextCursor!);
  assert.equal(last.nextCursor, null);
  assert.deepEqual([...last.turns, ...first.turns, ...snapshot.thread.turns].map(turn => turn.id), turns.map(turn => turn.id));
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
