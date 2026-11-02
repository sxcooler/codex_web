import type {ExtensionsSnapshot,ExtensionSectionSnapshot,ExtensionItem,ExtensionMarketplace,ExtensionKind} from '../codex/extensions.ts';
const internalSources=new Set(['openai-bundled','openai-primary-runtime']);
export function appIconFallback(entry:ExtensionItem,items:ExtensionItem[]):string|null{
 if(entry.kind!=='app'||!entry.iconUrl||entry.ownerNames?.length!==1)return null;
 const owners=items.filter(item=>item.kind==='plugin'&&item.installed===true&&item.name===entry.ownerNames![0]);
 const icon=owners.length===1?owners[0].iconUrl:null;
 return icon&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(icon)?icon:null;
}
export function visibleExtensionItems(items:ExtensionItem[]):ExtensionItem[]{
 // Native Apps expose owner display names; ambiguous ownership must stay visible.
 const pluginsByName=new Map<string,ExtensionItem[]>();for(const item of new Map(items.filter(item=>item.kind==='plugin').map(item=>[item.key,item])).values())pluginsByName.set(item.name,[...(pluginsByName.get(item.name)??[]),item]);
 const skills=new Set<string>();
 return items.filter(item=>{
  if(item.kind==='app')return item.callable===true&&item.source!=='openai-bundled'&&!(item.ownerNames?.length&&item.ownerNames.every(name=>{const owners=pluginsByName.get(name);return owners?.length===1&&owners[0].source==='openai-bundled';}));
  if(item.kind==='mcp')return item.configured===true;
  if(internalSources.has(item.source??''))return false;
  if(item.kind==='plugin')return item.installPolicySource!=='IMPLICIT_CANONICAL_APP';
  if(item.kind==='skill'){if(item.scope!=='user'||item.owner||item.recommended===true||skills.has(item.id))return false;skills.add(item.id);return true;}
  return false;
 });
}
export const visibleExtensionMarketplaces=(items:ExtensionMarketplace[])=>items.filter(item=>item.configured===true&&!['openai-bundled','openai-primary-runtime','openai-curated','openai-curated-remote'].includes(item.name));
export function visibleExtensionCount(snapshot:ExtensionsSnapshot|null,kind:ExtensionKind|'marketplace'):number|null{
 if(!snapshot)return null;
 const required=kind==='plugin'?['plugins']:kind==='app'?['apps']:kind==='skill'?['skills','skill-recommendations']:kind==='mcp'?['configuration','mcp-definitions']:['configuration','marketplaces'];
 const related=[...required,...(kind==='plugin'?['plugin-directories']:kind==='skill'?['skill-directories']:kind==='app'?['apps-metadata']:[])];
 if(required.some(id=>!snapshot.sources.some(source=>source.id===id&&source.status==='ok'))||snapshot.sources.some(source=>related.includes(source.id)&&source.status!=='ok'))return null;
 if(kind==='app'&&snapshot.items.some(item=>item.kind==='app'&&item.callable==null)||kind==='skill'&&snapshot.items.some(item=>item.kind==='skill'&&item.scope==='user'&&!item.owner&&item.recommended==null))return null;
 return kind==='marketplace'?visibleExtensionMarketplaces(snapshot.marketplaces).length:visibleExtensionItems(snapshot.items).filter(item=>item.kind===kind).length;
}
export function mergeExtensionSection(current:ExtensionsSnapshot|null,incoming:ExtensionSectionSnapshot):ExtensionsSnapshot&{contextKey:string}{
 const old=current as (ExtensionsSnapshot&{contextKey?:string})|null;
 if(old&&(old.contextKey!==incoming.contextKey||old.userVersion!==incoming.userVersion))throw Error('EXTENSION_CONTEXT_CHANGED');
 const section=incoming.section,owned=(entry:ExtensionItem)=>section==='installed'?['plugin','skill'].includes(entry.kind):section==='apps'?entry.kind==='app':section==='mcp'?entry.kind==='mcp':false;
 const available=incoming.items.filter(entry=>owned(entry)||section==='installed'&&entry.kind==='mcp');
 const usable=(id:string)=>!incoming.sources.some(s=>s.id===id&&['error','unsupported','notLoaded'].includes(s.status));
 const replace=(entry:ExtensionItem)=>owned(entry)&&usable(entry.kind==='plugin'?'plugins':entry.kind==='skill'?'skills':entry.kind==='app'?'apps':'mcp');
 const previous=old?.items??[],items=previous.filter(entry=>!replace(entry));
 for(const entry of available){const index=items.findIndex(item=>item.key===entry.key),earlier=previous.find(item=>item.key===entry.key),next={...earlier,...entry,...(entry.config===undefined&&earlier?.config?{config:earlier.config}:{})};if(index>=0)items[index]=next;else items.push(next);}
 if(!incoming.cache.stale&&incoming.sources.some(source=>source.id==='mcp-definitions'&&source.status==='ok')){
  const configured=new Set(incoming.items.filter(entry=>entry.kind==='mcp'&&entry.configured===true).map(entry=>entry.key));
  for(let index=0;index<items.length;index++)if(items[index].kind==='mcp')items[index]={...items[index],configured:configured.has(items[index].key)};
 }
 const sources=new Map((old?.sources??[]).map(s=>[s.id,s]));for(const source of incoming.sources)if(source.status!=='notLoaded'||!sources.has(source.id))sources.set(source.id,source);
 return {...incoming,items,available:old?.available??[],marketplaces:section==='marketplaces'&&(usable('marketplaces')||!old)?incoming.marketplaces:old?.marketplaces??[],sources:[...sources.values()]};
}
