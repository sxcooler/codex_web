import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AppServer } from '../src/codex/app-server.ts';
import { resolveCodexExecutable } from '../src/codex/executable.ts';
import { pathKey } from '../src/projects.ts';
import { hasUserMarker, rejectionFor } from './probe-support.ts';
import { runTurn } from './probe-turn.ts';
import type { Thread } from '../.local/protocol/v2/Thread.ts';
import type { Turn } from '../.local/protocol/v2/Turn.ts';
import type { ThreadStartParams } from '../.local/protocol/v2/ThreadStartParams.ts';

const command = process.argv[2] ?? 'doctor';
const allowed = ['doctor', 'start', 'read', 'verify', 'interrupt', 'approval', 'inspect', 'reverse', 'locate'];
if (!allowed.includes(command)) throw new Error(`命令：${allowed.join(' | ')}`);
const executable = resolveCodexExecutable();
const cwd = resolve(import.meta.dirname, '..');
const stateFile = resolve(cwd, '.local/probe.json');
const expectedHome = resolve(homedir(), '.codex');
if (process.env.CODEX_HOME && pathKey(resolve(process.env.CODEX_HOME)) !== pathKey(expectedHome)) {
  throw new Error('CODEX_HOME 与默认用户存储不同；先确认环境，未启动验证。');
}
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
console.log(`使用 ${version}，按实际协议响应与权限校验`);
const mutation = ['start', 'verify', 'reverse', 'interrupt', 'approval'].includes(command);
const lockFile = resolve(cwd, '.local/probe-operation.lock');
if (mutation) {
  mkdirSync(resolve(cwd, '.local'), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }), { flag: 'wx' });
}
const client = new AppServer({ executable, cwd, timeoutMs: 60_000 });
const counts: Record<string, number> = {};
let diagnosticBytes = 0;
let approvals = 0;
const commandApprovalRequests: any[] = [];
const declinedCommands = new Set<string>();

let state: any = {};

function save() {
  mkdirSync(resolve(cwd, '.local'), { recursive: true });
  writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n');
  renameSync(stateFile + '.tmp', stateFile);
}

function load() {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(typeof state.threadId, 'string', '请先运行 start');
  return state;
}

client.on('diagnostic', (text: string) => { diagnosticBytes += Buffer.byteLength(text); });
client.on('failure', (error: Error) => { console.error('Runtime:', error.message); });
client.on('notification', (message: any) => {
  counts[message.method] = (counts[message.method] ?? 0) + 1;
  if (message.method === 'item/completed' && message.params.item.type === 'commandExecution'
    && message.params.item.status === 'declined') declinedCommands.add(message.params.item.id);
  if (['turn/started', 'turn/completed'].includes(message.method)) {
    console.log(`${message.method}: ${message.params.turn.id} ${message.params.turn.status}`);
  }
});
client.on('request', (message: any) => {
  approvals++;
  if (message.method === 'item/commandExecution/requestApproval') commandApprovalRequests.push(message.params);
  console.log(`服务端请求 ${message.method}：probe 拒绝执行或返回不支持`);
  const reply = rejectionFor(message.method);
  if (reply === undefined) client.respondError(message.id, -32601, 'Probe does not support this interaction');
  else client.respond(message.id, reply);
});


async function newThread(approvalPolicy: ThreadStartParams['approvalPolicy'] = 'on-request') {
  const params: ThreadStartParams = {
    cwd, sandbox: 'read-only', approvalPolicy, approvalsReviewer: 'user', ephemeral: false,
  };
  const result: any = await client.request('thread/start', params);
  checkPermissions(result, approvalPolicy);
  return result.thread as Thread;
}

function checkPermissions(result: any, approvalPolicy: ThreadStartParams['approvalPolicy']) {
  assert.equal(result.approvalPolicy, approvalPolicy, '实际审批策略与请求不一致');
  assert.equal(result.approvalsReviewer, 'user', '实际审批未路由给客户端用户');
  assert.equal(result.sandbox.type, 'readOnly', 'probe 必须使用只读沙箱');
}

async function resumeThread(threadId: string) {
  const result = await client.request('thread/resume', {
    threadId, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
  });
  checkPermissions(result, 'on-request');
}

async function readThread(threadId: string) {
  return (await client.request<{ thread: Thread }>('thread/read', { threadId, includeTurns: true })).thread;
}

