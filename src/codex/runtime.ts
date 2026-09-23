import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { permissionChoices, threadPermissionOptions, type PermissionMode, type PermissionPolicy } from './permissions.ts';
import { AppServer } from './app-server.ts';
import {diagnosticId,type DiagnosticEvent} from '../server/diagnostics.ts';

export type NativeInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string };
export type TurnOptions = { model?: string; effort?: string; permissionMode?: PermissionMode; nativeInput?: NativeInput[] };
type Id = string | number;
type Options = {
  executable: string;
  cwd: string;
  idleMs?: number;
  sandbox?: 'read-only' | 'danger-full-access';
  args?: string[];
  diagnostic?:(event:DiagnosticEvent)=>void;
};
type Patch = { state?: any; thread?: any; turn?: any; item?: { turnId: string; item: any; completed?: boolean }; delta?: { turnId: string; itemId: string; field: 'text' | 'aggregatedOutput' | 'summary' | 'content'; index?: number; offset: number; text: string } };
type Change = { id: string; threadId: string; kind: string; revision: number; patch: Patch };
type Waiter = { promise: Promise<'started' | 'completed' | 'failed'>; resolve: (value: 'started' | 'completed' | 'failed') => void };
type PendingRequest = { requestId: string; nativeId: Id; method: string; params: Record<string, any>; epoch: string; threadId: string; turnId: string; answered: boolean };
type ThreadState = {
  openPromise?: Promise<any>;
  externalWriter?: boolean;
  activeTurnId: string | null;
  cwd?: string;
  diagnosticProjectKey?:string;
  model?: string;
  reasoningEffort?: string | null;
  retry?: { turnId: string; message: string };
  releaseRequested?: boolean;
  releasePromise?: Promise<any>;
  releaseError?: string;
  handoffReady?: boolean;
  nativeReleaseStatus?: string;
  completedTurns: Set<string>;
  completedItems: Set<string>;
  completion?: { promise: Promise<void>; resolve: () => void };
  emptyThreadEpoch?: string;
  error?: string;
  liveTurns: Map<string, any>;
  loaded: boolean;
  nativeStatus?: any;
  pending: Map<string, PendingRequest>;
  permissions?: any;
  selectedPermissionMode?: PermissionMode;
  recoverOnIdle?: boolean;
  released: boolean;
  reserved: boolean;
  revision: number;
  snapshotSequence: number;
  syncHeader?: any;
  syncTurns?: Map<string, string>;
  syncEpoch?: string;
  waiter?: Waiter;
};
type Idempotent = { signature: string; promise: Promise<any> };

const HISTORY_SIZE = 20;
// ponytail: bound first-paint native reads; a single oversized turn still needs native item pagination.
const INITIAL_HISTORY_SIZE = 3;
type HistoryWindow = { before?: string; headersOnly?: boolean };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function browserMedia(value: any, images: Map<string, string>): any {
  const image = (data: string) => {
    if (data.length && data.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 && /^[a-z0-9+/]*={0,2}$/i.test(data)) images.set(createHash('sha256').update(data).digest('hex'), data);
    return '[图片单独加载]';
  };
  if (typeof value === 'string') {
    if (!/^data:image\//i.test(value)) return value;
    const comma = value.indexOf(',');
    return /^data:image\/[a-z0-9.+-]+;base64$/i.test(value.slice(0, comma)) ? image(value.slice(comma + 1)) : '[图片格式不支持]';
  }
  if (Array.isArray(value)) return value.map(child => browserMedia(child, images));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === 'result' && value.type === 'imageGeneration' && typeof child === 'string' && !/^(?:https?:)?\/\/|^data:/i.test(child)
      ? image(child) : key === 'data' && typeof child === 'string' && (value.type === 'image' || /^image\//i.test(value.mimeType ?? ''))
      ? image(child) : ['text', 'command', 'aggregatedOutput'].includes(key) ? child : browserMedia(child, images),
  ]));
}

function browserItem(item: any, completed = false): any {
  const images = new Map<string, string>();
  item = browserMedia(item, images);
  if (images.size) item.imagePreviews = [...images.keys()].map(id => ({ id }));
  if (item?.type !== 'commandExecution' || (!completed && !['completed', 'failed', 'declined', 'interrupted'].includes(item.status)) || typeof item.aggregatedOutput !== 'string') return item;
  const outputBytes = Buffer.byteLength(item.aggregatedOutput);
  return outputBytes > 8192 ? { ...item, aggregatedOutput: item.aggregatedOutput.slice(0, 2048), outputDeferred: true, outputChars: item.aggregatedOutput.length, outputBytes } : item;
}

function browserTurn(turn: any): any {
  return { ...turn, items: (turn.items ?? []).map((item: any) => browserItem(item, ['completed', 'failed', 'interrupted'].includes(turn.status))) };
}

function historyWindow(turns: any[], before?: string): { turns: any[]; nextCursor: string | null } {
  const end = before === undefined ? turns.length : turns.findIndex(turn => turn.id === before);
  if (end < 0) throw runtimeError(409, 'RUNTIME_HISTORY_CURSOR_INVALID', 'History cursor is no longer available; refresh the session and retry');
  const start = Math.max(0, end - (before === undefined ? INITIAL_HISTORY_SIZE : HISTORY_SIZE));
  return { turns: turns.slice(start, end), nextCursor: start > 0 ? turns[start].id : null };
}

const EVENT_BYTES = 64 * 1024;
const SYNC_CACHE_BYTES = 8 * 1024 * 1024;
const REQUEST_LIMIT = 1024;
const SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'exec'];
const COMMAND_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const hasOwn = (value: object, key: string) => Object.hasOwn(value, key);
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nativeKey = (id: Id) => `${typeof id}:${id}`;

function runtimeError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function exactKeys(value: Record<string, any>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validateMcpValue(schema: any, value: any): boolean {
  if (!isObject(schema)) return false;
  if (Array.isArray(schema.enum)) return schema.enum.some((choice: any) => isDeepStrictEqual(choice, value));
  if (schema.type === 'string') return typeof value === 'string' && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'integer') return Number.isInteger(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type !== 'object' || !isObject(value) || !isObject(schema.properties)) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.every((key: unknown) => typeof key === 'string' && hasOwn(value, key))) return false;
  if (!Object.keys(value).every((key) => hasOwn(schema.properties, key))) return false;
  return Object.entries(value).every(([key, child]) => validateMcpValue(schema.properties[key], child));
}

export class Runtime extends EventEmitter {
  private options: Options;
  private idleMs: number;
  private sandbox: 'read-only' | 'danger-full-access';
  private server?: AppServer;
  private starting?: Promise<AppServer>;
  private stopping?: Promise<void>;
  private releaseQueued = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private epoch = randomUUID();
  private sequence = 0;
  private requestSequence = 0;
  private events: Array<{ change: Change; bytes: number; sequence: number }> = [];
  private eventBytes = 0;
  private syncCache = new Map<string, { state: ThreadState; bytes: number }>();
  private syncCacheBytes = 0;
  private states = new Map<string, ThreadState>();
  private requests = new Map<string, Idempotent>();
  private nativeRequests = new Map<string, PendingRequest>();
  private inFlight = 0;
  private reads = 0;
  private failures = 0;
  private diagnosticsSeen = 0;
  private initializeInfo?: any;
  private modelCatalog?: { epoch: string; expiresAt: number; data: any[] };
  private modelLoading?: { epoch: string; promise: Promise<{ data: any[]; nextCursor: null }> };
  private notificationKeys = new Set<string>();

  constructor(options: Options) {
    super();
    this.options = { ...options };
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.sandbox = options.sandbox ?? 'danger-full-access';
    if (!options.executable || !options.cwd || !Number.isSafeInteger(this.idleMs) || this.idleMs < 1) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Invalid runtime options');
  }

  async list(cursor?: string, archived = false): Promise<{ data: any[]; nextCursor: string | null }> {
    const result = await this.call<any>('thread/list', { cursor: cursor ?? null, sourceKinds: SOURCE_KINDS, useStateDbOnly: true, ...(archived?{archived:true}:{}) });
    return { data: Array.isArray(result?.data) ? result.data.map((thread: any) => ({ ...thread, ...(this.states.has(thread.id) ? { release: this.releaseState(this.states.get(thread.id)!) } : {}) })) : [], nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null };
  }

  open(threadId:string):Promise<any>{
    this.requireString(threadId,'threadId');const state=this.state(threadId);
    if(state.openPromise)return state.openPromise;
    if(state.reserved||state.activeTurnId||state.pending.size||(state.loaded&&!state.released&&!state.error&&!state.externalWriter))return Promise.resolve({phase:this.phase(state)});
    state.reserved=true;
    const operation=async()=>{
      try {
        const read=await this.call<any>('thread/read',{threadId,includeTurns:false});
        if(!isObject(read?.thread))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread status is unavailable');
        state.cwd=read.thread.cwd;state.model=read.thread.model;
        if(read.thread.status?.type==='active')throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread is active in another client');
        const policy=await this.resolvePermissions(state.selectedPermissionMode,state.cwd!);
        const resumed=await this.mutation<any>('thread/resume',{threadId,excludeTurns:true,...(policy?threadPermissionOptions(policy):{})});
        if(!isObject(resumed?.thread))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread resume was not confirmed');
        if(resumed.thread.status?.type==='active')throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread is active in another client');
        state.loaded=true;state.released=false;state.handoffReady=false;state.externalWriter=false;
        state.nativeStatus=resumed.thread.status;state.model=resumed.model;state.reasoningEffort=resumed.reasoningEffort;
        state.permissions=this.verifyPermissions(resumed,policy,state.cwd!);
        state.error=undefined;state.recoverOnIdle=false;
      } catch(error){
        const mapped=this.mapError(error);state.externalWriter=mapped.code==='RUNTIME_THREAD_CONFLICT';
        state.error=state.externalWriter?undefined:mapped.message;state.recoverOnIdle=false;
        if(!state.externalWriter)throw mapped;
      } finally {
        state.reserved=false;state.openPromise=undefined;this.change(threadId,'status');
        if(state.releaseRequested&&state.loaded)void this.requestRelease(threadId).catch(()=>{});
        this.scheduleIdle();
      }
      return {phase:this.phase(state)};
    };
    state.openPromise=Promise.resolve().then(operation);return state.openPromise;
  }

