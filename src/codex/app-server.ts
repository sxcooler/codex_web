import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {diagnosticCode,diagnosticId,type DiagnosticEvent} from '../server/diagnostics.ts';

type Id = string | number;
type Options = { executable: string; args?: string[]; cwd?: string; timeoutMs?: number; maxMessageBytes?: number; diagnostic?:(event:DiagnosticEvent)=>void };
type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; method:string;threadId?:string;started:number };
const isId = (value: unknown): value is Id => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private timeoutMs: number;
  private maxMessageBytes: number;
  private pending = new Map<Id, Pending>();
  private approvals = new Set<Id>();
  private nextId = 0;
  private parts: Buffer[] = [];
  private frameBytes = 0;
  private stopped: Error | undefined;
  private closing = false;
  private ended: Promise<void>;
  private closePromise?: Promise<void>;
  private initialization?: Promise<unknown>;
  private diagnostic?:Options['diagnostic'];
  private receivedBytes=0;
  private lastReceived=performance.now();

  constructor(options: Options) {
    super();
    this.diagnostic=options.diagnostic;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1) {
      throw new Error('timeoutMs and maxMessageBytes must be positive integers');
    }
    const env = { ...process.env };
    // A new Web runtime must not inherit the hosting client's identity or active thread.
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    this.child = spawn(options.executable, options.args ?? ['app-server'], {
      cwd: options.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.record({event:'native_start'});
    this.ended = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.record({event:'native_exit',exitCode:code,signal,expected:this.closing});
        if (!this.closing) this.fail(new Error(`App-server exited (code ${code}, signal ${signal})`));
        resolve();
      });
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('error', (error) => this.fail(error));
    this.child.stderr.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (chunk: Buffer) => {this.receivedBytes+=chunk.length;this.lastReceived=performance.now();this.consume(chunk);});
    this.child.stdout.on('end', () => {
      if (this.frameBytes) this.fail(new Error('Incomplete JSONL protocol frame at EOF'));
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.emit('diagnostic', chunk.slice(0, 8192)));
  }

  initialize(): Promise<unknown> {
    return this.initialization ??= this.request('initialize', {
      clientInfo: { name: 'codex_remote_web', title: 'Codex Web', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    }).then((result) => { this.notify('initialized', {}); return result; });
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = this.nextId++;
    const started=performance.now(),threadId=diagnosticId(isObject(params)?params.threadId:undefined);
    const finish=(outcome:string,error?:any)=>{const elapsedMs=Math.round(performance.now()-started);if(elapsedMs>=1000||outcome!=='ok')this.record({event:'rpc_end',id,method,threadId,elapsedMs,outcome,errorCode:diagnosticCode(error?.code)});};
    let timedOut=false;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut=true;
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out; outcome is uncertain, do not automatically retry`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer,method,threadId,started });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    }).then(result=>{finish('ok');return result;},error=>{finish(timedOut?'timeout':'error',error);throw error;});
  }

  private record(event:DiagnosticEvent){try{this.diagnostic?.({...event,nativePid:this.child.pid});}catch{/* Diagnostics cannot change RPC outcomes. */}}
  diagnosticState(){return {nativePid:this.child.pid,pendingCount:this.pending.size,receivedBytes:this.receivedBytes,lastReceivedAgoMs:Math.round(performance.now()-this.lastReceived),pending:[...this.pending.entries()].slice(0,10).map(([id,pending])=>({id,method:pending.method,threadId:pending.threadId,elapsedMs:Math.round(performance.now()-pending.started)}))};}

  notify(method: string, params: unknown): void { this.send({ method, params }); }

  respond(id: Id, result: unknown): void { this.answer(id, { id, result }); }

  respondError(id: Id, code: number, message: string): void {
    if (!Number.isSafeInteger(code) || typeof message !== 'string') throw new Error('Invalid RPC error');
    this.answer(id, { id, error: { code, message } });
  }

  private answer(id: Id, message: Record<string, unknown>): void {
    if (!this.approvals.has(id)) throw new Error('No pending server request: stale or already answered');
    this.send(message);
    this.approvals.delete(id);
  }

  private send(message: Record<string, unknown>): void {
    if (this.stopped) throw this.stopped;
    if ('method' in message && (typeof message.method !== 'string' || !message.method)) throw new Error('Invalid RPC method');
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > this.maxMessageBytes) throw new Error('Outgoing message exceeds maxMessageBytes');
    if ('result' in message && !Object.hasOwn(JSON.parse(line), 'result')) throw new Error('RPC result must be a JSON value');
    this.child.stdin.write(line + '\n', (error) => { if (error) this.fail(error); });
  }

  private consume(chunk: Buffer): void {
    if (this.stopped) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.frameBytes += part.length;
      if (this.frameBytes > this.maxMessageBytes) { this.fail(new Error('Protocol frame exceeds maxMessageBytes')); return; }
      this.parts.push(part);
      if (newline < 0) return;
      const frame = Buffer.concat(this.parts, this.frameBytes);
      this.parts = [];
      this.frameBytes = 0;
      try { this.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame))); }
      catch { this.fail(new Error('Invalid JSON/protocol frame')); return; }
      if (this.stopped) return;
      offset = newline + 1;
    }
  }

  private receive(message: unknown): void {
    if (!isObject(message)) throw new Error('Expected protocol object');
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !isId(message.id)) throw new Error('Invalid request id');
    if (Object.hasOwn(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method || 'result' in message || 'error' in message) throw new Error('Invalid method message');
      if (hasId) {
        if (this.approvals.has(message.id)) throw new Error('Duplicate pending server request id');
        this.approvals.add(message.id);
        this.emit('request', message);
      } else {
        if (message.method === 'serverRequest/resolved') {
          if (!isObject(message.params) || !isId(message.params.requestId)) throw new Error('Invalid resolved request id');
          this.approvals.delete(message.params.requestId);
        }
        this.emit('notification', message);
      }
      return;
    }
    if (!hasId || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error('Invalid response');
    if ('error' in message && (!isObject(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string')) throw new Error('Invalid RPC error');
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out request can still finish; never send it again.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(Object.assign(new Error(message.error.message), message.error));
    else pending.resolve(message.result);
  }

  private stop(error: Error): void {
    this.stopped ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.approvals.clear();
    this.parts = [];
    this.frameBytes = 0;
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.record({event:'native_failure',reason:/frame|JSON|protocol|maxMessageBytes/i.test(error.message)?'protocol':'transport',errorCode:diagnosticCode((error as any).code)});
    this.stop(error);
    this.child.kill();
    this.emit('failure', error);
  }

  close(): Promise<void> {
    return this.closePromise ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.stop(new Error('App-server closed'));
    this.child.stdin.end();
    let timeoutError: Error | undefined;
    const timer = setTimeout(() => {
      timeoutError = new Error('App-server shutdown timed out after 5000 ms; killed owned child');
      this.child.kill();
      this.emit('failure', timeoutError);
    }, 5000);
    try { await this.ended; }
    finally { clearTimeout(timer); }
    if (timeoutError) throw timeoutError;
  }
}
