import type { AppServer } from '../src/codex/app-server.ts';
import type { Turn } from '../.local/protocol/v2/Turn.ts';

export async function runTurn(client: AppServer, threadId: string, prompt: string, interrupt = false): Promise<Turn> {
  let finish!: (turn: Turn) => void;
  let fail!: (error: Error) => void;
  let markRunning!: () => void;
  const running = new Promise<void>(yes => { markRunning = yes; });
  const completed = new Promise<Turn>((yes, no) => { finish = yes; fail = no; });
  // 立即安装拒绝处理，避免 turn/start 尚未返回时事件 Promise 先失败。
  void completed.catch(() => {});
  let turnId: string | undefined;
  let terminal: Turn | undefined;
  const complete = (turn: Turn) => { terminal = turn; finish(turn); };
  const early: Turn[] = [];
  const startedIds = new Set<string>();
  const listener = (message: any) => {
    if (message.params?.threadId !== threadId) return;
    if (message.method === 'turn/started') {
      startedIds.add(message.params.turn.id);
      if (message.params.turn.id === turnId) markRunning();
    } else if (message.method === 'turn/completed') {
      if (!turnId) early.push(message.params.turn);
      else if (message.params.turn.id === turnId) complete(message.params.turn);
    }
  };
  const timer = setTimeout(() => fail(new Error('Turn 超时；结果不确定，不自动重发')), 180_000);
  client.on('notification', listener);
  client.on('failure', fail);
  try {
    const started = await client.request<{ turn: Turn }>('turn/start', {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
    console.log(`turn/start response: ${started.turn.id} ${started.turn.status}`);
    if (started.turn.status === 'failed') throw new Error(`Turn start failed: ${JSON.stringify(started.turn.error)}`);
    turnId = started.turn.id;

    if (startedIds.has(turnId)) markRunning();
    for (const turn of early) if (turn.id === turnId) complete(turn);
    if (interrupt && await Promise.race([running.then(() => true), completed.then(() => false)]) && !terminal) {
      await client.request('turn/interrupt', { threadId, turnId });
    }
    const turn = await completed;

    if (turn.status === 'failed') throw new Error(`Turn failed: ${JSON.stringify(turn.error)}`);
    return turn;
  } catch (error) {
    if (turnId && !terminal) {
      try { await client.request('turn/interrupt', { threadId, turnId }); }
      catch { console.error('中断未确认；请检查该测试 Thread。'); }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    client.off('notification', listener);
    client.off('failure', fail);
  }
}
