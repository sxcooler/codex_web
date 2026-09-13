import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUserMarker, rejectionFor } from '../scripts/probe-support.ts';

test('接力标记必须来自用户文本，不能被 assistant 引用或其他字段伪造', () => {
  const history = { turns: [{ items: [
    { type: 'agentMessage', text: 'EXTERNAL-MARKER' },
    { type: 'userMessage', content: [{ type: 'text', text: 'REAL-MARKER' }] },
  ] }] };
  assert.equal(hasUserMarker(history, 'EXTERNAL-MARKER'), false);
  assert.equal(hasUserMarker(history, 'REAL-MARKER'), true);
  assert.equal(hasUserMarker(history, ''), false);
});

test('probe 只拒绝已知审批，不会因未知请求而批准或伪造用户答案', () => {
  assert.deepEqual(rejectionFor('item/commandExecution/requestApproval'), { decision: 'decline' });
  assert.deepEqual(rejectionFor('item/fileChange/requestApproval'), { decision: 'decline' });
  assert.deepEqual(rejectionFor('item/permissions/requestApproval'), { permissions: {}, scope: 'turn' });
  assert.deepEqual(rejectionFor('mcpServer/elicitation/request'), { action: 'decline', content: null, _meta: null });
  assert.equal(rejectionFor('item/tool/requestUserInput'), undefined);
  assert.equal(rejectionFor('unknown/method'), undefined);
});
