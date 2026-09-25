import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Runtime } from '../src/codex/runtime.ts';

const fixture = fileURLToPath(new URL('./fixtures/runtime-server.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

function start(t: { after: (fn: () => Promise<void>) => void }, idleMs = 60_000, mode = 'normal') {
  const runtime = new Runtime({ executable: process.execPath, args: [fixture, mode], cwd, idleMs, sandbox: 'danger-full-access' });
  t.after(() => runtime.close().catch(() => {}));
  return runtime;
}

test('missing CLI reports the executable and configuration remedy', async t => {
  const runtime = new Runtime({ executable: '/missing/codex-web-cli', cwd });
  t.after(() => runtime.close());
  await assert.rejects(runtime.list(), (error: any) => error.statusCode === 503 && /CODEX_BIN/.test(error.message) && /missing/.test(error.message));
});

test('opening detects another writer before sending and history reads cannot clear the conflict',async t=>{
  const runtime=start(t,60_000,'resume-conflict');
  const [a,b]=await Promise.all([runtime.open('external-thread'),runtime.open('external-thread')]);
  assert.equal(a.phase,'EXTERNAL');assert.strictEqual(a,b);
  assert.equal((await runtime.snapshot('external-thread')).phase,'EXTERNAL');
  await assert.rejects(runtime.send('external-thread',{text:'no',clientRequestId:'blocked-send'}),{code:'RUNTIME_THREAD_BUSY'});
  assert.equal((await runtime.open('external-thread')).phase,'IDLE');
  const snapshot=await runtime.snapshot('external-thread');assert.equal(snapshot.phase,'IDLE');assert.equal(snapshot.thread.turns.length,0);
  const before=(await (runtime as any).call('fixture/stats',{}));
  await runtime.open('external-thread');
  assert.deepEqual(await (runtime as any).call('fixture/stats',{}),before,'already open must not resume again');
});

test('leaving during open releases the acquired thread instead of retaining a hidden writer',async t=>{
  const runtime=start(t);const nativeCall=(runtime as any).mutation.bind(runtime);
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  t.mock.method(runtime as any,'mutation',async(method:string,params:any)=>{if(method==='thread/resume'){entered.resolve();await gate.promise;}return nativeCall(method,params);});
  const opening=runtime.open('opening-thread');await entered.promise;
  assert.equal((await runtime.requestRelease('opening-thread')).status,'pending');gate.resolve();await opening;
  for(let i=0;i<100&&!(runtime as any).states.get('opening-thread').released;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((runtime as any).states.get('opening-thread').released,true);
});

test('all concurrent first calls wait until initialize and initialized complete', async (t) => {
  const runtime = start(t, 60_000, 'delayed-init');
  const [listed, diagnostics] = await Promise.all([runtime.list(), runtime.diagnostics()]);
  assert.deepEqual(listed, { data: [], nextCursor: null });
  assert.equal(diagnostics.available, true);
});

test('active resume returns 409 before turn/start can steer external work', async (t) => {
  const runtime = start(t, 60_000, 'active-resume');
  await assert.rejects(runtime.send('external-thread', { text: 'must not steer', clientRequestId: 'active-resume' }), (error: any) => error.statusCode === 409 && error.code === 'RUNTIME_THREAD_CONFLICT');
});

test('steering adds an idempotent user message to exactly the expected local turn', async (t) => {
  const runtime = start(t, 60_000, 'steering');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const started = await runtime.send(threadId, { text: 'hold', clientRequestId: 'initial' });
  const input = { text: 'also check this', clientRequestId: 'steer-1', expectedTurnId: started.turnId };
  const reply = await runtime.send(threadId, input);
  assert.equal(reply.status, 'steered');
  assert.deepEqual(await runtime.send(threadId, input), reply);
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'RUNNING');
  assert.equal(snapshot.thread.turns.length, 1);
  assert.deepEqual(snapshot.thread.turns[0].items.map((item: any) => item.clientId), ['initial', 'steer-1']);
  await assert.rejects(runtime.send(threadId, { ...input, clientRequestId: 'wrong', expectedTurnId: 'old-turn' }), (e: any) => e.code === 'RUNTIME_STEER_CONFLICT');
  await assert.rejects(runtime.send(threadId, { ...input, clientRequestId: 'settings', permissionMode: 'full-access' }), (e: any) => e.code === 'RUNTIME_INVALID_INPUT');
  await assert.rejects(runtime.send(threadId, { ...input, clientRequestId: 'race', text: 'race-completed' }), (e: any) => e.code === 'RUNTIME_STEER_CONFLICT');
  assert.equal((await runtime.snapshot(threadId)).phase, 'RUNNING');
  await runtime.abort(threadId);
  await assert.rejects(runtime.send(threadId, { ...input, clientRequestId: 'finished' }), (e: any) => e.code === 'RUNTIME_STEER_CONFLICT');
  await assert.rejects(runtime.send('external', { ...input, clientRequestId: 'external' }), (e: any) => e.code === 'RUNTIME_STEER_CONFLICT');
});

test('steering rechecks approval and release state after asynchronous attachment validation', async (t) => {
  for (const change of ['approval', 'release']) {
    const runtime = start(t, 60_000, 'steering');
    const { threadId, turnId } = await runtime.create({ cwd, clientRequestId: 'create', prompt: 'hold' });
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const state = (runtime as any).state(threadId);
    t.mock.method(runtime as any, 'validateTurnOptions', async () => { entered.resolve(); await gate.promise; });
    const sending = runtime.send(threadId, { text: 'wait', clientRequestId: 'steer', expectedTurnId: turnId });
    await entered.promise;
    if (change === 'approval') state.pending.set('approval', {});
    else state.releasePromise = Promise.resolve({});
    gate.resolve();
    await assert.rejects(sending, (e: any) => e.code === 'RUNTIME_STEER_CONFLICT');
    state.pending.clear();state.releasePromise = undefined;
    await runtime.abort(threadId);
  }
});

test('refresh of an unloaded thread clears a resume conflict and allows an explicit retry', async (t) => {
  const runtime = start(t, 60_000, 'resume-conflict');
  await assert.rejects(runtime.send('external-thread', { text: 'continue', clientRequestId: 'first-attempt' }), (e: any) => e.code === 'RUNTIME_THREAD_CONFLICT');
  const snapshot = await runtime.snapshot('external-thread');
  assert.equal(snapshot.thread.status.type, 'notLoaded');
  assert.equal(snapshot.phase, 'IDLE');
  assert.equal(snapshot.error, undefined);
  await runtime.send('external-thread', { text: 'continue', clientRequestId: 'explicit-retry' });
  assert.equal((await runtime.snapshot('external-thread')).phase, 'IDLE');
});

test('released paginated threads resume on the next explicit send', async (t) => {
  const runtime = start(t, 60_000, 'paginated-resume');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create', prompt: 'persist' });
  const before = (await runtime.snapshot(threadId)).thread.turns;
  // Keep the fixture process alive: its native history lives in memory.
  const other = await runtime.create({ cwd, clientRequestId: 'other', prompt: 'hold' });
  await runtime.release(threadId);
  assert.equal((await runtime.snapshot(threadId)).phase, 'RELEASED');
  await runtime.send(threadId, { text: 'continue', clientRequestId: 'after-release' });
  const resumed = await runtime.snapshot(threadId);
  assert.equal(resumed.phase, 'IDLE');
  assert.deepEqual(resumed.thread.turns.slice(0, before.length), before);
  assert.equal(resumed.thread.turns.length, before.length + 1);
  await runtime.abort(other.threadId);
});

test('overlapping snapshots retain the latest read in either completion order', async (t) => {
  for (const newestFirst of [true, false]) {
    const runtime = start(t);
    const reads = [Promise.withResolvers<any>(), Promise.withResolvers<any>()];
    let index = 0;
    (runtime as any).readThread = () => reads[index++].promise;
    const old = runtime.snapshot('thread'), latest = runtime.snapshot('thread');
    const complete = (i: number) => reads[i].resolve({ id: 'thread', status: { type: i ? 'idle' : 'active' }, turns: [] });
    complete(newestFirst ? 1 : 0);
    await (newestFirst ? latest : old);
    complete(newestFirst ? 0 : 1);
    await Promise.all([old, latest]);
    assert.equal((runtime as any).state('thread').nativeStatus.type, 'idle');
  }
});

test('a snapshot started before a new turn cannot unlock that turn', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const read = Promise.withResolvers<any>();
  (runtime as any).readThread = () => read.promise;
  const pending = runtime.snapshot(threadId);
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'hold' });
  read.resolve({ id: threadId, status: { type: 'idle' }, turns: [] });
  assert.equal((await pending).phase, 'RUNNING');
  await assert.rejects(runtime.send(threadId, { text: 'duplicate', clientRequestId: 'duplicate' }), (e: any) => e.statusCode === 409);
  await runtime.abort(threadId);
});