  async threadCwd(threadId: string): Promise<string | null> {
    this.requireString(threadId, 'threadId');
    const result = await this.call<any>('thread/read', { threadId, includeTurns: false });
    if (!isObject(result?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread information is unavailable');
    return typeof result.thread.cwd === 'string' ? result.thread.cwd : null;
  }

  async snapshot(threadId: string, options?: { window: boolean; signal?: AbortSignal }): Promise<any> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    const revision = state.revision;
    const snapshotSequence = ++state.snapshotSequence;
    // Keep content that arrives while native history pages are in flight, including
    // terminal turns that reconcile removes from liveTurns. Offsets handle overlap.
    const changes: Change[] = [];
    const changed = (event: Change) => { if (event.threadId === threadId) changes.push(event); };
    this.on('snapshotChange', changed);
    let thread: any;
    try { thread = await this.readThread(threadId, options?.window ? {} : undefined, options?.signal); } finally { this.off('snapshotChange', changed); }
    const mergedThread = this.mergeThread(thread, state);
    for (const event of changes) this.mergeSnapshotPatch(mergedThread, event.patch);
    // A read started before a newer operation/notification must not unlock that work.
    if (state.snapshotSequence === snapshotSequence && !state.reserved && (state.revision === revision || (state.activeTurnId && thread.turns.some((turn: any) => turn.id === state.activeTurnId && ['completed', 'interrupted', 'failed'].includes(turn.status))))) {
      const previousPhase = this.phase(state), previousError = state.error;
      this.reconcile(threadId, thread);
      if (thread.status?.type === 'notLoaded') state.loaded = false;
      if (state.error && state.recoverOnIdle && ['idle', 'notLoaded'].includes(thread.status?.type)
        && !state.activeTurnId && !state.pending.size && !thread.turns.some((turn: any) => turn.status === 'inProgress')) {
        state.error = undefined;
        state.recoverOnIdle = false;
      }
      if (this.phase(state) !== previousPhase || state.error !== previousError) this.change(threadId, 'status');
      this.scheduleIdle();
    }
    for (const turn of mergedThread.turns) if (turn.status === 'inProgress' && !state.liveTurns.has(turn.id) && !state.completedTurns.has(turn.id)) state.liveTurns.set(turn.id, structuredClone(turn));
    if (state.snapshotSequence === snapshotSequence) this.rememberSync(state, mergedThread);
    const window = options?.window ? historyWindow(mergedThread.turns) : null;
    return {
      thread: window ? { ...mergedThread, turns: window.turns.map(browserTurn) } : mergedThread,
      ...(window ? { history: { nextCursor: window.nextCursor } } : {}),
      model: state.model ?? mergedThread.model ?? null,
      reasoningEffort: state.reasoningEffort !== undefined ? state.reasoningEffort : mergedThread.reasoningEffort ?? null,
      phase: this.phase(state),
      activeTurnId: state.activeTurnId,
      pending: [...state.pending.values()].map(({ requestId, method, params }) => ({ requestId, method, params: structuredClone(params) })),
      epoch: this.epoch,
      revision: state.revision,
      syncCursor: `${this.epoch}:${this.sequence}`,
      ...(state.error ? { error: state.error } : {}),
      ...(state.permissions ? { permissions: structuredClone(state.permissions) } : {}),
      retry: state.retry ? { ...state.retry } : null,
      release: this.releaseState(state),
      unmaterialized: state.emptyThreadEpoch === this.epoch,
    };
  }

  async history(threadId: string, before: string, signal?: AbortSignal): Promise<{ turns: any[]; nextCursor: string | null }> {
    this.requireString(threadId, 'threadId');
    this.requireString(before, 'before');
    const thread = await this.readThread(threadId, { before }, signal);
    const page = historyWindow(thread.turns, before);
    return { turns: page.turns.map(browserTurn), nextCursor: page.nextCursor };
  }

  async output(threadId: string, turnId: string, itemId: string): Promise<{ output: string }> {
    const item = await this.command(threadId, turnId, itemId);
    return { output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '' };
  }

  async command(threadId: string, turnId: string, itemId: string): Promise<any> {
    const item = await this.readItem(threadId, turnId, itemId);
    if (item?.type !== 'commandExecution') throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Command item was not found');
    return item;
  }

  async image(threadId: string, turnId: string, itemId: string, imageId: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(imageId)) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Invalid image ID');
    const item = await this.readItem(threadId, turnId, itemId), images = new Map<string, string>();
    browserMedia(item, images);
    const data = images.get(imageId);
    if (!data) throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Image was not found or exceeds 10 MiB');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw runtimeError(413, 'RUNTIME_INVALID_INPUT', 'Image exceeds 10 MiB');
    return bytes;
  }

  private async readItem(threadId: string, turnId: string, itemId: string): Promise<any> {
    this.requireString(threadId, 'threadId');
    this.requireString(turnId, 'turnId');
    this.requireString(itemId, 'itemId');
    this.reads++;
    try {
      await this.getServer();
      const epoch = this.epoch;
      const turn = { id: turnId, items: [] as any[], itemsView: 'notLoaded' };
      await this.readTurnBodies(threadId, [turn], itemId);
      if (epoch !== this.epoch) throw runtimeError(503, 'RUNTIME_SYNC_RESTARTED', 'Native runtime changed during item loading; retry');
      const item = turn.items.find(item => item.id === itemId);
      if (!item) throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Item was not found');
      return item;
    } finally { this.reads--; this.scheduleIdle(); }
  }

  async status(threadId: string, epoch?: string): Promise<{ resync: boolean }> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    await this.getServer();
    if (!state.syncHeader || !state.syncTurns || state.syncEpoch !== this.epoch || (epoch && epoch !== this.epoch)) return { resync: true };
    const revision = state.revision;
    const result = await this.call<any>('thread/read', { threadId, includeTurns: false });
    if (!isObject(result?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread status is unavailable');
    if (!state.syncHeader || !state.syncTurns) return { resync: true };
    const header = this.threadHeader(result.thread);
    // Native clocks change while this client streams. Completion and turn headers
    // below still detect missing terminal notifications without reloading items.
    const expected = { ...state.syncHeader, status: state.nativeStatus ?? state.syncHeader.status };
    if (state.activeTurnId) { delete header.updatedAt; delete header.recencyAt; delete expected.updatedAt; delete expected.recencyAt; }
    let resync = !isDeepStrictEqual(header, expected);
    let cursor: string | null = null;
    const seen = new Set<string>();
    const turns = new Map<string, string>();
    do {
      let page: any;
      try { page = await this.call('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'notLoaded' }); }
      catch (error) {
        if (isObject(error) && error.code === 'RUNTIME_HISTORY_UNSUPPORTED' && state.emptyThreadEpoch === this.epoch && state.syncTurns?.size === 0 && turns.size === 0) break;
        throw error;
      }
      if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn history is unavailable');
      for (const turn of page.data) if (typeof turn?.id === 'string') turns.set(turn.id, this.turnSignature(turn));
      cursor = page.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor))) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination is invalid');
      if (cursor) seen.add(cursor);
    } while (cursor);
    // A notification during the probe may be newer than its native response.
    if (state.syncEpoch !== this.epoch || (epoch && epoch !== this.epoch)) return { resync: true };
    if (state.revision !== revision) return { resync: false };
    resync ||= !isDeepStrictEqual(turns, state.syncTurns);
    return { resync };
  }

