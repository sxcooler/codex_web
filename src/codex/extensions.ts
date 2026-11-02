import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {isAbsolute,resolve,relative,sep} from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
import {baseUserLayer,settingsError} from './settings.ts';
import {SkillFiles} from './skill-files.ts';
import {createPluginIconReader,readAppIconUrl} from './extension-icons.ts';
import {readRecommendedSkills} from './recommended-skills.ts';
import type {SkillTarget} from './skill-files.ts';

export function classifyExtensionReadError(error:unknown):ExtensionReadError{
 const e=error as any,text=Buffer.from(String(e?.message??'').slice(0,16384),'utf8').subarray(0,16384).toString('utf8'),rpcCode=Number.isSafeInteger(e?.rpcCode)?e.rpcCode:Number.isSafeInteger(e?.code)?e.code:undefined;
 const status=[e?.httpStatus,e?.status,e?.statusCode,e?.response?.status].find(v=>Number.isInteger(v)&&v>=100&&v<=599)??Number(text.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[: ]\s*(401|403)\b/i)?.[1]);
 const httpStatus=Number.isInteger(status)&&status>=100?status:undefined;
 const challenge=e?.headers?.['cf-mitigated']==='challenge'||e?.response?.headers?.get?.('cf-mitigated')==='challenge';
 let code:ExtensionReadError['code']='UNAVAILABLE';
 if(['UPSTREAM_CHALLENGE','UPSTREAM_FORBIDDEN','UNAUTHENTICATED','UNSUPPORTED','TIMEOUT','INVALID_RESPONSE','CATALOG_LIMIT','UNAVAILABLE'].includes(e?.code))code=e.code;
 else if(challenge||httpStatus===403&&/(?:cloudflare|cf[-_]chl|challenge-platform|just a moment)/i.test(text)&&/(?:challenge|cf[-_]chl|just a moment)/i.test(text))code='UPSTREAM_CHALLENGE';
 else if(httpStatus===403)code='UPSTREAM_FORBIDDEN';else if(httpStatus===401)code='UNAUTHENTICATED';
 else if(rpcCode===-32601||/\bmethod (?:not found|is not supported)\b/i.test(text))code='UNSUPPORTED';
 else if(['ETIMEDOUT','ABORT_ERR'].includes(e?.code)||e?.name==='TimeoutError'||/\btime(?:d? out|out)\b/i.test(text))code='TIMEOUT';
 else if(e?.code==='CATALOG_LIMIT'||/^(?:Catalog limit|Invalid cursor)/.test(text))code='CATALOG_LIMIT';
 else if(e instanceof SyntaxError||e?.code==='INVALID_RESPONSE'||/^Invalid (?:config|requirements|catalog|app|plugin|marketplace|skills|MCP)/.test(text))code='INVALID_RESPONSE';
 return {code,...(rpcCode===undefined?{}:{rpcCode}),...(httpStatus===undefined?{}:{httpStatus})};
}