test('completion during history pagination refreshes the earlier active header', async (t) => {
  const runtime = start(t, 60_000, 'completion-during-read');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'hold' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.thread.turns.at(-1).status, 'completed');
  assert.equal(snapshot.phase, 'IDLE');
  assert.equal(snapshot.activeTurnId, null);
});

test('loaded threads also reject sends while native status is active or failed', async (t) => {
  for (const mode of ['external-active', 'system-error']) {
    const runtime = start(t, 60_000, mode);
    const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
    await runtime.snapshot(threadId);
    await assert.rejects(runtime.send(threadId, { text: 'must not send', clientRequestId: 'blocked' }), (e: any) => e.code === 'RUNTIME_THREAD_BUSY');
  }
});

test('refresh reconciles a missed completion and discards stale live text', async (t) => {
  const runtime = start(t, 60_000, 'missed-completion');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'stream', clientRequestId: 'stream' });
  const changes: any[] = [];
  runtime.on('change', change => { if (change.kind === 'status') changes.push(change); });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'IDLE');
  assert.equal(snapshot.activeTurnId, null);
  assert.equal(snapshot.thread.turns.at(-1).status, 'completed');
  assert.equal(snapshot.thread.turns.at(-1).items[0].text, 'persisted final');
  assert.equal(changes.length, 1, 'reconciliation must notify other open readers');
  await runtime.snapshot(threadId);
  assert.equal(changes.length, 1, 'stable reads must not trigger a refresh loop');
  await runtime.release(threadId);
});

test('native external activity and runtime errors are not presented as ready to send', async (t) => {
  assert.equal((await start(t, 60_000, 'external-active').snapshot('external')).phase, 'EXTERNAL');
  assert.equal((await start(t, 60_000, 'system-error').snapshot('broken')).phase, 'UNKNOWN');
});

test('snapshot exhausts native turn and item pagination', async (t) => {
  const runtime = start(t, 60_000, 'pagination');
  const snapshot = await runtime.snapshot('long-thread');
  assert.deepEqual(snapshot.thread.turns.map((value: any) => value.id), ['old', 'recent']);
  assert.deepEqual(snapshot.thread.turns[0].items.map((value: any) => value.text), ['old one', 'old two']);
  assert.equal(snapshot.thread.turns[0].itemsView, 'full');
});

test('large history uses bounded item pages instead of oversized full turns', async (t) => {
  const runtime = start(t, 60_000, 'large-history');
  const snapshot = await runtime.snapshot('large-thread');
  assert.equal(snapshot.phase, 'IDLE');
  assert.deepEqual(snapshot.thread.turns[0].items.map((item: any) => item.text), ['old one', 'old two']);
  assert.equal(snapshot.thread.turns[0].itemsView, 'full');
});

test('legacy threads without item pagination retain windowed history and full command output', async t => {
  const runtime=start(t,60_000,'legacy-items');
  const snapshot=await runtime.snapshot('legacy',{window:true});
  assert.deepEqual(snapshot.thread.turns.map((t:any)=>t.id),['legacy-22','legacy-23','legacy-24']);
  assert.equal(snapshot.history.nextCursor,'legacy-22');
  assert.equal(snapshot.thread.turns[0].items[0].outputDeferred,true);
  let stats=await (runtime as any).call('fixture/stats',{});
  assert.equal(stats.fullTurnLists,3,'initial load must not wait for twenty full native turn reads');
  const earlier=await runtime.history('legacy',snapshot.history.nextCursor);
  assert.deepEqual(earlier.turns.map((t:any)=>t.id),Array.from({length:20},(_,i)=>`legacy-${i+2}`));
  assert.equal(earlier.nextCursor,'legacy-2');
  let next=await (runtime as any).call('fixture/stats',{});
  assert.equal(next.fullTurnLists-stats.fullTurnLists,20,'an older window must not load newer turn bodies');
  const oldest=await runtime.history('legacy',earlier.nextCursor);
  assert.equal(oldest.nextCursor,null);
  assert.deepEqual([...oldest.turns,...earlier.turns,...snapshot.thread.turns].map((t:any)=>t.id),Array.from({length:25},(_,i)=>`legacy-${i}`));
  next=await (runtime as any).call('fixture/stats',{});
  assert.equal(next.fullTurnLists-stats.fullTurnLists,22);
  stats=next;
  assert.deepEqual(await runtime.output('legacy','legacy-7','command-7'),{output:'x'.repeat(9000)});
  next=await (runtime as any).call('fixture/stats',{});
  assert.equal(next.fullTurnLists-stats.fullTurnLists,1,'targeted output must load only its turn body');
  stats=next;
  await assert.rejects(runtime.output('legacy','legacy-7','missing'),{code:'RUNTIME_NOT_FOUND'});
  next=await (runtime as any).call('fixture/stats',{});
  assert.equal(next.fullTurnLists-stats.fullTurnLists,1,'a missing item still checks only its declared turn');
  stats=next;
  await assert.rejects(runtime.output('legacy','missing-turn','missing'),{code:'RUNTIME_NOT_FOUND'});
  next=await (runtime as any).call('fixture/stats',{});
  assert.equal(next.fullTurnLists-stats.fullTurnLists,0,'a missing turn must not load unrelated bodies');
});

