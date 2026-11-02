import type {ExtensionReadError,ExtensionReadErrorCode,ExtensionSection} from './extensions.ts';

export type ExtensionReadContext={epoch:string;home:string;cwd:string;authRevision:number;configGeneration:number};
export type ExtensionCachePolicy={ttlMs:number;maxAgeMs:number};
export type ExtensionCached<T>={data:T;fetchedAt:number;lastSuccessAt:number;stale:boolean;error?:ExtensionReadError};
type Entry={context:string;key:string;data?:unknown;hasData:boolean;successAt:number;attemptAt:number;error?:ExtensionReadError;pending?:Promise<ExtensionCached<any>>;invalidated:boolean};
const codes=new Set<ExtensionReadErrorCode>(['UPSTREAM_CHALLENGE','UPSTREAM_FORBIDDEN','UNAUTHENTICATED','UNSUPPORTED','TIMEOUT','INVALID_RESPONSE','CATALOG_LIMIT','UNAVAILABLE']);
const contextChanged=()=>Object.assign(new Error('原生上下文已变化，请重新读取。'),{code:'EXTENSION_CONTEXT_CHANGED',statusCode:503});
function safeError(value:any):ExtensionReadError{return {code:codes.has(value?.code)?value.code:'UNAVAILABLE',...(Number.isSafeInteger(value?.rpcCode)?{rpcCode:value.rpcCode}:{}),...(Number.isInteger(value?.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?{httpStatus:value.httpStatus}:{})};}

export class ExtensionCatalogCache {
 private entries=new Map<string,Entry>();
 private contexts=new Map<string,true>();
 private now:()=>number;
 private maxContexts:number;
 private maxSearchPages:number;
 constructor(options:{now?:()=>number;maxContexts?:number;maxSearchPages?:number}={}){this.now=options.now??Date.now;this.maxContexts=options.maxContexts??32;this.maxSearchPages=options.maxSearchPages??64;}
 private id(context:ExtensionReadContext){return JSON.stringify([context.epoch,context.home,context.cwd,context.authRevision,context.configGeneration]);}
 private touch(context:string,key:string,entry:Entry){
  this.contexts.delete(context);this.contexts.set(context,true);this.entries.delete(key);this.entries.set(key,entry);
  while(this.contexts.size>this.maxContexts){const oldest=this.contexts.keys().next().value!;this.contexts.delete(oldest);for(const [id,item]of this.entries)if(item.context===oldest)this.entries.delete(id);}
  const pages=[...this.entries].filter(([,item])=>item.key.startsWith('search:'));
  for(let i=0;i<pages.length-this.maxSearchPages;i++)this.entries.delete(pages[i][0]);
 }
 private result<T>(entry:Entry,stale:boolean):ExtensionCached<T>{return {data:entry.data as T,fetchedAt:entry.attemptAt,lastSuccessAt:entry.successAt,stale,...(entry.error?{error:entry.error}:{})};}
 seed<T>(context:ExtensionReadContext,key:string,value:ExtensionCached<T>){
  if(value.stale||value.error)return;
  const ctx=this.id(context),id=JSON.stringify([ctx,key]);if(this.entries.has(id))return;
  this.touch(ctx,id,{context:ctx,key,data:value.data,hasData:true,successAt:value.lastSuccessAt,attemptAt:value.fetchedAt,invalidated:false});
 }
 async read<T>(context:ExtensionReadContext,key:string,policy:ExtensionCachePolicy,load:()=>Promise<T>,refresh=false):Promise<ExtensionCached<T>>{
  const ctx=this.id(context),id=JSON.stringify([ctx,key]),now=this.now();let entry=this.entries.get(id);
  if(!entry){entry={context:ctx,key,hasData:false,successAt:0,attemptAt:0,invalidated:false};}
  this.touch(ctx,id,entry);
  if(entry.pending)return entry.pending;
  const age=now-entry.successAt,usable=entry.hasData&&age<=policy.maxAgeMs;
  if(!refresh&&entry.error&&now-entry.attemptAt<5000){if(usable)return this.result<T>(entry,true);throw Object.assign(new Error('扩展来源暂时不可用。'),entry.error,{statusCode:503});}
  if(!refresh&&usable&&!entry.error&&age<policy.ttlMs)return this.result<T>(entry,false);
  const current=entry;
  current.pending=Promise.resolve().then(load).then(data=>{
   if(current.invalidated)throw contextChanged();
   current.data=data;current.hasData=true;current.successAt=this.now();current.attemptAt=current.successAt;current.error=undefined;
   return this.result<T>(current,false);
  },error=>{
   if(current.invalidated)throw contextChanged();
   current.attemptAt=this.now();current.error=safeError(error);
   if(current.hasData&&current.attemptAt-current.successAt<=policy.maxAgeMs)return this.result<T>(current,true);
   current.hasData=false;current.data=undefined;
   throw Object.assign(new Error('扩展来源暂时不可用。'),current.error,{statusCode:503});
  }).finally(()=>{current.pending=undefined;});
  return current.pending;
 }
 invalidate(context?:ExtensionReadContext,namespaces?:Array<ExtensionSection|'search'>){
  const ctx=context?this.id(context):null;
  for(const [id,entry]of this.entries){if((ctx===null||entry.context===ctx)&&(!namespaces||namespaces.some(n=>entry.key===n||entry.key.startsWith(n+':')))){entry.invalidated=true;this.entries.delete(id);}}
  if(!namespaces){if(ctx===null)this.contexts.clear();else this.contexts.delete(ctx);}
 }
}