export type ExtensionKind='plugin'|'app'|'mcp'|'skill';
export type ExtensionSection='installed'|'apps'|'mcp'|'marketplaces';
export type ExtensionReadErrorCode='UPSTREAM_CHALLENGE'|'UPSTREAM_FORBIDDEN'|'UNAUTHENTICATED'|'UNSUPPORTED'|'TIMEOUT'|'INVALID_RESPONSE'|'CATALOG_LIMIT'|'UNAVAILABLE';
export type ExtensionReadError={code:ExtensionReadErrorCode;rpcCode?:number;httpStatus?:number};
export type ExtensionCacheInfo={fetchedAt:number|null;lastSuccessAt:number|null;stale:boolean};
export type ExtensionSectionSnapshot=ExtensionsSnapshot&{section:ExtensionSection;contextKey:string;cache:ExtensionCacheInfo;writePendingSections?:ExtensionSection[]};
export type ExtensionSearchPage={contextKey:string;query:string;items:ExtensionItem[];nextCursor:string|null;source:ExtensionSource;cache:ExtensionCacheInfo};
export type ExtensionMutationOptions={contextKey?:string;searchTarget?:{contextKey:string;query:string;cursor?:string;key:string};targetKind?:ExtensionKind;assertCurrent?:()=>void};
export type McpCatalog={tools:Array<{name:string;description:string|null}>;resources:Array<{name:string;description:string|null}>;templates:Array<{name:string;description:string|null}>;toolsKnown:boolean;resourcesKnown:boolean;templatesKnown:boolean;truncated:boolean;toolsError:boolean};
export type ExtensionItem={key:string;kind:ExtensionKind;id:string;name:string;description:string|null;owner:string|null;ownerNames?:string[];scope:string;installed:boolean|null;enabled:boolean|null;connected:boolean|null;callable:boolean|null;connection:string|null;authorization:string|null;version:string|null;source:string|null;installPolicySource?:string|null;configured?:boolean|null;recommended?:boolean|null;iconUrl?:string|null;writable:boolean;reason:string|null;installUrl:string|null;config?:Record<string,unknown>;hasSecrets?:boolean;capabilities?:string[];policyWritable?:boolean;catalog?:McpCatalog};
export type ExtensionSource={id:string;status:'ok'|'partial'|'unsupported'|'error'|'notLoaded';count:number|null;reason:string|null;code?:ExtensionReadErrorCode;rpcCode?:number;httpStatus?:number;failedAt?:number;lastSuccessAt?:number};
export type ExtensionMarketplace={key:string;name:string;writable:boolean;reason:string|null;installed:string[];impactVersion:string;sourceType:'local'|'git'|null;configured?:boolean|null};
export type ExtensionsSnapshot={host:'native';scope:string;userVersion:string|null;writable:boolean;items:ExtensionItem[];available:ExtensionItem[];marketplaces:ExtensionMarketplace[];sources:ExtensionSource[];updatedAt:number;limitations:string[]};
export type ExtensionMutation={action:'enabled'|'plugin.install'|'plugin.remove'|'marketplace.add'|'marketplace.remove'|'marketplace.upgrade'|'mcp.save'|'mcp.policy'|'mcp.remove'|'mcp.login'|'mcp.logout'|'mcp.reload'|'skill.read'|'skill.create'|'skill.save'|'skill.import'|'skill.remove';key?:string;expectedVersion?:string;enabled?:boolean;name?:string;source?:string;ref?:string;sparsePaths?:string[];config?:Record<string,unknown>;impactVersion?:string;scope?:'user'|'repo';content?:string;expectedContentVersion?:string};
export type ExtensionPeer={request:(method:string,params:any)=>Promise<any>;cli:(args:string[])=>Promise<any>;home:string};
export const object=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const string=(v:any):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\x00-\x1f]/.test(v);
const name=(v:any):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,119}$/.test(v);
export const extensionKey=(kind:string,id:string)=>createHash('sha256').update(JSON.stringify([kind,id])).digest('hex');
const key=extensionKey;
const safe=(v:any):string|null=>typeof v==='string'&&v.length<=4096&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)?v:null;
const bool=(v:any)=>typeof v==='boolean'?v:null;
const err=(status:number,code:string,message:string)=>settingsError(status,code,message);
const invalid=()=>err(400,'EXTENSION_INVALID_INPUT','扩展操作参数无效。');
const unknown=()=>err(504,'EXTENSION_WRITE_UNKNOWN','操作结果待核实，请先刷新核对，勿重复执行。');
const managed=['mdm','enterpriseManaged','legacyManagedConfigTomlFromFile','legacyManagedConfigTomlFromMdm'];
const limitations=['Plugin creation, sharing, publishing and remote skill installation have no verified public host contract. Use the native creator/skill-installer workflow explicitly.','App account connection and disconnection require the native app or the official install page. Local enablement does not authorize an account.','Plugin update has no stable per-plugin CLI command. Marketplace Git sync is available; it does not prove an installed package updated.','MCP status discovery can initialize configured servers. No tools are called by this page.'];
const item=(kind:ExtensionKind,id:string,extra:Partial<ExtensionItem>={}):ExtensionItem=>({key:key(kind,id),kind,id,name:id,description:null,owner:null,scope:'user',installed:true,enabled:null,connected:null,callable:null,connection:null,authorization:null,version:null,source:null,writable:false,reason:null,installUrl:null,...extra});
const mcpDefinitions=(config:any):Record<string,any>=>({...object(config?.mcpServers)?config.mcpServers:{},...object(config?.mcp_servers)?config.mcp_servers:{}});
function mcpCatalog(m:any):McpCatalog{
 const values=(rows:any[])=>rows.slice(0,20).map(v=>({name:(safe(v?.name)??'Unknown').slice(0,200),description:safe(v?.description)?.slice(0,512)??null}));
 const tools=object(m.tools)?Object.entries(m.tools).map(([name,tool])=>({...(object(tool)?tool:{}),name})):[],resources=Array.isArray(m.resources)?m.resources:[],templates=Array.isArray(m.resourceTemplates)?m.resourceTemplates:[];
 return {tools:values(tools),resources:values(resources),templates:values(templates),toolsKnown:object(m.tools)&&m.toolsError==null,resourcesKnown:Array.isArray(m.resources),templatesKnown:Array.isArray(m.resourceTemplates),truncated:[tools,resources,templates].some(rows=>rows.length>20),toolsError:typeof m.toolsError==='string'&&m.toolsError.length>0};
}
function trustedUrl(value:any):string|null{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['chatgpt.com','chat.openai.com','auth.openai.com'].includes(u.hostname)?u.href:null;}catch{return null;}}
function publicConfig(config:any){
 const values:Record<string,unknown>={};
 for(const field of ['command','args','cwd','enabled','startup_timeout_sec','tool_timeout_sec','enabled_tools','disabled_tools','default_tools_approval_mode'])if(config[field]!==undefined)values[field]=config[field];
 if(object(config.tools)&&Object.keys(config.tools).length<=200)values.tools=Object.fromEntries(Object.entries(config.tools).filter(([_,v])=>object(v)).map(([tool,v])=>[tool,Object.fromEntries(Object.entries(v as object).filter(([k])=>['approval_mode','output_token_limit'].includes(k)))]));
 // Endpoint paths, arguments and environment values can carry credentials. Editing retains omitted values on the server.
 if(typeof values.command==='string')values.command=safe(values.command);
 delete values.args;delete values.cwd;
 if(config.url){try{values.url=new URL(config.url).origin;}catch{}}
 return values;
}
function readOnly(read:any,section:string,id:string){
 const layer=baseUserLayer(read);
 if(!layer||layer.disabledReason!=null||layer.disabled_reason!=null||read.config?.profile!=null)return 'The base user configuration is unavailable or uses a profile.';
 const paths=[section,`${section}.${id}`,`${section}.${JSON.stringify(id)}`,`${section}.${id}.enabled`];
 for(const [path,value]of Object.entries(read.origins??{}))if(paths.some(p=>path===p||path.startsWith(p+'.'))){const origin=(value as any)?.name;if(managed.includes(origin?.type)||origin?.type==='project'||origin?.type==='sessionFlags')return 'This value is controlled by another configuration layer.';}
 for(const l of read.layers??[])if(managed.includes(l.name?.type)&&l.config?.[section]!=null)return 'This section is managed by policy.';
 return null;
}
async function nativeConfig(peer:ExtensionPeer,cwd:string){
 const read=await peer.request('config/read',{cwd,includeLayers:true});if(!object(read?.config))throw Error('Invalid config');
 const requirements=await peer.request('configRequirements/read',{});if(!object(requirements)||!Object.hasOwn(requirements,'requirements')||requirements.requirements!==null&&!object(requirements.requirements))throw Error('Invalid requirements');
 return {read,layer:baseUserLayer(read),requirements:requirements.requirements};
}
async function pages(peer:ExtensionPeer,method:string,params:Record<string,unknown>={}){const data:any[]=[],seen=new Set<string>();let cursor:string|null=null;for(let page=0;page<20;page++){const result=await peer.request(method,{...params,cursor,limit:100});if(!Array.isArray(result?.data)||result.data.length>1000)throw Error('Invalid catalog');data.push(...result.data);if(result.nextCursor==null)return data;if(!string(result.nextCursor)||seen.has(result.nextCursor))throw Error('Invalid cursor');seen.add(result.nextCursor);cursor=result.nextCursor;}throw Error('Catalog limit');}
type Internal={snapshot:ExtensionsSnapshot;targets:Map<string,any>;config:any|null;pluginMarkets:Array<{name:string;path:string|null}>};
export async function readExtensionSources(peer:ExtensionPeer,cwd:string,options:{sources?:string[];refresh?:boolean;mcpKey?:string}={}):Promise<Internal>{
 const snapshot:ExtensionsSnapshot={host:'native',scope:cwd,userVersion:null,writable:false,items:[],available:[],marketplaces:[],sources:[],updatedAt:Date.now(),limitations};
 const targets=new Map<string,any>(),pluginMarkets:Internal['pluginMarkets']=[];let config:any=null;
 snapshot.sources.push({id:'discovery',status:'notLoaded',count:null,reason:null});
 const source=async(id:string,read:()=>Promise<number>)=>{if(!(options.sources??['configuration','plugins','skills','mcp-definitions']).includes(id)){snapshot.sources.push({id,status:'notLoaded',count:null,reason:null});return;}try{const count=await read();snapshot.sources.push({id,status:'ok',count,reason:null,lastSuccessAt:Date.now()});}catch(e){const diagnostic=classifyExtensionReadError(e);snapshot.sources.push({id,status:diagnostic.code==='UNSUPPORTED'?'unsupported':'error',count:null,reason:'The native catalog could not be read. Refresh before changing it.',...diagnostic,failedAt:Date.now()});}};
 await source('configuration',async()=>{config=await nativeConfig(peer,cwd);snapshot.userVersion=config.layer?.version??null;snapshot.writable=!readOnly(config.read,'','');return 1;});
 const definitions=mcpDefinitions(config?.read.config);
 const add=(entry:ExtensionItem,target:any)=>{if(snapshot.items.length>=5000)throw Error("Catalog limit");snapshot.items.push(entry);targets.set(entry.key,target);};
 await Promise.all([source('plugins',async()=>{
  const result=await peer.request('plugin/installed',{cwds:[cwd]});if(!Array.isArray(result?.marketplaces)||!Array.isArray(result.marketplaceLoadErrors)||result.marketplaces.length>1000)throw Error('Invalid plugins');
  const readIcon=createPluginIconReader(peer.home);
  for(const market of result.marketplaces){if(!string(market.name)||market.path!=null&&!string(market.path)||!Array.isArray(market.plugins))throw Error('Invalid marketplace');pluginMarkets.push({name:market.name,path:market.path??null});for(const p of market.plugins){if(p.installed!==true)continue;if(!string(p.id))throw Error('Invalid plugin');
   const sourceType=p.source?.type??p.source?.source;const reason=p.availability==='DISABLED_BY_ADMIN'||p.installPolicy==='NOT_AVAILABLE'||p.installPolicySource==='WORKSPACE_SETTING'?'This plugin is controlled by policy.':config?readOnly(config.read,'plugins',p.id):'Configuration is unavailable.';
    const e=item('plugin',p.id,{key:key('plugin',JSON.stringify([market.name,market.path??null,p.id])),name:safe(p.interface?.displayName)??safe(p.name)??p.id,description:safe(p.interface?.shortDescription),iconUrl:market.name==='openai-bundled'?null:await readIcon(p.interface?.logoDark??p.interface?.logoUrlDark??p.interface?.logo??p.interface?.logoUrl,sourceType==='local'?p.source.path:undefined,sourceType==='remote'?{marketplace:market.name,name:p.name,version:p.localVersion??null}:undefined),enabled:bool(p.enabled),version:safe(p.localVersion),source:name(market.name)?market.name:null,installPolicySource:safe(p.installPolicySource),writable:!reason&&name(market.name)&&/^[\w.-]+@[\w.-]+$/.test(p.id)&&p.remotePluginId==null,reason:reason??(p.remotePluginId!=null?'Remote plugin management requires the native app.':null),capabilities:[]});
   add(e,{kind:'plugin',id:p.id,market:market.name,raw:p});}}
  snapshot.sources.push({id:'plugin-directories',status:result.marketplaceLoadErrors.length?'partial':'ok',count:result.marketplaceLoadErrors.length,reason:result.marketplaceLoadErrors.length?'Some plugin directories failed to load. Their contents are unknown.':null});return snapshot.items.filter(entry=>entry.kind==='plugin').length;
 }),
  source('skills',async()=>{const result=await peer.request('skills/list',{cwds:[cwd],forceReload:options.refresh===true});if(!Array.isArray(result?.data))throw Error('Invalid skills');const recommended=await readRecommendedSkills(peer.home);snapshot.sources.push({id:'skill-recommendations',status:recommended.known?'ok':'partial',count:null,reason:recommended.known?null:'The recommended skill catalog could not be read; standalone skill membership is unknown.'});let count=0,directoryErrors=0;for(const group of result.data){if(!Array.isArray(group.skills)||!Array.isArray(group.errors))throw Error('Invalid skills');directoryErrors+=group.errors.length;for(const s of group.skills){if(!string(s.path)||!string(s.name))throw Error('Invalid skill');const reason=s.pluginId?'Manage this skill through its owning plugin.':!['user','repo'].includes(s.scope)?'System and administrator skills are read-only.':config?readOnly(config.read,'skills',s.path):'Configuration is unavailable.';add(item('skill',s.path,{key:key('skill',s.path),id:s.name,name:s.name,description:safe(s.description),enabled:bool(s.enabled),scope:s.scope,owner:safe(s.pluginId),recommended:recommended.known?recommended.matches(s):null,writable:!reason,reason}),{kind:'skill',id:s.path,raw:s});count++;}}snapshot.sources.push({id:'skill-directories',status:directoryErrors?'partial':'ok',count:directoryErrors,reason:directoryErrors?'Some skill directories failed to load.':null});return count;}),
 source('apps',async()=>{
  const reasonFor=(id:string)=>config?readOnly(config.read,'apps',id):'Configuration is unavailable.';let inventory:any;
  try{inventory=await peer.request('app/installed',options.refresh?{forceRefresh:true}:{});}catch(e){
   if(classifyExtensionReadError(e).code!=='UNSUPPORTED')throw e;
    const data=await pages(peer,'app/list');for(const a of data){if(!string(a.id)||!string(a.name))throw Error('Invalid app');if(a.isAccessible!==true)continue;const reason=reasonFor(a.id);add(item('app',a.id,{name:a.name,description:safe(a.description),iconUrl:readAppIconUrl(a.logoUrlDark,a.logoUrl),enabled:bool(a.isEnabled),callable:bool(a.isAccessible),installed:null,authorization:'accessible',writable:!reason,reason,installUrl:trustedUrl(a.installUrl),ownerNames:Array.isArray(a.pluginDisplayNames)?a.pluginDisplayNames.filter(string):[]}),{kind:'app',id:a.id,raw:a});}return snapshot.items.filter(x=>x.kind==='app').length;
  }
  if(!Array.isArray(inventory?.apps)||inventory.apps.length>5000)throw Error('Invalid app inventory');
  const installed=new Map<string,any>();for(const a of inventory.apps){if(!string(a.id))throw Error('Invalid app');installed.set(a.id,a);}
  const ids=[...installed.keys()],metadata=new Map<string,any>();let offset=0,metadataError:ExtensionReadError|undefined,missing=false;
  const worker=async()=>{while(offset<ids.length){const batch=ids.slice(offset,offset+=100);try{const read=await peer.request('app/read',{appIds:batch});if(!Array.isArray(read?.apps)||!Array.isArray(read.missingAppIds)||read.apps.length>batch.length)throw Error('Invalid app metadata');for(const a of read.apps){if(!string(a.id)||!string(a.name)||!batch.includes(a.id))throw Error('Invalid app metadata');metadata.set(a.id,a);}if(read.missingAppIds.length||batch.some(id=>!metadata.has(id)))missing=true;}catch(e){metadataError=classifyExtensionReadError(e);}}};await Promise.all([worker(),worker()]);
  for(const [id,a]of installed){const m=metadata.get(id),reason=reasonFor(id);add(item('app',id,{name:safe(m?.name)??safe(a.runtimeName)??id,description:safe(m?.description),iconUrl:readAppIconUrl(m?.iconUrlDark,m?.iconUrl),enabled:bool(a.enabled),callable:bool(a.callable),installed:true,authorization:typeof m?.isAccessible==='boolean'?(m.isAccessible?'accessible':'notAccessible'):null,connected:bool(a.connected),writable:!reason,reason,installUrl:trustedUrl(m?.installUrl),ownerNames:Array.isArray(m?.pluginDisplayNames)?m.pluginDisplayNames.filter(string):[],owner:Array.isArray(m?.pluginDisplayNames)?m.pluginDisplayNames.map(safe).filter(Boolean).join(', ')||null:null}),{kind:'app',id,raw:a});}
  snapshot.sources.push({id:'apps-metadata',status:metadataError||missing?'partial':'ok',count:metadata.size,reason:metadataError||missing?'Some installed app metadata is unavailable.':null,...(metadataError?{...metadataError,failedAt:Date.now()}:{lastSuccessAt:Date.now()})});return installed.size;
 }),
  source('mcp',async()=>{let selected=options.mcpKey?Object.keys(definitions).find(id=>key('mcp',id)===options.mcpKey):undefined;if(options.mcpKey&&!selected){const statuses=await pages(peer,'mcpServerStatus/list',{detail:'toolsAndAuthOnly'});selected=statuses.find(m=>string(m.name)&&key('mcp',m.name)===options.mcpKey)?.name;if(!selected)throw err(409,'EXTENSION_STALE','MCP 已变化，请刷新。');}const data=await pages(peer,'mcpServerStatus/list',options.sources?{detail:options.mcpKey?'full':'toolsAndAuthOnly',...(selected?{serverName:selected}:{})}:{}),servers=new Map<string,any>();for(const m of data){if(!string(m.name))throw Error('Invalid MCP');if(!selected||m.name===selected)servers.set(m.name,m);}for(const id of Object.keys(definitions))if((!selected||id===selected)&&!servers.has(id))servers.set(id,{name:id});for(const [id,m]of servers){const c=definitions[id]??{},reason=m.pluginId&&!Object.hasOwn(definitions,id)?'Manage this server through its owning plugin.':config?readOnly(config.read,'mcp_servers',id):'Configuration is unavailable.';
    add(item('mcp',id,{name:id,owner:Object.hasOwn(definitions,id)?null:safe(m.pluginId),configured:config?Object.hasOwn(definitions,id):null,enabled:bool(c.enabled),connected:m.runtimeStatus==null?null:m.runtimeStatus==='connected',connection:safe(m.runtimeStatus),authorization:safe(m.authStatus),callable:m.runtimeStatus==='connected'&&object(m.tools)&&m.toolsError==null?Object.keys(m.tools).length>0:null,writable:!reason,reason,config:publicConfig(c),hasSecrets:!!(c.env||c.http_headers||c.bearer_token_env_var||c.env_http_headers),...(!options.sources||options.mcpKey?{catalog:mcpCatalog(m)}:{})}),{kind:'mcp',id,raw:m});}return servers.size;}),
  source('marketplaces',async()=>{const result=await peer.cli(['plugin','marketplace','list','--json']);if(!Array.isArray(result?.marketplaces)||result.marketplaces.length>1000)throw Error('Invalid marketplaces');for(const m of result.marketplaces){if(!object(m)||!name(m.name)||!string(m.root))throw Error('Invalid marketplace');const configured=config?.layer?.config.marketplaces?.[m.name],source=m.marketplaceSource;const writable=!!(configured&&object(source)&&['local','git'].includes(source.sourceType)&&source.sourceType===configured.source_type&&source.source===configured.source&&!readOnly(config.read,'marketplaces',m.name));const entry:ExtensionMarketplace={key:key('marketplace',m.name),name:m.name,configured:config?Object.hasOwn(config.read.config.marketplaces??{},m.name):null,writable,sourceType:['local','git'].includes(source?.sourceType)?source.sourceType:null,reason:writable?null:'Implicit, managed or unverified marketplace ownership is read-only.',installed:[],impactVersion:''};snapshot.marketplaces.push(entry);targets.set(entry.key,{kind:'marketplace',id:m.name,entry,sourceType:source?.sourceType});}return result.marketplaces.length;})]);
 if(options.sources?.includes('marketplaces')&&config&&snapshot.sources.some(source=>source.id==='marketplaces'&&source.status==='ok'))for(const id of Object.keys(config.read.config.marketplaces??{}))if(name(id)&&!snapshot.marketplaces.some(m=>m.name===id))snapshot.marketplaces.push({key:key('marketplace',id),name:id,configured:true,writable:false,sourceType:null,reason:'Implicit, managed or unverified marketplace ownership is read-only.',installed:[],impactVersion:''});
 for(const m of snapshot.marketplaces){m.installed=snapshot.items.filter(x=>x.kind==='plugin'&&x.source===m.name).map(x=>x.name);m.impactVersion=key('impact',JSON.stringify([m.name,m.installed,snapshot.userVersion]));}
 for(const m of snapshot.items.filter(x=>x.kind==='mcp'&&x.owner)){
  const owner=snapshot.items.find(x=>x.kind==='plugin'&&x.id===m.owner),raw=owner?targets.get(owner.key)?.raw:null,overlay=config?.read.config.plugins?.[m.owner!]?.mcp_servers?.[m.id]??{};
  m.policyWritable=!!(owner&&config&&name(m.id)&&raw?.availability!=='DISABLED_BY_ADMIN'&&!['WORKSPACE_SETTING','IMPLICIT_CANONICAL_APP'].includes(raw?.installPolicySource)&&!readOnly(config.read,'plugins',m.owner!));
  m.config=publicConfig(overlay);m.enabled=bool(overlay.enabled);if(m.policyWritable)m.reason='Plugin transport is owned by its manifest; only local server enablement and tool policy can be edited.';
 }
 const definitionsIncluded=options.sources?.includes('mcp-definitions')||options.sources?.includes('mcp')&&!options.mcpKey;
 if(definitionsIncluded)for(const [id,c]of Object.entries(definitions))if(!snapshot.items.some(entry=>entry.kind==='mcp'&&entry.id===id)){const reason=config?readOnly(config.read,'mcp_servers',id):'Configuration is unavailable.';add(item('mcp',id,{configured:true,enabled:bool(c.enabled),config:publicConfig(c),writable:!reason,reason,hasSecrets:!!(c.env||c.http_headers||c.bearer_token_env_var||c.env_http_headers)}),{kind:'mcp',id,raw:{name:id}});}
 snapshot.sources.push({id:'mcp-definitions',status:definitionsIncluded&&config?'ok':'notLoaded',count:definitionsIncluded&&config?Object.keys(definitions).length:null,reason:null});
 // Join package capabilities without counting them as independent installations in the all view.
 for(const p of snapshot.items.filter(x=>x.kind==='plugin'))p.capabilities=snapshot.items.filter(x=>x.owner===p.id).map(x=>`${x.kind}: ${x.name}`);
 return {snapshot,targets,config,pluginMarkets};
}
const load=readExtensionSources;
export async function readExtensions(peer:ExtensionPeer,cwd:string){return (await load(peer,cwd,{sources:['configuration','plugins','skills','mcp-definitions']})).snapshot;}

