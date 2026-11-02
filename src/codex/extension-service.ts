import {createHash} from 'node:crypto';
import {ExtensionCatalogCache,type ExtensionReadContext} from './extension-cache.ts';
import {readExtensionSection,searchExtensions,classifyExtensionReadError} from './extension-catalog.ts';
import {changeExtension,type ExtensionPeer,type ExtensionSection,type ExtensionSectionSnapshot,type ExtensionSearchPage,type ExtensionMutation,type ExtensionItem,type ExtensionsSnapshot} from './extensions.ts';
type Identity={base:string;context:ExtensionReadContext;peer:ExtensionPeer;state:{version?:string;sequence:number;generation:number}};
type Target={base:string;contextKey:string;kind:ExtensionItem['kind'];id:string;expiresAt:number;query?:string;cursor?:string;key:string};
type SearchHistory={base:string;updatedAt:number;pages:Map<string,{next:string|null;keys:string[]}>};
const ttl:Record<ExtensionSection,number>={installed:30_000,apps:300_000,mcp:15_000,marketplaces:30_000};
const unavailable=()=>Object.assign(Error('原生上下文已变化，请重新读取。'),{statusCode:503,code:'EXTENSION_CONTEXT_CHANGED'});
const stale=()=>Object.assign(Error('目录对象已变化，请刷新后再操作。'),{statusCode:409,code:'EXTENSION_STALE'});