async function persistedTurn(threadId: string, turnId: string) {
  const thread = await readThread(threadId);
  assert.ok(thread.turns.some(turn => turn.id === turnId && turn.status !== 'inProgress'), '回程 Turn 未确认持久化');
  return thread;
}

async function listed(threadId: string) {
  let cursor: string | null = null;
  do {
    const page: { data: Thread[]; nextCursor: string | null } = await client.request('thread/list', {
      cwd, limit: 100, cursor, modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
    });
    if (page.data.some(thread => thread.id === threadId)) return true;
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

try {
  await client.initialize();
  if (command === 'doctor') {
    const account: any = await client.request('account/read', { refreshToken: false });
    const models: any = await client.request('model/list', {});
    const requirements: any = await client.request('configRequirements/read', {});
    console.log(JSON.stringify({ version, executable, node: process.version, cwd, codexHome: expectedHome,
      initialized: true, authenticated: account.account != null,
      authType: account.account?.type, modelCount: models.data.length,
      defaultModel: models.data.find((model: any) => model.isDefault)?.id,
      managedRequirementsPresent: requirements.requirements != null }, null, 2));
    assert.ok(account.account, 'Codex 尚未登录，请使用独立 CLI 登录');
  } else if (command === 'locate') {
    load();
    const thread = await readThread(state.threadId);
    console.log(JSON.stringify({ threadId: thread.id, cwd: thread.cwd, path: thread.path,
      name: thread.name, preview: thread.preview,
      source: thread.source, historyMode: thread.historyMode, modelProvider: thread.modelProvider,
      section: thread.section, projectId: thread.projectId, cliVersion: thread.cliVersion }, null, 2));
    for (const [filter, params] of Object.entries({
      defaults: {}, project: { cwd }, stateDb: { cwd, useStateDbOnly: true },
      vscodeSource: { cwd, sourceKinds: ['vscode'] }, unsectioned: { cwd, sectionId: null },
      lowerDrive: { cwd: cwd[0].toLowerCase() + cwd.slice(1) }, lowerCase: { cwd: cwd.toLowerCase() },
    })) {
      const page: any = await client.request('thread/list', { limit: 100, ...params });
      console.log(JSON.stringify({ filter, foundInFirstPage: page.data.some((item: Thread) => item.id === thread.id),
        hasMore: page.nextCursor != null }));
      if (filter === 'defaults') console.log(JSON.stringify({ vscodeOriginCandidates: page.data
        .filter((item: Thread) => item.preview?.includes('VSCODE-ORIGIN-PROBE'))
        .map((item: Thread) => ({ threadId: item.id, cwd: item.cwd, source: item.source })) }));
    }
  } else if (command === 'start') {
    assert.ok(!existsSync(stateFile), '已有验证状态；先 read/verify，避免覆盖未完成接力');
    const marker = `REMOTE-PROBE-${randomUUID()}`;
    const thread = await newThread();
    state = { version, cwd, threadId: thread.id, source: thread.source, historyMode: thread.historyMode,
      marker, externalMarker: `VSCODE-REPLY-${randomUUID()}`, startedAt: new Date().toISOString() };
    save();
    const turn = await runTurn(client, thread.id, `Codex Web 兼容性验证。请只回复“收到 ${marker}”。不要调用工具、读写文件或执行命令。`);
    assert.equal(turn.status, 'completed');
    assert.ok(hasUserMarker(await readThread(thread.id), marker));
    state.firstTurnId = turn.id;
    state.release = await client.request('thread/unsubscribe', { threadId: thread.id });
    state.events = counts;
    save();
    console.log(JSON.stringify(state, null, 2));
  } else if (command === 'read' || command === 'verify') {
    load();
    const thread = await readThread(state.threadId);
    assert.ok(hasUserMarker(thread, state.marker), '原始用户标记未持久化');
    const foundInList = await listed(thread.id);
    const externalUserMarkerFound = hasUserMarker(thread, state.externalMarker);
    if (command === 'verify') {
      assert.ok(externalUserMarkerFound, `尚未收到 VS Code 用户标记：${state.externalMarker}`);
      assert.ok(!state.returnAttemptedAt, '已尝试回程追加；先 read 核对结果，不会重复发消息');
      await resumeThread(thread.id);
      state.returnAttemptedAt = new Date().toISOString();
      save();
      const turn = await runTurn(client, thread.id, '接力回程验证：请只回复“Web 已读取 VS Code 追加内容”。不要调用工具。');
      assert.equal(turn.status, 'completed');
      await persistedTurn(thread.id, turn.id);
      state.returnTurnId = turn.id;
      state.externalUserMarkerFound = true;
      state.release = await client.request('thread/unsubscribe', { threadId: thread.id });
      save();
    }
    console.log(JSON.stringify({ threadId: thread.id, source: thread.source, turns: thread.turns.length,
      historyMode: thread.historyMode, listed: foundInList, readAfterRestart: true,
      externalUserMarkerFound, externalMarker: state.externalMarker }, null, 2));
  } else if (command === 'inspect' || command === 'reverse') {
    const threadId = process.argv[3];
    assert.match(threadId ?? '', /^[0-9a-f-]{36}$/i, '请提供原生 Thread UUID');
    const thread = await readThread(threadId);
    if (command === 'reverse') {
      assert.equal(thread.source, 'vscode', '反向验证必须由 VS Code 原生创建');
      assert.ok(hasUserMarker(thread, 'VSCODE-ORIGIN-PROBE'), '仅操作包含专用验证标记的测试会话');
      assert.equal(resolve(thread.cwd).toLowerCase(), cwd.toLowerCase(), '测试会话 cwd 不属于当前项目');
      const reverseFile = resolve(cwd, '.local/reverse-probe.json');
      assert.ok(!existsSync(reverseFile), '已尝试反向接力，请先核对原生历史；不会重复发消息');
      await resumeThread(threadId);
      mkdirSync(resolve(cwd, '.local'), { recursive: true });
      writeFileSync(reverseFile, JSON.stringify({ version, threadId, attemptedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
      const turn = await runTurn(client, threadId, 'Web 反向接力验证成功。请只回复“已收到 Web 回程”，不要使用工具。');
      assert.equal(turn.status, 'completed');
      await persistedTurn(threadId, turn.id);
      await client.request('thread/unsubscribe', { threadId });
      writeFileSync(reverseFile, JSON.stringify({ version, threadId,
        source: thread.source, turnId: turn.id, status: turn.status }, null, 2) + '\n');
    }
    console.log(JSON.stringify({ threadId, cwd: thread.cwd, source: thread.source,
      turns: thread.turns.length, historyMode: thread.historyMode }, null, 2));
  } else {
    const thread = await newThread(command === 'approval' ? 'untrusted' : 'on-request');
    console.log(`测试 Thread: ${thread.id}`);
    const turn = await runTurn(client, thread.id, command === 'interrupt'
      ? '请写一篇较长的中文说明，介绍二叉搜索树。不要调用工具。'
      : '这是拒绝审批的无害协议测试。请仅执行 PowerShell 命令 Write-Output "CODEX-APPROVAL-PROBE"。若请求被拒绝，请停止并说明，不得尝试其他工具或绕过。不要读写任何文件。', command === 'interrupt');
    if (command === 'interrupt') assert.equal(turn.status, 'interrupted', '未观察到真实中断终态');
    else {
      assert.equal(turn.status, 'completed', '拒绝审批后未正常结束');
      assert.ok(commandApprovalRequests.some(request => request.threadId === thread.id && request.turnId === turn.id
        && declinedCommands.has(request.itemId)),
        '未同时观察到本次 Turn 的命令审批和拒绝终态，本项未通过');
    }
    const snapshot = await readThread(thread.id);
    await client.request('thread/unsubscribe', { threadId: thread.id });
    mkdirSync(resolve(cwd, '.local'), { recursive: true });
    writeFileSync(resolve(cwd, `.local/${command}-probe.json`), JSON.stringify({ version, threadId: thread.id,
      status: turn.status, approvals, events: counts, persistedTurns: snapshot.turns.length }, null, 2) + '\n');
    console.log(JSON.stringify({ status: turn.status, approvals, events: counts }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '验证失败');
  process.exitCode = 1;
} finally {
  try { await client.close(); }
  finally { if (mutation) unlinkSync(lockFile); }
  console.log(`runtime 已关闭；stderr ${diagnosticBytes} bytes（未输出，避免泄漏用户配置）`);
}
