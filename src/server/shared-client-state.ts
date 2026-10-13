import type {Runtime} from '../codex/runtime.ts';
import type {AccountUsage} from './account-usage.ts';
import type {DiagnosticEvent} from './diagnostics.ts';

export type SessionQuery={cursor?:string;sortKey:'updated_at'|'created_at';archived:boolean;includeHidden:boolean;searchTerm:string};
type HardReason='metadata'|'name'|'thread'|'archive'|'resync';
type SoftReason='status'|'release'|'turn'|'fork';
type Entry={id:number;query:SessionQuery;lastUsed:number;updatedAt:number;version:number;dirty:boolean;pending?:boolean;followupDeadline?:number;readId?:number;data?:any;job?:Promise<any>;controller?:AbortController;failedAt?:number;error?:ReturnType<typeof publicError>;failure?:unknown};
const lifetime=5*60_000,capacity=32;
const unavailable=()=>Object.assign(new Error('共享状态读取暂不可用，请稍后刷新。'),{statusCode:503,code:'SHARED_STATE_UNAVAILABLE'});
const publicError=(cause:any)=>({message:typeof cause?.code==='string'&&/^(ACCOUNT_|RUNTIME_|SESSION_|SHARED_)/.test(cause.code)?String(cause.message):'后台更新暂时失败，请稍后刷新。',...(typeof cause?.code==='string'?{code:cause.code}:{})});

