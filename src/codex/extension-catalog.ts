import {readExtensionSources,extensionKey,object,classifyExtensionReadError} from './extensions.ts';
import type {ExtensionPeer,ExtensionReadError,ExtensionSection,ExtensionSearchPage,ExtensionItem} from './extensions.ts';

export {classifyExtensionReadError} from './extensions.ts';

export async function readExtensionSection(peer:ExtensionPeer,cwd:string,section:ExtensionSection,options:{refresh?:boolean;key?:string}={}){
 const sources=section==='installed'?['configuration','plugins','skills','mcp-definitions']:section==='marketplaces'?['configuration','plugins','marketplaces']:section==='mcp'?['configuration','plugins','mcp']:['configuration','apps'];
 const result=await readExtensionSources(peer,cwd,{sources,refresh:options.refresh,mcpKey:options.key});
 const required=section==='installed'?['configuration','plugins','skills']:section==='marketplaces'?['marketplaces']:section==='apps'?['apps']:options.key?['mcp']:['configuration'];
 if(required.every(id=>result.snapshot.sources.some(s=>s.id===id&&['error','unsupported'].includes(s.status)))){
  const failed=result.snapshot.sources.find(s=>required.includes(s.id)&&s.code);throw Object.assign(Error('Extension source unavailable'),failed?{code:failed.code,rpcCode:failed.rpcCode,httpStatus:failed.httpStatus}:{});
 }
 return result.snapshot;
}

function text(v:unknown):string|null{return typeof v==='string'&&v.length<=4096&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)?v:null;}
export async function searchExtensions(peer:ExtensionPeer,cwd:string,input:{query:string;cursor?:string;refresh?:boolean}):Promise<Omit<ExtensionSearchPage,'contextKey'|'cache'>>{
 const query=typeof input?.query==='string'?input.query.trim():'';
 if(!query||query.length>200||/[\x00-\x1f]/.test(query)||input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>4096||/[\x00-\x1f]/.test(input.cursor)))throw Object.assign(Error('扩展搜索参数无效。'),{statusCode:400,code:'EXTENSION_INVALID_INPUT'});
 let result:any;try{result=await peer.request('plugin/search',{searchTerm:query,scope:'global',cwds:[cwd],limit:50,cursor:input.cursor??null});}catch(e){throw Object.assign(Error('Extension search unavailable'),classifyExtensionReadError(e));}
 if(!Array.isArray(result?.data))throw Object.assign(Error('Invalid catalog'),{code:'INVALID_RESPONSE'});
 if(result.data.length>1000)throw Object.assign(Error('Catalog limit'),{code:'CATALOG_LIMIT'});
 if(result.nextCursor!=null&&(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>4096||result.nextCursor===input.cursor))throw Object.assign(Error('Invalid cursor'),{code:'CATALOG_LIMIT'});
 const items:ExtensionItem[]=[],seen=new Set<string>();
 for(const row of result.data){
  const p=row?.plugin;
  if(!object(p))throw Object.assign(Error('Invalid plugin'),{code:'INVALID_RESPONSE'});
  const id=text(p.id),market=text(row.marketplaceName),display=text(p.interface?.displayName??p.name),path=row.marketplacePath;
  if(path!==null&&typeof path!=='string')throw Object.assign(Error('Invalid marketplace'),{code:'INVALID_RESPONSE'});
  if(!id||!market||!display)throw Object.assign(Error('Invalid plugin'),{code:'INVALID_RESPONSE'});
  const identity=extensionKey('plugin',JSON.stringify([market,path,id]));if(seen.has(identity))continue;seen.add(identity);
  const allowed=/^[\w.-]+@[\w.-]+$/.test(id)&&id.endsWith('@'+market)&&p.remotePluginId===null&&['AVAILABLE','INSTALLED_BY_DEFAULT'].includes(p.installPolicy)&&p.availability==='AVAILABLE'&&!['WORKSPACE_SETTING','IMPLICIT_CANONICAL_APP'].includes(p.installPolicySource);
  items.push({key:identity,kind:'plugin',id,name:display,description:text(p.interface?.shortDescription??p.description),source:market,installPolicySource:text(p.installPolicySource),scope:'global',installed:typeof p.installed==='boolean'?p.installed:false,enabled:typeof p.enabled==='boolean'?p.enabled:null,owner:null,connected:null,callable:null,connection:null,authorization:null,version:text(p.localVersion??p.version),writable:allowed,reason:allowed?null:'This entry has no verified writable CLI installation identity or is controlled by policy.',installUrl:null});
 }
 const cliIds=new Map<string,number>();for(const entry of items)cliIds.set(entry.id,(cliIds.get(entry.id)??0)+1);
 for(const entry of items)if(cliIds.get(entry.id)!==1){entry.writable=false;entry.reason='Multiple marketplace identities share this CLI id; install it through the native app.';}
 return {query,items,nextCursor:result.nextCursor??null,source:{id:'discovery',status:'ok',count:items.length,reason:null,lastSuccessAt:Date.now()}};
}