test('legacy targeted reads reject unstable native turn cursors', async t => {
  await assert.rejects(start(t,60_000,'legacy-items-repeat').output('legacy','missing-turn','missing'),{code:'RUNTIME_UNAVAILABLE'});
  await assert.rejects(start(t,60_000,'legacy-items-mismatch').output('legacy','legacy-7','command-7'),{code:'RUNTIME_UNAVAILABLE'});
});

test('automatic leave and idle shutdown preserve explicit permissions while manual handoff resets them', async t => {
  const runtime=start(t,60_000,'tightened-resume');
  const {threadId}=await runtime.create({cwd,clientRequestId:'create',permissionMode:'full-access',prompt:'early-complete'});
  await runtime.requestRelease(threadId);
  await runtime.cancelRelease(threadId);
  await runtime.open(threadId);
  let snapshot=await runtime.snapshot(threadId);
  assert.equal(snapshot.permissions.sandbox.type,'dangerFullAccess');
  assert.equal(snapshot.permissions.approvalPolicy,'never');
  await runtime.send(threadId,{text:'early-complete',clientRequestId:'continue'});
  assert.equal((await (runtime as any).call('fixture/stats',{})).lastTurn.sandboxPolicy.type,'dangerFullAccess');
  await (runtime as any).closeIdleServer();
  await runtime.send(threadId,{text:'early-complete',clientRequestId:'after-idle'});
  assert.equal((await (runtime as any).call('fixture/stats',{})).lastTurn.sandboxPolicy.type,'dangerFullAccess');
  await runtime.release(threadId);
  await runtime.open(threadId);
  snapshot=await runtime.snapshot(threadId);
  assert.equal(snapshot.permissions.sandbox.type,'readOnly');
});

test('manual handoff also clears permissions when joining an automatic release', async t => {
  const runtime=start(t,60_000,'tightened-resume');
  const {threadId}=await runtime.create({cwd,clientRequestId:'create',permissionMode:'full-access'});
  await Promise.all([runtime.requestRelease(threadId),runtime.release(threadId)]);
  await runtime.cancelRelease(threadId);
  await runtime.open(threadId);
  assert.equal((await runtime.snapshot(threadId)).permissions.sandbox.type,'readOnly');
});

test('automatically restored permissions are checked against changed native requirements', async t => {
  for (const reopen of [true,false]) {
    const runtime=start(t);
    const {threadId}=await runtime.create({cwd,clientRequestId:'create',permissionMode:'full-access'});
    if (reopen) { await runtime.requestRelease(threadId); await runtime.cancelRelease(threadId); }
    else await (runtime as any).closeIdleServer();
    const call=(runtime as any).call.bind(runtime);
    t.mock.method(runtime as any,'call',(method:string,params:any)=>method==='configRequirements/read'?Promise.resolve({requirements:{allowedSandboxModes:['read-only']}}):call(method,params));
    await assert.rejects(reopen?runtime.open(threadId):runtime.send(threadId,{text:'must not run',clientRequestId:'blocked'}),{code:'RUNTIME_PERMISSION_UNAVAILABLE'});
    const stats=await call('fixture/stats',{});
    assert.equal(stats.lastResume,undefined);
    assert.equal(stats.turnStarts,0);
  }
});

test('release reserves the thread before its native history check', async (t) => {
  const runtime = start(t, 60_000, 'release-race');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const releasing = runtime.release(threadId);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(runtime.send(threadId, { text: 'hold', clientRequestId: 'racing-send' }), (error: any) => error.statusCode === 409 && error.code === 'RUNTIME_THREAD_BUSY');
  assert.equal((await releasing).status, 'released');
});

test('restart discards partial live overlays in favor of persisted terminal history', async (t) => {
  const runtime = start(t, 60_000, 'recovery');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await assert.rejects(runtime.send(threadId, { text: 'stale-crash', clientRequestId: 'stale-crash' }), (error: any) => error.code === 'RUNTIME_RESULT_UNKNOWN');
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.thread.turns[0].status, 'completed');
  assert.equal(snapshot.thread.turns[0].items[0].text, 'final');
});

test('confirmed missing native threads map to a sanitized 404', async (t) => {
  const runtime = start(t, 60_000, 'notfound');
  await assert.rejects(runtime.snapshot('missing-thread'), (error: any) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'RUNTIME_NOT_FOUND');
    assert.equal(error.message, 'Thread was not found');
    assert.doesNotMatch(error.message, /fixture detail/i);
    return true;
  });
});

test('same-epoch newly created empty thread falls back to authoritative metadata', async (t) => {
  const runtime = start(t, 60_000, 'unsupported-empty');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'empty-create' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'IDLE');
  assert.deepEqual(snapshot.thread.turns, []);
  assert.equal(snapshot.unmaterialized, true);
  const window = await runtime.snapshot(threadId, { window: true });
  assert.deepEqual(window.history, { nextCursor: null });
  assert.deepEqual(window.thread.turns, []);
  assert.equal(window.unmaterialized, true);
  assert.deepEqual(await runtime.status(threadId, window.epoch), { resync: false });
});

test('current native unmaterialized error uses the same narrow empty-thread fallback', async (t) => {
  const runtime = start(t, 60_000, 'unmaterialized-current');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'empty-create-current' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.unmaterialized, true);
  assert.deepEqual(snapshot.thread.turns, []);
});

test('new thread metadata retries preserve the accepted first turn without resending it', async t => {
  const runtime = start(t, 60_000, 'metadata-delayed');
  const { threadId, turnId } = await runtime.create({ cwd, clientRequestId: 'metadata-create', prompt: 'hold' });
  const snapshot = await runtime.snapshot(threadId, { window: true });
  assert.equal(snapshot.phase, 'RUNNING');
  assert.equal(snapshot.activeTurnId, turnId);
  assert.equal(snapshot.thread.turns[0].id, turnId);
  const stats = await (runtime as any).call('fixture/stats', {});
  assert.equal(stats.threadReads, 3);
  assert.equal(stats.turnStarts, 1);
  await runtime.abort(threadId);
});

