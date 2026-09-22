import {appendFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import type {FastifyInstance} from 'fastify';

export type DiagnosticEvent=Record<string,unknown>;
export const diagnosticId=(value:unknown)=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value)?value:undefined;
export const diagnosticCode=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?value:typeof value==='string'&&/^[A-Z0-9_]{1,64}$/.test(value)?value:undefined;
const FILE_BYTES=1024*1024,QUEUE_BYTES=64*1024;

// Local, bounded metadata only. Callers must never pass request bodies or raw errors.
export class Diagnostics {
  private file:string;
  private queue:string[]=[];
  private queuedBytes=0;
  private size:number|undefined;
  private writing?:Promise<void>;
  private closed=false;
  private dropped=0;
  private writeFailures=0;
  private loop=monitorEventLoopDelay({resolution:20});
  private cpu=process.cpuUsage();
  private sampledAt=performance.now();
  private timer:ReturnType<typeof setInterval>;
  private sequence=0;
  private http=new Map<number,{id:number;method:string;route:string;threadId?:string;started:number}>();
  private active=0;
  private streams=0;
  private runtime:()=>unknown;

  constructor(directory:string,runtime:()=>unknown=()=>undefined){
    this.file=join(directory,'diagnostics.jsonl');this.runtime=runtime;
    this.loop.enable();this.timer=setInterval(()=>this.sample(),10_000);this.timer.unref();
    this.record({event:'start',parentPid:process.ppid,nodeVersion:process.version});
  }
  record=(event:DiagnosticEvent):void=>{
    if(this.closed)return;
    try {
      const line=JSON.stringify({...event,time:new Date().toISOString(),pid:process.pid})+'\n',bytes=Buffer.byteLength(line);
      if(bytes>16*1024||this.queuedBytes+bytes>QUEUE_BYTES){this.dropped++;return;}
      this.queue.push(line);this.queuedBytes+=bytes;
      this.startWrite();
    } catch {this.dropped++;}
  };
  private startWrite(){this.writing??=this.drain().finally(()=>{this.writing=undefined;if(this.queue.length)this.startWrite();});}
  private async drain(){
    let batchCount=0;
    try {
      this.size??=(await stat(this.file).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return {size:0};throw error;})).size;
      while(this.queue.length){
        const batch=this.queue.join('');batchCount=this.queue.length;this.queue=[];this.queuedBytes=0;const bytes=Buffer.byteLength(batch);
        if(this.size+bytes>FILE_BYTES){await rename(this.file,this.file+'.1');this.size=0;}
        await appendFile(this.file,batch,{mode:0o600});this.size+=bytes;batchCount=0;
      }
    } catch {
      this.writeFailures++;this.dropped+=batchCount+this.queue.length;this.queue=[];this.queuedBytes=0;this.size=undefined;
      if(this.writeFailures===1)console.error('Diagnostic log unavailable; service continues without durable diagnostics.');
    }
  }
  async flush(){while(this.writing)await this.writing;}
  sample=()=>{
    if(this.closed)return;
    try {
    const now=performance.now(),cpu=process.cpuUsage(),memory=process.memoryUsage();
    this.record({event:'sample',intervalMs:Math.round(now-this.sampledAt),cpuUserMs:(cpu.user-this.cpu.user)/1000,cpuSystemMs:(cpu.system-this.cpu.system)/1000,
      rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,externalBytes:memory.external,loopMaxMs:Math.round(this.loop.max/1e6),
      http:{active:this.active,streams:this.streams,tracked:this.http.size,pending:[...this.http.values()].slice(0,10).map(({started,...request})=>({...request,elapsedMs:Math.round(now-started)}))},
      runtime:this.runtime(),dropped:this.dropped,writeFailures:this.writeFailures});
    this.cpu=cpu;this.sampledAt=now;this.loop.reset();
    } catch {this.dropped++;}
  };
  attach(app:FastifyInstance){
    app.addHook('onRequest',async(request,reply)=>{
      const route=request.routeOptions.url;if(!route?.startsWith('/api/'))return;
      const stream=route.endsWith('/events'),id=++this.sequence,started=performance.now();
      const metadata={id,method:request.method,route,threadId:diagnosticId((request.params as any)?.threadId)};
      if(stream)this.streams++;else{this.active++;if(this.http.size<256)this.http.set(id,{...metadata,started});}
      let ended=false;
      const finish=(outcome:string)=>{
        if(ended)return;ended=true;
        if(stream)this.streams--;else{this.active--;this.http.delete(id);}
        const elapsedMs=Math.round(performance.now()-started);
        if((!stream&&(elapsedMs>=1000||outcome==='aborted'))||reply.statusCode>=500)this.record({event:'http_end',...metadata,elapsedMs,statusCode:reply.statusCode,outcome});
      };
      reply.raw.once('finish',()=>finish('complete'));
      reply.raw.once('close',()=>finish(reply.raw.writableFinished?'complete':'aborted'));
    });
  }
  async close(){
    if(!this.closed){clearInterval(this.timer);this.loop.disable();this.record({event:'stop'});this.closed=true;}
    await this.flush();
  }
}