export class ExtensionService {
 private cache=new ExtensionCatalogCache();
 private authRevision=0;
 private sequence=0;
 private lastEpoch='';
 private identities=new Map<string,Identity['state']>();
 private targets=new Map<string,Target>();
 private unsupportedApps=new Map<string,Set<string>>();
 private searchHistory=new Map<string,SearchHistory>();
 private pendingWrites=new Map<string,{required:ExtensionSection[];remaining:Set<ExtensionSection>}>();
 private options:{peer:(cwd:string)=>Promise<ExtensionPeer>;epoch:()=>string;normalize:(path:string)=>string};
 constructor(options:{peer:(cwd:string)=>Promise<ExtensionPeer>;epoch:()=>string;normalize:(path:string)=>string}){this.options=options;}
 private key(context:ExtensionReadContext){return createHash('sha256').update(JSON.stringify(context)).digest('hex');}
 invalidate(method?:string){
  if(method==='app/list/updated'){this.cache.invalidate(undefined,['apps']);return;}
  if(method==='account/rateLimits/updated')return;
  this.authRevision++;this.cache.invalidate();this.identities.clear();this.targets.clear();this.unsupportedApps.clear();this.searchHistory.clear();this.pendingWrites.clear();
 }
 private async identity(cwd:string):Promise<Identity>{
  const original=await this.options.peer(cwd),epoch=this.options.epoch();
  if(this.lastEpoch!==epoch){this.cache.invalidate();this.identities.clear();this.targets.clear();this.unsupportedApps.clear();this.searchHistory.clear();this.pendingWrites.clear();this.lastEpoch=epoch;}
  const home=this.options.normalize(original.home),path=this.options.normalize(cwd),base=JSON.stringify([epoch,home,path,this.authRevision]);
  let state=this.identities.get(base);if(!state){state={sequence:0,generation:0};this.identities.set(base,state);}
  this.identities.delete(base);this.identities.set(base,state);
  while(this.identities.size>32){const oldest=this.identities.keys().next().value!;this.identities.delete(oldest);this.unsupportedApps.delete(oldest);for(const [key,target]of this.targets)if(target.base===oldest)this.targets.delete(key);for(const [key,value]of this.searchHistory)if(value.base===oldest)this.searchHistory.delete(key);}
  const context={epoch,home,cwd:path,authRevision:this.authRevision,configGeneration:state.generation};
  const peer={...original,request:async(method:string,params:any)=>{
   const modern=method==='app/installed'||method==='app/read';
   if(modern&&this.unsupportedApps.get(base)?.has(method))throw Object.assign(Error('Method not found'),{code:-32601});
   try{return await original.request(method,params);}catch(error){if(modern&&classifyExtensionReadError(error).code==='UNSUPPORTED'){let methods=this.unsupportedApps.get(base);if(!methods){methods=new Set();this.unsupportedApps.set(base,methods);}methods.add(method);}throw error;}
  }};
  return {base,context,peer,state};
 }
 private assertCurrent(id:Identity){if(id.context.epoch!==this.options.epoch()||id.context.authRevision!==this.authRevision||this.identities.get(id.base)!==id.state)throw unavailable();}
 private observe(id:Identity,version:string|null,sequence:number){
  this.assertCurrent(id);if(version===null)return;
  if(sequence<id.state.sequence&&version!==id.state.version)throw unavailable();
  id.state.sequence=Math.max(sequence,id.state.sequence);
  if(id.state.version!==version){
   this.cache.invalidate(id.context);id.state.generation++;
   const pending=this.pendingWrites.get(id.base);if(pending)pending.remaining=new Set(pending.required);
   for(const [key,target]of this.targets)if(target.base===id.base)this.targets.delete(key);
   for(const [key,value]of this.searchHistory)if(value.base===id.base)this.searchHistory.delete(key);
  }
  id.state.version=version;id.context={...id.context,configGeneration:id.state.generation};
 }
 private register(id:Identity,items:ExtensionItem[],search?:{query:string;cursor?:string}){
  const contextKey=this.key(id.context),now=Date.now();
  for(const [key,target]of this.targets)if(target.expiresAt<=now)this.targets.delete(key);
  for(const item of items){const key=JSON.stringify([contextKey,item.key]),previous=this.targets.get(key);this.targets.set(key,{base:id.base,contextKey,kind:item.kind,id:item.id,key:item.key,expiresAt:now+60_000,...(previous?.query?{query:previous.query,cursor:previous.cursor}:{}),...search});}
  while(this.targets.size>5000)this.targets.delete(this.targets.keys().next().value!);
 }
 async read(cwd:string,options:{section?:ExtensionSection;refresh?:boolean;key?:string}={}):Promise<ExtensionSectionSnapshot>{
  const section=options.section??'installed';
  if(!Object.hasOwn(ttl,section)||options.key!==undefined&&(section!=='mcp'||!/^[a-f0-9]{64}$/.test(options.key)))throw Object.assign(Error('扩展读取参数无效。'),{statusCode:400,code:'EXTENSION_INVALID_INPUT'});
  for(let attempt=0;;attempt++){
   const id=await this.identity(cwd),key=section==='mcp'?`mcp:${options.key?'detail:'+options.key:'status'}`:section;
   let sequence=0;
   try{
    const result=await this.cache.read(id.context,key,{ttlMs:ttl[section],maxAgeMs:900_000},async()=>{
     sequence=++this.sequence;
     try{return await readExtensionSection(id.peer,cwd,section,options);}catch(error){if((error as any)?.code==='EXTENSION_INVALID_INPUT')throw error;throw classifyExtensionReadError(error);}
    },options.refresh);
    this.assertCurrent(id);
    if(id.context.configGeneration!==id.state.generation)throw unavailable();
    const generation=id.state.generation;
    if(sequence)this.observe(id,result.data.userVersion,sequence);
    // Carry only this verified result across the configuration fence; older pending reads must retry.
    if(generation!==id.state.generation)this.cache.seed(id.context,key,result);
    if(result.data.userVersion!==null&&id.state.version!==undefined&&result.data.userVersion!==id.state.version)throw unavailable();
    id.context={...id.context,configGeneration:id.state.generation};
    const sources=result.error?[...result.data.sources.filter(source=>source.id!==section),{id:section,status:'error' as const,count:null,reason:'The native catalog could not be read. Refresh before changing it.',...result.error,failedAt:result.fetchedAt,lastSuccessAt:result.lastSuccessAt}]:result.data.sources;
    const pending=this.pendingWrites.get(id.base);
    if(pending&&options.refresh&&!options.key&&!result.stale&&!result.error&&!sources.some(s=>s.id!=='skill-recommendations'&&['error','unsupported','partial'].includes(s.status))){pending.remaining.delete(section);if(!pending.remaining.size)this.pendingWrites.delete(id.base);}
    const data={...result.data,section,contextKey:this.key(id.context),sources,cache:{fetchedAt:result.fetchedAt,lastSuccessAt:result.lastSuccessAt,stale:result.stale},writePendingSections:[...(this.pendingWrites.get(id.base)?.remaining??[])]};
    this.register(id,data.items);return data;
   }catch(error){
    if((error as any)?.code==='EXTENSION_CONTEXT_CHANGED'){if(attempt===0){this.cache.invalidate(id.context,[section]);continue;}throw error;}
    if((error as any)?.statusCode===400)throw error;
    this.assertCurrent(id);const safe=classifyExtensionReadError(error),now=Date.now();
    return {host:'native',scope:cwd,userVersion:id.state.version??null,writable:false,items:[],available:[],marketplaces:[],limitations:[],updatedAt:now,section,contextKey:this.key(id.context),cache:{fetchedAt:now,lastSuccessAt:null,stale:false},sources:[{id:section,status:safe.code==='UNSUPPORTED'?'unsupported':'error',count:null,reason:'The native catalog could not be read. Refresh before changing it.',...safe,failedAt:now}],writePendingSections:[...(this.pendingWrites.get(id.base)?.remaining??[])]};
   }
  }
 }
 async search(cwd:string,input:{query:string;cursor?:string;refresh?:boolean}):Promise<ExtensionSearchPage>{
  const query=typeof input.query==='string'?input.query.trim():'';
  if(!query||query.length>200||/[\x00-\x1f]/.test(query)||input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>4096||/[\x00-\x1f]/.test(input.cursor)))throw Object.assign(Error('扩展搜索参数无效。'),{statusCode:400,code:'EXTENSION_INVALID_INPUT'});
  const id=await this.identity(cwd);
  for(const [key,value]of this.searchHistory)if(Date.now()-value.updatedAt>900_000)this.searchHistory.delete(key);
  const historyKey=JSON.stringify([this.key(id.context),query]);
  if(input.refresh&&!input.cursor){this.cache.invalidate(id.context,['search']);for(const [key,value]of this.searchHistory)if(value.base===id.base)this.searchHistory.delete(key);}
  let history=this.searchHistory.get(historyKey);if(!history){history={base:id.base,updatedAt:Date.now(),pages:new Map()};this.searchHistory.set(historyKey,history);}
  this.searchHistory.delete(historyKey);this.searchHistory.set(historyKey,history);while(this.searchHistory.size>64)this.searchHistory.delete(this.searchHistory.keys().next().value!);
  try{
  if(input.cursor&&![...history.pages.values()].some(page=>page.next===input.cursor))throw Object.assign(Error('Search cursor expired'),{code:'CATALOG_LIMIT'});
  const result=await this.cache.read(id.context,'search:'+JSON.stringify([query,input.cursor??null]),{ttlMs:60_000,maxAgeMs:900_000},async()=>{
   try{return await searchExtensions(id.peer,cwd,{...input,query});}catch(error){if((error as any)?.statusCode===400)throw error;throw classifyExtensionReadError(error);}
  },input.refresh);
  this.assertCurrent(id);if(id.context.configGeneration!==id.state.generation)throw unavailable();
  const source=result.error?{...result.data.source,status:'error' as const,count:null,...result.error,failedAt:result.fetchedAt,lastSuccessAt:result.lastSuccessAt}:result.data.source;
  const cursor=input.cursor??'',seen=new Set([cursor]);let next=result.data.nextCursor;
  while(next!==null){if(seen.has(next))throw Object.assign(Error('Search cursor cycle'),{code:'CATALOG_LIMIT'});seen.add(next);const known=history.pages.get(next);if(!known)break;next=known.next;}
  const previous=new Set<string>();let before='';const traversed=new Set<string>();
  while(before!==cursor&&!traversed.has(before)){traversed.add(before);const known=history.pages.get(before);if(!known)break;for(const key of known.keys)previous.add(key);if(known.next===null)break;before=known.next;}
  const items=result.data.items.filter(item=>!previous.has(item.key));
  if(!result.error){history.updatedAt=Date.now();history.pages.set(cursor,{next:result.data.nextCursor,keys:result.data.items.map(item=>item.key)});}
  // Keep cycle/dedup evidence bounded without imposing a 64-page browsing limit.
  const size=()=>[...this.searchHistory.values()].reduce((total,h)=>{total.pages+=h.pages.size;for(const p of h.pages.values())total.items+=p.keys.length;return total;},{pages:0,items:0});
  let used=size();while(used.pages>4096||used.items>64_000){const oldest=this.searchHistory.keys().next().value!;this.searchHistory.delete(oldest);if(oldest===historyKey)throw Object.assign(Error('Search evidence limit'),{code:'CATALOG_LIMIT'});used=size();}
  const page={...result.data,items,source,contextKey:this.key(id.context),cache:{fetchedAt:result.fetchedAt,lastSuccessAt:result.lastSuccessAt,stale:result.stale}};
  this.register(id,page.items,{query,cursor:input.cursor});return page;
  }catch(error){
   if((error as any)?.code==='EXTENSION_CONTEXT_CHANGED')throw error;
   this.assertCurrent(id);const safe=classifyExtensionReadError(error),now=Date.now();
   return {contextKey:this.key(id.context),query,items:[],nextCursor:null,source:{id:'discovery',status:safe.code==='UNSUPPORTED'?'unsupported':'error',count:null,reason:'The native catalog could not be read. Refresh before changing it.',...safe,failedAt:now},cache:{fetchedAt:now,lastSuccessAt:null,stale:false}};
  }
 }
 async change(cwd:string,input:ExtensionMutation){
  const id=await this.identity(cwd),contextKey=this.key(id.context),target=input.key?this.targets.get(JSON.stringify([contextKey,input.key])):undefined;
  const unknown=()=>Object.assign(Error('操作结果待核实，请先刷新相关来源，勿重复执行。'),{statusCode:504,code:'EXTENSION_WRITE_UNKNOWN'});
  if(input.action!=='skill.read'&&this.pendingWrites.has(id.base))throw unknown();
  if(input.action==='plugin.install'&&(!target?.query||target.expiresAt<=Date.now()||[...this.targets.values()].some(other=>other.contextKey===contextKey&&other.query&&other.id===target.id&&other.key!==target.key)))throw stale();
  let result;
  try{
   result=await changeExtension(id.peer,cwd,input,{contextKey,targetKind:target?.kind,...(target?.query?{searchTarget:{contextKey,query:target.query,cursor:target.cursor,key:target.key}}:{}),assertCurrent:()=>{this.assertCurrent(id);if(id.context.configGeneration!==id.state.generation)throw unavailable();}});
   this.assertCurrent(id);
   if(id.context.configGeneration!==id.state.generation)throw input.action==='skill.read'?unavailable():unknown();
  }
  catch(error){
   if((error as any)?.code==='EXTENSION_WRITE_UNKNOWN'){
    this.assertCurrent(id);
    const sections:ExtensionSection[]=input.action.startsWith('skill.')?['installed']:input.action.startsWith('marketplace.')?['installed','apps','mcp','marketplaces']:input.action.startsWith('plugin.')||target?.kind==='plugin'?['installed','apps','mcp']:target?.kind==='app'?['installed','apps']:['installed','mcp'];
    this.pendingWrites.set(id.base,{required:sections,remaining:new Set(sections)});this.cache.invalidate({...id.context,configGeneration:id.state.generation},sections);
   }
   throw error;
  }
  const snapshot=(result as any).snapshot as ExtensionsSnapshot|undefined;
  const generation=id.state.generation;if(snapshot)this.observe(id,snapshot.userVersion,++this.sequence);
  const invalidatedSections:ExtensionSection[]=generation!==id.state.generation?['installed','apps','mcp','marketplaces']:(result as any).invalidatedSections??[];
  this.cache.invalidate(id.context,invalidatedSections);
  if(input.action.startsWith('plugin.')||input.action.startsWith('marketplace.')){this.cache.invalidate(id.context,['search']);for(const [key,value]of this.targets)if(value.base===id.base)this.targets.delete(key);}
  return {...result,contextKey:this.key(id.context),invalidatedSections};
 }
}
