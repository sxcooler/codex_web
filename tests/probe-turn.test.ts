import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runTurn } from '../scripts/probe-turn.ts';

class TurnPeer extends EventEmitter {
  running = false;
  earlyComplete: boolean;
  constructor(earlyComplete: boolean) { super(); this.earlyComplete = earlyComplete; }
  emitTurn(method: string, status: string) {
    this.emit('notification', { method, params: { threadId: 'thread', turn: { id: 'turn', status } } });
  }
  async request(method: string) {
    if (method === 'turn/start') {
      if (this.earlyComplete) {
        this.emitTurn('turn/started', 'inProgress');
        this.emitTurn('turn/completed', 'completed');
      } else {
        setImmediate(() => { this.running = true; this.emitTurn('turn/started', 'inProgress'); });
      }
      return { turn: { id: 'turn', status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      if (!this.running) throw new Error('no active turn to interrupt');
      this.running = false;
      this.emitTurn('turn/completed', 'interrupted');
      return {};
    }
    throw new Error('unexpected request');
  }
}

for (const earlyComplete of [true, false]) {
  test(earlyComplete ? '早到完成事件阻止向已结束 Turn 发中断' : '受理响应之后等待真正 started 再中断', async () => {
    const peer = new TurnPeer(earlyComplete);
    const turn = await runTurn(peer as any, 'thread', 'probe', true);
    assert.equal(turn.status, earlyComplete ? 'completed' : 'interrupted');
    assert.equal(peer.listenerCount('notification'), 0);
    assert.equal(peer.listenerCount('failure'), 0);
  });
}