test('empty metadata retries are bounded and do not mask unrelated reads or replay writes', async t => {
  for (const mode of ['metadata-empty', 'metadata-denied', 'metadata-write-error']) {
    const runtime = start(t, 60_000, mode);
    if (mode === 'metadata-write-error') {
      await assert.rejects(runtime.create({ cwd, clientRequestId: mode, prompt: 'hold' }), { code: 'RUNTIME_RESULT_UNKNOWN' });
      assert.equal((await (runtime as any).call('fixture/stats', {})).turnStarts, 1);
      continue;
    }
    const { threadId } = await runtime.create({ cwd, clientRequestId: mode });
    await assert.rejects(runtime.threadCwd(threadId), (error: any) => {
      assert.equal(error.code, mode === 'metadata-empty' ? 'RUNTIME_HISTORY_NOT_READY' : 'RUNTIME_UNAVAILABLE');
      assert.doesNotMatch(error.message, /private|rollout.jsonl/);
      return true;
    });
    assert.equal((await (runtime as any).call('fixture/stats', {})).threadReads, mode === 'metadata-empty' ? 5 : 1);
  }
});

test('empty-thread fallback ends before the first turn is submitted', async (t) => {
  const runtime = start(t, 60_000, 'unsupported-empty');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'empty-create' });
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'first-turn' });
  await assert.rejects(runtime.snapshot(threadId), (error: any) => error.statusCode === 503 && error.code === 'RUNTIME_HISTORY_UNSUPPORTED');
  await runtime.abort(threadId);
});

test('empty thread reports that it was not persisted after its runtime exits', async (t) => {
  const runtime = start(t, 20, 'unsupported-empty');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'empty-create' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(runtime.snapshot(threadId), (error: any) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'RUNTIME_EMPTY_THREAD_NOT_PERSISTED');
    assert.match(error.message, /empty thread.*not persisted/i);
    assert.doesNotMatch(error.message, new RegExp(threadId));
    return true;
  });
});

test('deduplicates accepted sends and atomically rejects a second active turn', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const first = runtime.send(threadId, { text: 'hold', clientRequestId: 'same' });
  assert.deepEqual(await runtime.send(threadId, { text: 'hold', clientRequestId: 'same' }), await first);
  await assert.rejects(runtime.send(threadId, { text: 'different', clientRequestId: 'same' }), (error: any) => error.statusCode === 409 && error.code === 'RUNTIME_IDEMPOTENCY_CONFLICT');
  await assert.rejects(runtime.send(threadId, { text: 'other', clientRequestId: 'other' }), (error: any) => error.statusCode === 409 && error.code === 'RUNTIME_THREAD_BUSY');
  await runtime.abort(threadId);
});

test('does not interrupt a turn whose completion arrived before turn/start response', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'early-complete', clientRequestId: 'early' });
  assert.equal((await runtime.abort(threadId)).status, 'idle');
  assert.equal((await runtime.snapshot(threadId)).thread.turns.at(-1).status, 'completed');
  const diagnostics = await runtime.diagnostics();
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.userAgent, 'codex-cli/fixture');
  assert.equal(diagnostics.account.type, 'chatgpt');
});

test('holds approval with opaque id, validates decision, and rejects stale reply', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'approval', clientRequestId: 'approval' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'WAITING_APPROVAL');
  assert.equal(snapshot.pending[0].method, 'item/commandExecution/requestApproval');
  assert.notEqual(snapshot.pending[0].requestId, `approval-${snapshot.activeTurnId}`);
  await assert.rejects(runtime.respond(threadId, snapshot.pending[0].requestId, { decision: 'anything' }), (error: any) => error.statusCode === 400);
  await runtime.respond(threadId, snapshot.pending[0].requestId, { decision: 'decline' });
  await assert.rejects(runtime.respond(threadId, snapshot.pending[0].requestId, { decision: 'decline' }), (error: any) => error.statusCode === 409);
  assert.equal((await runtime.snapshot(threadId)).phase, 'IDLE');
});

test('merges native history with live delta items by turn and item id', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'stream', clientRequestId: 'stream' });
  const snapshot = await runtime.snapshot(threadId);
  assert.deepEqual(snapshot.thread.turns.map((value: any) => value.id), ['past', snapshot.activeTurnId]);
  assert.equal(snapshot.thread.turns[1].items[0].text, 'hello');
  await runtime.abort(threadId);
});

test('process failure marks an accepted mutation unknown without retry', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await assert.rejects(runtime.send(threadId, { text: 'exit-unknown', clientRequestId: 'unknown' }), (error: any) => error.statusCode === 504 && error.code === 'RUNTIME_RESULT_UNKNOWN');
  await assert.rejects(runtime.send(threadId, { text: 'exit-unknown', clientRequestId: 'unknown' }), (error: any) => error.statusCode === 504 && error.code === 'RUNTIME_RESULT_UNKNOWN');
  assert.equal((await runtime.diagnostics()).failures, 1);
});

test('create preserves a started thread id when its initial prompt result is unknown', async (t) => {
  const runtime = start(t);
  await assert.rejects(runtime.create({ cwd, prompt: 'exit-unknown', clientRequestId: 'create-with-prompt' }), (error: any) => {
    assert.equal(error.code, 'RUNTIME_RESULT_UNKNOWN');
    assert.equal(error.partial.threadId, 'thread-1');
    return true;
  });
});

test('bounded replay requires reset after old event ids are evicted', { timeout: 10_000 }, async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const firstChange = once(runtime, 'change');
  await runtime.send(threadId, { text: 'flood', clientRequestId: 'flood' });
  const [first] = await firstChange;
  await runtime.snapshot(threadId);
  assert.equal(runtime.replay(threadId, first.id).reset, true);
});

test('release requires idle history, unsubscribes, and reports released snapshot', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'hold' });
  await assert.rejects(runtime.release(threadId), (error: any) => error.statusCode === 409);
  await runtime.abort(threadId);
  const released = await runtime.release(threadId);
  assert.equal(released.status, 'released');
  assert.equal(released.runtimeStopped, true);
  assert.equal((await runtime.snapshot(threadId)).phase, 'RELEASED');
});

test('validates permission grants against the requested profile', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'permissions', clientRequestId: 'permissions' });
  const [pending] = (await runtime.snapshot(threadId)).pending;
  await assert.rejects(runtime.respond(threadId, pending.requestId, {
    permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['C:\\extra'] } }, scope: 'session',
  }), (error: any) => error.code === 'RUNTIME_INVALID_ANSWER');
  await runtime.respond(threadId, pending.requestId, { permissions: pending.params.permissions, scope: 'turn' });
});

