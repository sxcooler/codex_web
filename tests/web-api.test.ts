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
