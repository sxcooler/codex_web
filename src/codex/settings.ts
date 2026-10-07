import {isAbsolute} from 'node:path';
import {permissionChoices} from './permissions.ts';

export type SettingsValues={model:string;model_reasoning_effort:string;approval_policy:string;approvals_reviewer:string;sandbox_mode:string;workspaceNetworkAccess:boolean;web_search:string;service_tier:string;memoriesEnabled:boolean;generateMemories:boolean;useMemories:boolean;allowExternalMemory:boolean};
export type SettingsOrigin={type:string;file?:string;profile?:string|null};
export type SettingsField={userValue:string|boolean|null;effectiveValue:string|boolean|null;defaultValue?:string|boolean|null;origin:SettingsOrigin|null;writable:boolean;reason:string|null};
export type SettingsSnapshot={fields:Record<keyof SettingsValues,SettingsField>;userVersion:string|null;userFile:string|null;writable:boolean;supported?:boolean};
export type SettingsWriteInput={expectedVersion:string;values:Partial<SettingsValues>};
export const settingsKeys=['model','model_reasoning_effort','approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess','web_search','service_tier','memoriesEnabled','generateMemories','useMemories','allowExternalMemory'] as const;
const booleanKeys=['workspaceNetworkAccess','memoriesEnabled','generateMemories','useMemories','allowExternalMemory'];
const memoryDefaults={memoriesEnabled:false,generateMemories:true,useMemories:true,allowExternalMemory:true};
const permissionKeys=['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'] as const;
const approvals=['untrusted','on-failure','on-request','never'];
const reviewers=['user','auto_review'];
const sandboxes=['read-only','workspace-write','danger-full-access'];
const searches=['disabled','cached','live'];
const networkReason='网络选项仅能在 workspace-write 沙箱下编辑。';
const managedTypes=['mdm','enterpriseManaged','legacyManagedConfigTomlFromFile','legacyManagedConfigTomlFromMdm'];
const object=(v:any):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const string=(v:any):v is string=>typeof v==='string'&&v.length>0;
export function settingsError(statusCode:number,code:string,message:string){return Object.assign(new Error(message),{statusCode,code});}
type Peer={request:(method:string,params:any)=>Promise<any>;models:()=>Promise<{data:any[]}>;platform:()=>string|undefined};
const nativeKeys:Partial<Record<keyof SettingsValues,string>>={workspaceNetworkAccess:'sandbox_workspace_write.network_access',memoriesEnabled:'features.memories',generateMemories:'memories.generate_memories',useMemories:'memories.use_memories',allowExternalMemory:'memories.disable_on_external_context'};
const nativeKey=(key:keyof SettingsValues)=>nativeKeys[key]??key;
const nativeValue=(config:any,key:keyof SettingsValues)=>nativeKey(key).split('.').reduce((v,k)=>v?.[k],config);
function value(config:any,key:keyof SettingsValues):string|boolean|null{
 const v=nativeValue(config,key);
 if(booleanKeys.includes(key))return typeof v==='boolean'?(key==='allowExternalMemory'?!v:v):null;
 const allowed=key==='approval_policy'?approvals:key==='approvals_reviewer'?reviewers:key==='sandbox_mode'?sandboxes:key==='web_search'?searches:null;
 return string(v)&&v.length<=120&&(!allowed||allowed.includes(v))?v:null;
}
function origin(metadata:any):SettingsOrigin|null{
 const name=metadata?.name;
 if(!object(name)||!['packagedDefaults','system','user','project','sessionFlags',...managedTypes].includes(name.type))return null;
 const result:SettingsOrigin={type:name.type};
 const file=name.type==='project'?name.dotCodexFolder:name.file;
 if(string(file)&&isAbsolute(file))result.file=file;
 if(name.type==='user'&&(name.profile===null||string(name.profile)))result.profile=name.profile;
 return result;
}
export function baseUserLayer(read:any){
 const users=Array.isArray(read.layers)?read.layers.filter((l:any)=>l?.name?.type==='user'):[];
 const layer=users.length===1&&users[0].name.profile===null?users[0]:null;
 return layer&&string(layer.version)&&string(layer.name.file)&&isAbsolute(layer.name.file)&&object(layer.config)?layer:null;
}
function permissionReason(cwd:string,config:any,requirements:any,platform?:string):string|null{
 if(['untrusted','on-failure'].includes(config.approval_policy))return `旧审批策略 ${config.approval_policy} 已停用或由原生迁移，权限设置只读；请在官方客户端核对配置。`;
 if(config.permissions!=null||config.default_permissions!=null||!approvals.includes(config.approval_policy)||!reviewers.includes(config.approvals_reviewer))return '原生自定义权限无法无损表示，权限设置只读。';
 if(requirements?.allowedSandboxModes!=null||requirements?.allowedApprovalPolicies!=null||requirements?.allowedPermissionProfiles!=null||requirements?.defaultPermissions!=null||requirements?.autoReview!=null)return '权限由受管要求限制，权限设置只读。';
 return permissionChoices(cwd,config,requirements,platform).modes.find(m=>m.id==='custom')?.available?null:'当前原生权限无法安全表示，权限设置只读。';
}
async function context(peer:Peer,cwd:string){
 let read:any,requirements:any;
 try{
  const results=await Promise.all([peer.request('config/read',{cwd,includeLayers:true}),peer.request('configRequirements/read',{})]);
  read=results[0];requirements=results[1];
  if(!object(read?.config)||!object(requirements)||!Object.hasOwn(requirements,'requirements')||(requirements.requirements!==null&&!object(requirements.requirements)))throw Error('invalid response');
 }catch(error:any){
  if(error.code===-32601){
   const fields=Object.fromEntries(settingsKeys.map(key=>[key,{userValue:null,effectiveValue:null,origin:null,writable:false,reason:'当前 Codex 版本不支持读取完整配置设置。'}])) as SettingsSnapshot['fields'];
   return {read:{config:{}},layer:null,requirements:null,snapshot:{fields,userVersion:null,userFile:null,writable:false,supported:false} satisfies SettingsSnapshot};
  }
  throw settingsError(503,'SETTINGS_READ_FAILED','无法读取本机 Codex 配置，请稍后重新读取。');
 }
 const layer=baseUserLayer(read),req=requirements.requirements;
 const baseReason=!layer?'无法确定基础用户配置文件与版本，暂不能保存。':layer.disabledReason!=null||layer.disabled_reason!=null?'基础用户配置层已禁用，暂不能保存。':read.config.profile!=null?'当前使用原生 profile，暂不能保存基础用户配置。':null;
 const permissions=permissionReason(cwd,['untrusted','on-failure'].includes(layer?.config.approval_policy)?layer!.config:read.config,req,peer.platform());
 const fields={} as SettingsSnapshot['fields'];
 for(const key of settingsKeys){
  const source=origin(read.origins?.[nativeKey(key)]??read.origins?.[nativeKey(key).split('.')[0]]);
  let reason=baseReason;
  if(source&&managedTypes.includes(source.type))reason='该设置由受管配置控制。';
  if(permissionKeys.includes(key as any)&&permissions)reason=permissions;
  if(key==='workspaceNetworkAccess'&&read.config.sandbox_mode!=='workspace-write'&&!reason)reason=networkReason;
  if(key==='model'&&req?.models?.newThread?.model!=null||key==='model_reasoning_effort'&&req?.models?.newThread?.modelReasoningEffort!=null||key==='service_tier'&&req?.models?.newThread?.serviceTier!=null)reason='该模型默认值由受管要求控制。';
  if(key==='memoriesEnabled'&&req?.featureRequirements?.memories!=null)reason='该记忆功能由受管要求控制。';
  fields[key]={userValue:layer?value(layer.config,key):null,effectiveValue:value(read.config,key),...(key in memoryDefaults?{defaultValue:memoryDefaults[key as keyof typeof memoryDefaults]}:{}),origin:source,writable:!reason,reason};
 }
 if(fields.service_tier.effectiveValue===null){
  const catalog=(await peer.models().catch(()=>({data:[]}))).data;
  const candidates=catalog.filter(m=>read.config.model==null?m.isDefault===true:m.model===read.config.model);
  const model=candidates.length===1?candidates[0]:null,tier=model?.defaultServiceTier;
  fields.service_tier.defaultValue=string(tier)&&(tier==='default'||model?.serviceTiers?.some((t:any)=>t.id===tier))?tier:null;
 }
 return {read,layer,requirements:req,snapshot:{fields,userVersion:layer?.version??null,userFile:layer?.name.file??null,writable:!baseReason,supported:true} satisfies SettingsSnapshot};
}
export async function readSettings(peer:Peer,cwd:string):Promise<SettingsSnapshot>{return (await context(peer,cwd)).snapshot;}
export async function writeSettings(peer:Peer,cwd:string,input:SettingsWriteInput):Promise<{status:'written';snapshot:SettingsSnapshot;effect:'future-sessions'}>{
 if(!object(input)||!string(input.expectedVersion))throw settingsError(409,'SETTINGS_VERSION_REQUIRED','缺少读取时的配置版本，请刷新页面后再保存。');
 if(Object.keys(input).some(k=>!['expectedVersion','values'].includes(k))||!object(input.values)||!Object.keys(input.values).length||Object.keys(input.values).some(k=>!settingsKeys.includes(k as any)))throw settingsError(400,'SETTINGS_INVALID_INPUT','只允许保存指定的 Codex 设置字段。');
 for(const [key,v]of Object.entries(input.values))if(booleanKeys.includes(key)?typeof v!=='boolean':typeof v!=='string'||!v||v.length>120)throw settingsError(400,'SETTINGS_INVALID_INPUT','设置值无效。');
 if('approval_policy'in input.values&&!['on-request','never'].includes(input.values.approval_policy!))throw settingsError(400,'SETTINGS_INVALID_INPUT','审批策略仅支持 on-request 或 never；旧策略已停用或由原生迁移。');
 const before=await context(peer,cwd),{snapshot,layer,requirements}=before;
 if(!snapshot.writable||!layer)throw settingsError(409,'SETTINGS_READ_ONLY','无法确定可写的基础用户配置，请重新读取。');
 if(input.expectedVersion!==snapshot.userVersion)throw settingsError(409,'SETTINGS_CONFLICT','配置已被其他程序修改，请重新读取并比较后保存。');
 for(const key of Object.keys(input.values) as (keyof SettingsValues)[])if(!snapshot.fields[key].writable&&!(key==='workspaceNetworkAccess'&&input.values.sandbox_mode==='workspace-write'&&snapshot.fields[key].reason===networkReason))throw settingsError(409,'SETTINGS_READ_ONLY',snapshot.fields[key].reason!);
 const next={...before.read.config,...input.values};
 const userNext=(key:keyof SettingsValues)=>{
  if(key in input.values)return input.values[key];
  const own=value(layer.config,key);if(own!==null||nativeValue(layer.config,key)!=null)return own;
  const source=origin(before.read.origins?.[nativeKey(key)]);
  return source&&['packagedDefaults','system'].includes(source.type)?value(before.read.config,key):null;
 };
 for(const [key,allowed]of [['approval_policy',approvals],['approvals_reviewer',reviewers],['sandbox_mode',sandboxes],['web_search',searches]] as const)if(key in input.values&&!allowed.includes(next[key]))throw settingsError(400,'SETTINGS_INVALID_INPUT','设置值不受原生协议支持。');
 if('model'in input.values||'model_reasoning_effort'in input.values||'service_tier'in input.values&&input.values.service_tier!=='default'){
  const pairChanged='model'in input.values||'model_reasoning_effort'in input.values;
  const catalog=(await peer.models()).data;
  const defaultModels=layer.config.model==null&&before.read.config.model==null?catalog.filter(m=>m.isDefault===true):[];
  const selectedModel=userNext('model')??(defaultModels.length===1?defaultModels[0].model:null);
  const model=catalog.find(m=>m.model===selectedModel);
  if(!model)throw settingsError(400,'RUNTIME_INVALID_MODEL','Selected model is unavailable');
  const selectedEffort=userNext('model_reasoning_effort')??(layer.config.model_reasoning_effort==null&&before.read.config.model_reasoning_effort==null?model.defaultReasoningEffort:null);
  if(pairChanged&&!model.supportedReasoningEfforts?.some((e:any)=>e.reasoningEffort===selectedEffort))throw settingsError(400,'RUNTIME_INVALID_EFFORT','Reasoning effort is not supported by this model; select an explicit compatible pair if inherited defaults are unknown');
  const effectiveNext=(key:'model'|'model_reasoning_effort'|'service_tier')=>{
   const current=value(before.read.config,key);if(!(key in input.values))return current;
   const source=origin(before.read.origins?.[key]);
   if(source&&['project','sessionFlags',...managedTypes].includes(source.type))return current;
   if(source&&(source.type==='user'&&source.file===layer.name.file&&source.profile===null||['packagedDefaults','system'].includes(source.type)))return input.values[key];
   if(!source&&before.read.layers.every((l:any)=>l===layer||['packagedDefaults','system'].includes(l?.name?.type))&&(layer.config[key]==null||current===value(layer.config,key)))return input.values[key];
   throw settingsError(400,'SETTINGS_INVALID_INPUT','无法核对编辑对当前有效模型的影响，请重新读取配置来源。');
  };
  const effectiveModel=catalog.find(m=>m.model===(effectiveNext('model')??(defaultModels.length===1?defaultModels[0].model:null)));
  if(!effectiveModel)throw settingsError(400,'RUNTIME_INVALID_MODEL','Effective model is unavailable');
  const effectiveEffort=effectiveNext('model_reasoning_effort')??effectiveModel.defaultReasoningEffort;
  if(pairChanged&&!effectiveModel.supportedReasoningEfforts?.some((e:any)=>e.reasoningEffort===effectiveEffort))throw settingsError(400,'RUNTIME_INVALID_EFFORT','Reasoning effort is not supported by the resulting effective model');
  if('model'in input.values||'service_tier'in input.values){
   const userTier=userNext('service_tier');
   if(userTier===null&&'model'in input.values&&(before.read.config.service_tier!=null||before.read.layers.some((l:any)=>l.config?.service_tier!=null)))throw settingsError(400,'RUNTIME_INVALID_SERVICE_TIER','无法核对被项目或会话覆盖的用户继承速度，请显式选择兼容速度。');
   for(const [selected,tier] of [[model,userTier],[effectiveModel,effectiveNext('service_tier')]] as const){
    if(tier!=null&&tier!=='default'&&!selected.serviceTiers?.some((t:any)=>t.id===tier))throw settingsError(400,'RUNTIME_INVALID_SERVICE_TIER','所选速度不受用户或当前有效模型支持。');
   }
  }
 }
 if('workspaceNetworkAccess'in input.values&&userNext('sandbox_mode')!=='workspace-write')throw settingsError(400,'SETTINGS_INVALID_INPUT','网络选项只能在保存后的 workspace-write 用户沙箱中编辑。');
 if('web_search'in input.values&&requirements?.allowedWebSearchModes!=null&&(!Array.isArray(requirements.allowedWebSearchModes)||!requirements.allowedWebSearchModes.includes(next.web_search)))throw settingsError(400,'SETTINGS_INVALID_INPUT','搜索模式不符合受管要求。');
 if(permissionKeys.some(k=>k in input.values)){
  const nativeNext={...next,sandbox_workspace_write:{...before.read.config.sandbox_workspace_write,...('workspaceNetworkAccess'in input.values?{network_access:input.values.workspaceNetworkAccess}:{})}};
  if(permissionReason(cwd,nativeNext,requirements,peer.platform()))throw settingsError(400,'SETTINGS_INVALID_INPUT','权限组合不符合原生要求。');
 }
 const edits=Object.entries(input.values).map(([key,v])=>({keyPath:nativeKey(key as keyof SettingsValues),value:key==='allowExternalMemory'?!v:v,mergeStrategy:'upsert'}));
 let response:any;
 try{response=await peer.request('config/batchWrite',{filePath:layer.name.file,expectedVersion:input.expectedVersion,edits});}
 catch(error:any){
  // Verified with CLI 0.159.2 in an isolated CODEX_HOME; never classify by error text.
  if(error.code===-32600&&error.data?.config_write_error_code==='configVersionConflict')throw settingsError(409,'SETTINGS_CONFLICT','配置已被其他程序修改，请重新读取并比较后保存。');
  if(Number.isSafeInteger(error.code))throw settingsError(503,'SETTINGS_WRITE_FAILED','原生配置写入被拒绝，请重新读取并核对。');
  await context(peer,cwd).catch(()=>{});
  throw settingsError(504,'SETTINGS_WRITE_UNKNOWN','保存结果待核实，请先重新读取配置，勿重复保存。');
 }
 try{
  const after=await context(peer,cwd);
  if(!['ok','okOverridden'].includes(response?.status)||!string(response.version)||response.filePath!==layer.name.file||after.snapshot.userFile!==layer.name.file||after.snapshot.userVersion!==response.version||Object.entries(input.values).some(([k,v])=>after.snapshot.fields[k as keyof SettingsValues].userValue!==v))throw Error('readback mismatch');
  return {status:'written',snapshot:after.snapshot,effect:'future-sessions'};
 }catch{throw settingsError(504,'SETTINGS_WRITE_UNKNOWN','配置写入后无法核对结果，请先重新读取配置，勿重复保存。');}
}