const policyFields=['enabled','enabled_tools','disabled_tools','default_tools_approval_mode','tools'];
const fields=['command','args','cwd','env','env_vars','url','http_headers','env_http_headers','bearer_token_env_var','auth','enabled','startup_timeout_sec','tool_timeout_sec',...policyFields];
const environmentName=(v:any)=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(v);
const approvalModes=['auto','prompt','writes','approve'];
function validateMcp(c:any){
 if(!object(c)||!Object.keys(c).length||Object.keys(c).some(k=>!fields.includes(k)))throw invalid();
 for(const [k,v]of Object.entries(c)){
  if(['args','enabled_tools','disabled_tools'].includes(k)){if(!Array.isArray(v)||v.length>200||v.some(x=>typeof x!=='string'||x.length>4096||x.includes('\0')))throw invalid();}
  else if(k==='tools'){if(!object(v)||Object.keys(v).length>200||Object.entries(v).some(([tool,policy])=>!string(tool)||!object(policy)||Object.keys(policy).some(k=>!['approval_mode','output_token_limit'].includes(k))||policy.approval_mode!==undefined&&!approvalModes.includes(policy.approval_mode)||policy.output_token_limit!==undefined&&(!Number.isSafeInteger(policy.output_token_limit)||policy.output_token_limit<=0)))throw invalid();}
  else if(k==='default_tools_approval_mode'){if(!approvalModes.includes(v as string))throw invalid();}
  else if(k==='auth'){if(!['oauth','chatgpt'].includes(v as string))throw invalid();}
  else if(k==='bearer_token_env_var'){if(!environmentName(v))throw invalid();}
  else if(k==='env_vars'){if(!Array.isArray(v)||v.length>100||v.some(value=>typeof value==='string'?!environmentName(value):!object(value)||!environmentName(value.name)||Object.keys(value).some(k=>!['name','source'].includes(k))||value.source!==undefined&&!['local','remote'].includes(value.source)))throw invalid();}
  else if(['env','http_headers','env_http_headers'].includes(k)){if(!object(v)||Object.keys(v).length>100||Object.entries(v).some(([name,val])=>!name||/\x00|\r|\n/.test(name)||typeof val!=='string'||val.length>8192||/\x00|\r|\n/.test(val)||k==='env_http_headers'&&!environmentName(val)))throw invalid();}
  else if(k==='enabled'){if(typeof v!=='boolean')throw invalid();}
  else if(k.endsWith('_sec')){if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>3600)throw invalid();}
  else if(!string(v))throw invalid();
 }
 if(c.command!==undefined&&c.url!==undefined)throw invalid();
 if(c.url!==undefined){let u:URL;try{u=new URL(c.url);}catch{throw invalid();}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash)throw invalid();if(['args','cwd','env','env_vars'].some(k=>k in c))throw invalid();}
 if(c.command!==undefined&&['http_headers','env_http_headers','bearer_token_env_var','auth'].some(k=>k in c))throw invalid();
}
function validate(input:any){
 if(!object(input)||Object.keys(input).some(k=>!['action','key','expectedVersion','enabled','name','source','ref','sparsePaths','config','impactVersion','scope','content','expectedContentVersion'].includes(k)))throw invalid();
 if(!['enabled','plugin.install','plugin.remove','marketplace.add','marketplace.remove','marketplace.upgrade','mcp.save','mcp.policy','mcp.remove','mcp.login','mcp.logout','mcp.reload','skill.read','skill.create','skill.save','skill.import','skill.remove'].includes(input.action))throw invalid();
 if(input.action.startsWith('skill.')){
  if(['skill.create','skill.import'].includes(input.action)&&(!name(input.name)||!['user','repo'].includes(input.scope)||input.key!==undefined))throw invalid();
  if(['skill.create','skill.save','skill.import'].includes(input.action)&&(typeof input.content!=='string'||Buffer.byteLength(input.content)>262144||!string(input.expectedContentVersion)))throw invalid();
  if(['skill.create','skill.import'].includes(input.action)&&input.expectedContentVersion!=='missing')throw invalid();
  if(input.action==='skill.remove'&&!string(input.expectedContentVersion))throw invalid();
 }
 if(input.action==='mcp.policy'){validateMcp(input.config);if(Object.keys(input.config).some(k=>!policyFields.includes(k)))throw invalid();}
 if(input.key!==undefined&&(typeof input.key!=='string'||!/^[a-f0-9]{64}$/.test(input.key)))throw invalid();
 if(input.action==='enabled'&&typeof input.enabled!=='boolean')throw invalid();
 if(input.action==='mcp.save'){if(!name(input.name)||!string(input.expectedVersion))throw invalid();validateMcp(input.config);}
 if(input.action==='marketplace.add'){
  if(!string(input.source)||input.source.startsWith('-')||input.source.length>2048)throw invalid();
  if(input.source.split(/[\\/]/).includes('..')||/^\\\\|^\/\//.test(input.source))throw invalid();
  if(input.ref!==undefined&&(!string(input.ref)||input.ref.startsWith('-')))throw invalid();
  if(input.sparsePaths!==undefined&&(!Array.isArray(input.sparsePaths)||input.sparsePaths.length>20||input.sparsePaths.some((v:any)=>!string(v)||isAbsolute(v)||v.split(/[\\/]/).includes('..')||v.startsWith('-'))))throw invalid();
  if(/^[a-z]+:\/\//i.test(input.source)){let u:URL;try{u=new URL(input.source);}catch{throw invalid();}if(!['https:','ssh:'].includes(u.protocol)||u.password||u.search||u.hash||u.protocol==='https:'&&u.username)throw invalid();}
 }
 if(input.config!==undefined&&!['mcp.save','mcp.policy'].includes(input.action))throw invalid();
}
async function marketplaceSource(peer:ExtensionPeer,cwd:string,source:string){
 const shorthand=/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:@[A-Za-z0-9][A-Za-z0-9_.\/-]*)?$/.test(source);
 if(/^(?:https|ssh):\/\//i.test(source)||/^git@[A-Za-z0-9.-]+:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source))return {source,local:false};
 if(!isAbsolute(source)&&/^[a-z][a-z0-9+.-]*:/i.test(source))throw invalid();
 const candidate=resolve(cwd,source),within=(root:string,path:string)=>{const r=relative(root,path);return r!== '..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
 const root=within(cwd,candidate)?cwd:within(peer.home,candidate)?peer.home:null;if(!root)throw invalid();
 let current=await realpath(root);const parts=relative(root,candidate).split(sep).filter(Boolean);
 for(const part of parts){current=resolve(current,part);let info;try{info=await lstat(current);}catch(e:any){if(e.code==='ENOENT'&&shorthand)return {source,local:false};throw err(400,'EXTENSION_INVALID_INPUT','本地市场来源必须是授权根内可核实的现有目录。');}if(info.isSymbolicLink()||!info.isDirectory())throw err(400,'EXTENSION_INVALID_INPUT','本地市场来源不能包含链接或非目录。');}
 return {source:current,local:true};
}
async function writeConfig(peer:ExtensionPeer,cwd:string,before:Internal,version:string|undefined,section:string,id:string,value:any,assertCurrent?:()=>void){
 const ctx=before.config;if(!ctx?.layer||readOnly(ctx.read,section,id))throw err(409,'EXTENSION_READ_ONLY','该配置来源只读或受管。');
 if(!version||version!==ctx.layer.version)throw err(409,'EXTENSION_CONFLICT','配置已变化，请刷新后比较再保存。');
 if(ctx.requirements?.mcpServers!=null&&section==='mcp_servers'||ctx.requirements?.apps!=null&&section==='apps'||ctx.requirements?.plugins!=null&&section==='plugins')throw err(409,'EXTENSION_READ_ONLY','该扩展受原生要求控制。');
 const keyPath=`${section}.${JSON.stringify(id)}`;
 let result:any;
 assertCurrent?.();
 try{result=await peer.request('config/batchWrite',{filePath:ctx.layer.name.file,expectedVersion:version,edits:[{keyPath,value,mergeStrategy:'replace'}]});}
 catch(e:any){if(e?.code===-32600&&e?.data?.config_write_error_code==='configVersionConflict')throw err(409,'EXTENSION_CONFLICT','配置已变化，请刷新后比较再保存。');if(Number.isSafeInteger(e?.code))throw err(503,'EXTENSION_WRITE_FAILED','原生配置拒绝了本次操作。');await nativeConfig(peer,cwd).catch(()=>{});throw unknown();}
 try{const after=await nativeConfig(peer,cwd);if(!['ok','okOverridden'].includes(result?.status)||result.filePath!==ctx.layer.name.file||result.version!==after.layer?.version||!isDeepStrictEqual(after.layer?.config?.[section]?.[id],value))throw Error('Readback');}catch{throw unknown();}
}
export async function changeExtension(peer:ExtensionPeer,cwd:string,input:ExtensionMutation,options:ExtensionMutationOptions={}){
 validate(input);const source=input.action==='marketplace.add'?await marketplaceSource(peer,cwd,input.source!):null;
 const action=input.action;
 const selected=action.startsWith('skill.')?['skills']:action.startsWith('marketplace.')?['plugins','marketplaces']:action.startsWith('plugin.')?['plugins']:action==='enabled'?options.targetKind==='app'?['apps']:options.targetKind==='mcp'?['plugins','mcp']:options.targetKind==='skill'?['skills']:options.targetKind==='plugin'?['plugins']:['plugins','skills','mcp-definitions']:action==='mcp.save'?['mcp-definitions']:['plugins','mcp'];
 let before=await load(peer,cwd,{sources:['configuration',...selected],refresh:true});
 if(action==='enabled'&&!options.targetKind&&input.key&&!before.targets.has(input.key)){
  before=await load(peer,cwd,{sources:['configuration','apps'],refresh:true});
  if(!before.targets.has(input.key))before=await load(peer,cwd,{sources:['configuration','plugins','mcp'],refresh:true});
 }
 if(action==='plugin.install'){
  const registration=options.searchTarget;
  if(!registration||!options.contextKey||registration.contextKey!==options.contextKey||registration.key!==input.key)throw err(409,'EXTENSION_STALE','搜索目标已过期，请重新搜索。');
  let page;try{const {searchExtensions}=await import('./extension-catalog.ts');page=await searchExtensions(peer,cwd,{query:registration.query,cursor:registration.cursor,refresh:true});}catch{throw err(409,'EXTENSION_STALE','搜索目标无法重新核实，请重新搜索。');}
  const found=page.items.find(x=>x.key===input.key);if(!found)throw err(409,'EXTENSION_STALE','搜索结果已变化，请重新搜索。');
  const markets=before.pluginMarkets.filter(m=>m.name===found.source);
  if(!before.snapshot.sources.some(s=>s.id==='plugins'&&s.status==='ok')||before.snapshot.sources.some(s=>s.id==='plugin-directories'&&s.status!=='ok')||markets.length!==1||key('plugin',JSON.stringify([markets[0].name,markets[0].path,found.id]))!==found.key)throw err(409,'EXTENSION_STALE','无法核实唯一的 CLI 市场身份，请刷新或使用原生应用安装。');
  before.snapshot.available=[found];before.targets.set(found.key,{kind:'available',id:found.id});
 }
 const target=input.key?before.targets.get(input.key):null,entry=before.snapshot.items.find(x=>x.key===input.key),market=before.snapshot.marketplaces.find(x=>x.key===input.key);
 const invalidatedSections:ExtensionSection[]=action.startsWith('skill.')||action==='enabled'&&target?.kind==='skill'?['installed']:action.startsWith('marketplace.')?['installed','apps','mcp','marketplaces']:action.startsWith('plugin.')||action==='enabled'&&target?.kind==='plugin'?['installed','apps','mcp']:action==='enabled'&&target?.kind==='app'?['installed','apps']:['installed','mcp'];
 const afterSources=action.startsWith('skill.')?['configuration','skills']:action.startsWith('marketplace.')?['configuration','plugins','marketplaces']:action.startsWith('plugin.')?['configuration','plugins']:action==='enabled'&&target?.kind==='app'?['configuration','apps']:action==='enabled'&&target?.kind==='skill'?['configuration','skills']:action==='enabled'&&target?.kind==='plugin'?['configuration','plugins']:action==='mcp.save'?['configuration','mcp-definitions']:['configuration','plugins','mcp'];
 const readAfter=()=>load(peer,cwd,{sources:afterSources,refresh:true});
 options.assertCurrent?.();
 const requireTarget=(kind:string)=>{if(!target||target.kind!==kind)throw err(409,'EXTENSION_STALE','扩展已变化或不在当前授权目录中，请刷新。');};
 const writable=()=>{if(!entry?.writable)throw err(409,'EXTENSION_READ_ONLY','该扩展受管、属于插件或不支持本地修改。');};
 let verify:(after:ExtensionsSnapshot)=>boolean=()=>true,result:any;
 if(input.action.startsWith('skill.')){
  const files=new SkillFiles(peer.home,cwd);let selected:SkillTarget;
  if(['skill.create','skill.import'].includes(input.action)){
   if(!before.config||readOnly(before.config.read,'skills',''))throw err(409,'EXTENSION_READ_ONLY','技能配置来源不可写或受管。');selected={scope:input.scope!,name:input.name!};
  }else{requireTarget('skill');if(input.action!=='skill.read')writable();selected=files.fromNative(target.raw);}
  if(input.action==='skill.read')return {status:'read' as const,document:await files.read(selected),invalidatedSections:[] as ExtensionSection[]};
  options.assertCurrent?.();
  let document;
  if(input.action==='skill.remove')await files.remove(selected,input.expectedContentVersion!);
  else document=await files.save(selected,{expectedVersion:input.expectedContentVersion!,content:input.content!});
  try{const reloaded=await peer.request('skills/list',{cwds:[cwd],forceReload:true});if(!Array.isArray(reloaded?.data))throw Error('Invalid reload');const nativeSkills=reloaded.data.flatMap((group:any)=>Array.isArray(group.skills)?group.skills:[]),equal=(path:string)=>process.platform==='win32'?path.toLowerCase()===files.path(selected).toLowerCase():path===files.path(selected),found=nativeSkills.some((s:any)=>typeof s.path==='string'&&equal(s.path));if(found!==(input.action!=='skill.remove'))throw Error('Native discovery differs');}catch{throw unknown();}
  return {status:'written' as const,document,snapshot:(await readAfter()).snapshot,effect:'future-sessions' as const,invalidatedSections};
 }else if(input.action==='enabled'){
  if(!target||!entry)throw err(409,'EXTENSION_STALE','扩展已变化，请刷新。');writable();
  if(target.kind==='skill'){
   options.assertCurrent?.();try{await peer.request('skills/config/write',{path:target.id,enabled:input.enabled});}catch(e:any){if(Number.isSafeInteger(e?.code))throw err(503,'EXTENSION_WRITE_FAILED','原生宿主拒绝了技能设置。');throw unknown();}
  }else{const section=target.kind==='plugin'?'plugins':target.kind==='app'?'apps':'mcp_servers',current=before.config?.layer?.config?.[section]?.[target.id]??{};await writeConfig(peer,cwd,before,input.expectedVersion,section,target.id,{...current,enabled:input.enabled},options.assertCurrent);}
  verify=s=>s.items.find(x=>x.key===input.key)?.enabled===input.enabled;
 }else if(input.action==='mcp.policy'){
  requireTarget('mcp');if(!entry?.policyWritable||!entry.owner)throw err(409,'EXTENSION_READ_ONLY','此插件 MCP 策略来源受管或尚未核实。');
  const previous=before.config.layer.config.plugins?.[entry.owner]??{},servers=previous.mcp_servers??{},overlay=servers[target.id]??{};
  await writeConfig(peer,cwd,before,input.expectedVersion,'plugins',entry.owner,{...previous,mcp_servers:{...servers,[target.id]:{...overlay,...input.config}}},options.assertCurrent);
 }else if(input.action==='mcp.save'){
  if(input.key){requireTarget('mcp');writable();if(input.name!==target.id)throw invalid();}else if(before.config?.read.config.mcp_servers?.[input.name!]!==undefined)throw err(409,'EXTENSION_CONFLICT','同名 MCP 已存在，请刷新并编辑。');
  const previous=before.config?.layer?.config?.mcp_servers?.[input.name!]??{},next={...previous,...input.config};
  if(input.config?.url!==undefined){for(const k of ['command','args','cwd','env','env_vars'])delete next[k];}else if(input.config?.command!==undefined){for(const k of ['url','http_headers','env_http_headers','bearer_token_env_var','auth'])delete next[k];}
  validateMcp(Object.fromEntries(Object.entries(next).filter(([k])=>fields.includes(k))));if(!next.command&&!next.url)throw invalid();
  await writeConfig(peer,cwd,before,input.expectedVersion,'mcp_servers',input.name!,next,options.assertCurrent);
 }else if(input.action==='mcp.reload'){
  options.assertCurrent?.();try{await peer.request('config/mcpServer/reload',{});}catch(e:any){if(Number.isSafeInteger(e?.code))throw err(503,'EXTENSION_WRITE_FAILED','MCP 重载被宿主拒绝。');throw unknown();}
 }else if(input.action==='mcp.login'){
  requireTarget('mcp');writable();options.assertCurrent?.();try{result=await peer.request('mcpServer/oauth/login',{name:target.id});}catch(e:any){if(Number.isSafeInteger(e?.code))throw err(503,'EXTENSION_WRITE_FAILED','宿主未能启动 MCP 授权。');throw unknown();}
  const url=(()=>{try{const u=new URL(result?.authorizationUrl);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}})();if(!url)throw unknown();return {status:'authorization-required' as const,authorizationUrl:url,snapshot:(await readAfter()).snapshot,invalidatedSections};
 }else{
  let args:string[];
  if(input.action==='marketplace.add'){
   if(source!.local&&(input.sparsePaths?.length||input.ref))throw invalid();
   args=['plugin','marketplace','add',source!.source,...(input.ref?['--ref',input.ref]:[]),...(input.sparsePaths??[]).flatMap(p=>['--sparse',p]),'--json'];verify=s=>s.marketplaces.some(m=>!before.snapshot.marketplaces.some(b=>b.key===m.key));
  }else if(input.action==='marketplace.remove'||input.action==='marketplace.upgrade'){
   requireTarget('marketplace');if(!market?.writable)throw err(409,'EXTENSION_READ_ONLY','隐式或所有权未核实的市场只读。');
   if(input.action==='marketplace.upgrade'&&target.sourceType!=='git')throw err(409,'EXTENSION_READ_ONLY','本地市场不支持 Git 同步；请在来源目录中更新文件。');
   if(input.action==='marketplace.remove'&&before.snapshot.sources.some(s=>['plugin-directories','plugins'].includes(s.id)&&s.status!=='ok'))throw err(409,'EXTENSION_CONFLICT','插件目录读取不完整，无法核实移除市场的全部影响。');
   if(input.action==='marketplace.remove'&&input.impactVersion!==market.impactVersion)throw err(409,'EXTENSION_CONFLICT','市场移除影响已变化，请重新查看确认。');
   args=['plugin','marketplace',input.action==='marketplace.remove'?'remove':'upgrade',target.id,'--json'];verify=input.action==='marketplace.remove'?s=>!s.marketplaces.some(m=>m.key===input.key):()=>true;
  }else if(input.action==='plugin.install'){
   requireTarget('available');if(!target.id||before.snapshot.available.find(x=>x.key===input.key)?.writable!==true)throw err(409,'EXTENSION_READ_ONLY','该目录项受管、不可安装或没有可核实的安装标识。');args=['plugin','add',target.id,'--json'];verify=s=>s.items.some(x=>x.kind==='plugin'&&x.key===input.key);
  }else if(input.action==='plugin.remove'){
   requireTarget('plugin');writable();args=['plugin','remove',target.id,'--json'];verify=s=>!s.items.some(x=>x.key===input.key);
  }else{
   requireTarget('mcp');writable();if(!name(target.id))throw invalid();args=['mcp',input.action==='mcp.remove'?'remove':'logout',target.id];verify=input.action==='mcp.remove'?s=>!s.items.some(x=>x.kind==='mcp'&&x.id===target.id):s=>s.items.find(x=>x.key===input.key)?.authorization==='notLoggedIn';
  }
  if(!input.expectedVersion||before.snapshot.userVersion!==input.expectedVersion)throw err(409,'EXTENSION_CONFLICT','配置已变化，请刷新后再执行。');
  options.assertCurrent?.();try{result=await peer.cli(args);}catch(e:any){if(e.code==='EXTENSION_CLI_REJECTED')throw e;throw unknown();}
  if(input.action==='marketplace.upgrade'&&(!Array.isArray(result?.selectedMarketplaces)||!result.selectedMarketplaces.includes(target.id)||!Array.isArray(result.upgradedRoots)||!Array.isArray(result.errors)))throw unknown();
  if(input.action==='plugin.install'&&result?.pluginId!==target.id||input.action==='plugin.remove'&&result?.pluginId!==target.id||input.action==='marketplace.remove'&&result?.marketplaceName!==target.id)throw unknown();
  if(input.action==='marketplace.add'){if(!name(result?.marketplaceName)||typeof result?.alreadyAdded!=='boolean')throw unknown();verify=s=>s.marketplaces.some(m=>m.name===result.marketplaceName);}
  if(Array.isArray(result?.errors)&&result.errors.length)return {status:'partial' as const,snapshot:(await readAfter()).snapshot,errorCount:result.errors.length,invalidatedSections};
 }
 let after:ExtensionsSnapshot;try{after=(await readAfter()).snapshot;}catch{throw unknown();}
 if(after.sources.some(s=>s.status==='error'&&['configuration',target?.kind==='plugin'?'plugins':target?.kind==='mcp'?'mcp':target?.kind==='skill'?'skills':target?.kind==='app'?'apps':'marketplaces'].includes(s.id))||!verify(after))throw unknown();
 return {status:'written' as const,snapshot:after,effect:'future-sessions' as const,invalidatedSections};
}

export async function runExtensionCli(options:{executable:string;args?:string[];home:string;cwd:string;timeoutMs?:number},argv:string[]):Promise<any>{
 const writes=argv.some(x=>['add','remove','upgrade','logout'].includes(x));
 const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:options.home};delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;delete env.CODEX_THREAD_ID;delete env.CODEX_SESSION_ID;
 return new Promise((accept,reject)=>{
  const child=spawn(options.executable,[...(options.args??[]),...argv],{cwd:options.cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const chunks:Buffer[]=[];let bytes=0,done=false,hasDiagnostics=false;const finish=(error?:Error,result?:any)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else accept(result);};
  const timer=setTimeout(()=>{finish(writes?unknown():err(503,'EXTENSION_CLI_FAILED','原生扩展命令读取超时。'));child.kill();},options.timeoutMs??30_000);
  child.stdout.on('data',(buffer:Buffer)=>{bytes+=buffer.length;if(bytes>2*1024*1024){finish(writes?unknown():err(503,'EXTENSION_CLI_FAILED','原生扩展目录超过读取上限。'));child.kill();}else chunks.push(buffer);});
  // Never forward stderr: CLI diagnostics may contain source credentials and environment values.
  child.stderr.on('data',()=>{hasDiagnostics=true;});child.on('error',()=>finish(writes?unknown():err(503,'EXTENSION_CLI_FAILED','无法启动原生扩展命令。')));
  child.on('close',code=>{if(code!==0){finish(writes?unknown():err(503,'EXTENSION_CLI_REJECTED','原生命令未成功；请刷新核对结果后再决定下一步。'));return;}if(!writes&&hasDiagnostics){finish(err(503,'EXTENSION_CLI_FAILED','原生目录返回了诊断，可能有来源读取失败；请在原生宿主核对。'));return;}const output=Buffer.concat(chunks).toString('utf8');if(!argv.includes('--json')){finish(undefined,{});return;}try{const result=JSON.parse(output);if(!object(result)&&!Array.isArray(result))throw Error('Invalid JSON');finish(undefined,result);}catch{finish(writes?unknown():err(503,'EXTENSION_CLI_FAILED','原生扩展命令未返回有效 JSON。'));}});
 });
}
