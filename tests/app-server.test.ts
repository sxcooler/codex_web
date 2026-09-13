import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AppServer } from '../src/codex/app-server.ts';

const fixture = fileURLToPath(new URL('./fixtures/rpc-server.mjs', import.meta.url));
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
    clientInfo: { name: 'codex_remote_web', title: 'Codex Remote Web', version: '0.1.0' },
    capabilities: { experimentalApi: false },
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
  const server = start(t, { timeoutMs: 80 });
  await assert.rejects(server.request('ignore', {}), /timed out.*uncertain/i);
  assert.equal(await server.request('count', {}), 1);
  await assert.rejects(server.request('rpcError', {}), /denied/);
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
