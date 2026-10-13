import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AppServer } from '../src/codex/app-server.ts';

const fixture = fileURLToPath(new URL('./fixtures/rpc-server.mjs', import.meta.url));
test('native history diagnostics retain only exact error class code method and thread correlation',async t=>{
 const events:any[]=[],server=start(t,{diagnostic:(event:any)=>events.push(event)}),threadId='d5f13aa2-13c1-4119-a795-0006b4e326a6';
 const message=`thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;
 for(const [code,text,method,kind] of [[-32600,message,'thread/turns/list','history-not-materialized'],[-32603,message,'thread/turns/list','rpc-error'],[-32601,'list_turns is not supported yet','thread/read','history-unsupported']]){
  await assert.rejects(server.request(method as string,{threadId,prompt:'secret-prompt',fixtureError:{code,message:text,data:{credential:'secret-credential'}}}));
  const event=events.filter(event=>event.event==='rpc_end').at(-1);assert.equal(event.errorClass,kind);assert.equal(event.errorCode,code);assert.equal(event.method,method);assert.equal(event.threadId,threadId);
 }
 assert.doesNotMatch(JSON.stringify(events),/secret-prompt|secret-credential|not materialized yet|fixtureError/);
});
function start(t: { after: (fn: () => Promise<void>) => void }, options = {}) {
  const server = new AppServer({ executable: process.execPath, args: [fixture], timeoutMs: 1000, ...options });
  t.after(() => server.close().catch(() => {}));
  return server;
}

test('drops inherited client identity while preserving all other environment values', async (t) => {
  const identities = ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
  const original = identities.map((key) => process.env[key]);
  let server: AppServer;
  try {
    identities.forEach((key) => { process.env[key] = 'fixture-host-identity'; });
    server = start(t);
    assert.ok(identities.every((key) => process.env[key] === 'fixture-host-identity'), 'parent environment must stay intact');
  } finally {
    identities.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    });
  }
  const inherited = await server!.request<Record<string, string>>('environment', {});
  assert.ok(identities.every((key) => !(key in inherited)), 'child must not inherit another client identity');
  const expected = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !identities.includes(key))
    .map(([key, value]) => [key, createHash('sha256').update(value!).digest('hex')]));
  assert.deepEqual(inherited, expected, 'preserve all other environment values including security restrictions and credentials');
});

test('initialize completes before initialized is sent', async (t) => {
  const server = start(t);
  assert.deepEqual(await server.initialize(), {
    clientInfo: { name: 'codex_remote_web', title: 'Codex Web', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  assert.equal(await server.request('ready', {}), true);
});

test('correlates out-of-order responses including id zero and split UTF-8', async (t) => {
  const server = start(t);
  assert.deepEqual(await Promise.all([server.request('pair', {}), server.request('pair', {})]), ['中文🙂', 'second']);
});

test('separates requests from notifications, preserves typed ids, rejects stale replies', async (t) => {
  const server = start(t);
  const requests: any[] = [];
  const notifications: any[] = [];
  server.on('request', (message) => requests.push(message));
  server.on('notification', (message) => notifications.push(message));
  await server.request('events', {});
  assert.deepEqual(requests.map(({ id }) => id), [0, '0', 'stale']);
  assert.deepEqual(notifications.map(({ method }) => method), ['notice', 'serverRequest/resolved']);
  const answer = once(server, 'notification');
  server.respond(0, { decision: 'decline' });
  assert.deepEqual((await answer)[0].params, { id: 0, result: { decision: 'decline' } });
  assert.throws(() => server.respond(0, {}), /pending|stale|answered/i);
  const rejection = once(server, 'notification');
  server.respondError('0', -32601, 'unsupported');
  assert.deepEqual((await rejection)[0].params, { id: '0', error: { code: -32601, message: 'unsupported' } });
  assert.throws(() => server.respond('stale', {}), /pending|stale|answered/i);
});

test('timeout reports uncertain outcome without retrying and leaves connection usable', async (t) => {
  const server = start(t);
  await server.initialize();
  await assert.rejects(server.request('ignore', {}, 80), /timed out.*uncertain/i);
  assert.equal(await server.request('count', {}), 1);
  await assert.rejects(server.request('rpcError', {}), /denied/);
});

test('a short read deadline removes the pending request without changing other RPC timeouts',async t=>{
  const server=start(t);
  await server.initialize();const started=performance.now();
  await assert.rejects(server.request('lateRead',{},40),/timed out.*uncertain/i);
  assert.ok(performance.now()-started<500);assert.equal(server.diagnosticState().pendingCount,0);
  assert.equal(await server.request('count',{}),1);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await server.request('ready',{}),true);assert.equal(server.diagnosticState().pendingCount,0);
});

test('opt-in late outcomes retain exact RPC ownership without retrying ordinary timed-out calls',async t=>{
  const server=start(t);await server.initialize();
  const outcomes:any[]=[],first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>();
  await Promise.all([
    assert.rejects(server.request('lateOutcome',{value:'first',delay:120},20,(outcome:any)=>{outcomes.push(['first',outcome]);first.resolve();}),/timed out.*uncertain/i),
    assert.rejects(server.request('lateOutcome',{value:'second',delay:80},20,(outcome:any)=>{outcomes.push(['second',outcome]);second.resolve();}),/timed out.*uncertain/i),
    assert.rejects(server.request('lateOutcome',{value:'ordinary',delay:60},20),/timed out.*uncertain/i),
  ]);
  assert.equal(server.diagnosticState().pendingCount,0);
  assert.equal(server.diagnosticState().lateOutcomeCount,2);
  await Promise.all([first.promise,second.promise]);
  assert.deepEqual(outcomes,[['second',{result:'second'}],['first',{result:'first'}]]);
  assert.equal(server.diagnosticState().lateOutcomeCount,0);
  assert.equal(await server.request('count',{}),3,'No timed-out call is replayed');
});

test('opt-in late RPC errors settle ownership once while callbacks cannot break the transport',{timeout:2000},async t=>{
  const server=start(t);await server.initialize();
  const late=Promise.withResolvers<any>();
  await assert.rejects(server.request('lateOutcome',{error:true},20,(outcome:any)=>{late.resolve(outcome);throw Error('observer failure');}),/timed out/i);
  const outcome=await late.promise;assert.equal(outcome.error.code,-32000);assert.match(outcome.error.message,/late denial/);
  assert.equal(server.diagnosticState().lateOutcomeCount,0);assert.equal(await server.request('ready',{}),true);
});

for(const end of ['close','failure'])test(`opt-in late ownership ends on ${end} without waiting for the unknown RPC`,async t=>{
  const server=start(t);await server.initialize();const outcomes:any[]=[];
  await assert.rejects(server.request('ignore',{},20,(outcome:any)=>outcomes.push(outcome)),/timed out/i);
  assert.equal(server.diagnosticState().lateOutcomeCount,1);
  if(end==='close')await server.close();else await assert.rejects(server.request('exit',{}),/exited/i);
  assert.equal(outcomes.length,1);assert.match(outcomes[0].error.message,/closed|exited/i);
  assert.equal(server.diagnosticState().lateOutcomeCount,0);
});

test('process exit rejects all pending calls and future calls', async (t) => {
  const server = start(t);
  const failure = once(server, 'failure');
  const pending = server.request('ignore', {});
  const exiting = server.request('exit', {});
  await Promise.all([assert.rejects(pending, /exited.*7/i), assert.rejects(exiting, /exited.*7/i)]);
  assert.match((await failure)[0].message, /exited.*7/i);
  await assert.rejects(server.request('ready', {}), /closed|exited/i);
});

for (const method of ['malformed', 'invalid', 'oversize', 'invalidUtf8', 'partial', 'duplicate']) {
  test(`${method} frame fails pending calls without EventEmitter error crash`, async (t) => {
    const server = start(t, { maxMessageBytes: 512 });
    await assert.rejects(server.request(method, {}), /JSON|protocol|bytes|size/i);
    await assert.rejects(server.request('ready', {}));
  });
}

test('response ids are not coerced between number and string', async (t) => {
  const server = start(t);
  assert.equal(await server.request('typedId', {}), 'right');
});

test('malformed protocol errors never expose the payload in failure or pending rejection', async (t) => {
  const server = start(t);
  const failure = once(server, 'failure');
  const pending = server.request('sensitiveMalformed', {});
  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /JSON|protocol/i);
    assert.doesNotMatch(error.message, /secret-protocol-sentinel|secret-pro/i);
    return true;
  });
  const [error] = await failure;
  assert.doesNotMatch(error.message, /secret-protocol-sentinel|secret-pro/i);
});

test('spawn failures reject pending requests without an unhandled error event', async (t) => {
  const server = start(t, { executable: fileURLToPath(new URL('./missing-codex.exe', import.meta.url)) });
  await assert.rejects(server.request('ready', {}), /ENOENT/);
  await server.close();
});

test('unserializable answers preserve approval for a valid retry', async (t) => {
  const server = start(t);
  await server.request('events', {});
  assert.throws(() => server.respond(0, undefined), /result|JSON/i);
  const answer = once(server, 'notification');
  server.respond(0, null);
  assert.deepEqual((await answer)[0].params, { id: 0, result: null });
});

test('invalid outgoing methods are rejected without terminating the connection', async (t) => {
  const server = start(t);
  await assert.rejects(server.request('', {}), /method/i);
  assert.throws(() => server.notify('', {}), /method/i);
  assert.deepEqual(await server.request('echo', { ok: true }), { ok: true });
});

test('stderr remains diagnostic and each emitted chunk is bounded', async (t) => {
  const server = start(t);
  const diagnostics: string[] = [];
  server.on('diagnostic', (line) => diagnostics.push(line));
  assert.equal(await server.request('stderr', {}), true);
  await server.close();
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.every((line) => typeof line === 'string' && line.length <= 8192));
});

test('close rejects pending calls and prevents stale approval responses', async (t) => {
  const server = start(t);
  await server.request('events', {});
  const pending = assert.rejects(server.request('ignore', {}), /closed/i);
  await server.close();
  await pending;
  await assert.rejects(server.request('ready', {}), /closed/i);
  assert.throws(() => server.respond(0, {}), /closed|pending|stale/i);
});

test('close kills only its unresponsive child after the graceful deadline', { timeout: 8000 }, async (t) => {
  const server = start(t);
  await server.request('hang', {});
  await assert.rejects(server.close(), /5.*(second|000)|shutdown.*timed out/i);
});

test('close has a bounded deadline when process close confirmation never arrives', { timeout: 10000 }, async t => {
  const server = start(t);
  await server.request('ready', {});
  const confirmation = Promise.withResolvers<void>();
  (server as any).ended = confirmation.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      assert.rejects(server.close(), /shutdown.*timed out/i),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown deadline did not settle close')), 6500); }),
    ]);
  } finally { clearTimeout(timer); confirmation.resolve(); }
});