test('validates requestUserInput option labels and MCP form schemas', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'input', clientRequestId: 'input' });
  let [pending] = (await runtime.snapshot(threadId)).pending;
  await assert.rejects(runtime.respond(threadId, pending.requestId, { answers: { choice: { answers: ['C'] } } }), (error: any) => error.code === 'RUNTIME_INVALID_ANSWER');
  await runtime.respond(threadId, pending.requestId, { answers: { choice: { answers: ['A'] } } });
  assert.equal((await runtime.snapshot(threadId)).phase, 'IDLE');

  await runtime.send(threadId, { text: 'mcp', clientRequestId: 'mcp' });
  ;[pending] = (await runtime.snapshot(threadId)).pending;
  await assert.rejects(runtime.respond(threadId, pending.requestId, { action: 'accept', content: { name: '', extra: true }, _meta: null }), (error: any) => error.code === 'RUNTIME_INVALID_ANSWER');
  await runtime.respond(threadId, pending.requestId, { action: 'accept', content: { name: 'Ada' }, _meta: null });
});

test('completed items replace accumulated deltas and late deltas are ignored', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'stream-complete', clientRequestId: 'stream-complete' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.thread.turns.at(-1).items[0].text, 'final');
  assert.equal(snapshot.thread.turns.at(-1).status, 'completed');
});

test('accumulates command output deltas in the live native item shape', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'command-stream', clientRequestId: 'command-stream' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.thread.turns.at(-1).items[0].aggregatedOutput, 'one two');
  await runtime.abort(threadId);
});

test('rejects unknown server interactions and exposes an explicit thread error', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'unsupported', clientRequestId: 'unsupported' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'UNKNOWN');
  assert.match(snapshot.error, /unsupported interaction/i);
});

test('turn error notifications retain the active turn and its Abort control', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'retry-error', clientRequestId: 'retry-error' });
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'RUNNING');
  assert.equal(snapshot.thread.turns.at(-1).error, null);
  assert.equal(snapshot.retry.message, 'temporary fixture failure');
  assert.equal(snapshot.retry.turnId, snapshot.activeTurnId);
  await runtime.abort(threadId);
});

test('idle shutdown restarts with a new replay epoch', async (t) => {
  const runtime = start(t, 20);
  await runtime.list();
  const oldEpoch = (await runtime.diagnostics()).epoch;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await runtime.list();
  assert.notEqual((await runtime.diagnostics()).epoch, oldEpoch);
  assert.equal(runtime.replay('thread-1', `${oldEpoch}:0`).reset, true);
});


test('direct release reconciles a missed completion without a prior refresh', async (t) => {
  const runtime = start(t, 60_000, 'missed-completion');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'stream', clientRequestId: 'stream' });
  const result = await runtime.release(threadId);
  assert.equal(result.handoffReady, true);
  assert.equal(result.runtimeStopped, true);
});

test('release on leave waits for terminal state and shared work; returning cancels deferred release', async (t) => {
  const runtime = start(t);
  const a = await runtime.create({ cwd, clientRequestId: 'a', prompt: 'hold' });
  const b = await runtime.create({ cwd, clientRequestId: 'b', prompt: 'hold' });
  assert.equal((await runtime.requestRelease(a.threadId)).status, 'pending');
  assert.equal((await runtime.snapshot(a.threadId)).release.requested, true);
  await runtime.cancelRelease(a.threadId);
  await runtime.abort(a.threadId);
  assert.equal((await runtime.snapshot(a.threadId)).release.requested, false);
  const released = await runtime.release(a.threadId);
  assert.equal(released.handoffReady, false);
  assert.equal((await runtime.snapshot(b.threadId)).phase, 'RUNNING');
  await runtime.requestRelease(a.threadId);
  const ready = new Promise<void>(resolve => runtime.on('change', (change) => {
    if (change.threadId === a.threadId && (runtime as any).state(a.threadId).handoffReady) resolve();
  }));
  await runtime.abort(b.threadId);
  await ready;
});

test('return during release waits for completion and cannot race a new send', async (t) => {
  const runtime = start(t, 60_000, 'release-race');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const releasing = runtime.requestRelease(threadId);
  const returning = runtime.cancelRelease(threadId);
  await assert.rejects(runtime.send(threadId, { text: 'hold', clientRequestId: 'race' }), (e: any) => e.code === 'RUNTIME_THREAD_BUSY');
  await Promise.all([releasing, returning]);
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'after-return' });
  assert.equal((await runtime.snapshot(threadId)).phase, 'RUNNING');
  await runtime.abort(threadId);
});

test('model catalog validates effort and forwards controlled native input', async (t) => {
  const runtime = start(t);
  const catalog = await runtime.models();
  assert.equal(catalog.data[0].model, 'fixture');
  await assert.rejects(runtime.create({ cwd, clientRequestId: 'invalid', model: 'missing' }), (e: any) => e.code === 'RUNTIME_INVALID_MODEL');
  await assert.rejects(runtime.create({ cwd, clientRequestId: 'effort', model: 'fixture', effort: 'ultra' }), (e: any) => e.code === 'RUNTIME_INVALID_EFFORT');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create', model: 'fixture' });
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'image', model: 'fixture', effort: 'high', nativeInput: [{ type: 'localImage', path: cwd + '/private.png' }] });
  const stats = await (runtime as any).call('fixture/stats', {});
  assert.equal(stats.lastTurn.effort, 'high');
  assert.equal(stats.lastTurn.input[1].type, 'localImage');
  await assert.rejects(runtime.send(threadId, { text: 'hold', clientRequestId: 'image', model: 'fixture', effort: 'low' }), (e: any) => e.code === 'RUNTIME_IDEMPOTENCY_CONFLICT');
  await runtime.abort(threadId);
});

test('permission presets and custom explicitly replace previous effective policies', async (t) => {
  const runtime = start(t);
  const modes = await runtime.permissionModes(cwd);
  assert.deepEqual(modes.modes.map((m: any) => m.id), ['ask', 'auto-review', 'full-access', 'custom']);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create', permissionMode: 'ask' });
  assert.equal((await runtime.snapshot(threadId)).permissions.sandbox.type, 'workspaceWrite');
  for (const [mode, policy, reviewer, sandbox] of [
    ['auto-review', 'on-request', 'auto_review', 'workspaceWrite'],
    ['full-access', 'never', 'user', 'dangerFullAccess'],
    ['custom', 'on-request', 'user', 'readOnly'],
  ]) {
    await runtime.send(threadId, { text: 'early-complete', clientRequestId: mode, permissionMode: mode as any });
    const stats = await (runtime as any).call('fixture/stats', {});
    assert.equal(stats.lastTurn.approvalPolicy, policy);
    assert.equal(stats.lastTurn.approvalsReviewer, reviewer);
    assert.equal(stats.lastTurn.sandboxPolicy.type, sandbox);
  }
  await runtime.rename(threadId, '  Renamed  ');
  assert.equal((await runtime.snapshot(threadId)).thread.name, 'Renamed');
});