  private async acceptedUserItem(threadId: string, turnId: string, clientId: string): Promise<any> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: any = await this.call('thread/items/list', { threadId, turnId, cursor, limit: 10, sortDirection: 'desc' });
      if (!Array.isArray(page?.data)) return null;
      const entry = page.data.find((entry: any) => entry?.turnId === turnId && entry.item?.type === 'userMessage' && entry.item.clientId === clientId && typeof entry.item.id === 'string');
      if (entry) return entry.item;
      cursor = page.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor))) return null;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return null;
  }

  private threadHeader(thread: any): any {
    const { turns, ...header } = thread;
    return structuredClone(header);
  }

  private turnSignature(turn: any): string {
    const { items, itemsView, ...header } = turn;
    return JSON.stringify(header);
  }

  private rememberSync(state: ThreadState, thread: any): void {
    state.syncHeader = this.threadHeader(thread);
    state.syncTurns = new Map(thread.turns.map((turn: any) => [turn.id, this.turnSignature(turn)]));
    state.syncEpoch = this.epoch;
    this.cacheSync(thread.id, state);
  }

  private cacheSync(threadId: string, state: ThreadState): void {
    this.syncCacheBytes -= this.syncCache.get(threadId)?.bytes ?? 0;
    this.syncCache.delete(threadId);
    const bytes = Buffer.byteLength(JSON.stringify([state.syncHeader, [...state.syncTurns!]]));
    this.syncCache.set(threadId, { state, bytes });
    this.syncCacheBytes += bytes;
    // Evicted baselines ask for an authoritative snapshot; they never permit stale reuse.
    while (this.syncCacheBytes > SYNC_CACHE_BYTES && this.syncCache.size) {
      const id = this.syncCache.keys().next().value!, entry = this.syncCache.get(id)!;
      entry.state.syncHeader = undefined;
      entry.state.syncTurns = undefined;
      this.syncCacheBytes -= entry.bytes;
      this.syncCache.delete(id);
    }
  }

  private mergeSnapshotPatch(thread: any, patch: Patch): void {
    if (patch.thread) Object.assign(thread, structuredClone(patch.thread));
    const turnId = patch.turn?.id ?? patch.item?.turnId ?? patch.delta?.turnId;
    if (!turnId) return;
    let turn = thread.turns.find((entry: any) => entry.id === turnId);
    if (!turn) { turn = { id: turnId, items: [], status: 'inProgress' }; thread.turns.push(turn); }
    if (patch.turn) {
      if (turn.status !== 'inProgress' && patch.turn.status === 'inProgress') return;
      const { items, ...header } = structuredClone(patch.turn);
      Object.assign(turn, header);
      for (const item of items ?? []) this.mergeSnapshotPatch(thread, { item: { turnId, item, completed: patch.turn.status !== 'inProgress' } });
    }
    if (patch.delta) {
      const delta = patch.delta, item = turn.items.find((entry: any) => entry.id === delta.itemId);
      if (item && turn.status === 'inProgress') {
        const target=delta.index===undefined?item:(item[delta.field]??=[]),key=delta.index??delta.field;
        if(delta.index!==undefined)while(target.length<=delta.index)target.push('');
        const text = target[key] ?? '';
        if (text.length >= delta.offset && text.length < delta.offset + delta.text.length) target[key] = text + delta.text.slice(text.length - delta.offset);
      }
    }
    if (patch.item) {
      if (turn.status !== 'inProgress' && !patch.item.completed) return;
      const index = turn.items.findIndex((entry: any) => entry.id === patch.item!.item.id);
      if (index < 0) turn.items.push(structuredClone(patch.item.item));
      else turn.items[index] = structuredClone(patch.item.item);
    }
  }

  create(input: { cwd: string; clientRequestId: string; prompt?: string } & TurnOptions): Promise<any> {
    this.requireString(input?.cwd, 'cwd');
    this.requireRequestId(input?.clientRequestId);
    if (input.prompt !== undefined && typeof input.prompt !== 'string') throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'prompt must be a string');
    if (input.model !== undefined && typeof input.model !== 'string') throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'model must be a string');
    return this.idempotent(input.clientRequestId, JSON.stringify(['create', input.cwd, input.prompt ?? null, input.model ?? null, input.effort ?? null, input.permissionMode ?? null, input.nativeInput ?? null]), async () => {
      if (input.model) await this.validateTurnOptions(input, input.cwd);
      const policy = await this.resolvePermissions(input.permissionMode, input.cwd);
      const result = await this.mutation<any>('thread/start', { cwd: input.cwd, ...(input.model ? { model: input.model } : {}), ...(policy ? threadPermissionOptions(policy) : {}) });
      const threadId = result?.thread?.id;
      if (typeof threadId !== 'string') throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread creation returned an invalid result');
      const state = this.state(threadId);
      state.loaded = true;
      state.released = false;
      state.emptyThreadEpoch = input.prompt ? undefined : this.epoch;
      try {
        state.permissions = this.verifyPermissions(result, policy, input.cwd);
        state.selectedPermissionMode = input.permissionMode;
        state.cwd = input.cwd;
        state.model = result.model;
        state.reasoningEffort = result.reasoningEffort;
        this.change(threadId, 'thread', { thread: this.threadHeader(result.thread) });
        await this.validateTurnOptions(input, input.cwd, state.model);
        if (!input.prompt && !input.nativeInput?.length) return { threadId, status: 'idle' };
        return await this.startTurn(threadId, input.prompt ?? '', input, state, state.permissions);
      } catch (error) {
        throw Object.assign(this.mapError(error), { partial: { threadId } });
      }
    });
  }

  send(threadId: string, input: { text: string; clientRequestId: string; expectedTurnId?: string } & TurnOptions): Promise<any> {
    this.requireString(threadId, 'threadId');
    if (typeof input?.text !== 'string' || (!input.text && !input.nativeInput?.length)) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'text or attachments are required');
    this.requireRequestId(input?.clientRequestId);
    if (input.model !== undefined && typeof input.model !== 'string') throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'model must be a string');
    if (input.expectedTurnId !== undefined) this.requireString(input.expectedTurnId, 'expectedTurnId');
    return this.idempotent(input.clientRequestId, JSON.stringify(['send', threadId, input.text, input.model ?? null, input.effort ?? null, input.permissionMode ?? null, input.nativeInput ?? null, input.expectedTurnId ?? null]), async () => {
      const state = this.state(threadId);
      if (input.expectedTurnId !== undefined) {
        if (input.model !== undefined || input.effort !== undefined || input.permissionMode !== undefined) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', '插话沿用当前轮次的模型、推理强度和权限');
        await this.validateTurnOptions(input, state.cwd ?? this.options.cwd, state.model);
        if (!state.loaded || state.released || state.releasePromise || state.reserved || state.pending.size || state.error || state.activeTurnId !== input.expectedTurnId) throw runtimeError(409, 'RUNTIME_STEER_CONFLICT', '当前轮次已变化或无法插话，请刷新后重新发送');
        const result = await this.mutation<any>('turn/steer', {
          threadId, expectedTurnId: input.expectedTurnId, clientUserMessageId: input.clientRequestId,
          input: [...(input.text ? [{ type: 'text', text: input.text, text_elements: [] }] : []), ...(input.nativeInput ?? [])],
        });
        if (result?.turnId !== input.expectedTurnId) throw runtimeError(504, 'RUNTIME_RESULT_UNKNOWN', '插话结果待核实，请刷新历史');
        // The acknowledgement has no item: read only this turn to obtain its native id.
        try {
          const item = await this.acceptedUserItem(threadId, result.turnId, input.clientRequestId);
          if (item) this.onNotification({ method: 'item/completed', params: { threadId, turnId: result.turnId, item } });
          else this.change(threadId, 'resync');
        } catch { this.change(threadId, 'resync'); }
        return { threadId, turnId: result.turnId, status: 'steered' };
      }
      if (state.releasePromise || state.reserved || state.activeTurnId || state.pending.size || state.error || state.externalWriter || ['active', 'systemError'].includes(state.nativeStatus?.type)) throw runtimeError(409, 'RUNTIME_THREAD_BUSY', 'Thread already has active or unresolved work');
      state.releaseRequested = false;
      state.handoffReady = false;
      state.reserved = true;
      state.waiter = this.waiter();
      state.completion = this.completion();
      this.change(threadId, 'phase');
      try {
        if (!state.cwd) {
          const read = await this.call<any>('thread/read', { threadId, includeTurns: false });
          state.cwd = read.thread?.cwd ?? this.options.cwd;
          state.model = read.thread?.model;
        }
        const policy = await this.resolvePermissions(input.permissionMode ?? state.selectedPermissionMode, state.cwd!, state.loaded && !state.released ? state.permissions : undefined);
        if (!state.loaded || state.released) {
          const resumed = await this.mutation<any>('thread/resume', { threadId, excludeTurns: true, ...(policy ? threadPermissionOptions(policy) : {}) });
          state.permissions = this.verifyPermissions(resumed, policy, state.cwd!);
          state.model = resumed.model;
          state.reasoningEffort = resumed.reasoningEffort;
          if (resumed?.thread?.status?.type === 'active') throw runtimeError(409, 'RUNTIME_THREAD_CONFLICT', 'Thread is active in another client; release it there before continuing');
          state.loaded = true;
          state.released = false;
          state.nativeStatus = resumed.thread.status;
        }
        await this.validateTurnOptions(input, state.cwd!, state.model);
        return await this.startTurn(threadId, input.text, input, state, policy ?? state.permissions);
      } catch (error) {
        const mapped = this.mapError(error);
        state.error = mapped.message;
        state.recoverOnIdle = true;
        state.reserved = false;
        state.waiter?.resolve('failed');
        this.change(threadId, 'error');
        throw mapped;
      }
    });
  }

  async abort(threadId: string): Promise<any> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    if (!state.reserved && !state.activeTurnId) return { threadId, status: 'idle' };
    if (!state.activeTurnId && state.waiter) await state.waiter.promise;
    const turnId = state.activeTurnId;
    if (!turnId) return { threadId, status: state.error ? 'unknown' : 'idle' };
    await this.mutation('turn/interrupt', { threadId, turnId });
    if (state.activeTurnId && state.completion) await state.completion.promise;
    return { threadId, turnId, status: state.activeTurnId ? 'interrupting' : 'idle' };
  }

  release(threadId: string, automatic = false): Promise<any> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    if (state.releasePromise) return automatic ? state.releasePromise : state.releasePromise.then(result => {
      state.selectedPermissionMode = undefined;
      return result;
    });
    if (state.reserved) return Promise.reject(runtimeError(409, 'RUNTIME_THREAD_BUSY', 'Thread operation is in progress'));
    state.reserved = true;
    state.releaseError = undefined;
    this.change(threadId, 'release');
    const operation = async () => {
      try {
        if (!state.released) {
          const thread = await this.readThread(threadId, { headersOnly: true });
          this.reconcile(threadId, thread);
          if (!['idle', 'notLoaded'].includes(thread.status?.type) || state.activeTurnId || state.pending.size || thread.turns.some((t: any) => t.status === 'inProgress')) throw runtimeError(409, 'RUNTIME_THREAD_BUSY', 'Native thread must be idle before release');
          const result = await this.mutation<any>('thread/unsubscribe', { threadId });
          if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result?.status)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native release was not confirmed');
          state.nativeReleaseStatus = result.status;
          state.loaded = false;
          state.released = true;
          this.clearLiveState(state);
          state.error = undefined;
          state.recoverOnIdle = false;
        }
        if (!automatic) state.selectedPermissionMode = undefined;
        state.reserved = false;
        const runtimeStopped = state.handoffReady || await this.closeIdleServer();
        state.handoffReady = !!runtimeStopped;
        return { threadId, status: 'released', nativeStatus: state.nativeReleaseStatus ?? null, runtimeStopped: !!runtimeStopped, handoffReady: !!runtimeStopped,
          ...(!runtimeStopped ? { warning: 'Subscription cancelled; waiting for other runtime work before ownership can be released' } : {}) };
      } catch (error) {
        state.releaseError = this.mapError(error).message;
        throw error;
      } finally {
        state.reserved = false;
        state.releasePromise = undefined;
        this.change(threadId, 'release');
      }
    };
    state.releasePromise = Promise.resolve().then(operation);
    return state.releasePromise;
  }

  async requestRelease(threadId: string): Promise<any> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    if (!state.loaded && !state.released && !state.reserved && !state.activeTurnId) return { threadId, status: 'skipped', ...this.releaseState(state) };
    state.releaseRequested = true;
    state.releaseError = undefined;
    this.change(threadId, 'release');
    if (!state.reserved) {
      try { await this.release(threadId, true); } catch (error) {
        if (this.mapError(error).code === 'RUNTIME_THREAD_BUSY') state.releaseError = undefined;
      }
    }
    return { threadId, status: state.handoffReady ? 'released' : 'pending', ...this.releaseState(state) };
  }

  async cancelRelease(threadId: string): Promise<any> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    state.releaseRequested = false;
    if (state.releasePromise) { try { await state.releasePromise; } catch {} }
    this.change(threadId, 'release');
    return { threadId, ...this.releaseState(state) };
  }

  private releaseState(state: ThreadState) {
    return { requested: !!state.releaseRequested, inProgress: !!state.releasePromise, handoffReady: !!state.handoffReady, ...(state.releaseError ? { error: state.releaseError } : {}) };
  }

  private reconcile(threadId: string, thread: any): void {
    const state = this.state(threadId);
    state.nativeStatus = thread.status;
    for (const turn of thread.turns) {
      if (!['completed', 'interrupted', 'failed'].includes(turn.status)) continue;
      state.completedTurns.add(turn.id);
      state.liveTurns.delete(turn.id);
      if (state.retry?.turnId === turn.id) state.retry = undefined;
      if (state.activeTurnId === turn.id) {
        state.activeTurnId = null;
        state.waiter?.resolve('completed');
        state.completion?.resolve();
      }
      for (const pending of [...state.pending.values()]) if (pending.turnId === turn.id) this.clearPending(pending, 'request');
    }
  }

  async respond(threadId: string, requestId: string, answer: any): Promise<any> {
    this.requireString(threadId, 'threadId');
    this.requireString(requestId, 'requestId');
    const state = this.state(threadId);
    const pending = state.pending.get(requestId);
    if (!pending || pending.answered || pending.epoch !== this.epoch) throw runtimeError(409, 'RUNTIME_STALE_REQUEST', 'The interaction is stale or already answered');
    const result = this.validateAnswer(pending, answer);
    const server = await this.getServer();
    try { server.respond(pending.nativeId, result); }
    catch (error) { throw this.mapError(error); }
    pending.answered = true;
    state.pending.delete(requestId);
    this.nativeRequests.delete(nativeKey(pending.nativeId));
    this.change(threadId, 'request');
    this.scheduleIdle();
    return { requestId, status: 'accepted' };
  }

  async diagnostics(): Promise<any> {
    try {
      await this.getServer();
      const account = await this.call<any>('account/read', { refreshToken: false });
      return {
        available: true,
        epoch: this.epoch,
        failures: this.failures,
        diagnosticsSeen: this.diagnosticsSeen,
        permissionModes: await this.permissionModes(this.options.cwd),
        userAgent: this.initializeInfo?.userAgent ?? null,
        codexHome: this.initializeInfo?.codexHome ?? null,
        platformFamily: this.initializeInfo?.platformFamily ?? null,
        platformOs: this.initializeInfo?.platformOs ?? null,
        account: account?.account ?? null,
        requiresOpenaiAuth: account?.requiresOpenaiAuth ?? null,
      };
    } catch (error) {
      const mapped = this.mapError(error);
      return { available: false, epoch: this.epoch, failures: this.failures, diagnosticsSeen: this.diagnosticsSeen, error: mapped.message, code: mapped.code };
    }
  }

  // No RPC or filesystem access: sampling must not wake or wait for the native process.
  diagnosticState(){
    const native=this.server?.diagnosticState(),waiting=new Set(native?.pending.map(request=>request.threadId));
    return {epoch:this.epoch,inFlight:this.inFlight,reads:this.reads,failures:this.failures,diagnosticsSeen:this.diagnosticsSeen,
      native,threads:[...this.states.entries()].filter(([id,state])=>state.loaded||state.activeTurnId||state.reserved||waiting.has(id)).sort(([left],[right])=>Number(waiting.has(right))-Number(waiting.has(left))).slice(0,20).map(([id,state])=>({threadId:diagnosticId(id),phase:this.phase(state),projectKey:state.diagnosticProjectKey??(state.cwd?createHash('sha256').update(process.platform==='win32'?state.cwd.toLowerCase():state.cwd).digest('hex').slice(0,24):undefined)}))};
  }

  replay(threadId: string, lastId?: string): { reset: boolean; events: any[] } {
    this.requireString(threadId, 'threadId');
    if (!lastId) return { reset: true, events: [] };
    const split = lastId.lastIndexOf(':');
    const epoch = split < 0 ? '' : lastId.slice(0, split);
    const sequence = Number(split < 0 ? NaN : lastId.slice(split + 1));
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence < oldest - 1 || sequence > this.sequence) return { reset: true, events: [] };
    return { reset: false, events: this.events.filter((event) => event.sequence > sequence && event.change.threadId === threadId).map((event) => event.change) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server) await server.close();
  }

  private state(threadId: string): ThreadState {
    let state = this.states.get(threadId);
    if (!state) {
      state = { activeTurnId: null, completedTurns: new Set(), completedItems: new Set(), liveTurns: new Map(), loaded: false, pending: new Map(), released: false, reserved: false, revision: 0, snapshotSequence: 0 };
      this.states.set(threadId, state);
    }
    return state;
  }

  private waiter(): Waiter {
    let resolve!: Waiter['resolve'];
    const promise = new Promise<'started' | 'completed' | 'failed'>((done) => { resolve = done; });
    return { promise, resolve };
  }

  private completion(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  private async startTurn(threadId: string, text: string, input: TurnOptions & { clientRequestId: string }, state: ThreadState, policy: PermissionPolicy): Promise<any> {
    state.emptyThreadEpoch = undefined;
    if (!state.waiter) state.waiter = this.waiter();
    if (!state.completion) state.completion = this.completion();
    state.reserved = true;
    const result = await this.mutation<any>('turn/start', {
      threadId,
      clientUserMessageId: input.clientRequestId,
      input: [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...(input.nativeInput ?? [])],
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandboxPolicy: policy.sandbox,
    });
    state.permissions = structuredClone(policy);
    if (input.permissionMode !== undefined) state.selectedPermissionMode = input.permissionMode;
    const turnId = result?.turn?.id;
    if (typeof turnId !== 'string') throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn start returned an invalid result');
    // A model-only change does not confirm which effort the new model resolved.
    if (input.effort !== undefined || (input.model && input.model !== state.model)) state.reasoningEffort = input.effort ?? null;
    state.model = input.model ?? state.model;
    this.mergeLiveTurn(state, result.turn);
    if (!state.completedTurns.has(turnId) && result.turn.status === 'inProgress') state.activeTurnId ??= turnId;
    state.reserved = false;
    this.change(threadId, 'turn', { turn: state.liveTurns.get(turnId) ?? result.turn });
    return { threadId, turnId, status: state.completedTurns.has(turnId) ? 'completed' : result.turn.status };
  }

  async models(): Promise<{ data: any[]; nextCursor: null }> {
    await this.getServer();
    const epoch = this.epoch;
    if (this.modelCatalog?.epoch === epoch && this.modelCatalog.expiresAt > Date.now()) return { data: structuredClone(this.modelCatalog.data), nextCursor: null };
    if (this.modelLoading?.epoch === epoch) return structuredClone(await this.modelLoading.promise);
    const promise = this.loadModels().then(result => {
      if (this.epoch === epoch) this.modelCatalog = { epoch, expiresAt: Date.now() + 5 * 60_000, data: structuredClone(result.data) };
      return result;
    }).finally(() => { if (this.modelLoading?.promise === promise) this.modelLoading = undefined; });
    this.modelLoading = { epoch, promise };
    return structuredClone(await promise);
  }

  private async loadModels(): Promise<{ data: any[]; nextCursor: null }> {
    const data: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: any = await this.call('model/list', { cursor, includeHidden: true });
      if (!Array.isArray(result?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native model catalog is unavailable');
      data.push(...result.data.map((m: any) => ({ id: m.id, model: m.model, displayName: m.displayName, description: m.description, hidden: m.hidden, supportedReasoningEfforts: m.supportedReasoningEfforts, defaultReasoningEffort: m.defaultReasoningEffort, inputModalities: m.inputModalities, isDefault: m.isDefault })));
      cursor = result.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || cursors.has(cursor))) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Invalid model pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { data, nextCursor: null };
  }

  private async permissionCatalog(cwd: string) {
    this.requireString(cwd, 'cwd');
    const [read, requirements] = await Promise.all([this.call<any>('config/read', { cwd, includeLayers: false }), this.call<any>('configRequirements/read', {})]);
    if (!isObject(read?.config) || !isObject(requirements) || !hasOwn(requirements, 'requirements')) throw runtimeError(503, 'RUNTIME_PERMISSION_UNAVAILABLE', 'Native permission configuration is unavailable');
    return { ...permissionChoices(cwd, read.config, requirements.requirements, this.initializeInfo?.platformFamily),
      model: typeof read.config.model === 'string' ? read.config.model : null,
      effort: typeof read.config.model_reasoning_effort === 'string' ? read.config.model_reasoning_effort : null };
  }

  async permissionModes(cwd: string) {
    const { modes, current, model, effort } = await this.permissionCatalog(cwd);
    return { modes, current, model, effort };
  }

  private async resolvePermissions(mode: PermissionMode | undefined, cwd: string, previous?: PermissionPolicy): Promise<PermissionPolicy | undefined> {
    if (mode === undefined) return previous;
    if (!['ask', 'auto-review', 'full-access', 'custom'].includes(mode)) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Invalid permission mode');
    const catalog = await this.permissionCatalog(cwd);
    const choice = catalog.modes.find(m => m.id === mode)!;
    if (!choice.available) throw runtimeError(409, 'RUNTIME_PERMISSION_UNAVAILABLE', choice.reason!);
    return { ...catalog.policies[mode], mode };
  }

  private async validateTurnOptions(input: TurnOptions, cwd: string, currentModel?: string): Promise<void> {
    if (input.effort !== undefined && (typeof input.effort !== 'string' || !input.effort)) throw runtimeError(400, 'RUNTIME_INVALID_EFFORT', 'Invalid reasoning effort');
    if (input.nativeInput !== undefined && (!Array.isArray(input.nativeInput) || input.nativeInput.some(item => !isObject(item) || (item.type !== 'localImage' && item.type !== 'text') || (item.type === 'localImage' ? typeof item.path !== 'string' || !item.path : typeof item.text !== 'string' || !Array.isArray(item.text_elements) || item.text_elements.length)))) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Invalid controlled attachment input');
    if (!input.model && !input.effort && !input.nativeInput?.some(item => item.type === 'localImage')) return;
    const { data } = await this.models();
    const selected = input.model ?? currentModel ?? (await this.call<any>('config/read', { cwd, includeLayers: false })).config?.model;
    const model = selected ? data.find(m => m.model === selected) : data.find(m => m.isDefault);
    if (!model) throw runtimeError(400, 'RUNTIME_INVALID_MODEL', 'Selected model is unavailable; select another model');
    if (input.effort && !model.supportedReasoningEfforts?.some((e: any) => e.reasoningEffort === input.effort)) throw runtimeError(400, 'RUNTIME_INVALID_EFFORT', 'Reasoning effort is not supported by this model');
    if (input.nativeInput?.some(item => item.type === 'localImage') && !model.inputModalities?.includes('image')) throw runtimeError(400, 'RUNTIME_MODEL_INPUT_UNSUPPORTED', 'Selected model does not support images');
  }

  async rename(threadId: string, name: string): Promise<any> {
    this.requireString(threadId, 'threadId');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Name must contain 1 to 120 characters');
    await this.mutation('thread/name/set', { threadId, name: name.trim() });
    this.change(threadId, 'name', { thread: { name: name.trim() } });
    return { threadId, name: name.trim() };
  }

  async accountIdentity(): Promise<{identity:string;resetProtocol:boolean}> {
    const result=await this.call<any>('account/read',{refreshToken:false});
    return {identity:createHash('sha256').update(JSON.stringify(result?.account??null)+'|'+this.epoch).digest('hex'),resetProtocol:result?.account?.type==='chatgpt'&&/^codex_remote_web\/0\.153\.4(?:\s|$)/.test(this.initializeInfo?.userAgent??'')};
  }

  readAccountUsage():Promise<any>{return this.call('account/rateLimits/read',{});}

  async consumeAccountReset(input:{creditId:string;idempotencyKey:string},accountId:string):Promise<any>{
    this.inFlight++;
    try {
      const server=await this.getServer();
      if(!/^codex_remote_web\/0\.153\.4(?:\s|$)/.test(this.initializeInfo?.userAgent??''))throw runtimeError(409,'RUNTIME_ACCOUNT_UNSUPPORTED','当前 Codex 版本尚未验证重置接口。');
      const usage=await server.request<any>('account/rateLimits/read',{});
      if(typeof usage?.accountId!=='string'||!usage.accountId||createHash('sha256').update(usage.accountId).digest('hex')!==accountId||server!==this.server)throw runtimeError(409,'RUNTIME_ACCOUNT_CHANGED','账户已变化，请重新读取用量。');
      try {return await server.request('account/rateLimitResetCredit/consume',input);}
      catch {throw runtimeError(504,'RUNTIME_RESULT_UNKNOWN','重置结果待核实，请使用原操作标识重试。');}
    } catch(error){throw this.mapError(error);}
    finally {this.inFlight--;this.scheduleIdle();}
  }

  async archive(threadId:string,archived=true):Promise<any>{
    this.requireString(threadId,'threadId');
    if(archived)await this.open(threadId);
    const state=this.state(threadId);
    if(state.reserved||state.activeTurnId||state.pending.size||state.releasePromise||(archived&&this.phase(state)!=='IDLE'))throw runtimeError(409,'RUNTIME_THREAD_BUSY','会话仍被占用，请先结束任务或在其他应用中关闭。');
    state.reserved=true;
    try{
      await this.mutation(archived?'thread/archive':'thread/unarchive',{threadId});
      state.loaded=false;state.released=true;state.handoffReady=true;state.releaseRequested=false;state.releaseError=undefined;state.externalWriter=false;state.error=undefined;state.recoverOnIdle=false;state.nativeStatus={type:'notLoaded'};this.clearLiveState(state);
      return {threadId,archived};
    }finally{state.reserved=false;this.change(threadId,'archive');this.scheduleIdle();}
  }

  private verifyPermissions(result: any, expected?: PermissionPolicy, cwd?: string): PermissionPolicy {
    if (!expected) {
      const approval = result?.approvalPolicy, sandbox = result?.sandbox;
      const validApproval = ['untrusted', 'on-request', 'never'].includes(approval) || (isObject(approval?.granular) && ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'].every(key => typeof approval.granular[key] === 'boolean'));
      const validSandbox = sandbox?.type === 'dangerFullAccess'
        || (sandbox?.type === 'readOnly' && typeof sandbox.networkAccess === 'boolean')
        || (sandbox?.type === 'externalSandbox' && ['restricted', 'enabled'].includes(sandbox.networkAccess))
        || (sandbox?.type === 'workspaceWrite' && Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.every((root: unknown) => typeof root === 'string') && ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'].every(key => typeof sandbox[key] === 'boolean'));
      if (!validApproval || !validSandbox || !['user', 'auto_review'].includes(result?.approvalsReviewer)) throw runtimeError(503, 'RUNTIME_PERMISSION_MISMATCH', 'Native effective permissions cannot be represented by this protocol');
      return { mode: 'custom', approvalPolicy: structuredClone(approval), approvalsReviewer: result.approvalsReviewer, sandbox: structuredClone(sandbox) };
    }
    // Native workspace-write includes cwd implicitly and may omit it from writableRoots.
    const effectiveSandbox = (sandbox: any, directory: unknown) => {
      if (sandbox?.type !== 'workspaceWrite' || typeof directory !== 'string' || !isAbsolute(directory)
        || !Array.isArray(sandbox.writableRoots) || !sandbox.writableRoots.every((root: unknown) => typeof root === 'string' && isAbsolute(root))) return sandbox;
      return {...sandbox, writableRoots: [...new Set([...sandbox.writableRoots, directory].map(root => resolve(root)))].sort()};
    };
    if (!isDeepStrictEqual(result?.approvalPolicy, expected.approvalPolicy) || result?.approvalsReviewer !== expected.approvalsReviewer || !isDeepStrictEqual(effectiveSandbox(result?.sandbox, result?.cwd), effectiveSandbox(expected.sandbox, cwd))) {
      throw runtimeError(503, 'RUNTIME_PERMISSION_MISMATCH', 'Codex did not apply the selected approval and sandbox policy');
    }
    return { ...expected, sandbox: structuredClone(result.sandbox) };
  }

  private idempotent(clientRequestId: string, signature: string, operation: () => Promise<any>): Promise<any> {
    const old = this.requests.get(clientRequestId);
    if (old) {
      if (old.signature !== signature) return Promise.reject(runtimeError(409, 'RUNTIME_IDEMPOTENCY_CONFLICT', 'clientRequestId was already used for different content'));
      return old.promise;
    }
    if (this.requests.size >= REQUEST_LIMIT) return Promise.reject(runtimeError(503, 'RUNTIME_REQUEST_CAPACITY', 'Runtime request capacity is full'));
    const promise = operation();
    this.requests.set(clientRequestId, { signature, promise });
    return promise;
  }

  private async mutation<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.call<T>(method, params, true);
  }

  private async call<T = unknown>(method: string, params: unknown, uncertain = false): Promise<T> {
    this.inFlight++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      let server: AppServer;
      try { server = await this.getServer(); }
      catch (error) { throw this.mapError(error); }
      for (let attempt = 0; ; attempt++) {
        try { return await server.request<T>(method, params); }
        catch (error) {
          const mapped = this.mapError(error, method, params);
          // thread/start may return before its rollout metadata is flushed. Retry only this read race.
          if (!uncertain && mapped.code === 'RUNTIME_HISTORY_NOT_READY' && attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
            continue;
          }
          if (uncertain && mapped.statusCode === 503) throw runtimeError(504, 'RUNTIME_RESULT_UNKNOWN', 'Codex did not confirm the operation; its result is unknown');
          throw mapped;
        }
      }
    } catch (error) {
      throw this.mapError(error, method, params);
    } finally {
      this.inFlight--;
      this.scheduleIdle();
    }
  }

  private getServer(): Promise<AppServer> {
    if (this.closed) return Promise.reject(runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Runtime is closed'));
    if (this.stopping) return this.stopping.then(() => this.getServer());
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve(this.server);
    this.epoch = randomUUID();
    this.sequence = 0;
    this.events = [];
    this.eventBytes = 0;
    const server = new AppServer({ executable: this.options.executable, cwd: this.options.cwd, args: this.options.args,diagnostic:this.options.diagnostic });
    this.server = server;
    server.on('notification', (message) => { if (this.server === server) this.onNotification(message); });
    server.on('request', (message) => { if (this.server === server) this.onRequest(message); });
    server.on('diagnostic', () => { this.diagnosticsSeen++; });
    server.on('failure', () => this.onFailure(server));
    this.starting = server.initialize().then((result) => {
      this.initializeInfo = structuredClone(result);
      return server;
    }).catch(async (error) => {
      if (this.server === server) this.server = undefined;
      try { await server.close(); } catch {}
      throw this.mapError(error);
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private onFailure(server: AppServer): void {
    if (this.server !== server) return;
    this.failures++;
    this.server = undefined;
    this.starting = undefined;
    for (const [threadId, state] of this.states) {
      state.loaded = false;
      state.waiter?.resolve('failed');
      state.completion?.resolve();
      this.clearLiveState(state);
      if (state.released) continue;
      state.error = 'Native runtime stopped; the last operation may have an unknown result';
      state.recoverOnIdle = true;
      state.activeTurnId = null;
      state.reserved = false;
      for (const pending of state.pending.values()) this.nativeRequests.delete(nativeKey(pending.nativeId));
      state.pending.clear();
      this.change(threadId, 'error');
    }
  }

  private onNotification(message: any): void {
    const method = message?.method;
    const params = message?.params;
    if (!isObject(params)) return;
    if(method==='account/updated'||method==='account/rateLimits/updated')this.emit('accountChanged');
    if (method === 'serverRequest/resolved') {
      const pending = this.nativeRequests.get(nativeKey(params.requestId));
      if (pending) this.clearPending(pending, 'request');
      return;
    }
    if (typeof params.threadId !== 'string') return;
    const state = this.state(params.threadId);
    if (method === 'thread/status/changed' || method === 'thread/closed') {
      state.nativeStatus = method === 'thread/closed' ? { type: 'notLoaded' } : params.status;
      if (state.nativeStatus?.type === 'notLoaded') state.loaded = false;
      this.change(params.threadId, 'status', { thread: { status: state.nativeStatus } });
      this.scheduleIdle();
      return;
    }
    if (method === 'turn/started' && isObject(params.turn)) {
      this.mergeLiveTurn(state, params.turn);
      if (state.completedTurns.has(params.turn.id)) return;
      state.activeTurnId = params.turn.id;
      state.nativeStatus = { type: 'active', activeFlags: [] };
      state.reserved = false;
      state.error = undefined;
      state.recoverOnIdle = false;
      state.waiter?.resolve('started');
      this.change(params.threadId, 'turn', { turn: params.turn, thread: { status: state.nativeStatus } });
      return;
    }
    if (method === 'turn/completed' && isObject(params.turn)) {
      this.notification(params.threadId, `turn:${params.turn.id}`, params.turn.status === 'failed' ? 'failed' : 'complete');
      if (state.retry?.turnId === params.turn.id) state.retry = undefined;
      this.mergeLiveTurn(state, params.turn);
      state.completedTurns.add(params.turn.id);
      if (!state.activeTurnId || state.activeTurnId === params.turn.id) {
        state.activeTurnId = null;
        state.nativeStatus = { type: 'idle' };
      }
      state.reserved = false;
      state.waiter?.resolve('completed');
      state.completion?.resolve();
      for (const pending of [...state.pending.values()]) if (pending.turnId === params.turn.id) this.clearPending(pending, 'request');
      this.change(params.threadId, 'turn', { turn: params.turn, thread: { status: state.nativeStatus } });
      this.scheduleIdle();
      return;
    }
    if (typeof method === 'string' && method.startsWith('item/') && state.retry?.turnId === params.turnId) state.retry = undefined;
    if ((method === 'item/started' || method === 'item/completed') && isObject(params.item) && typeof params.turnId === 'string') {
      const itemKey = `${params.turnId}:${params.item.id}`;
      if (method === 'item/started' && state.completedItems.has(itemKey)) return;
      const activeTurn = state.liveTurns.get(params.turnId) ?? { id: params.turnId, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
      const index = activeTurn.items.findIndex((item: any) => item.id === params.item.id);
      if (index < 0) activeTurn.items.push(structuredClone(params.item));
      else activeTurn.items[index] = structuredClone(params.item);
      if (method === 'item/completed') state.completedItems.add(itemKey);
      state.liveTurns.set(params.turnId, activeTurn);
      this.change(params.threadId, 'item', { item: { turnId: params.turnId, item: params.item, completed: method === 'item/completed' } });
      return;
    }
    const summaryPart=method==='item/reasoning/summaryPartAdded',reasoning=summaryPart||method==='item/reasoning/summaryTextDelta'||method==='item/reasoning/textDelta';
    if ((reasoning || method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') && typeof params.turnId === 'string' && typeof params.itemId === 'string' && (summaryPart||typeof params.delta === 'string')) {
      const index=reasoning?(method==='item/reasoning/textDelta'?params.contentIndex:params.summaryIndex):undefined;
      if(reasoning&&(!Number.isSafeInteger(index)||index<0||index>10000))return;
      if (state.completedTurns.has(params.turnId) || state.completedItems.has(`${params.turnId}:${params.itemId}`)) return;
      const activeTurn = state.liveTurns.get(params.turnId) ?? { id: params.turnId, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
      let item = activeTurn.items.find((candidate: any) => candidate.id === params.itemId);
      if (!item) {
        item = reasoning ? {type:'reasoning',id:params.itemId,summary:[],content:[]} : method === 'item/agentMessage/delta'
          ? { type: 'agentMessage', id: params.itemId, text: '', phase: null, memoryCitation: null, delivery: null, questions: null }
          : { type: 'commandExecution', id: params.itemId, pluginId: null, scriptPath: null, command: '', cwd: '', processId: null, source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: '', exitCode: null, durationMs: null };
        activeTurn.items.push(item);
      }
      const field = reasoning ? method==='item/reasoning/textDelta'?'content':'summary' : method === 'item/agentMessage/delta' ? 'text' : 'aggregatedOutput';
      if(reasoning&&(item.type!=='reasoning'||!Array.isArray(item[field])))return;
      const target=reasoning?item[field]:item,key=reasoning?index:field;
      if(summaryPart&&target[index]!==undefined)return;
      if(reasoning)while(target.length<=index)target.push('');
      const offset = (target[key] ?? '').length,text=summaryPart?'':params.delta;
      target[key] = `${target[key] ?? ''}${text}`;
      state.liveTurns.set(params.turnId, activeTurn);
      this.change(params.threadId, 'delta', { delta: { turnId: params.turnId, itemId: params.itemId, field, ...(reasoning?{index}:{}), offset, text } });
      return;
    }
    if (method === 'error') {
      const turnId = typeof params.turnId === 'string' ? params.turnId : state.activeTurnId;
      if (turnId && params.willRetry === true) {
        if (!state.completedTurns.has(turnId)) state.retry = { turnId, message: typeof params.error?.message === 'string' ? params.error.message : 'Native model is retrying' };
        this.change(params.threadId, 'retry');
        return;
      }
      if (turnId) {
        state.retry = undefined;
        const activeTurn = state.liveTurns.get(turnId) ?? { id: turnId, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
        activeTurn.error = structuredClone(params.error ?? null);
        state.liveTurns.set(turnId, activeTurn);
      }
      this.diagnosticsSeen++;
      this.change(params.threadId, 'error', turnId ? { turn: { id: turnId, error: params.error ?? null } } : {});
      return;
    }
    this.diagnosticsSeen++;
  }

  private onRequest(message: any): void {
    const server = this.server;
    const params = message?.params;
    const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);
    const turnId = isObject(params) && typeof params.turnId === 'string'
      ? params.turnId
      : isObject(params) && message?.method === 'mcpServer/elicitation/request' && typeof params.threadId === 'string'
        ? this.states.get(params.threadId)?.activeTurnId
        : null;
    if (!server || !supported.has(message?.method) || !isObject(params) || typeof params.threadId !== 'string' || !turnId) {
      try { server?.respondError(message.id, -32601, `Unsupported interaction: ${typeof message?.method === 'string' ? message.method : 'unknown'}`); } catch {}
      if (isObject(params) && typeof params.threadId === 'string') {
        const state = this.state(params.threadId);
        state.error = 'Codex requested an unsupported interaction';
        state.recoverOnIdle = false;
        this.change(params.threadId, 'error');
      }
      return;
    }
    const state = this.state(params.threadId);
    if (state.released || turnId !== state.activeTurnId) {
      try { server.respondError(message.id, -32600, 'Stale interaction'); } catch {}
      return;
    }
    const requestId = `${this.epoch}:request:${++this.requestSequence}`;
    const pending: PendingRequest = { requestId, nativeId: message.id, method: message.method, params: structuredClone(params), epoch: this.epoch, threadId: params.threadId, turnId, answered: false };
    state.pending.set(requestId, pending);
    this.nativeRequests.set(nativeKey(message.id), pending);
    this.notification(params.threadId, `request:${turnId}:${message.method}:${params.approvalId ?? params.itemId ?? nativeKey(message.id)}`, ['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(message.method) ? 'input' : 'approval');
    this.change(params.threadId, 'request');
  }

  private validateAnswer(pending: PendingRequest, answer: any): any {
    if (!isObject(answer)) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Invalid interaction answer');
    if (pending.method === 'item/commandExecution/requestApproval' || pending.method === 'item/fileChange/requestApproval') {
      if (!exactKeys(answer, ['decision']) || !COMMAND_DECISIONS.has(answer.decision)) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Invalid approval decision');
      return { decision: answer.decision };
    }
    if (pending.method === 'item/permissions/requestApproval') {
      if (!exactKeys(answer, ['permissions', 'scope', 'strictAutoReview']) || !isObject(answer.permissions) || !['turn', 'session'].includes(answer.scope) || (answer.strictAutoReview !== undefined && typeof answer.strictAutoReview !== 'boolean')) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Invalid permission decision');
      if (Object.keys(answer.permissions).length && !isDeepStrictEqual(answer.permissions, pending.params.permissions)) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Permission grant exceeds the requested profile');
      return structuredClone(answer);
    }
    if (pending.method === 'item/tool/requestUserInput') {
      if (!exactKeys(answer, ['answers']) || !isObject(answer.answers)) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Invalid user input answer');
      const questions = Array.isArray(pending.params.questions) ? pending.params.questions : [];
      if (Object.keys(answer.answers).length !== questions.length) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Every question requires an answer');
      for (const question of questions) {
        const entry = answer.answers[question.id];
        if (!isObject(entry) || !exactKeys(entry, ['answers']) || !Array.isArray(entry.answers) || !entry.answers.every((value: unknown) => typeof value === 'string')) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Invalid user input answer');
        const labels = Array.isArray(question.options) ? new Set(question.options.map((option: any) => option.label)) : null;
        if (labels && !question.isOther && !entry.answers.every((value: string) => labels.has(value))) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Answer is outside the allowed options');
      }
      return structuredClone(answer);
    }
    if (!exactKeys(answer, ['action', 'content', '_meta']) || !['accept', 'decline', 'cancel'].includes(answer.action)) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Invalid MCP elicitation answer');
    if (answer._meta !== null) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'MCP client metadata is not accepted from the browser');
    if (answer.action !== 'accept') {
      if (answer.content !== null || answer._meta !== null) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'Declined MCP elicitation must not include content');
      return structuredClone(answer);
    }
    if (pending.params.mode === 'url') {
      if (answer.content !== null) throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'URL elicitation content must be null');
    } else if (!validateMcpValue(pending.params.requestedSchema, answer.content)) {
      throw runtimeError(400, 'RUNTIME_INVALID_ANSWER', 'MCP elicitation content does not match the requested schema');
    }
    return structuredClone(answer);
  }

  private clearPending(pending: PendingRequest, kind: string): void {
    const state = this.states.get(pending.threadId);
    state?.pending.delete(pending.requestId);
    this.nativeRequests.delete(nativeKey(pending.nativeId));
    if (state) this.change(pending.threadId, kind);
  }

  private mergeLiveTurn(state: ThreadState, incoming: any): void {
    const old = state.liveTurns.get(incoming.id);
    if (!old) { state.liveTurns.set(incoming.id, structuredClone(incoming)); return; }
    if (state.completedTurns.has(incoming.id) && incoming.status === 'inProgress') return;
    const items = [...(Array.isArray(old.items) ? old.items : [])];
    for (const item of Array.isArray(incoming.items) ? incoming.items : []) {
      const index = items.findIndex((candidate: any) => candidate.id === item.id);
      if (index < 0) items.push(structuredClone(item));
      else items[index] = structuredClone(item);
    }
    const merged = { ...old, ...structuredClone(incoming), items };
    if (incoming.status === 'inProgress' && old.error && !incoming.error) merged.error = old.error;
    state.liveTurns.set(incoming.id, merged);
  }

  private async readThread(threadId: string, window?: HistoryWindow, signal?: AbortSignal): Promise<any> {
    this.reads++;
    try {
      signal?.throwIfAborted();
      await this.getServer();
      signal?.throwIfAborted();
      const epoch=this.epoch,thread=await this.loadThread(threadId, window, signal);
      signal?.throwIfAborted();
      if(epoch!==this.epoch)throw runtimeError(503,'RUNTIME_SYNC_RESTARTED','会话运行时已切换，请重新读取历史。');
      return thread;
    }
    finally { this.reads--; this.scheduleIdle(); }
  }

  private async loadThread(threadId: string, window?: HistoryWindow, signal?: AbortSignal): Promise<any> {
    const state = this.state(threadId);
    let result: any;
    try { result = await this.call<any>('thread/read', { threadId, includeTurns: false }); }
    catch (error) {
      if (isObject(error) && error.code === 'RUNTIME_THREAD_NOT_LOADED' && state.emptyThreadEpoch && state.emptyThreadEpoch !== this.epoch) {
        throw runtimeError(404, 'RUNTIME_EMPTY_THREAD_NOT_PERSISTED', 'Empty thread was not persisted before the runtime stopped');
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (!isObject(result?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread history is unavailable');
    const thread = structuredClone(result.thread);
    if(this.options.diagnostic&&typeof thread.cwd==='string')state.diagnosticProjectKey=createHash('sha256').update(process.platform==='win32'?thread.cwd.toLowerCase():thread.cwd).digest('hex').slice(0,24);
    const turns = new Map<string, any>();
    for (const value of Array.isArray(thread.turns) ? thread.turns : []) if (isObject(value) && typeof value.id === 'string') this.mergeNativeTurn(turns, value);

    let cursor: string | null = null;
    const seenTurnCursors = new Set<string>();
    for (;;) {
      let page: any;
      // Full turns can exceed the protocol frame limit; load their items in small pages below.
      try { page = await this.call<any>('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'notLoaded' }); }
      catch (error) {
        if (isObject(error) && error.code === 'RUNTIME_HISTORY_UNSUPPORTED' && state.emptyThreadEpoch === this.epoch && turns.size === 0) {
          thread.turns = [];
          return thread;
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn history is unavailable');
      for (const value of page.data) if (isObject(value) && typeof value.id === 'string') this.mergeNativeTurn(turns, value);
      if (page.nextCursor === null) break;
      if (typeof page.nextCursor !== 'string' || seenTurnCursors.has(page.nextCursor)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination is invalid');
      seenTurnCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    const selected = window?.headersOnly ? [] : window ? historyWindow([...turns.values()], window.before).turns : [...turns.values()];
    await this.readTurnBodies(threadId, selected, undefined, Boolean(window?.before), signal);
    thread.turns = [...turns.values()];
    // A turn may finish while history is paginating; confirm the earlier active header.
    if (thread.status?.type === 'active' && !thread.turns.some((turn: any) => turn.status === 'inProgress')) {
      const latest = await this.call<any>('thread/read', { threadId, includeTurns: false });
      if (!isObject(latest?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread status is unavailable');
      thread.status = latest.thread.status;
    }
    return thread;
  }

  private async readTurnBodies(threadId: string, turns: any[], itemId?: string, seek = false, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      for (const turn of turns) {
        if (turn.itemsView === 'full') continue;
        turn.items = await this.readItems(threadId, turn.id, itemId, signal);
        turn.itemsView = 'full';
      }
      return;
    } catch (error) {
      if (!isObject(error) || error.code !== 'RUNTIME_ITEMS_UNSUPPORTED') throw error;
    }
    signal?.throwIfAborted();
    // Older persisted threads expose full turns but do not implement item pagination.
    const pending = new Map(turns.filter(turn => turn.itemsView !== 'full').map(turn => [turn.id, turn]));
    if (itemId || seek) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      while (pending.size) {
        const pageCursor = cursor;
        const page: any = await this.call('thread/turns/list', { threadId, cursor, limit: HISTORY_SIZE, sortDirection: 'desc', itemsView: 'notLoaded' });
        signal?.throwIfAborted();
        if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn history is unavailable');
        const targets: { index: number; id: string; turn: any }[] = [];
        for (let index = 0; index < page.data.length; index++) {
          const id = page.data[index]?.id, turn = pending.get(id);
          if (turn) targets.push({ index, id, turn });
        }
        let bodyCursor = pageCursor, consumed = 0;
        for (const target of targets) {
          const gap = target.index - consumed;
          if (gap) {
            const skipped: any = await this.call('thread/turns/list', { threadId, cursor: bodyCursor, limit: gap, sortDirection: 'desc', itemsView: 'notLoaded' });
            signal?.throwIfAborted();
            if (!Array.isArray(skipped?.data) || skipped.data.length !== gap || typeof skipped.nextCursor !== 'string') throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination changed while loading history');
            bodyCursor = skipped.nextCursor;
          }
          const full: any = await this.call('thread/turns/list', { threadId, cursor: bodyCursor, limit: 1, sortDirection: 'desc', itemsView: 'full' });
          signal?.throwIfAborted();
          if (!Array.isArray(full?.data) || full.data.length !== 1 || full.data[0]?.id !== target.id) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination changed while loading history');
          const value = full.data[0];
          if (value.itemsView !== 'full' || !Array.isArray(value.items)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native full turn history is incomplete');
          target.turn.items = structuredClone(value.items);
          target.turn.itemsView = 'full';
          pending.delete(target.id);
          bodyCursor = full.nextCursor;
          consumed = target.index + 1;
        }
        if (!pending.size) return;
        if (page.nextCursor === null) throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Requested turn history was not found');
        if (typeof page.nextCursor !== 'string' || seen.has(page.nextCursor)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination is invalid');
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return;
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    while (pending.size) {
      const page: any = await this.call('thread/turns/list', { threadId, cursor, limit: 1, sortDirection: 'desc', itemsView: 'full' });
      signal?.throwIfAborted();
      if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native full turn history is unavailable');
      for (const value of page.data) {
        const turn = pending.get(value?.id);
        if (!turn) continue;
        if (value.itemsView !== 'full' || !Array.isArray(value.items)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native full turn history is incomplete');
        turn.items = structuredClone(value.items);
        turn.itemsView = 'full';
        pending.delete(value.id);
      }
      if (!pending.size) return;
      if (page.nextCursor === null) throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Requested turn history was not found');
      if (typeof page.nextCursor !== 'string' || seen.has(page.nextCursor)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination is invalid');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private async readItems(threadId: string, turnId: string, itemId?: string, signal?: AbortSignal): Promise<any[]> {
    const items = new Map<string, any>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page: any = await this.call('thread/items/list', { threadId, turnId, cursor, limit: 10, sortDirection: 'asc' });
      signal?.throwIfAborted();
      if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native item history is unavailable');
      for (const entry of page.data) if (entry?.turnId === turnId && isObject(entry.item) && typeof entry.item.id === 'string') {
        if (itemId && entry.item.id === itemId) return [structuredClone(entry.item)];
        if (!itemId) items.set(entry.item.id, structuredClone(entry.item));
      }
      if (page.nextCursor === null) return [...items.values()];
      if (typeof page.nextCursor !== 'string' || seen.has(page.nextCursor)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native item pagination is invalid');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private mergeNativeTurn(turns: Map<string, any>, incoming: any): void {
    const old = turns.get(incoming.id);
    if (!old) {
      turns.set(incoming.id, structuredClone(incoming));
      return;
    }
    const items = new Map<string, any>();
    for (const item of Array.isArray(old.items) ? old.items : []) if (isObject(item) && typeof item.id === 'string') items.set(item.id, structuredClone(item));
    for (const item of Array.isArray(incoming.items) ? incoming.items : []) if (isObject(item) && typeof item.id === 'string') items.set(item.id, structuredClone(item));
    turns.set(incoming.id, { ...old, ...structuredClone(incoming), items: [...items.values()] });
  }

  private mergeThread(nativeThread: any, state: ThreadState): any {
    const thread = structuredClone(nativeThread);
    thread.turns = Array.isArray(thread.turns) ? thread.turns : [];
    for (const live of state.liveTurns.values()) {
      const index = thread.turns.findIndex((turn: any) => turn.id === live.id);
      if (index < 0) thread.turns.push(structuredClone(live));
      else {
        if (['completed', 'interrupted', 'failed'].includes(thread.turns[index].status)) {
          // Sparse terminal notifications can omit items already streamed. Keep native
          // replacements, while retaining live items absent from that terminal page.
          const items = thread.turns[index].items ??= [];
          if (['completed', 'interrupted', 'failed'].includes(live.status)) for (const item of live.items ?? []) if (!items.some((candidate: any) => candidate.id === item.id)) items.push(structuredClone(item));
          continue;
        }
        const mergedItems = [...(Array.isArray(thread.turns[index].items) ? thread.turns[index].items : [])];
        for (const item of Array.isArray(live.items) ? live.items : []) {
          const itemIndex = mergedItems.findIndex((candidate: any) => candidate.id === item.id);
          if (itemIndex < 0) mergedItems.push(structuredClone(item));
          else mergedItems[itemIndex] = structuredClone(item);
        }
        thread.turns[index] = { ...thread.turns[index], ...structuredClone(live), items: mergedItems };
      }
    }
    return thread;
  }

  private phase(state: ThreadState): string {
    if (state.pending.size) return [...state.pending.values()].some(({ method }) => method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') ? 'WAITING_INPUT' : 'WAITING_APPROVAL';
    if (state.reserved || state.activeTurnId) return 'RUNNING';
    if (state.externalWriter || state.nativeStatus?.type === 'active') return 'EXTERNAL';
    if (state.error || state.nativeStatus?.type === 'systemError') return 'UNKNOWN';
    if (state.released) return 'RELEASED';
    return 'IDLE';
  }

  private notification(threadId: string, eventKey: string, kind: 'complete' | 'failed' | 'approval' | 'input'): void {
    const key = `${threadId}:${eventKey}`;
    if (this.notificationKeys.has(key)) return;
    this.notificationKeys.add(key);
    if (this.notificationKeys.size > REQUEST_LIMIT) this.notificationKeys.delete(this.notificationKeys.values().next().value!);
    this.emit('notification', { threadId, eventKey, kind });
  }

  private change(threadId: string, kind: string, patch: Patch = {}): void {
    const state = this.state(threadId);
    state.revision++;
    const sequence = ++this.sequence;
    if (state.syncHeader && patch.thread) Object.assign(state.syncHeader, structuredClone(patch.thread));
    if (state.syncTurns && patch.turn?.status) state.syncTurns.set(patch.turn.id, this.turnSignature(patch.turn));
    if (state.syncHeader && state.syncTurns && (patch.thread || patch.turn?.status)) this.cacheSync(threadId, state);
    const metadata = { phase: this.phase(state), activeTurnId: state.activeTurnId, pending: [...state.pending.values()].map(({requestId, method, params}) => ({requestId, method, params})), error: state.error ?? null, permissions: state.permissions ?? null, retry: state.retry ?? null, release: this.releaseState(state), model: state.model ?? null, ...(state.reasoningEffort !== undefined ? {reasoningEffort:state.reasoningEffort} : {}), unmaterialized: state.emptyThreadEpoch === this.epoch };
    let change: Change = structuredClone({ id: `${this.epoch}:${sequence}`, threadId, kind, revision: state.revision, patch: { state: metadata, ...patch } });
    this.emit('snapshotChange', change);
    // Keep authoritative snapshot merges complete; only the browser journal is projected.
    change = { ...change, patch: { ...change.patch,
      ...(change.patch.turn ? { turn: browserTurn(change.patch.turn) } : {}),
      ...(change.patch.item ? { item: { ...change.patch.item, item: browserItem(change.patch.item.item, change.patch.item.completed) } } : {}),
    } };
    let bytes = Buffer.byteLength(JSON.stringify(change));
    if (bytes > EVENT_BYTES) { change = { ...change, kind: 'resync', patch: {} }; bytes = Buffer.byteLength(JSON.stringify(change)); }
    this.events.push({ change, bytes, sequence });
    this.eventBytes += bytes;
    while (this.eventBytes > EVENT_BYTES && this.events.length) this.eventBytes -= this.events.shift()!.bytes;
    this.emit('change', change);
  }

  private scheduleIdle(): void {
    if (!this.releaseQueued && !this.closed && [...this.states.values()].some(state => state.releaseRequested && !state.handoffReady && !state.releaseError && !state.releasePromise && !state.reserved && !state.activeTurnId && !state.pending.size)) {
      this.releaseQueued = true;
      setImmediate(async () => {
        try {
          for (const [id, state] of this.states) if (state.releaseRequested && !state.handoffReady && !state.releaseError && !state.releasePromise && !state.reserved && !state.activeTurnId && !state.pending.size) {
            try { await this.release(id, true); } catch {}
          }
        } finally { this.releaseQueued = false; }
      });
    }
    if (this.closed || !this.server || this.inFlight || this.reads || [...this.states.values()].some((state) => state.reserved || state.activeTurnId || state.pending.size || state.recoverOnIdle)) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const server = this.server;
    this.idleTimer = setTimeout(() => {
      if (this.server !== server) return;
      this.closeIdleServer().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async closeIdleServer(): Promise<boolean> {
    if (this.stopping) { await this.stopping; return true; }
    const busy = () => [...this.states.values()].some(state => state.reserved || state.activeTurnId || state.pending.size || state.recoverOnIdle || ['active', 'systemError'].includes(state.nativeStatus?.type));
    const deadline = Date.now() + 2000;
    while ((this.inFlight || this.reads) && !busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const server = this.server;
    if (!server || this.inFlight || this.reads || busy()) return false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.server = undefined;
    this.stopping = server.close();
    try {
      await this.stopping;
      for (const [id, state] of this.states) {
        state.loaded = false;
        this.clearLiveState(state);
        if (state.released) { state.handoffReady = true; this.change(id, 'release'); }
      }
    } finally { this.stopping = undefined; }
    return true;
  }

  private clearLiveState(state: ThreadState): void {
    state.retry = undefined;
    state.nativeStatus = undefined;
    state.liveTurns.clear();
    state.completedItems.clear();
    state.completedTurns.clear();
    state.waiter = undefined;
    state.completion = undefined;
  }

  private mapError(error: unknown, method?: string, params?: unknown): Error & { statusCode: number; code: string } {
    if (isObject(error) && typeof error.statusCode === 'number' && typeof error.code === 'string' && error.code.startsWith('RUNTIME_')) return error as any;
    if (isObject(error) && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) && typeof error.syscall === 'string' && error.syscall.startsWith('spawn')) {
      return runtimeError(503, 'RUNTIME_UNAVAILABLE', `无法启动 Codex：${this.options.executable}。请检查文件、执行权限以及 CODEX_BIN 或 codexBin 配置。`);
    }
    const message = error instanceof Error ? error.message : '';
    if (method === 'thread/read' && /^failed to read thread: thread-store internal error: failed to read session metadata .+: rollout at .+ is empty$/.test(message)) {
      return runtimeError(503, 'RUNTIME_HISTORY_NOT_READY', '会话历史暂不可读，原生记录仍为空，请稍后重试');
    }
    if (method === 'thread/items/list' && message === 'thread/items/list is not supported yet') return runtimeError(503, 'RUNTIME_ITEMS_UNSUPPORTED', 'Native item pagination is not supported');
    if (method === 'turn/steer' && /no active turn|expected.*turn|turn.*mismatch/i.test(message)) return runtimeError(409, 'RUNTIME_STEER_CONFLICT', '当前轮次已结束或变化，请刷新后重新发送');
    if (method === 'thread/turns/list' && message.trim().toLowerCase() === 'list_turns is not supported yet') return runtimeError(503, 'RUNTIME_HISTORY_UNSUPPORTED', 'Native turn history is not supported');
    if (method === 'thread/turns/list' && isObject(params) && typeof params.threadId === 'string'
      && message === `thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) {
      return runtimeError(503, 'RUNTIME_HISTORY_UNSUPPORTED', 'Native turn history is not available before the first user message');
    }
    if (method === 'thread/read' && /^thread not loaded(?::|$)/i.test(message.trim())) return runtimeError(404, 'RUNTIME_THREAD_NOT_LOADED', 'Thread is not loaded in the native runtime');
    if (method?.startsWith('thread/') && /(?:record|thread) not found/i.test(message)) return runtimeError(404, 'RUNTIME_NOT_FOUND', 'Thread was not found');
    if (/timed out|uncertain/i.test(message)) return runtimeError(504, 'RUNTIME_RESULT_UNKNOWN', 'Codex did not confirm the operation; its result is unknown');
    if (/active writer|already.*active|in use/i.test(message)) return runtimeError(409, 'RUNTIME_THREAD_CONFLICT', 'Thread is active in another client; release it there before continuing');
    return runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native Codex runtime is unavailable');
  }

  private requireString(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string' || !value) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', `${name} must be a non-empty string`);
  }

  private requireRequestId(value: unknown): asserts value is string {
    this.requireString(value, 'clientRequestId');
    if (value.length > 200) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'clientRequestId is too long');
  }
}
