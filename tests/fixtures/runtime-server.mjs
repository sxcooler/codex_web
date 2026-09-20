import { createInterface } from 'node:readline';

const threads = new Map();
const archivedThreads = new Set();
const approvals = new Map();
const mode = process.argv[2] ?? 'normal';
let initialized = false;
let nextThread = 1;
let nextTurn = 1;
let turnStarts = 0;
let interrupts = 0;
let resumes = 0;
let lastTurn;
let lastThread, lastResume;
let modelLists = 0;
let itemLists = 0;
let threadReads = 0;
let turnLists = 0;
let fullTurnLists = 0;
let headerTurnLists = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const thread = (id, cwd = process.cwd(), turns = []) => ({
  id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false,
  section: null, sectionEnteredAt: null, projectId: null, historyMode: 'unlimited', modelProvider: 'openai',
  model: 'fixture', reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: 1,
  status: { type: 'idle' }, path: null, cwd, cliVersion: 'fixture', source: 'appServer',
  threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns,
});
const turn = (id, status = 'inProgress', items = []) => ({
  id, items, itemsView: 'full', status, error: null, startedAt: 1,
  completedAt: status === 'inProgress' ? null : 2, durationMs: status === 'inProgress' ? null : 1,
});
const settings = (value, params = {}) => ({ thread: value, model: mode === 'resume-text-model' ? 'actual-text' : 'fixture', modelProvider: 'openai', serviceTier: null,
  cwd: value.cwd, instructionSources: [], approvalPolicy: params.approvalPolicy ?? 'on-request', approvalsReviewer: params.approvalsReviewer ?? 'user',
  sandbox: mode === 'tightened-resume' && params.threadId && !params.sandbox ? {type:'readOnly',networkAccess:false} : mode === 'permission-mismatch' ? { type: 'dangerFullAccess' } : params.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: mode === 'implicit-cwd' ? params.config.sandbox_workspace_write.writable_roots.filter(root => root !== value.cwd) : params.config.sandbox_workspace_write.writable_roots, networkAccess: params.config.sandbox_workspace_write.network_access, excludeTmpdirEnvVar: params.config.sandbox_workspace_write.exclude_tmpdir_env_var, excludeSlashTmp: params.config.sandbox_workspace_write.exclude_slash_tmp } : params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' }, reasoningEffort: null });

function finish(threadId, activeTurn, status = 'completed') {
  const complete = turn(activeTurn.id, status, activeTurn.items);
  const value = threads.get(threadId);
  value.turns = [...value.turns.filter(({ id }) => id !== complete.id), complete];
  value.status = { type: 'idle' };
  send({ method: 'turn/completed', params: { threadId, turn: complete } });
}

function startTurn(id, params) {
  turnStarts++;
  lastTurn = params;
  const text = params.input?.[0]?.text ?? '';
  const turnId = `turn-${nextTurn++}`;
  const activeTurn = turn(turnId);
  const value = threads.get(params.threadId);
  value.status = { type: 'active', activeFlags: [] };
  value.turns.push(activeTurn);
  if (mode === 'steering') activeTurn.items.push({ type: 'userMessage', id: `user-${turnId}`, clientId: params.clientUserMessageId ?? null, content: params.input });

  if (text === 'exit-unknown') return process.exit(9);
  send({ method: 'turn/started', params: { threadId: params.threadId, turn: activeTurn } });
  if (text === 'stale-crash') {
    const item = { type: 'agentMessage', id: `item-${turnId}`, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
    send({ method: 'item/started', params: { threadId: params.threadId, turnId, item, startedAtMs: Date.now() } });
    send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: 'partial' } });
    return setImmediate(() => process.exit(9));
  }
  if (text === 'early-complete') finish(params.threadId, activeTurn);
  send({ id, result: { turn: activeTurn } });
  if (text === 'hold' || text === 'early-complete') return;

  if (text === 'retry-error') {
    send({ method: 'error', params: { threadId: params.threadId, turnId, willRetry: true,
      error: { message: 'temporary fixture failure', codexErrorInfo: null, additionalDetails: null } } });
    return;
  }

  if (text === 'approval') {
    const requestId = `approval-${turnId}`;
    approvals.set(requestId, { threadId: params.threadId, activeTurn });
    send({ id: requestId, method: 'item/commandExecution/requestApproval', params: {
      kind: 'command', threadId: params.threadId, turnId, itemId: `item-${turnId}`,
      startedAtMs: Date.now(), approvalId: null, environmentId: null, command: 'echo fixture', cwd: value.cwd,
    } });
    return;
  }
  if (text === 'permissions') {
    const requestId = `permissions-${turnId}`;
    approvals.set(requestId, { threadId: params.threadId, activeTurn });
    send({ id: requestId, method: 'item/permissions/requestApproval', params: {
      threadId: params.threadId, turnId, itemId: `item-${turnId}`, environmentId: null,
      startedAtMs: Date.now(), cwd: value.cwd, reason: 'network',
      permissions: { network: { enabled: true }, fileSystem: null },
    } });
    return;
  }
  if (text === 'input') {
    const requestId = `input-${turnId}`;
    approvals.set(requestId, { threadId: params.threadId, activeTurn });
    send({ id: requestId, method: 'item/tool/requestUserInput', params: {
      threadId: params.threadId, turnId, itemId: `item-${turnId}`, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }],
    } });
    return;
  }
  if (text === 'mcp') {
    const requestId = `mcp-${turnId}`;
    approvals.set(requestId, { threadId: params.threadId, activeTurn });
    send({ id: requestId, method: 'mcpServer/elicitation/request', params: {
      threadId: params.threadId, turnId: null, serverName: 'fixture', mode: 'form', _meta: null,
      message: 'Name', requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
    } });
    return;
  }
  if (text === 'unsupported') {
    const requestId = `unsupported-${turnId}`;
    approvals.set(requestId, { threadId: params.threadId, activeTurn });
    send({ id: requestId, method: 'item/tool/call', params: { threadId: params.threadId, turnId, itemId: `item-${turnId}` } });
    return;
  }
  if (text === 'stream') {
    const oldTurn = turn('past', 'completed', [{ type: 'agentMessage', id: 'past-item', text: 'persisted', phase: null, memoryCitation: null, delivery: null, questions: null }]);
    value.turns.unshift(oldTurn);
    const item = { type: 'agentMessage', id: `item-${turnId}`, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
    send({ method: 'item/started', params: { threadId: params.threadId, turnId, item, startedAtMs: Date.now() } });
    send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: 'hello' } });
    return;
  }
  if (text === 'command-stream') {
    const item = { type: 'commandExecution', id: `item-${turnId}`, pluginId: null, scriptPath: null,
      command: 'echo fixture', cwd: value.cwd, processId: null, source: 'agent', status: 'inProgress',
      commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    send({ method: 'item/started', params: { threadId: params.threadId, turnId, item, startedAtMs: Date.now() } });
    send({ method: 'item/commandExecution/outputDelta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: 'one' } });
    send({ method: 'item/commandExecution/outputDelta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: ' two' } });
    return;
  }
  if (text === 'stream-complete') {
    const item = { type: 'agentMessage', id: `item-${turnId}`, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
    send({ method: 'item/started', params: { threadId: params.threadId, turnId, item, startedAtMs: Date.now() } });
    send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: 'partial' } });
    const complete = { ...item, text: 'final' };
    activeTurn.items = [complete];
    send({ method: 'item/completed', params: { threadId: params.threadId, turnId, item: complete, completedAtMs: Date.now() } });
    send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: '-late' } });
    finish(params.threadId, activeTurn);
    return;
  }
  if (text === 'flood') {
    const item = { type: 'agentMessage', id: `item-${turnId}`, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
    send({ method: 'item/started', params: { threadId: params.threadId, turnId, item, startedAtMs: Date.now() } });
    for (let index = 0; index < 2500; index++) send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: item.id, delta: 'x' } });
    finish(params.threadId, activeTurn);
    return;
  }
  finish(params.threadId, activeTurn);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!('method' in message)) {
    const pending = approvals.get(message.id);
    if (pending) {
      approvals.delete(message.id);
      send({ method: 'serverRequest/resolved', params: { threadId: pending.threadId, requestId: message.id } });
      finish(pending.threadId, pending.activeTurn, message.result?.decision === 'cancel' ? 'interrupted' : 'completed');
    }
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) {
    if (method === 'initialized') initialized = true;
    return;
  }
  if (method === 'initialize') {
    const response = () => send({ id, result: { userAgent: 'codex-cli/fixture', codexHome: process.cwd(), platformFamily: 'windows', platformOs: 'windows' } });
    if (mode === 'delayed-init') return setTimeout(response, 60);
    return response();
  }
  if (!initialized) return send({ id, error: { code: -32000, message: 'request arrived before initialized' } });
  if (method === 'model/list') { modelLists++; return send({ id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', description: '', hidden: false, supportedReasoningEfforts: [{reasoningEffort:'low',description:''},{reasoningEffort:'high',description:''}], defaultReasoningEffort: 'low', inputModalities: ['text','image'], isDefault: true }, { id:'actual-text',model:'actual-text',displayName:'Text only',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',inputModalities:['text'],isDefault:false }], nextCursor: null } }); }
  if (method === 'config/read') return send({ id, result: { config: { model: mode === 'config-text-model' ? 'actual-text' : 'fixture', approval_policy: mode === 'null-config' ? null : 'on-request', approvals_reviewer: mode === 'null-config' ? null : 'user', sandbox_mode: ['custom-workspace', 'incomplete-workspace'].includes(mode) ? 'workspace-write' : 'read-only', ...(mode === 'incomplete-workspace' ? { sandbox_workspace_write: {} } : {}), ...(mode === 'custom-workspace' ? { sandbox_workspace_write: { writable_roots: [params.cwd + '/extra'], network_access: true, exclude_tmpdir_env_var: false, exclude_slash_tmp: true } } : {}) }, layers: [] } });
  if (method === 'configRequirements/read') return send({ id, result: { requirements: mode === 'managed' ? { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['on-request'] } : null } });
  if (method === 'thread/name/set') { threads.get(params.threadId).name = params.name; return send({id,result:{}}); }
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: true } });
  if (method === 'thread/list') return send({ id, result: { data: [...threads.values()].filter(value=>archivedThreads.has(value.id)===!!params.archived).map((value) => ({ ...value, turns: [] })), nextCursor: null, backwardsCursor: null } });
  if (method === 'thread/archive' || method === 'thread/unarchive') {
    if(method==='thread/archive')archivedThreads.add(params.threadId);else archivedThreads.delete(params.threadId);
    return send({id,result:method==='thread/archive'?{}:{thread:threads.get(params.threadId)}});
  }
  if (method === 'thread/start') {
    lastThread = params;
    const value = thread(mode === 'unmaterialized-current' ? '00000000-0000-4000-8000-000000000010' : `thread-${nextThread++}`, params.cwd);
    threads.set(value.id, value);
    return send({ id, result: settings(value, params) });
  }
  if (method === 'thread/resume') {
    lastResume = params;
    resumes++;
    if (mode === 'resume-conflict' && resumes === 1) return send({ id, error: { code: -32000, message: 'thread already has an active writer' } });
    if (mode === 'paginated-resume' && params.excludeTurns !== true) return send({ id, error: { code: -32600, message: 'paginated threads require excludeTurns' } });
    if (mode === 'active-resume') {
      const value = thread(params.threadId);
      value.status = { type: 'active', activeFlags: [] };
      return send({ id, result: { ...settings(value, params), turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
    }
    const value = threads.get(params.threadId) ?? thread(params.threadId);
    threads.set(value.id, value);
    return send({ id, result: { ...settings(value, params), turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
  }
  if (method === 'fixture/external-change') { const value=threads.get(params.threadId); value.name='External name'; value.updatedAt++; return send({id,result:{}}); }
  if (method === 'thread/read') {
    threadReads++;
    if (mode === 'notfound') return send({ id, error: { code: -32000, message: 'record not found' } });
    if (mode === 'unsupported-empty' && !threads.has(params.threadId)) return send({ id, error: { code: -32000, message: `thread not loaded: ${params.threadId}` } });
    if (mode === 'recovery') {
      const finalItem = { type: 'agentMessage', id: 'item-turn-1', text: 'final', phase: null, memoryCitation: null, delivery: null, questions: null };
      const value = thread(params.threadId, process.cwd(), [turn('turn-1', 'completed', [finalItem])]);
      if (params.threadId === 'thread-1' && threads.size === 0) return send({ id, result: { thread: value } });
    }
    const value = threads.get(params.threadId) ?? thread(params.threadId);
    if (mode === 'missed-completion' && value.turns.length) {
      value.turns = value.turns.map(t => turn(t.id, 'completed', [{ type: 'agentMessage', id: `item-${t.id}`, text: 'persisted final' }]));
      value.status = { type: 'idle' };
    }
    if (mode === 'resume-conflict' && !threads.has(params.threadId)) value.status = { type: 'notLoaded' };
    if (mode === 'external-active') value.status = { type: 'active', activeFlags: [] };
    if (mode === 'system-error') value.status = { type: 'systemError' };
    const response = { id, result: { thread: structuredClone(mode === 'sync-history' ? {...value, turns: []} : value) } };
    if (mode === 'release-race') return setTimeout(() => send(response), 60);
    return send(response);
  }
  if (method === 'thread/turns/list') {
    turnLists++;
    if (mode.startsWith('legacy-items')) {
      const values = Array.from({length:25},(_,i)=>turn(`legacy-${i}`,'completed',[{id:`command-${i}`,type:'commandExecution',status:'completed',aggregatedOutput:'x'.repeat(9000)}]));
      if (params.sortDirection === 'desc') values.reverse();
      const offset=Number(params.cursor??0);
      const limit=params.limit??20,page=values.slice(offset,offset+limit),nextCursor=offset+page.length<values.length?String(offset+page.length):null;
      if (params.itemsView === 'notLoaded') {headerTurnLists++;return send({id,result:{data:page.map(t=>({...t,items:[],itemsView:'notLoaded'})),nextCursor:mode==='legacy-items-repeat'?'0':nextCursor}});}
      fullTurnLists++;
      if (params.limit !== 1) return send({id,error:{code:-32600,message:'full turns must use bounded pages'}});
      if (mode === 'legacy-items-mismatch' && page.length) page[0]={...page[0],id:'wrong-turn'};
      return send({id,result:{data:page,nextCursor}});
    }
    if (mode === 'sync-history') return send({id,result:{data:threads.get(params.threadId).turns.map(value=>({...value,items:[],itemsView:'notLoaded'})),nextCursor:null}});
    if (mode === 'large-history') {
      const value = turn('large', 'completed', params.itemsView === 'notLoaded' ? [] : [{ id: 'oversize', text: 'x'.repeat(17 * 1024 * 1024) }]);
      value.itemsView = params.itemsView === 'notLoaded' ? 'notLoaded' : 'full';
      return send({ id, result: { data: [value], nextCursor: null } });
    }
    if (mode === 'completion-during-read') {
      const value = threads.get(params.threadId);
      value.turns = value.turns.map(t => turn(t.id, 'completed', t.items));
      value.status = { type: 'idle' };
    }
    if (mode === 'unsupported-empty') return send({ id, error: { code: -32000, message: 'list_turns is not supported yet' } });
    if (mode === 'unmaterialized-current') return send({ id, error: { code: -32000, message: `thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message` } });
    if (mode === 'pagination') {
      const old = turn('old', 'completed', [{ type: 'agentMessage', id: 'summary', text: 'summary', phase: null, memoryCitation: null, delivery: null, questions: null }]);
      old.itemsView = 'summary';
      const recent = turn('recent', 'completed', [{ type: 'agentMessage', id: 'recent-item', text: 'recent', phase: null, memoryCitation: null, delivery: null, questions: null }]);
      return params.cursor === 'turn-page-2'
        ? send({ id, result: { data: [recent], nextCursor: null, backwardsCursor: null } })
        : send({ id, result: { data: [old], nextCursor: 'turn-page-2', backwardsCursor: null } });
    }
    const value = threads.get(params.threadId) ?? thread(params.threadId);
    return send({ id, result: { data: structuredClone(value.turns), nextCursor: null, backwardsCursor: null } });
  }
  if (method === 'thread/items/list') {
    itemLists++;
    if (mode.startsWith('legacy-items')) return send({id,error:{code:-32601,message:'thread/items/list is not supported yet'}});
    if (mode === 'steering') return send({id,result:{data:threads.get(params.threadId).turns.find(turn=>turn.id===params.turnId).items.map(item=>({turnId:params.turnId,item})),nextCursor:null}});
    if (mode === 'large-history' && (!params.limit || params.limit > 10)) return send({ id, result: { data: [{ turnId: params.turnId, item: { id: 'oversize', text: 'x'.repeat(17 * 1024 * 1024) } }], nextCursor: null } });
    const first = { turnId: params.turnId, item: { type: 'agentMessage', id: 'old-item-1', text: 'old one', phase: null, memoryCitation: null, delivery: null, questions: null } };
    const second = { turnId: params.turnId, item: { type: 'agentMessage', id: 'old-item-2', text: 'old two', phase: null, memoryCitation: null, delivery: null, questions: null } };
    return params.cursor === 'item-page-2'
      ? send({ id, result: { data: [second], nextCursor: null, backwardsCursor: null } })
      : send({ id, result: { data: [first], nextCursor: 'item-page-2', backwardsCursor: null } });
  }
  if (method === 'turn/start') {
    if (mode === 'active-resume') return send({ id, error: { code: -32000, message: 'turn/start must not follow active resume' } });
    return startTurn(id, params);
  }
  if (method === 'turn/steer') {
    const active = threads.get(params.threadId)?.turns.find(t => t.status === 'inProgress');
    if (!active || active.id !== params.expectedTurnId || params.input[0]?.text === 'race-completed') return send({ id, error: { code: -32600, message: 'no active turn to steer' } });
    active.items.push({ type: 'userMessage', id: `steer-${active.items.length}`, clientId: params.clientUserMessageId, content: params.input });
    return send({ id, result: { turnId: active.id } });
  }
  if (method === 'turn/interrupt') {
    interrupts++;
    const value = threads.get(params.threadId);
    const activeTurn = value?.turns.find(({ id: turnId }) => turnId === params.turnId);
    if (!activeTurn || activeTurn.status !== 'inProgress') return send({ id, error: { code: -32000, message: 'no active turn' } });
    send({ id, result: {} });
    return finish(params.threadId, activeTurn, 'interrupted');
  }
  if (method === 'thread/unsubscribe') return send({ id, result: { status: mode === 'not-subscribed' ? 'notSubscribed' : 'unsubscribed' } });
  if (method === 'fixture/stats') return send({ id, result: { turnStarts, interrupts, lastTurn, modelLists, lastThread, lastResume, itemLists, threadReads, turnLists, fullTurnLists, headerTurnLists } });
  send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
