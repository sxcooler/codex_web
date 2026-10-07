import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/web/api.ts';

test('read timeout is distinguished from disconnection before headers and during body loading', async t => {
  for (const body of [false, true]) {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async () => {
      const timeout = () => { controller.abort(new DOMException('deadline', 'TimeoutError')); throw new DOMException('aborted', 'AbortError'); };
      if (!body) return timeout();
      return { json: async () => timeout() } as Response;
    });
    await assert.rejects(api('/sessions/thread', undefined, controller.signal), /读取超时/);
  }
});

test('timed out submissions remain uncertain and are never retried', async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    throw controller.signal.reason;
  });
  await assert.rejects(api('/sessions/thread/messages', { text: 'one' }, controller.signal), (error: any) => {
    assert.match(error.message, /超时.*提交结果待核实/);
    assert.equal(error.status, undefined, 'Submission must not be marked as a confirmed rejection');
    return true;
  });
  assert.equal(calls, 1);
});

test('navigation cancellation, network errors and HTTP errors remain distinguishable', async t => {
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, 'fetch', async () => { throw controller.signal.reason; });
  await assert.rejects(api('/sessions/thread', undefined, controller.signal), { name: 'AbortError' });
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api('/sessions/thread'), /无法连接服务器/);
  await assert.rejects(api('/sessions/thread/messages', {}), /提交结果待核实/);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'Native unavailable', code: 'RUNTIME_UNAVAILABLE' }), { status: 503 }));
  await assert.rejects(api('/sessions/thread'), (error: any) => error.status === 503 && error.data.code === 'RUNTIME_UNAVAILABLE');
});

test('empty, truncated and non-JSON success bodies fail clearly instead of becoming successful submissions', async t => {
  for (const body of ['', '{"ok":', '<html>private proxy response</html>', 'null']) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(body); });
    await assert.rejects(api('/sessions/thread'), /响应.*JSON.*重新同步/);
    await assert.rejects(api('/sessions/thread/messages', {}), (error: any) => {
      assert.match(error.message, /提交结果待核实.*不要重复发送/);
      assert.doesNotMatch(error.message, /private proxy response/);
      assert.equal(error.status, undefined, 'A broken success body cannot confirm rejection');
      return true;
    });
    assert.equal(calls, 2, 'Neither operation may be automatically retried');
  }
});

test('HTTP failures retain status and auth expiry even when the body is empty or invalid', async t => {
  const events = new EventTarget();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete (globalThis as any).window; });
  let expired = 0;
  events.addEventListener('auth-lost', () => expired++);
  for (const body of ['', '<html>private proxy response</html>', 'null']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 401 }));
    await assert.rejects(api('/sessions/thread'), (error: any) => error.status === 401 && /401/.test(error.message));
  }
  assert.equal(expired, 3);
  await assert.rejects(api('/auth/login', {}));
  assert.equal(expired, 3, 'Login errors must not trigger auth-lost');
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 502 }));
  await assert.rejects(api('/sessions/thread/messages', {}), (error: any) => error.status === 502 && /提交结果待核实/.test(error.message));
});

test('broken response streams keep uncertainty while explicit no-content success remains usable', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } })));
  await assert.rejects(api('/sessions/thread'), /响应.*重新同步/);
  await assert.rejects(api('/sessions/thread/messages', {}), /提交结果待核实/);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await api('/sessions/thread/abort', {}), undefined);
});
