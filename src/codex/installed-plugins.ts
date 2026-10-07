import {createHash} from 'node:crypto';

export type InstalledPlugin={key:string;id:string;name:string|null;description:string|null;marketplace:string|null;localVersion:string|null;enabled:boolean|null;availability:'AVAILABLE'|'DISABLED_BY_ADMIN'|null;reason:'disabled_by_admin'|'plan_not_eligible'|'required_app_unavailable'|null};
export type InstalledPluginsSnapshot={supported:boolean;items:InstalledPlugin[];partial:boolean;errorCount:number;updatedAt:number|null};
const text=(value:unknown):string|null=>typeof value==='string'&&value.length>0?value:null;
// Marketplace names may themselves be source addresses. Never expose those addresses.
const sourceName=(value:unknown)=>text(value)&&!/[:/\\?&#=\x00-\x1f]/.test(value as string)?value as string:null;
const failed=()=>Object.assign(new Error('无法读取已安装插件，请稍后重新读取。'),{statusCode:503,code:'PLUGINS_READ_FAILED'});

export async function readInstalledPlugins(peer:{request:(method:string,params:unknown)=>Promise<any>},cwd?:string):Promise<InstalledPluginsSnapshot>{
 let result:any;
 try{result=await peer.request('plugin/installed',cwd===undefined?{}:{cwds:[cwd]});}
 catch(error:any){
  if(error?.code===-32601)return {supported:false,items:[],partial:false,errorCount:0,updatedAt:null};
  throw failed();
 }
 if(!Array.isArray(result?.marketplaces)||!Array.isArray(result?.marketplaceLoadErrors))throw failed();
 const errorCount=result.marketplaceLoadErrors.length;
 if(errorCount&&!result.marketplaces.length)throw failed();
 const items:InstalledPlugin[]=[];
 for(const market of result.marketplaces){
  if(!text(market?.name)||!Array.isArray(market?.plugins)||(market.path!=null&&typeof market.path!=='string'))throw failed();
  for(const plugin of market.plugins){
   if(plugin?.installed!==true)continue;
   const id=text(plugin.id);if(!id)throw failed();
   items.push({
    key:createHash('sha256').update(JSON.stringify([market.name,market.path??null,id])).digest('hex'),id,
    name:text(plugin.interface?.displayName)??text(plugin.name),description:text(plugin.interface?.shortDescription),
    marketplace:sourceName(market.interface?.displayName)??sourceName(market.name),localVersion:text(plugin.localVersion),
    enabled:typeof plugin.enabled==='boolean'?plugin.enabled:null,
    availability:['AVAILABLE','DISABLED_BY_ADMIN'].includes(plugin.availability)?plugin.availability:null,
    reason:['disabled_by_admin','plan_not_eligible','required_app_unavailable'].includes(plugin.disabledReason)?plugin.disabledReason:null,
   });
  }
 }
 return {supported:true,items,partial:errorCount>0,errorCount,updatedAt:Date.now()};
}