test('permission catalog exposes only native model and effort defaults for the requested cwd',async t=>{
  const runtime=start(t),calls:any[]=[];
  t.mock.method(runtime as any,'call',async(method:string,params:any)=>{
    calls.push({method,params});
    return method==='config/read'?{config:{model:'native-model',model_reasoning_effort:'high',secret:'not-for-browser'}}:{requirements:null};
  });
  const result=await runtime.permissionModes(cwd);
  assert.equal(result.model,'native-model');assert.equal(result.effort,'high');
  assert.deepEqual(Object.keys(result).sort(),['current','effort','model','modes']);
  assert.deepEqual(calls,[{method:'config/read',params:{cwd,includeLayers:false}},{method:'configRequirements/read',params:{}}]);
});

test('confirmed turn options reach snapshots and incremental state even when history headers lag',async t=>{
  const runtime=start(t),changes:any[]=[];
  runtime.on('change',event=>changes.push(event));
  const {threadId}=await runtime.create({cwd,clientRequestId:'remember-create',permissionMode:'ask'});
  await runtime.send(threadId,{text:'early-complete',clientRequestId:'remember-send',model:'actual-text',effort:'low',permissionMode:'auto-review'});
  const snapshot=await runtime.snapshot(threadId);
  assert.equal(snapshot.model,'actual-text');assert.equal(snapshot.reasoningEffort,'low');
  assert.equal(changes.at(-1).patch.state.reasoningEffort,'low');
  await runtime.send(threadId,{text:'early-complete',clientRequestId:'remember-model-only',model:'fixture'});
  assert.equal((await runtime.snapshot(threadId)).reasoningEffort,null,'changing model without effort must not advertise the previous effort as confirmed');
  assert.equal(changes.at(-1).patch.state.reasoningEffort,null);
});

test('managed requirements disable incompatible presets and block writes', async (t) => {
  const runtime = start(t, 60_000, 'managed');
  const modes = await runtime.permissionModes(cwd);
  assert.equal(modes.modes.find((m: any) => m.id === 'full-access').available, false);
  await assert.rejects(runtime.create({ cwd, clientRequestId: 'denied', permissionMode: 'full-access' }), (e: any) => e.code === 'RUNTIME_PERMISSION_UNAVAILABLE');
});


test('terminal history wins over a same-turn late delta during snapshot pagination', async (t) => {
  const runtime = start(t, 60_000, 'missed-completion');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const sent = await runtime.send(threadId, { text: 'stream', clientRequestId: 'stream' });
  const read = (runtime as any).readThread.bind(runtime);
  (runtime as any).readThread = async (id: string) => {
    const result = await read(id);
    (runtime as any).onNotification({ method: 'item/agentMessage/delta', params: { threadId, turnId: sent.turnId, itemId: 'late', delta: 'tail' } });
    return result;
  };
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'IDLE');
  assert.equal(snapshot.activeTurnId, null);
});

test('already released threads can repeat release without leaving a permanent operation lock', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.release(threadId);
  await runtime.release(threadId);
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'after' });
  assert.equal((await runtime.snapshot(threadId)).phase, 'RUNNING');
  await runtime.abort(threadId);
});

test('new session defaults come from native configuration', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  assert.equal((await runtime.snapshot(threadId)).permissions.sandbox.type, 'dangerFullAccess');
});


test('leave reconciles missing terminal events instead of waiting forever', async (t) => {
  const runtime = start(t, 60_000, 'missed-completion');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'stream', clientRequestId: 'stream' });
  assert.equal((await runtime.requestRelease(threadId)).handoffReady, true);
});

test('refresh reconciles a terminal system error without reloading or interrupting any thread',async t=>{
  const runtime=start(t);
  const active=await runtime.create({cwd,clientRequestId:'other',prompt:'hold'});
  const {threadId}=await runtime.create({cwd,clientRequestId:'failed',prompt:'quota-error'});
  await (runtime as any).call('fixture/stats',{});
  assert.equal((runtime as any).phase((runtime as any).states.get(threadId)),'UNKNOWN');
  assert.equal((await runtime.open(threadId)).phase,'IDLE');
  const recovered=await runtime.snapshot(threadId);
  assert.equal(recovered.phase,'IDLE');assert.equal(recovered.thread.status.type,'systemError');
  assert.equal(recovered.thread.turns.at(-1).error.codexErrorInfo,'usageLimitExceeded');
  const stats=await (runtime as any).call('fixture/stats',{});
  assert.equal(stats.unsubscribes,0);assert.equal(stats.resumes,0);assert.equal(stats.interrupts,0);
  assert.equal((await runtime.snapshot(active.threadId)).activeTurnId,active.turnId);
  await runtime.send(threadId,{text:'continue',clientRequestId:'after-reset'});
  assert.equal((await runtime.snapshot(threadId)).phase,'IDLE');
});

test('a failed terminal thread can be released while active or unresolved native work remains protected',async t=>{
  const runtime=start(t);
  const active=await runtime.create({cwd,clientRequestId:'other',prompt:'hold'});
  const {threadId}=await runtime.create({cwd,clientRequestId:'failed',prompt:'quota-error'});
  assert.equal((await runtime.release(threadId)).status,'released');
  assert.equal((await (runtime as any).call('fixture/stats',{})).interrupts,0);
  await assert.rejects(runtime.release(active.threadId),{code:'RUNTIME_THREAD_BUSY'});
});

test('refresh recovers a missing local turn id without resuming or claiming an external writer',async t=>{
  const runtime=start(t);
  const {threadId,turnId}=await runtime.create({cwd,clientRequestId:'own',prompt:'hold'});
  const state=(runtime as any).states.get(threadId);state.activeTurnId=null;
  assert.equal((runtime as any).phase(state),'UNKNOWN');
  assert.equal((await runtime.open(threadId)).phase,'RUNNING');
  assert.equal((await runtime.snapshot(threadId)).activeTurnId,turnId);
  assert.equal((await (runtime as any).call('fixture/stats',{})).resumes,0);
  state.activeTurnId=null;state.externalWriter=true;
  assert.equal((await runtime.snapshot(threadId)).phase,'EXTERNAL');
  assert.equal(state.activeTurnId,null);
});