export class SharedClientState {
  private entries=new Map<string,Entry>();
  private clients=new Set<{valid:()=>boolean;write:(kind:string,data:any)=>void}>();
  private timer?:ReturnType<typeof setInterval>;
  private refreshTimer?:ReturnType<typeof setTimeout>;
  private cycle?:Promise<void>;
  private usageDirty=false;
  private sessionsDirty=false;
  private closed=false;
  private revision=0;
  private entrySequence=0;
  private readSequence=0;
  private diagnostic?:(event:DiagnosticEvent)=>void;
  private usageError?:ReturnType<typeof publicError>;
  private runtime:Runtime;
  private usage:AccountUsage;
  private load:(query:SessionQuery,signal:AbortSignal)=>Promise<any>;
  constructor(runtime:Runtime,usage:AccountUsage,load:(query:SessionQuery,signal:AbortSignal)=>Promise<any>,diagnostic?:(event:DiagnosticEvent)=>void){
    this.runtime=runtime;this.usage=usage;this.load=load;this.diagnostic=diagnostic;runtime.on('change',this.changed);usage.on('updated',this.usageUpdated);usage.on('invalidated',this.usageInvalidated);usage.on('refreshNeeded',this.usageChanged);
  }
  private record(event:DiagnosticEvent){try{this.diagnostic?.(event);}catch{/* Diagnostics cannot affect shared reads. */}}
  private publish(kind:string,data:any){for(const client of [...this.clients]){if(client.valid())client.write(kind,data);else this.clients.delete(client);}this.stopIfEmpty();}
  invalidateProjectCatalog(){this.publish('project-catalog-invalidated',{});}
  private usageUpdated=(data:any)=>{this.usageError=undefined;this.publish('usage',data);};
  private usageInvalidated=(event?:{refresh?:boolean})=>{this.usageError=undefined;this.publish('usage-invalidated',{});if(event?.refresh!==false)this.usageChanged();};
  private usageChanged=()=>{this.usageDirty=true;this.schedule();};
  private changed=(event:any)=>{
    if(['name','thread','archive','resync'].includes(event.kind))this.invalidateSessions(event.kind);
    else if(['status','release'].includes(event.kind)||(event.kind==='turn'&&['inProgress','completed','failed','interrupted'].includes(event.patch?.turn?.status)))this.refreshSessions(event.kind);
  };
  invalidateSessions(reason:HardReason='metadata'){for(const entry of this.entries.values()){entry.version++;entry.dirty=false;entry.updatedAt=0;entry.data=undefined;entry.pending=false;entry.failedAt=undefined;entry.error=undefined;entry.failure=undefined;this.record({event:'shared_sessions_invalidation',entryId:entry.id,readId:entry.readId,kind:'hard',reason,version:entry.version});}this.sessionsDirty=true;this.schedule();}
  refreshSessions(reason:SoftReason='status'){for(const entry of this.entries.values()){const changed=!entry.dirty;entry.dirty=true;if(changed)this.record({event:'shared_sessions_invalidation',entryId:entry.id,readId:entry.readId,kind:'soft',reason,version:entry.version});}this.sessionsDirty=true;this.schedule();}
  private prune(){const now=Date.now();for(const [key,entry] of this.entries)if(!entry.job&&now-entry.lastUsed>=lifetime)this.entries.delete(key);}
  private schedule(){if(this.closed||(!this.clients.size&&!this.sessionsDirty)||this.refreshTimer)return;this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;void this.refresh(false);},100);this.refreshTimer.unref();}
  private stopIfEmpty(){if(this.clients.size)return;clearInterval(this.timer);clearTimeout(this.refreshTimer);this.timer=undefined;this.refreshTimer=undefined;}
  subscribe(valid:()=>boolean,write:(kind:string,data:any)=>void){
    if(this.closed)return ()=>{};
    const client={valid,write};this.clients.add(client);
    if(!this.timer){this.timer=setInterval(()=>void this.refresh(true),60_000);this.timer.unref();}
    const snapshot=this.usage.snapshot();if(snapshot){write('usage',snapshot);if(this.usageError)write('usage-error',this.usageError);}
    else void this.readUsage().catch(()=>{});
    return ()=>{this.clients.delete(client);this.stopIfEmpty();};
  }
  private usageFailed(cause:unknown){if(!this.closed){this.usageError=publicError(cause);this.publish('usage-error',this.usageError);}}
  async readUsage(refresh=false){try{return await this.usage.read(refresh);}catch(cause){this.usageFailed(cause);throw cause;}}
  private refresh(periodic:boolean):Promise<void>{
    for(const client of [...this.clients])if(!client.valid())this.clients.delete(client);this.stopIfEmpty();
    if(this.closed||(!this.clients.size&&!this.sessionsDirty))return Promise.resolve();
    if(this.cycle)return this.cycle;
    this.prune();const usage=periodic||this.usageDirty,sessions=periodic||this.sessionsDirty;this.usageDirty=false;this.sessionsDirty=false;
    this.cycle=Promise.allSettled([...(usage?[this.usage.refreshBackground().catch(cause=>this.usageFailed(cause))]:[]),...(sessions?[...this.entries.values()].map(entry=>this.readSessions(entry.query,periodic||!!entry.pending,false)):[])]).then(()=>{}).finally(()=>{this.cycle=undefined;if(this.usageDirty||this.sessionsDirty)this.schedule();});
    return this.cycle;
  }
  readSessions(query:SessionQuery,refresh=false,touch=true,requestId?:string):Promise<any>{
    if(this.closed)return Promise.reject(unavailable());
    this.prune();const key=JSON.stringify([query.sortKey,query.archived,query.includeHidden,query.searchTerm,query.cursor??null]);
    let entry=this.entries.get(key);
    if(!entry){
      if(this.entries.size>=capacity){const oldest=[...this.entries].filter(([,value])=>!value.job).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];if(!oldest)return Promise.reject(unavailable());this.entries.delete(oldest[0]);}
      entry={id:++this.entrySequence,query,lastUsed:Date.now(),updatedAt:0,version:0,dirty:false};this.entries.set(key,entry);
    }
    if(touch)entry.lastUsed=Date.now();
    const correlation={entryId:entry.id,requestId:typeof requestId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(requestId)?requestId:undefined};
    if(entry.followupDeadline!==undefined&&Date.now()>=entry.followupDeadline){if(entry.job){if(refresh){const previous=entry.job;entry.controller?.abort(unavailable());return previous.catch(()=>{}).then(()=>this.readSessions(query,refresh,touch,requestId));}}else{entry.followupDeadline=undefined;entry.dirty=false;}}
    if(entry.job){this.record({event:'shared_sessions_join',...correlation,readId:entry.readId,version:entry.version});return entry.job;}
    if(!refresh&&entry.pending)return Promise.resolve({pending:true});
    if(!refresh&&entry.error&&entry.failedAt!==undefined&&Date.now()-entry.failedAt<60_000){this.record({event:'shared_sessions_cache',...correlation,readId:entry.readId,version:entry.version,outcome:entry.data?'stale':'failure'});return entry.data?Promise.resolve({...entry.data,stale:true,error:entry.error}):Promise.reject(entry.failure);}
    if(!refresh&&!entry.dirty&&entry.data&&entry.updatedAt&&Date.now()-entry.updatedAt<60_000){this.record({event:'shared_sessions_cache',...correlation,readId:entry.readId,version:entry.version,outcome:'fresh'});return Promise.resolve(entry.data);}
    const owned=entry,controller=new AbortController();owned.controller=controller;
    const readId=++this.readSequence,started=performance.now();owned.readId=readId;let attempts=0,outcome='ok';
    this.record({event:'shared_sessions_start',...correlation,readId,version:owned.version,reason:refresh?(touch?'manual':'periodic'):owned.dirty?'soft':owned.data?'expired':'miss'});
    const timeout=setTimeout(()=>{outcome='deadline';controller.abort(unavailable());},Math.max(1,Math.min(30_000,(owned.followupDeadline??Date.now()+30_000)-Date.now())));timeout.unref();
    const stopped=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    let readVersion=owned.version;
    const loading=(async()=>{
      for(let attempt=0;attempt<2;attempt++){
        const version=owned.version;readVersion=version;owned.dirty=false;attempts++;const result=await this.load(query,controller.signal);controller.signal.throwIfAborted();
        if(version!==owned.version){if(attempt===0)continue;readVersion=owned.version;outcome='version-conflict';owned.pending=true;owned.dirty=true;owned.followupDeadline??=Date.now()+30_000;if(Date.now()>=owned.followupDeadline){owned.followupDeadline=undefined;owned.dirty=false;}return {pending:true};}
        owned.pending=false;owned.followupDeadline=undefined;owned.data=result;owned.updatedAt=Date.now();owned.error=undefined;owned.failedAt=undefined;owned.failure=undefined;this.publish('sessions',{revision:++this.revision});return result;
      }
    })();
    owned.job=Promise.race([loading,stopped]).catch(cause=>{if(outcome==='ok')outcome=this.closed?'closed':'load-error';owned.pending=false;owned.followupDeadline=undefined;owned.dirty=false;if(!this.closed&&readVersion===owned.version){owned.error=publicError(cause);owned.failedAt=Date.now();owned.failure=cause;this.publish('sessions',{revision:++this.revision});}throw cause;}).finally(()=>{clearTimeout(timeout);owned.job=undefined;owned.controller=undefined;if(owned.followupDeadline!==undefined&&Date.now()>=owned.followupDeadline){owned.followupDeadline=undefined;owned.dirty=false;}this.record({event:'shared_sessions_end',...correlation,readId,version:owned.version,attempts,outcome,elapsedMs:Math.round(performance.now()-started)});if(!this.closed&&owned.dirty&&(!owned.followupDeadline||Date.now()<owned.followupDeadline)){this.sessionsDirty=true;this.schedule();}});return owned.job;
  }
  close(){this.closed=true;clearInterval(this.timer);clearTimeout(this.refreshTimer);this.runtime.off('change',this.changed);this.usage.off('updated',this.usageUpdated);this.usage.off('invalidated',this.usageInvalidated);this.usage.off('refreshNeeded',this.usageChanged);for(const entry of this.entries.values())entry.controller?.abort(unavailable());this.entries.clear();this.clients.clear();}
}
