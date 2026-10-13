import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import {setTimeout as wait} from 'node:timers/promises';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import { permissionChoices, threadPermissionOptions, type PermissionMode, type PermissionPolicy } from './permissions.ts';
import { AppServer } from './app-server.ts';
import {retainWriterLease,type WriterLease} from './writer-lease.ts';
import {generateNativeTitle,nativeTitleCleanupPending,settleNativeTitleCleanup} from './nativeTitle.ts';
import {baseUserLayer,readSettings,writeSettings,type SettingsWriteInput} from './settings.ts';
import {readInstalledPlugins,type InstalledPluginsSnapshot} from './installed-plugins.ts';
import { itemWithTimes } from './itemTimes.ts';
import {diagnosticId,type DiagnosticEvent} from '../server/diagnostics.ts';

export type NativeInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string };
export type TurnOptions = { model?: string; effort?: string; permissionMode?: PermissionMode; nativeInput?: NativeInput[] };
export type NativeProjectContext={home:string;epoch:string};
const directoryKey=(path:string)=>process.platform==='win32'?resolve(path.replaceAll('/','\\').replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'')).toLowerCase():resolve(path);
export type NativeProject={id:string;name:string;roots:Array<{path:string}>};
type Id = string | number;
type Options = {
  executable: string;
  cwd: string;
  idleMs?: number;
  sandbox?: 'read-only' | 'danger-full-access';
  args?: string[];
  diagnostic?:(event:DiagnosticEvent)=>void;
  writerLease?:(home:string,threadId:string)=>Promise<WriterLease>;
};
type Patch = { state?: any; thread?: any; turn?: any; item?: { turnId: string; item: any; completed?: boolean }; delta?: { turnId: string; itemId: string; field: 'text' | 'aggregatedOutput' | 'summary' | 'content'; index?: number; offset: number; text: string } };
type Change = { id: string; threadId: string; kind: string; revision: number; patch: Patch };
type Waiter = { promise: Promise<'started' | 'completed' | 'failed'>; resolve: (value: 'started' | 'completed' | 'failed') => void };
type PendingRequest = { requestId: string; nativeId: Id; method: string; params: Record<string, any>; epoch: string; threadId: string; turnId: string; answered: boolean };
type ThreadState = {
  titleGeneration?: {controller:AbortController;promise:Promise<void>};
  nameWrite?: Promise<any>;
  nameRevision?: number;
  nativeName?: string | null;
  subagent?: boolean;
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
  writerLease?:WriterLease;
  writerLeaseServer?:AppServer;
  nativeUnloaded?:boolean;
  unloadReceipt?:ReturnType<typeof Promise.withResolvers<void>>;
  handoffCheck?:Promise<boolean>;
  completedTurns: Set<string>;
  completedItems: Set<string>;
  completion?: { promise: Promise<void>; resolve: () => void };
  emptyThreadEpoch?: string;
  initialHistory?: {epoch:string;turnId:string;deadline?:number};
  historyRead?: {epoch:string;deadline:number;controller:AbortController;users:Set<symbol>;promise:Promise<any>};
  // History/status reconciliation cannot validate effective cwd and permission grants.
  contextUnknown?: boolean;
  pendingCwdIdentity?: {cwd:string;projectId:string};
  error?: string;
  liveTurns: Map<string, any>;
  loaded: boolean;
  maintenanceOnly?:boolean;
  identityRevision?:number;
  nativeStatus?: any;
  pending: Map<string, PendingRequest>;
  permissions?: any;
  selectedPermissionMode?: PermissionMode;
  recoverOnIdle?: boolean;
  released: boolean;
  reserved: boolean;
  revision: number;
  activityRevision: number;
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
const UNRECONCILED_ACTIVITY = 'Native thread activity could not be reconciled';
const SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'exec'];
const COMMAND_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const hasOwn = (value: object, key: string) => Object.hasOwn(value, key);
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
// A human fork has forkedFromId; only native subagent lineage/source hides a thread.
const isSubagentThread = (thread: any): boolean => Boolean(thread?.parentThreadId || (isObject(thread?.source) && (hasOwn(thread.source,'subAgent') || hasOwn(thread.source,'subagent'))));
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
  private updating=false;
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
  private forkHeaders=new Map<string,{thread:any;expiresAt:number}>();
  private listReads=new Map<string,{epoch:string;promise:Promise<any>}>();
  private headerReads=new Map<string,{epoch:string;promise:Promise<any>}>();
  private notificationKeys = new Set<string>();
  private temporaryThreads = new Set<string>();

  constructor(options: Options) {
    super();
    this.options = { ...options };
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.sandbox = options.sandbox ?? 'danger-full-access';
    if (!options.executable || !options.cwd || !Number.isSafeInteger(this.idleMs) || this.idleMs < 1) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Invalid runtime options');
  }

  async list(cursor?: string, archived = false, sortKey:'updated_at'|'created_at'='updated_at', searchTerm?:string, projectId?:null): Promise<{ data: any[]; nextCursor: string | null }> {
    if(!['updated_at','created_at'].includes(sortKey))throw runtimeError(400,'RUNTIME_INVALID_INPUT','Invalid session sort');
    const key=JSON.stringify([cursor??null,archived,sortKey,searchTerm||null,projectId===null]);
    let pending=this.listReads.get(key);
    if(pending?.epoch!==this.epoch){
      const promise=this.call<any>('thread/list', { cursor: cursor ?? null, sourceKinds: SOURCE_KINDS, useStateDbOnly: true, sortKey:sortKey==='updated_at'?'recency_at':sortKey, sortDirection:'desc', ...(archived?{archived:true}:{}), ...(searchTerm?{searchTerm}:{}), ...(projectId===null?{projectId:null,limit:100}:{}) }).finally(()=>{if(this.listReads.get(key)?.promise===promise)this.listReads.delete(key);});
      pending={epoch:this.epoch,promise};this.listReads.set(key,pending);
    }
    const result = await pending.promise;
    return { data: Array.isArray(result?.data) ? result.data.filter((thread:any)=>!thread.ephemeral&&!this.temporaryThreads.has(thread.id)&&!isSubagentThread(thread)).map((thread: any) => ({ ...thread, ...(this.states.has(thread.id) ? { release: this.releaseState(this.states.get(thread.id)!) } : {}) })) : [], nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null };
  }

  async projectContext():Promise<NativeProjectContext>{
    const home=await this.configurationHome();
    if(!home)throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native project home is unavailable');
    return {home,epoch:this.epoch};
  }
  assertProjectContext(context:NativeProjectContext){
    const home=this.initializeInfo?.codexHome;
    if(this.closed||!this.server||this.stopping||this.epoch!==context.epoch||typeof home!=='string'||directoryKey(home)!==directoryKey(context.home))throw runtimeError(503,'RUNTIME_SYNC_RESTARTED','Native project process changed during synchronization');
  }
  async listProjects(context?:NativeProjectContext):Promise<NativeProject[]>{
    const bound=context??await this.projectContext();this.assertProjectContext(bound);
    const data:NativeProject[]=[],ids=new Set<string>(),cursors=new Set<string>(),deadline=Date.now()+30_000;
    let cursor:string|null=null;
    for(let page=0;page<100;page++){
      if(Date.now()>=deadline)throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native project pagination exceeded its deadline');
      this.assertProjectContext(bound);
      const result=await this.call<any>('project/list',{cursor,limit:100},false,false,Math.max(1,deadline-Date.now()),bound);
      this.assertProjectContext(bound);
      if(!Array.isArray(result?.data))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native project catalog is unavailable');
      for(const project of result.data){this.requireProject(project);if(ids.has(project.id))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Duplicate native project identity');ids.add(project.id);data.push(project);}
      cursor=result.nextCursor??null;
      if(cursor===null)return data;
      if(typeof cursor!=='string'||!cursor||cursor.length>4096||cursors.has(cursor))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Invalid native project pagination');
      cursors.add(cursor);
    }
    throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native project pagination exceeded its page limit');
  }
  private requireProject(project:any):asserts project is NativeProject{
    if(!isObject(project)||typeof project.id!=='string'||!project.id||typeof project.name!=='string'||!Array.isArray(project.roots)||!project.roots.every((root:any)=>isObject(root)&&typeof root.path==='string'&&isAbsolute(root.path)))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Invalid native project response');
  }
  async createProject(input:{idempotencyKey:string;name:string;roots:Array<{path:string}>},context?:NativeProjectContext):Promise<NativeProject>{
    const bound=context??await this.projectContext();this.assertProjectContext(bound);
    const result=await this.mutation<any>('project/create',input,bound);this.assertProjectContext(bound);this.requireProject(result?.project);return result.project;
  }
  async setThreadProject(threadId:string,projectId:string,expected:{cwd:string;context:NativeProjectContext;assertCurrent?:()=>void}){
    this.requireString(projectId,'projectId');this.assertProjectContext(expected.context);
    if(!this.states.has(threadId))this.state(threadId).maintenanceOnly=true;
    return this.updateThreadIdentity(threadId,async before=>{
      this.assertProjectContext(expected.context);
      expected.assertCurrent?.();
      if(typeof before.cwd!=='string'||directoryKey(before.cwd)!==directoryKey(expected.cwd)||(before.projectId!==null&&before.projectId!==projectId))throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread project or working directory changed before synchronization');
      const state=this.state(threadId),activity=state.activityRevision,identity=state.identityRevision;
      const guard=()=>{expected.assertCurrent?.();if(state.releasePromise||state.activeTurnId||state.pending.size||state.contextUnknown||state.error||state.externalWriter||['active','systemError'].includes(state.nativeStatus?.type)||state.activityRevision!==activity||state.identityRevision!==identity)throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread identity or activity changed before synchronization');};
      if(before.projectId!==projectId)await this.mutation('thread/metadata/update',{threadId,projectId},expected.context,guard);
      this.assertProjectContext(expected.context);
      const thread=await this.threadHeaderRead(threadId);
      this.assertProjectContext(expected.context);
      if(thread.projectId!==projectId||thread.cwd!==before.cwd)throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native project assignment could not be verified');
      this.invalidateForkHeader(threadId);this.change(threadId,'thread',{thread:this.threadHeader(thread)});
      return {threadId,nativeProjectId:thread.projectId,cwd:thread.cwd};
    });
  }
  async setThreadCwd(threadId:string,cwd:string,projectId:string){
    this.requireString(threadId,'threadId');
    this.state(threadId).maintenanceOnly=false;
    this.requireString(cwd,'cwd');
    return this.updateThreadIdentity(threadId,async before=>{
      if(before.projectId!==projectId)throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Native project changed; refresh before switching directories');
      const state=this.state(threadId);
      // A successful native write can still lose its verification response. Never reuse old grants.
      state.contextUnknown=true;state.loaded=false;state.permissions=undefined;
      state.error='Native working directory and permissions require reconciliation';state.recoverOnIdle=false;
      await this.mutation('thread/settings/update',{threadId,cwd});
      const thread=await this.threadHeaderRead(threadId);
      if(thread.cwd!==cwd||thread.projectId!==projectId)throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native working directory change could not be verified');
      state.cwd=cwd;state.pendingCwdIdentity={cwd,projectId};state.error=undefined;this.invalidateForkHeader(threadId);this.change(threadId,'thread',{thread:this.threadHeader(thread)});
      return {cwd,nativeProjectId:thread.projectId};
    });
  }
  private async updateThreadIdentity<T>(threadId:string,operation:(before:any)=>Promise<T>):Promise<T>{
    this.requireString(threadId,'threadId');const state=this.state(threadId);
    if(state.releasePromise||state.reserved||state.activeTurnId||state.pending.size||state.contextUnknown||state.error||state.externalWriter||['active','systemError'].includes(state.nativeStatus?.type))throw runtimeError(409,'RUNTIME_THREAD_BUSY','Thread already has active or unresolved work');
    state.reserved=true;
    try{
      const revision=state.activityRevision,identity=state.identityRevision;
      this.headerReads.delete(threadId);const before=await this.threadHeaderRead(threadId);
      if(!['idle','notLoaded'].includes(before.status?.type)||state.releasePromise||state.activeTurnId||state.pending.size||state.contextUnknown||state.error||state.externalWriter||['active','systemError'].includes(state.nativeStatus?.type)||state.activityRevision!==revision||state.identityRevision!==identity)throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread is active or changed in another client');
      try{return await operation(before);}
      catch(error){this.invalidateForkHeader(threadId);this.change(threadId,'resync');throw error;}
    }finally{state.reserved=false;this.scheduleIdle();}
  }

  open(threadId:string):Promise<any>{
    this.requireString(threadId,'threadId');const state=this.state(threadId);
    state.maintenanceOnly=false;
    if(state.subagent)return Promise.reject(runtimeError(404,'RUNTIME_SUBAGENT_THREAD','子 Agent 会话不单独展示，请返回主会话。'));
    if(state.openPromise)return state.openPromise;
    if(state.reserved||state.activeTurnId||state.pending.size||(state.loaded&&!state.contextUnknown&&!state.released&&!state.error&&!state.externalWriter&&state.nativeStatus?.type==='idle'))return Promise.resolve({phase:this.phase(state),epoch:this.epoch});
    state.reserved=true;
    const operation=async()=>{
      try {
        const owned=state.loaded&&!state.contextUnknown&&!state.released&&!state.externalWriter;
        const activityRevision=state.activityRevision;
        const read=owned?{thread:await this.readThread(threadId,{headersOnly:true})}:await this.call<any>('thread/read',{threadId,includeTurns:false});
        if(!isObject(read?.thread))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread status is unavailable');
        this.requireUserThread(read.thread);
        if(state.pendingCwdIdentity&&(typeof read.thread.cwd!=='string'||directoryKey(read.thread.cwd)!==directoryKey(state.pendingCwdIdentity.cwd)||read.thread.projectId!==state.pendingCwdIdentity.projectId))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native working directory identity changed before resume');
        state.cwd=read.thread.cwd;state.model=read.thread.model;
        if(owned){
          this.reconcile(threadId,read.thread,activityRevision);
          if(state.activeTurnId||state.pending.size)return {phase:this.phase(state),epoch:this.epoch};
          if(!this.canUnload(state,read.thread))throw runtimeError(409,'RUNTIME_THREAD_BUSY',UNRECONCILED_ACTIVITY);
          if(read.thread.status?.type!=='notLoaded'){
            state.error=undefined;state.recoverOnIdle=false;
            return {phase:'IDLE',epoch:this.epoch};
          }
        }
        if(read.thread.status?.type==='active')throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread is active in another client');
        const policy=await this.resolvePermissions(state.selectedPermissionMode,state.cwd!);
        await this.discardWriterLease(state);
        const resumed=await this.mutation<any>('thread/resume',{threadId,excludeTurns:true,...(policy?threadPermissionOptions(policy):{})});
        if(!isObject(resumed?.thread))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread resume was not confirmed');
        if(state.contextUnknown&&(typeof resumed.thread.cwd!=='string'||typeof resumed.cwd!=='string'||directoryKey(resumed.thread.cwd)!==directoryKey(state.cwd!)||directoryKey(resumed.cwd)!==directoryKey(state.cwd!)||resumed.thread.projectId!==read.thread.projectId))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native working directory reconciliation was not confirmed');
        if(resumed.thread.status?.type==='active')throw runtimeError(409,'RUNTIME_THREAD_CONFLICT','Thread is active in another client');
        state.loaded=true;state.released=false;state.handoffReady=false;state.externalWriter=false;
        state.nativeStatus=resumed.thread.status;state.model=resumed.model;state.reasoningEffort=resumed.reasoningEffort;
        state.permissions=this.verifyPermissions(resumed,policy,state.cwd!);
        state.contextUnknown=false;state.pendingCwdIdentity=undefined;state.error=undefined;state.recoverOnIdle=false;
      } catch(error){
        const mapped=this.mapError(error);state.externalWriter=mapped.code==='RUNTIME_THREAD_CONFLICT';
        state.error=state.externalWriter?undefined:mapped.message;state.recoverOnIdle=false;
        if(!state.externalWriter)throw mapped;
      } finally {
        state.reserved=false;state.openPromise=undefined;this.change(threadId,'status');
        if(state.releaseRequested&&state.loaded)void this.requestRelease(threadId).catch(()=>{});
        this.scheduleIdle();
      }
      return {phase:this.phase(state),epoch:this.epoch};
    };
    state.openPromise=Promise.resolve().then(operation);return state.openPromise;
  }

  async threadCwd(threadId: string): Promise<string | null> {
    const thread=await this.threadHeaderRead(threadId);
    return typeof thread.cwd === 'string' ? thread.cwd : null;
  }

  async threadHeaderRead(threadId:string,timeoutMs?:number):Promise<any>{
    this.requireString(threadId, 'threadId');
    let result:any;
    if(timeoutMs!==undefined)result=await this.call<any>('thread/read', { threadId, includeTurns: false },false,false,timeoutMs);
    else{
      let pending=this.headerReads.get(threadId);
      if(pending?.epoch!==this.epoch){
        const promise=this.call<any>('thread/read', { threadId, includeTurns: false }).finally(()=>{if(this.headerReads.get(threadId)?.promise===promise)this.headerReads.delete(threadId);});
        pending={epoch:this.epoch,promise};this.headerReads.set(threadId,pending);
      }
      result=await pending.promise;
    }
    if (!isObject(result?.thread)||result.thread.id!==threadId) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread information is unavailable');
    this.requireUserThread(result.thread);
    const {turns,...thread}=result.thread;return thread;
  }

  invalidateForkHeader(threadId:string){this.forkHeaders.delete(threadId);}
  async forkListHeader(threadId:string,timeoutMs?:number):Promise<{thread:any;archived:boolean}|null>{
    const cached=this.forkHeaders.get(threadId);
    const thread=cached&&cached.expiresAt>Date.now()?cached.thread:await this.threadHeaderRead(threadId,timeoutMs),home=this.initializeInfo?.codexHome;
    this.requireUserThread(thread);
    if(typeof thread.forkedFromId!=='string'||!thread.forkedFromId||thread.preview!==''||!SOURCE_KINDS.includes(thread.source)||typeof home!=='string'||!isAbsolute(home)||typeof thread.path!=='string'||!isAbsolute(thread.path))return null;
    if(thread!==cached?.thread){this.forkHeaders.set(threadId,{thread,expiresAt:Date.now()+30_000});while(this.forkHeaders.size>32)this.forkHeaders.delete(this.forkHeaders.keys().next().value!);}
    const inside=(root:string,path:string)=>{const child=relative(root,path);return !!child&&!isAbsolute(child)&&child!=='..'&&!child.startsWith('..'+sep);};
    for(const archived of [false,true]){
      const root=resolve(home,archived?'archived_sessions':'sessions');
      if(!inside(root,resolve(thread.path)))continue;
      try{const [canonicalRoot,path]=await Promise.all([realpath(root),realpath(thread.path)]);if(inside(canonicalRoot,path)&&(await stat(path)).isFile())return {thread:{...thread,...(this.states.has(threadId)?{release:this.releaseState(this.states.get(threadId)!)}:{})},archived};}catch{}
    }
    return null;
  }

  async snapshot(threadId: string, options?: { window: boolean; signal?: AbortSignal; restartHistory?:boolean }): Promise<any> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    state.maintenanceOnly=false;
    const revision = state.revision;
    const activityRevision = state.activityRevision;
    const snapshotSequence = ++state.snapshotSequence;
    // Keep content that arrives while native history pages are in flight, including
    // terminal turns that reconcile removes from liveTurns. Offsets handle overlap.
    const changes: Change[] = [];
    const changed = (event: Change) => { if (event.threadId === threadId) changes.push(event); };
    this.on('snapshotChange', changed);
    let thread: any;
    try { thread = await this.readThread(threadId, options?.window ? {} : undefined, options?.signal,options?.restartHistory); } finally { this.off('snapshotChange', changed); }
    const mergedThread = this.mergeThread(thread, state);
    for (const event of changes) this.mergeSnapshotPatch(mergedThread, event.patch);
    // A read started before a newer operation/notification must not unlock that work.
    if (state.snapshotSequence === snapshotSequence && !state.reserved && (state.revision === revision || (state.activeTurnId && thread.turns.some((turn: any) => turn.id === state.activeTurnId && ['completed', 'interrupted', 'failed'].includes(turn.status))))) {
      const previousPhase = this.phase(state), previousError = state.error;
      this.reconcile(threadId, thread, activityRevision);
      const recovered = thread.turns.find((turn:any)=>turn.id===state.activeTurnId&&turn.status==='inProgress');
      if(recovered){
        const index=mergedThread.turns.findIndex((turn:any)=>turn.id===recovered.id&&turn.status!=='inProgress');
        if(index>=0)mergedThread.turns[index]=structuredClone(recovered);
      }
      if (thread.status?.type === 'notLoaded') state.loaded = false;
      if (!state.contextUnknown && state.error && state.recoverOnIdle && ['idle', 'notLoaded'].includes(thread.status?.type)
        && !state.activeTurnId && !state.pending.size && !thread.turns.some((turn: any) => turn.status === 'inProgress')) {
        state.error = undefined;
        state.recoverOnIdle = false;
      }
      if (this.phase(state) !== previousPhase || state.error !== previousError) this.change(threadId, 'status');
      this.scheduleIdle();
    }
    for (const turn of mergedThread.turns) if (turn.status === 'inProgress' && !state.liveTurns.has(turn.id) && !state.completedTurns.has(turn.id)) state.liveTurns.set(turn.id, structuredClone(turn));
    if (state.snapshotSequence === snapshotSequence) this.rememberSync(state, mergedThread);
    if(state.initialHistory?.epoch===this.epoch&&thread.turns.some((turn:any)=>turn.id===state.initialHistory!.turnId))state.initialHistory=undefined;
    return this.browserSnapshot(mergedThread,state,!!options?.window);
  }

  private browserSnapshot(mergedThread:any,state:ThreadState,windowed:boolean):any {
    const window = windowed ? historyWindow(mergedThread.turns) : null;
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
      titlePending: !!state.titleGeneration, unmaterialized: state.emptyThreadEpoch === this.epoch,
      historyPending: state.initialHistory?.epoch === this.epoch,
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

  async question(threadId:string,turnId:string,itemId:string):Promise<any>{
    const live=this.states.get(threadId)?.liveTurns.get(turnId)?.items?.find((item:any)=>item.id===itemId);
    const item=live??await this.readItem(threadId,turnId,itemId);
    if(item.type!=='agentMessage'||item.delivery!=='async'||!Array.isArray(item.questions)||!item.questions.length||item.questions.some((q:any)=>typeof q.title!=='string'))throw runtimeError(409,'RUNTIME_STALE_REQUEST','没有可回答的原生提问');
    return structuredClone(item);
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
      try { await this.readTurnBodies(threadId, [turn], itemId); }
      catch (error) {
        if (!isObject(error) || error.code !== 'RUNTIME_HISTORY_UNSUPPORTED') throw error;
        const full = await this.fullThread(threadId);
        const nativeTurn = full.turns.find((entry: any) => entry?.id === turnId);
        if (nativeTurn && Array.isArray(nativeTurn.items)) turn.items = nativeTurn.items;
      }
      if (epoch !== this.epoch) throw runtimeError(503, 'RUNTIME_SYNC_RESTARTED', 'Native runtime changed during item loading; retry');
      const item = turn.items.find(item => item.id === itemId);
      if (!item) throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Item was not found');
      return item;
    } finally { this.reads--; this.scheduleIdle(); }
  }

  async status(threadId: string, epoch?: string): Promise<{ resync: boolean; epoch: string; revision: number }> {
    this.requireString(threadId, 'threadId');
    const state = this.state(threadId);
    await this.getServer();
    const reply=(resync:boolean)=>({resync,epoch:this.epoch,revision:state.revision});
    if (!state.syncHeader || !state.syncTurns || state.syncEpoch !== this.epoch || (epoch && epoch !== this.epoch)) return reply(true);
    const revision = state.revision;
    const result = await this.call<any>('thread/read', { threadId, includeTurns: false });
    if (!isObject(result?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread status is unavailable');
    if (!state.syncHeader || !state.syncTurns) return reply(true);
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
        if (isObject(error) && ['RUNTIME_HISTORY_UNSUPPORTED','RUNTIME_HISTORY_NOT_MATERIALIZED'].includes(error.code) && state.emptyThreadEpoch === this.epoch && state.syncTurns?.size === 0 && turns.size === 0) break;
        if (isObject(error) && error.code === 'RUNTIME_HISTORY_UNSUPPORTED') {
          const full = await this.fullThread(threadId);
          for (const turn of full.turns) if (typeof turn?.id === 'string') turns.set(turn.id, this.turnSignature(turn));
          break;
        }
        throw error;
      }
      if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn history is unavailable');
      for (const turn of page.data) if (typeof turn?.id === 'string') turns.set(turn.id, this.turnSignature(turn));
      cursor = page.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor))) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination is invalid');
      if (cursor) seen.add(cursor);
    } while (cursor);
    // A notification during the probe may be newer than its native response.
    if (state.syncEpoch !== this.epoch || (epoch && epoch !== this.epoch)) return reply(true);
    if (state.revision !== revision) return reply(false);
    resync ||= !isDeepStrictEqual(turns, state.syncTurns);
    return reply(resync);
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
      else turn.items[index] = itemWithTimes(patch.item.item, {}, turn.items[index]);
    }
  }

  create(input: { cwd: string; clientRequestId: string; prompt?: string; nativeProjectId?:string|null } & TurnOptions): Promise<any> {
    this.requireString(input?.cwd, 'cwd');
    this.requireRequestId(input?.clientRequestId);
    if (input.prompt !== undefined && typeof input.prompt !== 'string') throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'prompt must be a string');
    if (input.model !== undefined && typeof input.model !== 'string') throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'model must be a string');
    if(input.nativeProjectId!==undefined&&input.nativeProjectId!==null)this.requireString(input.nativeProjectId,'nativeProjectId');
    return this.idempotent(input.clientRequestId, JSON.stringify(['create', input.cwd, input.prompt ?? null, input.model ?? null, input.effort ?? null, input.permissionMode ?? null, input.nativeInput ?? null,input.nativeProjectId??null]), async () => {
      if (input.model) await this.validateTurnOptions(input, input.cwd);
      const policy = await this.resolvePermissions(input.permissionMode, input.cwd);
      const result = await this.mutation<any>('thread/start', { cwd: input.cwd, ...(input.nativeProjectId?{projectId:input.nativeProjectId}:{}), ...(input.model ? { model: input.model } : {}), ...(policy ? threadPermissionOptions(policy) : {}) });
      const threadId = result?.thread?.id;
      if (typeof threadId !== 'string') throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread creation returned an invalid result');
      const state = this.state(threadId);
      state.loaded = true;
      state.released = false;
      state.emptyThreadEpoch = input.prompt ? undefined : this.epoch;
      try {
        if(input.nativeProjectId&&result.thread.projectId!==input.nativeProjectId)throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread project identity was not confirmed; no task was sent');
        if(typeof result.thread.cwd!=='string'||typeof result.cwd!=='string'||directoryKey(result.thread.cwd)!==directoryKey(input.cwd)||directoryKey(result.cwd)!==directoryKey(input.cwd)){state.contextUnknown=true;state.error='Native working directory was not confirmed';throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread working directory was not confirmed; no task was sent');}
        state.permissions = this.verifyPermissions(result, policy, input.cwd);
        state.selectedPermissionMode = input.permissionMode;
        state.cwd = input.cwd;
        state.model = result.model;
        state.reasoningEffort = result.reasoningEffort;
        state.nativeName = result.thread.name;
        this.change(threadId, 'thread', { thread: this.threadHeader(result.thread) });
        await this.validateTurnOptions(input, input.cwd, state.model);
        if (!input.prompt && !input.nativeInput?.length) return { threadId, status: 'idle' };
        const accepted=await this.startTurn(threadId, input.prompt ?? '', input, state, state.permissions);
        state.initialHistory={epoch:this.epoch,turnId:accepted.turnId};
        if(input.prompt?.trim()&&!state.nativeName&&!state.nameRevision)this.startTitleGeneration(threadId,input.prompt,result.modelProvider,result.thread.source,state);
        const initialThread=this.mergeThread({...result.thread,turns:result.thread.turns??[]},state);
        this.rememberSync(state,initialThread);
        return {...accepted,initialSnapshot:this.browserSnapshot(initialThread,state,true)};
      } catch (error) {
        throw Object.assign(this.mapError(error), { partial: { threadId } });
      }
    });
  }

  fork(threadId: string, input: { lastTurnId: string; clientRequestId: string }): Promise<{ threadId: string; status: 'idle'; cwd: string;header:any }> {
    this.requireString(threadId, 'threadId');
    this.requireString(input?.lastTurnId, 'lastTurnId');
    this.requireRequestId(input?.clientRequestId);
    if (!isObject(input) || !exactKeys(input, ['lastTurnId', 'clientRequestId'])) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', 'Invalid fork input');
    return this.idempotent(input.clientRequestId, JSON.stringify(['fork', threadId, input.lastTurnId]), async () => {
      const source = await this.readThread(threadId, { headersOnly: true });
      if (source.id !== threadId) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native source thread could not be verified');
      const end = source.turns.findIndex((turn: any) => turn.id === input.lastTurnId);
      if (end < 0) throw runtimeError(404, 'RUNTIME_NOT_FOUND', 'Fork target turn was not found');
      if (source.turns[end].status !== 'completed') throw runtimeError(409, 'RUNTIME_FORK_TURN_INCOMPLETE', 'Only completed turns can be forked');
      const result = await this.mutation<any>('thread/fork', { threadId, lastTurnId: input.lastTurnId, excludeTurns: true });
      const id = result?.thread?.id;
      const unknown = () => runtimeError(504, 'RUNTIME_RESULT_UNKNOWN', 'Fork could not be verified; check Recent Sessions before retrying');
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(id) || id === threadId) throw unknown();
      const state = this.state(id);
      try {
        const required = ['thread', 'model', 'modelProvider', 'serviceTier', 'disabledPluginIds', 'cwd', 'instructionSources', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'reasoningEffort'];
        if (!required.every(key => hasOwn(result, key)) || !isObject(result.thread) || result.thread.status?.type !== 'idle'
          || typeof result.cwd !== 'string' || !isAbsolute(result.cwd) || result.cwd !== source.cwd || result.thread.cwd !== result.cwd
          || typeof result.model !== 'string' || !result.model || typeof result.modelProvider !== 'string' || !result.modelProvider
          || (result.serviceTier !== null && typeof result.serviceTier !== 'string')
          || (result.reasoningEffort !== null && typeof result.reasoningEffort !== 'string')
          || !Array.isArray(result.disabledPluginIds) || !result.disabledPluginIds.every((value: any) => typeof value === 'string')
          || !Array.isArray(result.instructionSources) || !result.instructionSources.every((value: any) => typeof value === 'string')) throw unknown();
        this.requireUserThread(result.thread);
        state.permissions = this.verifyPermissions(result, undefined, result.cwd);
        state.cwd = result.cwd;
        state.model = result.model;
        state.reasoningEffort = result.reasoningEffort;
        state.nativeStatus = result.thread.status;
        state.loaded = true;
        state.released = false;
        const forked = await this.readThread(id, { headersOnly: true });
        const headers = (turns: any[]) => turns.map(turn => [turn.id, turn.status]);
        if (forked.id !== id || forked.cwd !== result.cwd || forked.status?.type !== 'idle'
          || !isDeepStrictEqual(headers(forked.turns), headers(source.turns.slice(0, end + 1)))) throw unknown();
        this.change(id, 'thread', { thread: this.threadHeader(forked) });
        return { threadId: id, status: 'idle', cwd: result.cwd,header:this.threadHeader(forked) };
      } catch (error) {
        const mapped = isObject(error) && error.code === 'RUNTIME_PERMISSION_MISMATCH' ? this.mapError(error) : unknown();
        state.error = mapped.message;
        throw Object.assign(mapped, { partial: { threadId: id } });
      } finally { this.scheduleIdle(); }
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
      state.maintenanceOnly=false;
      this.requireUserThread({id:threadId});
      if (input.expectedTurnId !== undefined) {
        if (input.model !== undefined || input.effort !== undefined || input.permissionMode !== undefined) throw runtimeError(400, 'RUNTIME_INVALID_INPUT', '插话沿用当前轮次的模型、推理强度和权限');
        await this.validateTurnOptions(input, state.cwd ?? this.options.cwd, state.model);
        if (!state.loaded || state.released || state.releasePromise || state.reserved || state.pending.size || state.contextUnknown || state.error || state.activeTurnId !== input.expectedTurnId) throw runtimeError(409, 'RUNTIME_STEER_CONFLICT', '当前轮次已变化或无法插话，请刷新后重新发送');
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
      if (state.releasePromise || state.reserved || state.activeTurnId || state.pending.size || state.contextUnknown || state.error || state.externalWriter || ['active', 'systemError'].includes(state.nativeStatus?.type)) throw runtimeError(409, 'RUNTIME_THREAD_BUSY', 'Thread already has active or unresolved work');
      state.releaseRequested = false;
      state.handoffReady = false;
      state.reserved = true;
      await this.discardWriterLease(state);
      state.waiter = this.waiter();
      state.completion = this.completion();
      this.change(threadId, 'phase');
      try {
        if (!state.cwd) {
          const read = await this.call<any>('thread/read', { threadId, includeTurns: false });
          this.requireUserThread(read.thread);
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
    const generation=state.titleGeneration;
    generation?.controller.abort();
    try {
      if (!state.reserved && !state.activeTurnId) return { threadId, status: 'idle' };
      if (!state.activeTurnId && state.waiter) await state.waiter.promise;
      const turnId = state.activeTurnId;
      if (!turnId) return { threadId, status: state.error ? 'unknown' : 'idle' };
      await this.mutation('turn/interrupt', { threadId, turnId });
      if (state.activeTurnId && state.completion) await state.completion.promise;
      return { threadId, turnId, status: state.activeTurnId ? 'interrupting' : 'idle' };
    } finally {await generation?.promise;}
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
        state.titleGeneration?.controller.abort();
        await state.titleGeneration?.promise;
        await state.nameWrite?.catch(()=>{});
        if (!state.released) {
          const activityRevision = state.activityRevision;
          const thread = await this.readThread(threadId, { headersOnly: true });
          this.reconcile(threadId, thread, activityRevision);
          if (!this.canUnload(state, thread)) throw runtimeError(409, 'RUNTIME_THREAD_BUSY', 'Native thread must be idle or finished before release');
          await this.discardWriterLease(state);
          state.nativeUnloaded=false;
          state.unloadReceipt=Promise.withResolvers<void>();
          const retain=this.options.writerLease??(process.platform==='win32'&&!this.options.args?retainWriterLease:undefined);
          if(retain)try{state.writerLease=await retain(this.initializeInfo?.codexHome,threadId);state.writerLeaseServer=this.server;}
          catch(error){this.writerCheckFailure(threadId,'capture_failed',error);}
          const result = await this.mutation<any>('thread/unsubscribe', { threadId });
          if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result?.status)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native release was not confirmed');
          state.nativeReleaseStatus = result.status;
          state.loaded = false;
          state.released = true;
          this.clearLiveState(state);
          state.error = undefined;
          state.recoverOnIdle = false;
        }
        if (!automatic) { state.selectedPermissionMode = undefined;state.releaseRequested = true; }
        state.reserved = false;
        if(state.writerLease&&!state.nativeUnloaded){
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{await Promise.race([state.unloadReceipt?.promise,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);}finally{clearTimeout(timer);}
          if(!state.nativeUnloaded)this.options.diagnostic?.({event:'writer_release_check',threadId:diagnosticId(threadId),outcome:'unconfirmed',reason:'unload_timeout'});
        }
        await this.finishThreadHandoff(threadId,state);
        const runtimeStopped = state.handoffReady ? !this.server&&!this.stopping : await this.closeIdleServer();
        state.handoffReady ||= !!runtimeStopped;
        return { threadId, status: 'released', nativeStatus: state.nativeReleaseStatus ?? null, runtimeStopped: !!runtimeStopped,
          handoffReady:!!state.handoffReady,...(!state.handoffReady ? { warning: 'Subscription cancelled; waiting for ownership release confirmation' } : {}) };
      } catch (error) {
        await this.discardWriterLease(state);
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

  private canUnload(state: ThreadState, thread: any): boolean {
    if(state.activeTurnId||state.pending.size||thread.turns.some((turn:any)=>turn.status==='inProgress'))return false;
    if(['idle','notLoaded'].includes(thread.status?.type))return true;
    return thread.status?.type==='systemError'&&state.loaded&&!state.released&&!state.externalWriter&&thread.turns.length>0&&thread.turns.every((turn:any)=>['completed','interrupted','failed'].includes(turn.status));
  }

  private reconcile(threadId: string, thread: any, activityRevision: number): void {
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
    if(state.loaded&&!state.released&&!state.externalWriter&&!state.activeTurnId&&thread.status?.type==='active'){
      const active=thread.turns.filter((turn:any)=>turn.status==='inProgress');
      // A fresh native read can correct a terminal cache entry, but cannot override
      // a start/completion/status notification received while that read was in flight.
      if(active.length===1&&state.activityRevision===activityRevision){
        state.completedTurns.delete(active[0].id);
        const live=state.liveTurns.get(active[0].id);
        if(live&&live.status!=='inProgress')state.liveTurns.delete(active[0].id);
        state.activeTurnId=active[0].id;
        if(state.error===UNRECONCILED_ACTIVITY){state.error=undefined;state.recoverOnIdle=false;}
      }
    }
    // Native systemError is an idle error flag cleared by the next turn, not a writer lock.
    // Keep the raw thread status/error in the snapshot; only reconcile our operation state.
    if(thread.status?.type==='systemError'&&this.canUnload(state,thread))state.nativeStatus={type:'idle'};
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

  async diagnostics({currentOnly=false}={}): Promise<any> {
    if(currentOnly)return {available:null,...this.diagnosticState(),permissionModes:null,
      userAgent:this.initializeInfo?.userAgent??null,codexHome:this.initializeInfo?.codexHome??null,
      platformFamily:this.initializeInfo?.platformFamily??null,platformOs:this.initializeInfo?.platformOs??null,
      account:null,requiresOpenaiAuth:null,note:'仅展示当前运行时内存状态；有效权限与账户尚未在此页面读取，请到配置和使用情况中核对。'};
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
    return {epoch:this.epoch,starting:!!this.starting,stopping:!!this.stopping,inFlight:this.inFlight,reads:this.reads,failures:this.failures,diagnosticsSeen:this.diagnosticsSeen,
      native,threads:[...this.states.entries()].filter(([id,state])=>state.loaded||state.activeTurnId||state.reserved||waiting.has(id)||((state.releaseRequested||state.released)&&!state.handoffReady)).sort(([left],[right])=>Number(waiting.has(right))-Number(waiting.has(left))).slice(0,20).map(([id,state])=>({threadId:diagnosticId(id),phase:this.phase(state),projectKey:state.diagnosticProjectKey??(state.cwd?createHash('sha256').update(process.platform==='win32'?state.cwd.toLowerCase():state.cwd).digest('hex').slice(0,24):undefined),release:{requested:!!state.releaseRequested,released:!!state.released,handoffReady:!!state.handoffReady}}))};
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
    for(const state of this.states.values()){state.titleGeneration?.controller.abort();state.historyRead?.controller.abort();}
    await Promise.all([...this.states.values()].map(async state=>{await state.titleGeneration?.promise;await state.nameWrite?.catch(()=>{});}));
    this.listReads.clear();this.headerReads.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    try{if (server)try{await server.close();}finally{await settleNativeTitleCleanup(server);}}
    finally{await Promise.all([...this.states.values()].map(state=>this.discardWriterLease(state)));}
  }

  private state(threadId: string): ThreadState {
    let state = this.states.get(threadId);
    if (!state) {
      state = { activeTurnId: null, completedTurns: new Set(), completedItems: new Set(), liveTurns: new Map(), loaded: false, pending: new Map(), released: false, reserved: false, revision: 0, activityRevision: 0, snapshotSequence: 0 };
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

  modelInfo(){return {executable:this.options.executable,version:this.initializeInfo?.userAgent??null,readAt:this.modelCatalog?this.modelCatalog.expiresAt-5*60_000:null};}

  assertIdle(){
    if(this.starting||this.stopping||this.inFlight||this.reads||(this.server&&nativeTitleCleanupPending(this.server))||[...this.states.values()].some(s=>s.reserved||s.activeTurnId||s.pending.size||s.recoverOnIdle||s.releasePromise||s.titleGeneration||s.nameWrite||['active','systemError'].includes(s.nativeStatus?.type)))throw runtimeError(409,'RUNTIME_THREAD_BUSY','仍有活动会话、待处理请求或读取操作。请等待所有任务、审批和输入处理完毕后再操作。');
  }

  async assertNativeIdle(){
    this.assertIdle();
    const server=this.server,epoch=this.epoch,deadline=Date.now()+20_000;
    if(!server)return;
    this.reads++;
    try{
      let cursor:string|null=null;const seen=new Set<string>();
      do{
        const page=await this.call<any>('thread/loaded/list',{cursor,limit:100});
        if(Date.now()>=deadline)throw Error('Activity check timed out');
        if(!Array.isArray(page?.data)||!page.data.every((id:unknown)=>typeof id==='string'&&id.length>0))throw Error('Invalid native loaded thread list');
        for(const threadId of page.data){
          const result=await this.call<any>('thread/read',{threadId,includeTurns:false});
          if(Date.now()>=deadline)throw Error('Activity check timed out');
          const status=result?.thread?.status?.type;
          if(result?.thread?.id!==threadId)throw Error('Invalid native thread status');
          if(status==='active')throw runtimeError(409,'RUNTIME_THREAD_BUSY','本机 Codex App Server 仍有活动任务（含待审批或待输入），暂不能重启。');
          if(status!=='idle'&&status!=='notLoaded')throw Error('Unknown native activity');
        }
        cursor=page.nextCursor;
        if(cursor!==null&&(typeof cursor!=='string'||!cursor||seen.has(cursor)))throw Error('Invalid native loaded thread cursor');
        if(cursor)seen.add(cursor);
      }while(cursor);
      if(server!==this.server||epoch!==this.epoch)throw Error('Native runtime changed during activity check');
    }catch(error:any){
      if(error.code==='RUNTIME_THREAD_BUSY')throw error;
      throw runtimeError(503,'RUNTIME_UNAVAILABLE','无法可靠查询本机 Codex App Server 的活动状态，请稍后重试。');
    }finally{this.reads--;this.scheduleIdle();}
    this.assertIdle();
  }

  async prepareRestart(){
    await this.assertNativeIdle();
    this.prepareUpdate();
  }

  prepareUpdate(){
    this.assertIdle();
    this.updating=true;
  }

  async reloadModels(){
    await this.assertNativeIdle();
    this.assertIdle();
    if(this.server&&!await this.closeIdleServer())throw runtimeError(409,'RUNTIME_THREAD_BUSY','仍有活动任务、待处理请求或读取操作，请稍后重启。');
    return this.models(true);
  }

  async models(refresh=false,allowStale=false): Promise<{ data: any[]; nextCursor: null; stale?: boolean }> {
    try{
    await this.getServer();
    const epoch = this.epoch;
    if (!refresh && this.modelCatalog?.epoch === epoch && this.modelCatalog.expiresAt > Date.now()) return { data: structuredClone(this.modelCatalog.data), nextCursor: null };
    if (this.modelLoading?.epoch === epoch) return structuredClone(await this.modelLoading.promise);
    const promise = this.loadModels().then(result => {
      if (this.epoch === epoch) this.modelCatalog = { epoch, expiresAt: Date.now() + 5 * 60_000, data: structuredClone(result.data) };
      return result;
    }).finally(() => { if (this.modelLoading?.promise === promise) this.modelLoading = undefined; });
    this.modelLoading = { epoch, promise };
    return structuredClone(await promise);
    }catch(error){
      if(allowStale&&!refresh&&this.modelCatalog)return {data:structuredClone(this.modelCatalog.data),nextCursor:null,stale:true};
      throw error;
    }
  }

  private async loadModels(): Promise<{ data: any[]; nextCursor: null }> {
    const data: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: any = await this.call('model/list', { cursor, includeHidden: true });
      if (!Array.isArray(result?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native model catalog is unavailable');
      data.push(...result.data.map((m: any) => {
        const serviceTiers=Array.isArray(m.serviceTiers)?m.serviceTiers.filter((t:any)=>isObject(t)&&typeof t.id==='string'&&t.id.length>0&&t.id.length<=120&&typeof t.name==='string'&&typeof t.description==='string').map((t:any)=>({id:t.id,name:t.name,description:t.description})):[];
        const defaultServiceTier=typeof m.defaultServiceTier==='string'&&(m.defaultServiceTier==='default'||serviceTiers.some((t:any)=>t.id===m.defaultServiceTier))?m.defaultServiceTier:null;
        return { id: m.id, model: m.model, displayName: m.displayName, description: m.description, hidden: m.hidden, supportedReasoningEfforts: m.supportedReasoningEfforts, defaultReasoningEffort: m.defaultReasoningEffort, inputModalities: m.inputModalities, isDefault: m.isDefault,serviceTiers,defaultServiceTier };
      }));
      cursor = result.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || cursors.has(cursor))) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Invalid model pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { data, nextCursor: null };
  }

  private async permissionCatalog(cwd: string,includeLayers=false) {
    this.requireString(cwd, 'cwd');
    const [read, requirements] = await Promise.all([this.call<any>('config/read', { cwd, includeLayers }), this.call<any>('configRequirements/read', {})]);
    if (!isObject(read?.config) || !isObject(requirements) || !hasOwn(requirements, 'requirements')) throw runtimeError(503, 'RUNTIME_PERMISSION_UNAVAILABLE', 'Native permission configuration is unavailable');
    const layer=includeLayers?baseUserLayer(read):null;
    return { ...permissionChoices(cwd, read.config, requirements.requirements, this.initializeInfo?.platformFamily),
      userVersion:layer&&layer.disabledReason==null&&layer.disabled_reason==null&&read.config.profile==null?layer.version:null,
      model: typeof read.config.model === 'string' ? read.config.model : null,
      effort: typeof read.config.model_reasoning_effort === 'string' ? read.config.model_reasoning_effort : null };
  }

  async permissionModes(cwd: string) {
    const { modes, current, model, effort,userVersion } = await this.permissionCatalog(cwd,true);
    return { modes, current, model, effort,userVersion };
  }

  private settingsPeer(){return {request:(method:string,params:any)=>this.call<any>(method,params,false,true),models:()=>this.models(),platform:()=>this.initializeInfo?.platformFamily};}

  async configurationHome():Promise<string|null>{
    this.reads++;
    try{
      const server=await this.getServer();
      if(this.server!==server||this.closed)throw runtimeError(503,'RUNTIME_UNAVAILABLE','当前原生进程不可用。');
      const home=this.initializeInfo?.codexHome;
      return typeof home==='string'&&isAbsolute(home)?resolve(home):null;
    }finally{this.reads--;this.scheduleIdle();}
  }

  async readSettings(cwd:string){
    this.requireString(cwd,'cwd');this.reads++;
    try{return await readSettings(this.settingsPeer(),cwd);}finally{this.reads--;this.scheduleIdle();}
  }

  async installedPlugins(cwd?:string):Promise<InstalledPluginsSnapshot>{
    if(cwd!==undefined)this.requireString(cwd,'cwd');
    return readInstalledPlugins(this.settingsPeer(),cwd);
  }

  async writeSettings(cwd:string,input:SettingsWriteInput){
    this.requireString(cwd,'cwd');this.reads++;
    try{return await writeSettings(this.settingsPeer(),cwd,input);}finally{this.reads--;this.scheduleIdle();}
  }

  async saveModelDefaults(cwd: string, selectedModel: string, selectedEffort?: string, expectedVersion?:string) {
    this.requireString(cwd, 'cwd');
    this.requireString(selectedModel, 'model');
    const model = (await this.models()).data.find(entry => entry.model === selectedModel);
    if (!model) throw runtimeError(400, 'RUNTIME_INVALID_MODEL', 'Selected model is unavailable');
    const effort = selectedEffort ?? model.defaultReasoningEffort;
    if (typeof effort !== 'string' || !model.supportedReasoningEfforts?.some((entry: any) => entry.reasoningEffort === effort))
      throw runtimeError(400, 'RUNTIME_INVALID_EFFORT', 'Reasoning effort is not supported by this model');
    const result=await this.writeSettings(cwd,{expectedVersion:expectedVersion!,values:{model:selectedModel,model_reasoning_effort:effort}});
    return { model: selectedModel, effort, effectiveModel: result.snapshot.fields.model.effectiveValue, effectiveEffort: result.snapshot.fields.model_reasoning_effort.effectiveValue };
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
    const state=this.state(threadId);
    state.maintenanceOnly=false;
    state.nameRevision=(state.nameRevision??0)+1;
    state.titleGeneration?.controller.abort();
    return this.queueName(state,()=>this.writeName(threadId,name.trim()));
  }

  private queueName(state:ThreadState,operation:()=>Promise<any>):Promise<any>{
    const next=(state.nameWrite??Promise.resolve()).catch(()=>{}).then(operation);
    state.nameWrite=next;
    void next.finally(()=>{if(state.nameWrite===next)state.nameWrite=undefined;}).catch(()=>{});
    return next;
  }

  private async writeName(threadId:string,name:string):Promise<any>{
    try{await this.mutation('thread/name/set',{threadId,name});}
    catch(error){
      if(this.mapError(error).code!=='RUNTIME_RESULT_UNKNOWN')throw error;
      const read=await this.call<any>('thread/read',{threadId,includeTurns:false});
      if(read.thread.name!==name)throw error;
    }
    const state=this.state(threadId);if(state.nativeName!==name){state.nativeName=name;this.change(threadId,'name',{thread:{name}});}
    return {threadId,name};
  }

  private startTitleGeneration(threadId:string,prompt:string,provider:string,source:string,state:ThreadState):void {
    if(typeof provider!=='string'||!SOURCE_KINDS.includes(source))return;
    const model='gpt-6-luna',effort='low',cwd=state.cwd!;
    const controller=new AbortController(),epoch=this.epoch,revision=state.nameRevision??0;
    const generation={controller,promise:Promise.resolve()};
    state.titleGeneration=generation;
    this.change(threadId,'title');
    generation.promise=(async()=>{
      const server=await this.getServer();
      const title=await generateNativeTitle(server,{cwd,model,provider,effort,prompt,source},controller.signal,id=>this.temporaryThreads.add(id),this.temporaryThreads);
      if(!title||controller.signal.aborted)return;
      await this.queueName(state,async()=>{
        const writable=()=>!controller.signal.aborted&&!this.closed&&this.epoch===epoch&&state.loaded&&!state.released&&!state.releaseRequested&&!state.releasePromise&&(state.nameRevision??0)===revision&&!state.nativeName;
        if(!writable())return;
        const read=await this.call<any>('thread/read',{threadId,includeTurns:false});
        if(read.thread.name){state.nativeName=read.thread.name;this.change(threadId,'name',{thread:{name:read.thread.name}});return;}
        if(writable())await this.writeName(threadId,title);
      });
    })().catch(()=>{}).finally(()=>{
      if(state.titleGeneration===generation)state.titleGeneration=undefined;
      this.change(threadId,'title');this.scheduleIdle();
    });
  }

  async accountIdentity(): Promise<{identity:string;resetProtocol:boolean}> {
    const result=await this.call<any>('account/read',{refreshToken:false});
    return {identity:createHash('sha256').update(JSON.stringify(result?.account??null)+'|'+this.epoch).digest('hex'),resetProtocol:result?.account?.type==='chatgpt'};
  }

  readAccountUsage():Promise<any>{return this.call('account/rateLimits/read',{});}

  async consumeAccountReset(input:{creditId:string;idempotencyKey:string},accountId:string):Promise<any>{
    this.inFlight++;
    try {
      const server=await this.getServer();
      const usage=await server.request<any>('account/rateLimits/read',{});
      if(typeof usage?.accountId!=='string'||!usage.accountId||createHash('sha256').update(usage.accountId).digest('hex')!==accountId||server!==this.server)throw runtimeError(409,'RUNTIME_ACCOUNT_CHANGED','账户已变化，请重新读取用量。');
      try {return await server.request('account/rateLimitResetCredit/consume',input);}
      catch(error){
        if(isObject(error)&&error.code===-32601)throw runtimeError(409,'RUNTIME_ACCOUNT_UNSUPPORTED','当前 Codex 未提供重置接口，请升级 CLI 后重试。');
        throw runtimeError(504,'RUNTIME_RESULT_UNKNOWN','重置结果待核实，请使用原操作标识重试。');
      }
    } catch(error){throw this.mapError(error);}
    finally {this.inFlight--;this.scheduleIdle();}
  }

  async archive(threadId:string,archived=true):Promise<any>{
    this.requireString(threadId,'threadId');
    if(archived)await this.open(threadId);
    const state=this.state(threadId);
    state.maintenanceOnly=false;
    if(state.reserved||state.activeTurnId||state.pending.size||state.releasePromise||(archived&&this.phase(state)!=='IDLE'))throw runtimeError(409,'RUNTIME_THREAD_BUSY','会话仍被占用，请先结束任务或在其他应用中关闭。');
    state.reserved=true;
    try{
      await this.mutation(archived?'thread/archive':'thread/unarchive',{threadId});
      this.invalidateForkHeader(threadId);
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

  private async mutation<T = unknown>(method: string, params: unknown,context?:NativeProjectContext,guard?:()=>void): Promise<T> {
    this.listReads.clear();this.headerReads.clear();
    try{return await this.call<T>(method, params, true,false,undefined,context,guard);}
    finally{this.listReads.clear();this.headerReads.clear();}
  }

  private async call<T = unknown>(method: string, params: unknown, uncertain = false, rawErrors = false,timeoutMs?:number,context?:NativeProjectContext,guard?:()=>void): Promise<T> {
    const deadline=timeoutMs===undefined?undefined:Date.now()+timeoutMs;
    this.inFlight++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      let server: AppServer;
      try {
        if(deadline===undefined)server=await this.getServer();
        else{
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{server=await Promise.race([this.getServer(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(runtimeError(503,'RUNTIME_UNAVAILABLE','Native initialization exceeded the bounded header read budget')),Math.max(1,deadline-Date.now()));})]);}
          finally{clearTimeout(timer);}
        }
      }
      catch (error) { throw this.mapError(error); }
      for (let attempt = 0; ; attempt++) {
        try {
          if(deadline!==undefined&&Date.now()>=deadline)throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native header read budget expired');
          if(context)this.assertProjectContext(context);
          guard?.();
          const result=await server.request<T>(method, params,deadline===undefined?undefined:Math.max(1,deadline-Date.now()));
          if(context)this.assertProjectContext(context);
          if(method==='thread/read'&&(!isObject(result)||!isObject(result.thread)||!isObject(params)||typeof result.thread.id!=='string'||result.thread.id!==params.threadId))throw runtimeError(503,'RUNTIME_UNAVAILABLE','Native thread information is unavailable');
          if(isObject(result)&&isObject(result.thread))this.rememberThreadSource(result.thread);
          return result;
        }
        catch (error) {
          if(context)this.assertProjectContext(context);
          if(rawErrors||(error as any)?.code==='RUNTIME_SYNC_RESTARTED')throw error;
          const mapped = this.mapError(error, method, params);
          // thread/start may return before its rollout metadata is flushed. Retry only this read race.
          if (!uncertain && mapped.code === 'RUNTIME_HISTORY_NOT_READY' && attempt < 4 && (deadline===undefined||Date.now()+50*2**attempt<deadline)) {
            await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
            continue;
          }
          if (uncertain && mapped.statusCode === 503) throw runtimeError(504, 'RUNTIME_RESULT_UNKNOWN', 'Codex did not confirm the operation; its result is unknown');
          throw mapped;
        }
      }
    } catch (error) {
      if(rawErrors)throw error;
      throw this.mapError(error, method, params);
    } finally {
      this.inFlight--;
      this.scheduleIdle();
    }
  }

  private getServer(): Promise<AppServer> {
    if(this.updating)return Promise.reject(runtimeError(503,'RUNTIME_UPDATING','正在更新应用，请稍后重试。'));
    if (this.closed) return Promise.reject(runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Runtime is closed'));
    if (this.stopping) return this.stopping.then(() => this.getServer());
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve(this.server);
    this.epoch = randomUUID();
    for(const state of this.states.values())state.historyRead?.controller.abort(runtimeError(503,'RUNTIME_SYNC_RESTARTED','会话运行时已切换，请重新读取历史。'));
    this.listReads.clear();this.headerReads.clear();
    this.forkHeaders.clear();
    this.sequence = 0;
    this.events = [];
    this.eventBytes = 0;
    const server = new AppServer({ executable: this.options.executable, cwd: this.options.cwd, args: this.options.args??(process.platform==='win32'?['-c','thread_unload_delay_secs=0','app-server']:undefined),diagnostic:this.options.diagnostic });
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
    this.listReads.clear();this.headerReads.clear();
    this.server = undefined;
    this.starting = undefined;
    for (const [threadId, state] of this.states) {
      const maintenanceOnly=state.maintenanceOnly&&!state.loaded&&state.cwd===undefined&&!state.error&&!state.contextUnknown&&!state.externalWriter&&!state.activeTurnId&&!state.pending.size&&!state.liveTurns.size&&!state.openPromise&&!state.nameWrite&&!state.waiter&&!state.completion&&!state.writerLease&&!state.pendingCwdIdentity&&!['active','systemError'].includes(state.nativeStatus?.type);
      state.historyRead?.controller.abort(runtimeError(503,'RUNTIME_UNAVAILABLE','Native Codex runtime is unavailable'));
      void this.discardWriterLease(state);
      state.loaded = false;
      state.waiter?.resolve('failed');
      state.completion?.resolve();
      this.clearLiveState(state);
      if (state.released) continue;
      if(maintenanceOnly){state.reserved=false;continue;}
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
    if(method==='project/changed'){this.emit('projectCatalogChanged');return;}
    if(params.thread?.ephemeral===true){if(typeof params.thread.id==='string')this.temporaryThreads.add(params.thread.id);return;}
    if(this.temporaryThreads.has(params.threadId))return;
    if(method==='thread/started'&&isObject(params.thread)){this.rememberThreadSource(params.thread);return;}
    if(method==='account/updated'||method==='account/rateLimits/updated')this.emit('accountChanged',{method});
    if (method === 'serverRequest/resolved') {
      const pending = this.nativeRequests.get(nativeKey(params.requestId));
      if (pending) this.clearPending(pending, 'request');
      return;
    }
    if (typeof params.threadId !== 'string') return;
    const state = this.state(params.threadId);
    if(method==='thread/settings/updated'){
      const settings=params.threadSettings;
      if(!isObject(settings)||typeof settings.cwd!=='string'||!isAbsolute(settings.cwd))return;
      state.identityRevision=(state.identityRevision??0)+1;
      if(typeof state.cwd==='string'&&directoryKey(state.cwd)!==directoryKey(settings.cwd)){state.contextUnknown=true;state.loaded=false;state.permissions=undefined;}
      state.cwd=settings.cwd;this.headerReads.delete(params.threadId);this.invalidateForkHeader(params.threadId);
      this.change(params.threadId,'thread',{thread:{cwd:settings.cwd}});return;
    }
    if(method==='thread/project/updated'){
      if(params.projectId!==null&&typeof params.projectId!=='string')return;
      state.identityRevision=(state.identityRevision??0)+1;
      this.headerReads.delete(params.threadId);this.invalidateForkHeader(params.threadId);
      this.change(params.threadId,'thread',{thread:{projectId:params.projectId}});this.emit('projectCatalogChanged');return;
    }
    if(method==='thread/name/updated'){
      if(params.threadName!==undefined&&typeof params.threadName!=='string')return;
      if(state.nativeName===(params.threadName??null))return;
      state.nativeName=params.threadName??null;state.nameRevision=(state.nameRevision??0)+1;
      this.change(params.threadId,'name',{thread:{name:state.nativeName}});return;
    }
    if(['thread/status/changed','thread/closed','turn/started','turn/completed'].includes(method)){state.activityRevision++;if(method==='turn/started'||params.status?.type==='active')state.maintenanceOnly=false;}
    if (method === 'thread/status/changed' || method === 'thread/closed') {
      if(method==='thread/closed'){state.nativeUnloaded=true;state.unloadReceipt?.resolve();}
      state.nativeStatus = method === 'thread/closed' ? { type: 'notLoaded' } : params.status;
      if (state.nativeStatus?.type === 'notLoaded') state.loaded = false;
      this.change(params.threadId, 'status', { thread: { status: state.nativeStatus } });
      this.scheduleIdle();
      return;
    }
    if (method === 'turn/started' && isObject(params.turn)) {
      const turn = this.mergeLiveTurn(state, params.turn);
      if (state.completedTurns.has(params.turn.id)) return;
      state.activeTurnId = params.turn.id;
      state.nativeStatus = { type: 'active', activeFlags: [] };
      state.reserved = false;
      state.error = undefined;
      state.recoverOnIdle = false;
      state.waiter?.resolve('started');
      this.change(params.threadId, 'turn', { turn, thread: { status: state.nativeStatus } });
      return;
    }
    if (method === 'turn/completed' && isObject(params.turn)) {
      if (state.retry?.turnId === params.turn.id) state.retry = undefined;
      const turn = this.mergeLiveTurn(state, params.turn);
      const finalItem=state.liveTurns.get(params.turn.id)?.items?.findLast((item:any)=>item?.type==='agentMessage'&&item.phase==='final_answer'&&typeof item.id==='string');
      this.notification(params.threadId, `turn:${params.turn.id}`, params.turn.status === 'failed' ? 'failed' : 'complete',
        {turnId:params.turn.id,...(finalItem?{itemId:finalItem.id}:{})});
      state.completedTurns.add(params.turn.id);
      if (!state.activeTurnId || state.activeTurnId === params.turn.id) {
        state.activeTurnId = null;
        state.nativeStatus = { type: 'idle' };
      }
      state.reserved = false;
      state.waiter?.resolve('completed');
      state.completion?.resolve();
      for (const pending of [...state.pending.values()]) if (pending.turnId === params.turn.id) this.clearPending(pending, 'request');
      this.change(params.threadId, 'turn', { turn, thread: { status: state.nativeStatus } });
      this.scheduleIdle();
      return;
    }
    if (typeof method === 'string' && method.startsWith('item/') && state.retry?.turnId === params.turnId) state.retry = undefined;
    if ((method === 'item/started' || method === 'item/completed') && isObject(params.item) && typeof params.turnId === 'string') {
      const itemKey = `${params.turnId}:${params.item.id}`;
      if (method === 'item/started' && state.completedItems.has(itemKey)) return;
      const activeTurn = state.liveTurns.get(params.turnId) ?? { id: params.turnId, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
      const index = activeTurn.items.findIndex((item: any) => item.id === params.item.id);
      const item = itemWithTimes(params.item, params, activeTurn.items[index]);
      if (index < 0) activeTurn.items.push(item);
      else activeTurn.items[index] = item;
      if (method === 'item/completed') state.completedItems.add(itemKey);
      state.liveTurns.set(params.turnId, activeTurn);
      this.change(params.threadId, 'item', { item: { turnId: params.turnId, item, completed: method === 'item/completed' } });
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
    if(this.temporaryThreads.has(params?.threadId)){try{server?.respondError(message.id,-32601,'Title generation does not accept tool interactions');}catch{}return;}
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
    this.notification(params.threadId, `request:${turnId}:${message.method}:${params.approvalId ?? params.itemId ?? nativeKey(message.id)}`, ['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(message.method) ? 'input' : 'approval',
      {turnId,requestId:String(pending.requestId),...(typeof params.itemId==='string'?{itemId:params.itemId}:{})});
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

  private mergeLiveTurn(state: ThreadState, incoming: any): any {
    const old = state.liveTurns.get(incoming.id);
    incoming = { ...incoming, items: (incoming.items ?? []).map((item: any) => itemWithTimes(item, {}, old?.items?.find((entry: any) => entry.id === item.id))) };
    if (!old) { state.liveTurns.set(incoming.id, structuredClone(incoming)); return incoming; }
    if (state.completedTurns.has(incoming.id) && incoming.status === 'inProgress') return incoming;
    const items = [...(Array.isArray(old.items) ? old.items : [])];
    for (const item of Array.isArray(incoming.items) ? incoming.items : []) {
      const index = items.findIndex((candidate: any) => candidate.id === item.id);
      if (index < 0) items.push(structuredClone(item));
      else items[index] = structuredClone(item);
    }
    const merged = { ...old, ...structuredClone(incoming), items };
    if (incoming.status === 'inProgress' && old.error && !incoming.error) merged.error = old.error;
    state.liveTurns.set(incoming.id, merged);
    return incoming;
  }

  private async readThread(threadId: string, window?: HistoryWindow, signal?: AbortSignal,restartHistory=false): Promise<any> {
    this.reads++;
    try {
      signal?.throwIfAborted();
      const ready = this.getServer();
      if (signal) {
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        });
        try { await Promise.race([ready, cancelled]); }
        finally { signal.removeEventListener('abort', abort); }
      } else await ready;
      signal?.throwIfAborted();
      const epoch=this.epoch,state=this.state(threadId),thread=state.initialHistory?.epoch===epoch&&!window?.before&&!window?.headersOnly
        ?await this.startupHistory(threadId,window,signal,restartHistory):await this.loadThread(threadId, window, signal);
      signal?.throwIfAborted();
      if(epoch!==this.epoch)throw runtimeError(503,'RUNTIME_SYNC_RESTARTED','会话运行时已切换，请重新读取历史。');
      return thread;
    }
    finally { this.reads--; this.scheduleIdle(); }
  }

  private async startupHistory(threadId:string,window?:HistoryWindow,signal?:AbortSignal,restartHistory=false):Promise<any>{
    const state=this.state(threadId);
    let job=state.historyRead;
    const expired=()=>runtimeError(503,'RUNTIME_HISTORY_NOT_MATERIALIZED','任务已启动，历史同步仍未完成，请重新同步。');
    if(job&&Date.now()>=job.deadline){job.controller.abort(expired());if(state.historyRead===job)state.historyRead=undefined;job=undefined;}
    if(!job||job.epoch!==this.epoch||job.controller.signal.aborted){
      const history=state.initialHistory!;if(restartHistory)history.deadline=undefined;
      const controller=new AbortController(),epoch=this.epoch,deadline=history.deadline??=Date.now()+15_000;
      if(Date.now()>=deadline)throw expired();
      const timer=setTimeout(()=>controller.abort(expired()),deadline-Date.now());
      job={epoch,deadline,controller,users:new Set(),promise:Promise.resolve()};state.historyRead=job;
      const owned=job;
      owned.promise=(async()=>{
        const delays=[200,500,1000,2000,4000];
        for(let attempt=0;;attempt++){
          controller.signal.throwIfAborted();
          if(epoch!==this.epoch)throw runtimeError(503,'RUNTIME_SYNC_RESTARTED','会话运行时已切换，请重新读取历史。');
          try{return await this.abortable(this.loadThread(threadId,window,controller.signal,deadline),controller.signal);}
          catch(error){
            controller.signal.throwIfAborted();
            if((error as any)?.code!=='RUNTIME_HISTORY_NOT_MATERIALIZED'||attempt===delays.length)throw error;
            try{await wait(delays[attempt],undefined,{signal:controller.signal});}
            catch(error){controller.signal.throwIfAborted();throw error;}
          }
        }
      })().finally(()=>{clearTimeout(timer);if(state.historyRead===owned)state.historyRead=undefined;});
    }
    const user=Symbol();job.users.add(user);
    try{return await this.abortable(job.promise,signal);}
    finally{job.users.delete(user);if(!job.users.size)job.controller.abort();}
  }

  private async abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();if(!signal)return promise;
    let abort!:()=>void;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
    finally{signal.removeEventListener('abort',abort);}
  }

  private historyCall<T=any>(method:string,params:unknown,signal?:AbortSignal,deadline?:number):Promise<T>{
    signal?.throwIfAborted();
    return this.abortable(this.call<T>(method,params,false,false,deadline===undefined?undefined:Math.max(1,deadline-Date.now())),signal);
  }

  private async loadThread(threadId: string, window?: HistoryWindow, signal?: AbortSignal,deadline?:number): Promise<any> {
    const state = this.state(threadId);
    let result: any;
    try { result = await this.historyCall('thread/read', { threadId, includeTurns: false },signal,deadline); }
    catch (error) {
      if (isObject(error) && error.code === 'RUNTIME_THREAD_NOT_LOADED' && state.emptyThreadEpoch && state.emptyThreadEpoch !== this.epoch) {
        throw runtimeError(404, 'RUNTIME_EMPTY_THREAD_NOT_PERSISTED', 'Empty thread was not persisted before the runtime stopped');
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (!isObject(result?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread history is unavailable');
    this.requireUserThread(result.thread);
    const thread = structuredClone(result.thread);
    if(this.options.diagnostic&&typeof thread.cwd==='string')state.diagnosticProjectKey=createHash('sha256').update(process.platform==='win32'?thread.cwd.toLowerCase():thread.cwd).digest('hex').slice(0,24);
    const turns = new Map<string, any>();
    for (const value of Array.isArray(thread.turns) ? thread.turns : []) if (isObject(value) && typeof value.id === 'string') this.mergeNativeTurn(turns, value);

    let cursor: string | null = null;
    const seenTurnCursors = new Set<string>();
    for (;;) {
      let page: any;
      // Full turns can exceed the protocol frame limit; load their items in small pages below.
      try { page = await this.historyCall('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'notLoaded' },signal,deadline); }
      catch (error) {
        if (isObject(error) && ['RUNTIME_HISTORY_UNSUPPORTED','RUNTIME_HISTORY_NOT_MATERIALIZED'].includes(error.code) && state.emptyThreadEpoch === this.epoch && turns.size === 0) {
          thread.turns = [];
          return thread;
        }
        if (isObject(error) && error.code === 'RUNTIME_HISTORY_UNSUPPORTED') {
          signal?.throwIfAborted();
          return this.fullThread(threadId,signal,deadline);
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
    await this.readTurnBodies(threadId, selected, undefined, Boolean(window?.before), signal,deadline);
    thread.turns = [...turns.values()];
    // A turn may finish while history is paginating; confirm the earlier active header.
    if (thread.status?.type === 'active' && !thread.turns.some((turn: any) => turn.status === 'inProgress')) {
      const latest = await this.historyCall('thread/read', { threadId, includeTurns: false },signal,deadline);
      if (!isObject(latest?.thread)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native thread status is unavailable');
      thread.status = latest.thread.status;
    }
    return thread;
  }

  private async fullThread(threadId: string,signal?:AbortSignal,deadline?:number): Promise<any> {
    // ponytail: full-history reads are bounded by the protocol frame; use native pagination when available.
    const result = await this.historyCall('thread/read', { threadId, includeTurns: true },signal,deadline);
    if (!isObject(result?.thread) || result.thread.id !== threadId || !Array.isArray(result.thread.turns))
      throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native full thread history is unavailable');
    return result.thread;
  }

  private async readTurnBodies(threadId: string, turns: any[], itemId?: string, seek = false, signal?: AbortSignal,deadline?:number): Promise<void> {
    signal?.throwIfAborted();
    try {
      for (const turn of turns) {
        if (turn.itemsView === 'full') continue;
        turn.items = await this.readItems(threadId, turn.id, itemId, signal,deadline);
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
        const page: any = await this.historyCall('thread/turns/list', { threadId, cursor, limit: HISTORY_SIZE, sortDirection: 'desc', itemsView: 'notLoaded' },signal,deadline);
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
            const skipped: any = await this.historyCall('thread/turns/list', { threadId, cursor: bodyCursor, limit: gap, sortDirection: 'desc', itemsView: 'notLoaded' },signal,deadline);
            signal?.throwIfAborted();
            if (!Array.isArray(skipped?.data) || skipped.data.length !== gap || typeof skipped.nextCursor !== 'string') throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native turn pagination changed while loading history');
            bodyCursor = skipped.nextCursor;
          }
          const full: any = await this.historyCall('thread/turns/list', { threadId, cursor: bodyCursor, limit: 1, sortDirection: 'desc', itemsView: 'full' },signal,deadline);
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
      const page: any = await this.historyCall('thread/turns/list', { threadId, cursor, limit: 1, sortDirection: 'desc', itemsView: 'full' },signal,deadline);
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

  private async readItems(threadId: string, turnId: string, itemId?: string, signal?: AbortSignal,deadline?:number): Promise<any[]> {
    const items = new Map<string, any>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page: any = await this.historyCall('thread/items/list', { threadId, turnId, cursor, limit: 10, sortDirection: 'asc' },signal,deadline);
      signal?.throwIfAborted();
      if (!Array.isArray(page?.data)) throw runtimeError(503, 'RUNTIME_UNAVAILABLE', 'Native item history is unavailable');
      for (const entry of page.data) if (entry?.turnId === turnId && isObject(entry.item) && typeof entry.item.id === 'string') {
        if (itemId && entry.item.id === itemId) return [itemWithTimes(entry.item, entry)];
        if (!itemId) items.set(entry.item.id, itemWithTimes(entry.item, entry));
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
          for (let i = 0; i < items.length; i++) items[i] = itemWithTimes(items[i], {}, live.items?.find((item: any) => item.id === items[i].id));
          if (['completed', 'interrupted', 'failed'].includes(live.status)) for (const item of live.items ?? []) if (!items.some((candidate: any) => candidate.id === item.id)) items.push(structuredClone(item));
          continue;
        }
        const mergedItems = [...(Array.isArray(thread.turns[index].items) ? thread.turns[index].items : [])];
        for (const item of Array.isArray(live.items) ? live.items : []) {
          const itemIndex = mergedItems.findIndex((candidate: any) => candidate.id === item.id);
          if (itemIndex < 0) mergedItems.push(structuredClone(item));
          else mergedItems[itemIndex] = itemWithTimes(item, {}, mergedItems[itemIndex]);
        }
        thread.turns[index] = { ...thread.turns[index], ...structuredClone(live), items: mergedItems };
      }
    }
    return thread;
  }

  private phase(state: ThreadState): string {
    if (state.pending.size) return [...state.pending.values()].some(({ method }) => method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') ? 'WAITING_INPUT' : 'WAITING_APPROVAL';
    if (state.reserved || state.activeTurnId) return 'RUNNING';
    if (state.externalWriter) return 'EXTERNAL';
    if (state.nativeStatus?.type === 'active') return state.loaded && !state.released ? 'UNKNOWN' : 'EXTERNAL';
    if (state.contextUnknown || state.error || state.nativeStatus?.type === 'systemError') return 'UNKNOWN';
    if (state.released) return 'RELEASED';
    return 'IDLE';
  }

  private rememberThreadSource(thread: any): boolean | undefined {
    if(typeof thread?.id!=='string')return undefined;
    const state=this.state(thread.id);
    if(isSubagentThread(thread))state.subagent=true;
    else if(thread.source!==undefined&&state.subagent===undefined)state.subagent=false;
    return state.subagent;
  }

  private requireUserThread(thread: any): void {
    if(this.rememberThreadSource(thread))throw runtimeError(404,'RUNTIME_SUBAGENT_THREAD','子 Agent 会话不单独展示，请返回主会话。');
  }

  private async notification(threadId: string, eventKey: string, kind: 'complete' | 'failed' | 'approval' | 'input', target:{turnId?:string;itemId?:string;requestId?:string}={}): Promise<void> {
    const key = `${threadId}:${eventKey}`;
    if (this.notificationKeys.has(key)) return;
    this.notificationKeys.add(key);
    if (this.notificationKeys.size > REQUEST_LIMIT) this.notificationKeys.delete(this.notificationKeys.values().next().value!);
    const state=this.state(threadId);
    if(state.subagent===undefined){
      // Completion/request events carry no source. Read metadata only; never resume or load history.
      try{await this.call('thread/read',{threadId,includeTurns:false});}catch{return;}
    }
    if(state.subagent!==false||this.closed)return;
    this.emit('notification', { threadId, eventKey, kind, ...target });
  }

  private change(threadId: string, kind: string, patch: Patch = {}): void {
    const state = this.state(threadId);
    state.revision++;
    const sequence = ++this.sequence;
    if (state.syncHeader && patch.thread) Object.assign(state.syncHeader, structuredClone(patch.thread));
    if (state.syncTurns && patch.turn?.status) state.syncTurns.set(patch.turn.id, this.turnSignature(patch.turn));
    if (state.syncHeader && state.syncTurns && (patch.thread || patch.turn?.status)) this.cacheSync(threadId, state);
    const metadata = { phase: this.phase(state), activeTurnId: state.activeTurnId, pending: [...state.pending.values()].map(({requestId, method, params}) => ({requestId, method, params})), error: state.error ?? null, permissions: state.permissions ?? null, retry: state.retry ?? null, release: this.releaseState(state), model: state.model ?? null, ...(state.reasoningEffort !== undefined ? {reasoningEffort:state.reasoningEffort} : {}), titlePending: !!state.titleGeneration, unmaterialized: state.emptyThreadEpoch === this.epoch };
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
            try { if(state.released){if(!await this.finishThreadHandoff(id,state))await this.closeIdleServer();}else await this.release(id, true); } catch {}
          }
        } finally { this.releaseQueued = false; }
      });
    }
    if (this.closed || !this.server || this.inFlight || this.reads || [...this.states.values()].some((state) => state.reserved || state.activeTurnId || state.pending.size || state.recoverOnIdle || state.titleGeneration || state.nameWrite)) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const server = this.server;
    this.idleTimer = setTimeout(() => {
      if (this.server !== server) return;
      this.closeIdleServer().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async closeIdleServer(): Promise<boolean> {
    // An uncertain temporary start never blocks stopping our otherwise idle child;
    // AppServer.close settles its retained outcome and the process owns the remaining resource.
    if (this.stopping) { await this.stopping; return true; }
    const busy = () => [...this.states.values()].some(state => state.reserved || state.activeTurnId || state.pending.size || state.recoverOnIdle || state.titleGeneration || state.nameWrite || ['active', 'systemError'].includes(state.nativeStatus?.type));
    const deadline = Date.now() + 2000;
    while ((this.inFlight || this.reads) && !busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const server = this.server;
    if (!server || this.inFlight || this.reads || busy()) return false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.server = undefined;
    this.stopping = server.close().finally(()=>settleNativeTitleCleanup(server));
    try {
      await this.stopping;
      for (const [id, state] of this.states) {
        state.loaded = false;
        this.clearLiveState(state);
        await this.discardWriterLease(state);
        if (state.released&&!state.handoffReady) { state.handoffReady = true; this.change(id, 'release'); }
      }
    } finally { this.stopping = undefined; }
    return true;
  }

  private async discardWriterLease(state:ThreadState):Promise<boolean>{
    const lease=state.writerLease;state.writerLease=undefined;state.writerLeaseServer=undefined;state.nativeUnloaded=false;state.unloadReceipt?.resolve();state.unloadReceipt=undefined;
    try{await lease?.close();return true;}catch(error){this.writerCheckFailure([...this.states].find(([,value])=>value===state)?.[0]??'','helper_cleanup_failed',error);return false;}
  }

  private finishThreadHandoff(threadId:string,state:ThreadState):Promise<boolean>{
    if(state.handoffReady)return Promise.resolve(true);
    if(state.handoffCheck)return state.handoffCheck;
    const lease=state.writerLease,server=state.writerLeaseServer;
    if(!lease||!state.nativeUnloaded||!state.released||state.reserved||state.activeTurnId||state.pending.size||server!==this.server||this.closed)return Promise.resolve(false);
    const operation=async()=>{
      let released=false;
      let failure:unknown;
      try{released=await lease.released();}catch(error){failure=error;}
      if(state.writerLease!==lease||server!==this.server||this.closed||!state.released||state.reserved||state.activeTurnId||state.pending.size)return false;
      if(failure)this.writerCheckFailure(threadId,'probe_failed',failure);
      else this.options.diagnostic?.({event:'writer_release_check',threadId:diagnosticId(threadId),outcome:released?'released':'unconfirmed',reason:released?'positive_lock':'writer_held'});
      const cleaned=await this.discardWriterLease(state);
      if(released&&cleaned&&!this.closed&&server===this.server&&state.released&&!state.reserved&&!state.activeTurnId&&!state.pending.size){state.handoffReady=true;this.change(threadId,'release');return true;}
      return false;
    };
    state.handoffCheck=operation().finally(()=>{state.handoffCheck=undefined;});return state.handoffCheck;
  }

  private writerCheckFailure(threadId:string,reason:string,error:unknown):void{
    const exception=error instanceof Error?error:new Error(String(error));
    const errorMessage=exception.message.slice(0,2048),errorName=exception.name.slice(0,128);
    this.options.diagnostic?.({event:'writer_release_check',threadId:diagnosticId(threadId),outcome:'unconfirmed',reason,errorName,errorMessage,...(Number.isSafeInteger((error as any)?.win32Error)?{win32Error:(error as any).win32Error}:{})});
    if((error as any)?.code!=='WRITER_CHECK_NOT_HELD')console.error(`Writer release check ${reason}: ${errorName}: ${errorMessage}`);
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
    if (method === 'thread/fork' && isObject(error) && error.code === -32601) return runtimeError(409, 'RUNTIME_FORK_UNSUPPORTED', 'Native Codex does not support thread fork; upgrade the CLI');
    if (method === 'thread/read' && /^failed to read thread: thread-store internal error: failed to read session metadata .+: rollout at .+ is empty$/.test(message)) {
      return runtimeError(503, 'RUNTIME_HISTORY_NOT_READY', '会话历史暂不可读，原生记录仍为空，请稍后重试');
    }
    if (method === 'thread/items/list' && message === 'thread/items/list is not supported yet') return runtimeError(503, 'RUNTIME_ITEMS_UNSUPPORTED', 'Native item pagination is not supported');
    if (method === 'turn/steer' && /no active turn|expected.*turn|turn.*mismatch/i.test(message)) return runtimeError(409, 'RUNTIME_STEER_CONFLICT', '当前轮次已结束或变化，请刷新后重新发送');
    if (method === 'thread/turns/list' && message.trim().toLowerCase() === 'list_turns is not supported yet') return runtimeError(503, 'RUNTIME_HISTORY_UNSUPPORTED', 'Native turn history is not supported');
    if(method==='thread/read'&&isObject(error)&&error.code===-32601&&isObject(params)&&params.includeTurns===true&&message==='list_turns is not supported yet')return runtimeError(503,'RUNTIME_HISTORY_UNSUPPORTED','Native turn history is not supported');
    if (method === 'thread/turns/list' && isObject(error) && error.code===-32600 && isObject(params) && typeof params.threadId === 'string'
      && message === `thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) {
      return runtimeError(503, 'RUNTIME_HISTORY_NOT_MATERIALIZED', '会话历史尚未物化，请稍后重新同步。');
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