test('recovery cannot unload a system error with unfinished or unknown work',async t=>{
  for(const prompt of [undefined,'hold']){
    const runtime=start(t,60_000,'system-error');
    const {threadId}=await runtime.create({cwd,clientRequestId:'blocked',prompt});
    const state=(runtime as any).states.get(threadId);state.activeTurnId=null;
    await runtime.snapshot(threadId);
    await assert.rejects(runtime.open(threadId),{code:'RUNTIME_THREAD_BUSY'});
    await assert.rejects(runtime.release(threadId),{code:'RUNTIME_THREAD_BUSY'});
    const stats=await (runtime as any).call('fixture/stats',{});
    assert.equal(stats.unsubscribes,0);assert.equal(stats.resumes,0);assert.equal(stats.interrupts,0);
  }
});

test('release preserves the actual native unsubscribe result', async (t) => {
  const runtime = start(t, 60_000, 'not-subscribed');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  assert.equal((await runtime.release(threadId)).nativeStatus, 'notSubscribed');
});

test('workspace custom configuration retains all native permission boundaries', async (t) => {
  const runtime = start(t, 60_000, 'custom-workspace');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create', permissionMode: 'custom' });
  const permissions = (await runtime.snapshot(threadId)).permissions;
  assert.equal(permissions.sandbox.networkAccess, true);
  assert.equal(permissions.sandbox.excludeTmpdirEnvVar, false);
  assert.equal(permissions.sandbox.excludeSlashTmp, true);
  assert.ok(permissions.sandbox.writableRoots.includes(cwd + '/extra'));
});

test('native permission mismatch rejects creation instead of silently broadening access', async (t) => {
  const runtime = start(t, 60_000, 'permission-mismatch');
  await assert.rejects(runtime.create({ cwd, clientRequestId: 'create', permissionMode: 'ask' }), (e: any) => e.code === 'RUNTIME_PERMISSION_MISMATCH');
});


test('returning to an approval cancels leave intent without answering or interrupting it', async (t) => {
  const runtime = start(t);
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'approval', clientRequestId: 'approval' });
  await runtime.requestRelease(threadId);
  const snapshot = await runtime.snapshot(threadId);
  assert.equal(snapshot.phase, 'WAITING_APPROVAL');
  assert.equal(snapshot.release.requested, true);
  assert.equal(snapshot.release.error, undefined);
  await runtime.cancelRelease(threadId);
  await runtime.respond(threadId, snapshot.pending[0].requestId, { decision: 'decline' });
  assert.equal((await runtime.snapshot(threadId)).phase, 'IDLE');
});

test('incomplete custom sandbox configuration is unavailable instead of approximated', async (t) => {
  const runtime = start(t, 60_000, 'incomplete-workspace');
  const modes = await runtime.permissionModes(cwd);
  assert.equal(modes.modes.find((m: any) => m.id === 'custom').available, false);
});


test('shared shutdown refuses native active or unknown work without a local turn event', async (t) => {
  for (const status of ['active', 'systemError']) {
    const runtime = start(t);
    const a = await runtime.create({ cwd, clientRequestId: 'a' });
    const b = await runtime.create({ cwd, clientRequestId: 'b' });
    (runtime as any).onNotification({ method: 'thread/status/changed', params: { threadId: b.threadId, status: { type: status } } });
    const released = await runtime.release(a.threadId);
    assert.equal(released.handoffReady, false);
    assert.equal(released.runtimeStopped, false);
  }
});

test('send validates effort and images against the authoritative resumed model', async (t) => {
  for (const options of [{ effort: 'high' }, { nativeInput: [{ type: 'localImage' as const, path: cwd + '/private.png' }] }]) {
    const runtime = start(t, 60_000, 'resume-text-model');
    await assert.rejects(runtime.send('existing', { text: 'hold', clientRequestId: 'send', ...options }), (e: any) => ['RUNTIME_INVALID_EFFORT', 'RUNTIME_MODEL_INPUT_UNSUPPORTED'].includes(e.code));
    assert.equal((await (runtime as any).call('fixture/stats', {})).turnStarts, 0);
  }
  const runtime = start(t, 60_000, 'config-text-model');
  await runtime.send('existing', { text: 'hold', clientRequestId: 'valid', effort: 'high' });
  assert.equal((await runtime.snapshot('existing')).phase, 'RUNNING');
  await runtime.abort('existing');
});

test('model catalog is cached for five minutes per native process epoch', async (t) => {
  const runtime = start(t);
  await Promise.all([runtime.models(), runtime.models()]);
  assert.equal((await (runtime as any).call('fixture/stats', {})).modelLists, 1);
  await runtime.models(true);
  assert.equal((await (runtime as any).call('fixture/stats', {})).modelLists, 2);
  assert.ok(runtime.modelInfo().readAt);
  const realNow = Date.now();
  t.mock.method(Date, 'now', () => realNow + 300001);
  await runtime.models();
  assert.equal((await (runtime as any).call('fixture/stats', {})).modelLists, 3);
  t.mock.restoreAll();
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.release(threadId);
  await runtime.models();
  assert.equal((await (runtime as any).call('fixture/stats', {})).modelLists, 1);
});

test('native async question metadata survives live items and safe reload rejects active work',async t=>{
  const runtime=start(t);await runtime.open('existing');
  (runtime as any).onNotification({method:'item/completed',params:{threadId:'existing',turnId:'question-turn',item:{type:'agentMessage',id:'question-item',delivery:'async',text:'Question text',questions:[{title:'Continue?',options:['Yes','No']}]}}});
  assert.equal((await runtime.question('existing','question-turn','question-item')).questions[0].options[0],'Yes');
  (runtime as any).states.get('existing').activeTurnId='active';
  await assert.rejects(runtime.reloadModels(),{code:'RUNTIME_THREAD_BUSY'});
  assert.throws(()=>runtime.prepareUpdate(),{code:'RUNTIME_THREAD_BUSY'});
  (runtime as any).states.get('existing').activeTurnId=null;
  assert.ok((await runtime.reloadModels()).data.length);
});

test('failed native reload preserves a marked display catalog without weakening turn validation',async t=>{
  const runtime=start(t),catalog=await runtime.models(),readAt=runtime.modelInfo().readAt;
  t.mock.method(runtime as any,'loadModels',async()=>{throw Error('model list unavailable');});
  await assert.rejects(runtime.reloadModels(),/unavailable/);
  const stale=await runtime.models(false,true);
  assert.deepEqual(stale.data,catalog.data);assert.equal(stale.stale,true);
  assert.equal(runtime.modelInfo().readAt,readAt);
  await assert.rejects(runtime.models(),/unavailable/);
  await assert.rejects(runtime.models(true,true),/unavailable/);
});

test('native lifecycle notifications emit small stable Push events without snapshot reads', async (t) => {
  const runtime = start(t);
  const events: any[] = [];
  runtime.on('notification', event => events.push(event));
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  await runtime.send(threadId, { text: 'early-complete', clientRequestId: 'complete' });
  assert.equal(events[0].kind, 'complete');
  const eventKey = events[0].eventKey;
  (runtime as any).onNotification({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'completed',items:[]}}});
  assert.equal(events.length, 1);
  assert.equal(events[0].eventKey, eventKey);
  await runtime.send(threadId, { text: 'approval', clientRequestId: 'approval' });
  await (runtime as any).call('fixture/stats', {});
  assert.equal(events.at(-1).kind, 'approval');
  assert.deepEqual(Object.keys(events[0]).sort(), ['eventKey','kind','threadId']);
});

test('unresolved native defaults are delegated on initial start and resume without overrides', async (t) => {
  const runtime = start(t, 60_000, 'null-config');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create' });
  const stats = await (runtime as any).call('fixture/stats', {});
  assert.equal(stats.lastThread.approvalPolicy, undefined);
  assert.equal(stats.lastThread.sandbox, undefined);
  assert.equal((await runtime.snapshot(threadId)).permissions.sandbox.type, 'dangerFullAccess');
  await runtime.send('existing', {text:'hold',clientRequestId:'resume'});
  assert.equal((await (runtime as any).call('fixture/stats', {})).lastResume.approvalPolicy, undefined);
  await runtime.abort('existing');
});

test('thread lists include cached pending-release state without reading thread history', async (t) => {
  const runtime = start(t);
  const {threadId} = await runtime.create({cwd,clientRequestId:'create',prompt:'hold'});
  await runtime.requestRelease(threadId);
  const listed = await runtime.list();
  assert.equal(listed.data.find((thread: any) => thread.id === threadId).release.requested, true);
  await runtime.cancelRelease(threadId);
  await runtime.abort(threadId);
});


test('handoff re-resolves omitted permissions without restoring an old full-access override', async (t) => {
  const runtime = start(t, 60_000, 'tightened-resume');
  const { threadId } = await runtime.create({ cwd, clientRequestId: 'create', permissionMode: 'full-access' });
  await runtime.send(threadId, { text: 'early-complete', clientRequestId: 'loaded' });
  assert.equal((await (runtime as any).call('fixture/stats', {})).lastTurn.approvalPolicy, 'never');
  await runtime.release(threadId);
  await runtime.send(threadId, { text: 'hold', clientRequestId: 'returned' });
  const stats = await (runtime as any).call('fixture/stats', {});
  assert.equal(stats.lastResume.approvalPolicy, undefined);
  assert.equal(stats.lastResume.sandbox, undefined);
  assert.equal(stats.lastTurn.approvalPolicy, 'on-request');
  assert.equal(stats.lastTurn.sandboxPolicy.type, 'readOnly');
  await runtime.abort(threadId);
});

test('approval notifications keep the same item identity across different native RPC ids', async (t) => {
  const runtime = start(t);
  const events: any[] = [];
  runtime.on('notification', event => events.push(event));
  const {threadId} = await runtime.create({cwd,clientRequestId:'create'});
  const {turnId} = await runtime.send(threadId, {text:'hold',clientRequestId:'hold'});
  const params = {threadId,turnId,itemId:'same-command',approvalId:null,startedAtMs:123};
  for (const id of [1,2]) (runtime as any).onRequest({id,method:'item/commandExecution/requestApproval',params});
  assert.equal(events.filter(event => event.kind === 'approval').length, 1);
  assert.match(events[0].eventKey, /same-command/);
  await runtime.abort(threadId);
});

test('implicit native cwd is equivalent on create and resume without relaxing permission checks', async (t) => {
  const runtime = start(t, 60_000, 'implicit-cwd');
  for (const permissionMode of ['ask', 'auto-review'] as const) {
    const {threadId} = await runtime.create({cwd, clientRequestId:'create-'+permissionMode, permissionMode});
    await runtime.release(threadId);
    await runtime.send(threadId,{text:'hold',clientRequestId:'resume-'+permissionMode,permissionMode});
    assert.equal((await runtime.snapshot(threadId)).phase,'RUNNING');
    await runtime.abort(threadId);
  }
  const expected={approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
  const native={...expected,cwd,sandbox:{...expected.sandbox,writableRoots:[]}};
  for (const changed of [
    {...native,approvalPolicy:'never'}, {...native,approvalsReviewer:'user'},
    {...native,sandbox:{...native.sandbox,networkAccess:true}},
    {...native,sandbox:{...native.sandbox,excludeTmpdirEnvVar:false}},
    {...native,sandbox:{...native.sandbox,writableRoots:[cwd+'/extra']}},
    {...native,cwd:cwd+'/other'},
  ]) assert.throws(()=>(runtime as any).verifyPermissions(changed,expected,cwd),(e:any)=>e.code==='RUNTIME_PERMISSION_MISMATCH');
});
test('native archive moves and restores idle sessions and refuses active or external writers',async t=>{
  const runtime=start(t),{threadId}=await runtime.create({cwd,clientRequestId:'archive-create',prompt:'done'});
  await runtime.snapshot(threadId);
  assert.equal((await runtime.archive(threadId)).archived,true);
  assert.ok(!(await runtime.list()).data.some(item=>item.id===threadId));
  assert.ok((await runtime.list(undefined,true)).data.some(item=>item.id===threadId));
  assert.equal((await runtime.archive(threadId,false)).archived,false);
  assert.ok((await runtime.list()).data.some(item=>item.id===threadId));
  await runtime.send(threadId,{text:'hold',clientRequestId:'active-archive'});
  await assert.rejects(runtime.archive(threadId),(error:any)=>error.code==='RUNTIME_THREAD_BUSY');
  const external=start(t,60000,'resume-conflict');
  await assert.rejects(external.archive('external'),(error:any)=>error.code==='RUNTIME_THREAD_BUSY');
});

test('session listing uses the native state index and preserves cursor/source filters',async t=>{
  const runtime=start(t);let args:any;
  t.mock.method(runtime as any,'call',async(method:string,input:any)=>{assert.equal(method,'thread/list');args=input;return {data:[{id:'listed'}],nextCursor:'next'};});
  const result=await runtime.list('page');assert.equal(args.useStateDbOnly,true);assert.equal(args.cursor,'page');assert.deepEqual(args.sourceKinds,['cli','vscode','appServer','exec']);assert.equal(result.nextCursor,'next');assert.equal(result.data[0].id,'listed');
});
