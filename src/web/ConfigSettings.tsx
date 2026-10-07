import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import type {SettingsSnapshot,SettingsValues} from '../codex/settings.ts';
import type {DraftProps,SettingsProject} from './Settings.tsx';

const configKeys=['model','model_reasoning_effort','approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess','web_search'] as const;
const memoryKeys=['memoriesEnabled','generateMemories','useMemories','allowExternalMemory'] as const;
const allKeys=[...configKeys,'service_tier',...memoryKeys] as const;
const labels:Record<typeof allKeys[number],string>={model:'默认模型',model_reasoning_effort:'推理强度',approval_policy:'审批策略',approvals_reviewer:'审批审核者',sandbox_mode:'沙箱模式',workspaceNetworkAccess:'工作区网络访问',web_search:'搜索模式',service_tier:'速度',memoriesEnabled:'启用 Codex 记忆',generateMemories:'生成记忆',useMemories:'使用记忆',allowExternalMemory:'允许从工具聊天生成记忆'};
const choices={approval_policy:['on-request','never'],approvals_reviewer:['user','auto_review'],sandbox_mode:['read-only','workspace-write','danger-full-access'],web_search:['disabled','cached','live']};
const display=(value:unknown)=>value===null||value===undefined?'未设置／未知':typeof value==='boolean'?(value?'允许':'关闭'):String(value);
export function ConfigSettings({projects,onDirtyChange,onLeave,actions,mode='config'}:DraftProps&{projects:SettingsProject[];mode?:'config'|'speed'|'memory'}){
 const keys=mode==='memory'?memoryKeys:mode==='speed'?['service_tier'] as const:configKeys;
 const [project,setProject]=useState(''),[snapshot,setSnapshot]=useState<SettingsSnapshot|null>(null),[draft,setDraft]=useState<Partial<SettingsValues>>({}),[models,setModels]=useState<Json[]>([]),[permissions,setPermissions]=useState<Json|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState<'conflict'|'unknown'|null>(null),errorBox=useRef<HTMLDivElement>(null),saving=useRef(false);
 const dirty=Object.keys(draft).length>0;
 useLayoutEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty,onDirtyChange]);
 useEffect(()=>{if(error)errorBox.current?.focus();},[error]);
 const query=project?'?projectId='+encodeURIComponent(project):'';
 const read=async(preserve=false,signal?:AbortSignal)=>{
  setBusy(true);setError('');
  try{const result=await Promise.allSettled([api('/codex/settings'+query,undefined,signal),api('/models',undefined,signal),api('/permission-modes'+query,undefined,signal)]);if(signal?.aborted)return;
   const failures:string[]=[];
   if(result[0].status==='fulfilled'){setSnapshot(result[0].value);if(!preserve)setDraft({});setBlocked(null);}else failures.push(result[0].reason.message);
   if(result[1].status==='fulfilled')setModels(result[1].value.data??[]);else{setModels([]);failures.push('模型目录读取失败：'+result[1].reason.message);}
   if(result[2].status==='fulfilled')setPermissions(result[2].value);else{setPermissions(null);failures.push('权限能力读取失败：'+result[2].reason.message);}
   setError(failures.join('；'));if(preserve&&result[0].status==='fulfilled')setNotice('已重新读取；保留草稿，请比较用户原值与编辑值后再保存。');
  }finally{if(!signal?.aborted)setBusy(false);}
 };
 useEffect(()=>{setSnapshot(null);setDraft({});setNotice('');setBlocked(null);const controller=new AbortController();void read(false,controller.signal);return()=>controller.abort();},[project]);
 const current=(key:keyof SettingsValues)=>draft[key]??snapshot?.fields[key]?.userValue??null;
 const resolved=(key:keyof SettingsValues)=>current(key)??snapshot?.fields[key]?.effectiveValue??snapshot?.fields[key]?.defaultValue??null;
 const selectedModel=current('model'),effort=current('model_reasoning_effort');
 const model=models.find(m=>m.model===selectedModel),menuModel=model??models.find(m=>m.model===snapshot?.fields.model.effectiveValue);
 const efforts:string[]=(menuModel?.supportedReasoningEfforts??[]).map((e:Json)=>e.reasoningEffort);
 const modelChanged='model'in draft||'model_reasoning_effort'in draft;
 const effective=(key:'model'|'model_reasoning_effort')=>{const field=snapshot?.fields[key];return key in draft&&(!field?.origin||['user','system','packagedDefaults'].includes(field.origin.type))?draft[key]:field?.effectiveValue;};
 const effectiveModel=models.find(m=>m.model===effective('model'));
 const effectiveEffort=effective('model_reasoning_effort')??effectiveModel?.defaultReasoningEffort;
 const pairIssue=selectedModel===null?'用户默认模型尚未确定，请显式选择模型；项目有效模型不能代替用户默认值。':effort===null?'用户推理强度尚未确定，请显式选择强度；项目有效强度不能代替用户默认值。':!model?.supportedReasoningEfforts?.some((e:Json)=>e.reasoningEffort===effort)||!effectiveModel?.supportedReasoningEfforts?.some((e:Json)=>e.reasoningEffort===effectiveEffort)?'用户或有效模型不支持当前推理强度，请显式选择兼容组合；不会自动降低强度。':'';
 const invalidPair=mode==='config'&&modelChanged&&!!pairIssue;
 const writableDraft=Object.keys(draft).every(name=>{const key=name as keyof SettingsValues,field=snapshot?.fields[key];return field?.writable||(key==='workspaceNetworkAccess'&&draft.sandbox_mode==='workspace-write'&&field?.reason==='网络选项仅能在 workspace-write 沙箱下编辑。');});
 const tierModel=model??(snapshot?.fields.model.userValue===null&&snapshot?.fields.model.effectiveValue===null?models.find(m=>m.isDefault):undefined);
 const tierEffective=effectiveModel??(snapshot?.fields.model.effectiveValue===null?models.find(m=>m.isDefault):undefined);
 const tiers=[{value:'default',label:'标准',description:'常规处理速度'},...(tierModel?.serviceTiers??[]).filter((tier:Json)=>tier.id!=='default'&&tierEffective?.serviceTiers?.some((other:Json)=>other.id===tier.id)).map((tier:Json)=>({value:tier.id,label:tier.id==='priority'||tier.name==='Fast'?'快速':tier.name??tier.id,description:tier.description??''}))];
 const tierIssue=mode==='speed'&&(!tierModel||!tierEffective)?'无法核对用户与有效模型的速度目录，请先在配置中确定默认模型。':mode==='speed'&&'service_tier'in draft&&!tiers.some(tier=>tier.value===draft.service_tier)?'所选速度不受当前模型支持，请重新选择。':'';
 const canSave=!!snapshot?.writable&&!!snapshot.userVersion&&dirty&&!busy&&!blocked&&!invalidPair&&!tierIssue&&writableDraft;
 const edit=(key:keyof SettingsValues,value:string|boolean)=>{setNotice('');setDraft(old=>{const next={...old,[key]:value};if(key==='sandbox_mode'&&value!=='workspace-write')delete next.workspaceNetworkAccess;if(value===snapshot?.fields[key]?.userValue)delete next[key];return next;});};
 const save=async()=>{
  if(!canSave||saving.current)return false;saving.current=true;setBusy(true);setError('');setNotice('');
  try{const result=await api('/codex/settings',{...(project?{projectId:project}:{}),expectedVersion:snapshot!.userVersion,values:draft});setSnapshot(result.snapshot);setDraft({});setNotice('本机默认配置已保存，供后续新建／重新加载的会话读取；当前任务设置保持原状。');return true;}
  catch(e:any){setError(e.message);if(e.status===409)setBlocked('conflict');else if(e.status===504||!e.status)setBlocked('unknown');return false;}
  finally{saving.current=false;setBusy(false);}
 };
 actions.current={save,discard:()=>{setDraft({});onDirtyChange(false);}};
 const permissionReadonly=!permissions||['approval_policy','approvals_reviewer','sandbox_mode'].some(key=>!snapshot?.fields[key as keyof SettingsValues]?.writable);
 const sandbox=current('sandbox_mode')??snapshot?.fields.sandbox_mode.effectiveValue;
 const permissionEdited=['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'].some(key=>key in draft);
 const preset=!permissionEdited?permissions?.current??'custom':sandbox==='danger-full-access'&&current('approval_policy')==='never'&&current('approvals_reviewer')==='user'?'full-access':sandbox==='workspace-write'&&current('workspaceNetworkAccess')===false&&current('approval_policy')==='on-request'?(current('approvals_reviewer')==='user'?'ask':current('approvals_reviewer')==='auto_review'?'auto-review':'custom'):'custom';
 const presetChange=(id:string)=>{if(id==='custom')return;const values:Partial<SettingsValues>=id==='full-access'?{approval_policy:'never',approvals_reviewer:'user',sandbox_mode:'danger-full-access'}:{approval_policy:'on-request',approvals_reviewer:id==='auto-review'?'auto_review':'user',sandbox_mode:'workspace-write',workspaceNetworkAccess:false};setDraft(old=>{const next={...old,...values};if(id==='full-access')delete next.workspaceNetworkAccess;for(const key of configKeys)if(next[key]===snapshot?.fields[key]?.userValue)delete next[key];return next;});};
 const translations:Record<string,string>={untrusted:'不受信任时审批','on-failure':'失败时审批','on-request':'按请求审批',never:'从不审批',user:'由我审批',auto_review:'自动审核','read-only':'只读','workspace-write':'工作区可写','danger-full-access':'完全访问',disabled:'关闭',cached:'缓存',live:'实时',none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'极高'};
 const help:Record<typeof allKeys[number],string>={model:'后续会话读取的默认模型。',model_reasoning_effort:'按当前模型支持的范围选择，不会自动降低强度。',approval_policy:'控制何时请求执行批准。',approvals_reviewer:'选择由你确认或交给自动审核。',sandbox_mode:'控制命令可访问的文件范围。',workspaceNetworkAccess:'工作区可写沙箱中的网络权限。',web_search:'选择网页搜索是否可用及读取方式。',service_tier:'选择后续会话的处理速度。',memoriesEnabled:'从历史聊天生成记忆，为后续聊天提供上下文。',generateMemories:'允许 Codex 从聊天中生成记忆。',useMemories:'允许 Codex 在后续任务中使用已保存记忆。',allowExternalMemory:'包含 MCP、网页搜索和工具搜索的聊天。'};
 const renderField=(key:typeof allKeys[number])=>{
  const field=snapshot!.fields[key];if(!field)return <div key={key} className="settings-row"><div><h4>{labels[key]}</h4><p>当前原生版本未提供此设置，暂不可编辑。</p></div></div>;
  const network=key==='workspaceNetworkAccess',boolean=network||memoryKeys.includes(key as typeof memoryKeys[number]);
  const writable=field.writable||(network&&sandbox==='workspace-write'&&draft.sandbox_mode==='workspace-write'&&field.reason==='网络选项仅能在 workspace-write 沙箱下编辑。');
  const disabled=busy||!writable||(['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'].includes(key)&&permissionReadonly)||(network&&sandbox!=='workspace-write')||(key==='service_tier'&&!!tierIssue);
  const value=memoryKeys.includes(key as typeof memoryKeys[number])||key==='service_tier'?resolved(key):current(key),shown=value===null?'':String(value);
  const options=key==='model'?models.map(m=>({value:m.model,label:m.displayName??m.model})):key==='model_reasoning_effort'?efforts.map(value=>({value,label:translations[value]??value})):key==='service_tier'?tiers:network?[{value:'false',label:'关闭'},{value:'true',label:'允许'}]:(choices[key as keyof typeof choices]??[]).map(value=>({value,label:translations[value]??value}));
  const overridden=field.origin&&!['user','system','packagedDefaults'].includes(field.origin.type),isDefault=field.userValue===null&&field.effectiveValue===null&&typeof field.defaultValue==='boolean';
  return <div key={key} className="settings-row settings-field" data-setting={key}><div className="settings-row-copy"><label htmlFor={'setting-'+key}>{labels[key]}</label><p>{key==='service_tier'?tiers.find(t=>t.value===value)?.description||help[key]:help[key]}</p>{isDefault?<p className="settings-field-status">未显式配置 · 默认{field.defaultValue?'开启':'关闭'}</p>:null}{boolean&&value===null?<p className="settings-field-status">未设置／未知</p>:null}{overridden?<p className="settings-field-status">{field.origin!.type==='project'?'当前项目覆盖此设置':'此设置有额外覆盖'}：{display(field.effectiveValue)}</p>:null}{!writable?<p className="settings-field-status">{field.reason??'只读'}</p>:null}{network&&sandbox!=='workspace-write'?<p className="settings-field-status">{sandbox==='danger-full-access'?'完全访问沙箱允许网络；此开关不构成限制。':'当前沙箱不使用工作区网络开关。'}</p>:null}</div>
   {boolean&&mode==='memory'?<input id={'setting-'+key} type="checkbox" role="switch" checked={value===true} disabled={disabled||value===null} onChange={event=>edit(key,event.target.checked)}/>:<select id={'setting-'+key} disabled={disabled} value={shown} onChange={event=>edit(key,network?event.target.value==='true':event.target.value)}><option value="" disabled>未设置／未知</option>{shown&&!options.some(o=>o.value===shown)?<option value={shown} disabled>{shown}（待核对）</option>:null}{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>}
  </div>;
 };
 const presetRow=<div className="settings-row"><div><label htmlFor="setting-permission-preset">权限预设</label><p>常用组合；高级设置可单独调整。</p></div><select id="setting-permission-preset" value={preset} disabled={busy||permissionReadonly} onChange={event=>presetChange(event.target.value)}><option value="custom">原生自定义／高级组合</option>{[['ask','请求批准'],['auto-review','帮我批准'],['full-access','完全访问权限']].map(([id,label])=><option key={id} value={id} disabled={!permissions?.modes?.find((mode:Json)=>mode.id===id)?.available}>{label}</option>)}</select></div>;
 return <div className="settings-editor">
  {mode==='config'?<div className="settings-context"><label htmlFor="settings-project">查看项目有效配置</label><select id="settings-project" value={project} disabled={busy} onChange={event=>{const value=event.target.value;onLeave(()=>setProject(value));}}><option value="">主机默认上下文</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><p>保存到主机默认配置；项目仅用于查看覆盖。</p></div>:null}
  {error?<div ref={errorBox} tabIndex={-1} role="alert" className="notice error">{error}</div>:null}{notice?<p role="status" className="settings-feedback">{notice}</p>:null}
  {snapshot?<>{snapshot.supported===false?<p className="notice">当前 Codex 版本不支持读取完整配置设置。</p>:null}<form onSubmit={event=>{event.preventDefault();void save();}}>
   {mode==='config'?<><div className="settings-group"><h3>模型</h3><div className="settings-card">{renderField('model')}{renderField('model_reasoning_effort')}</div></div><div className="settings-group"><h3>权限与网络</h3><div className="settings-card">{presetRow}{renderField('sandbox_mode')}{renderField('workspaceNetworkAccess')}{renderField('web_search')}<details className="settings-details" open={preset==='custom'}><summary>高级审批设置</summary>{renderField('approval_policy')}{renderField('approvals_reviewer')}</details></div></div></>:mode==='speed'?<div className="settings-group"><h3>运行速度</h3><div className="settings-card">{renderField('service_tier')}</div><p className="muted small">只影响后续读取默认配置的会话。</p></div>:<div className="settings-group"><h3>Codex 记忆</h3><p className="muted small">管理原生 Codex 记忆；AgentMemory 插件独立运行。</p><div className="settings-card">{renderField('memoriesEnabled')}{renderField('allowExternalMemory')}<details className="settings-details"><summary>记忆高级设置</summary>{renderField('generateMemories')}{renderField('useMemories')}</details></div><p className="muted small">删除全部原生记忆请在官方客户端中管理。</p></div>}
   {invalidPair?<p role="alert" className="notice error">{pairIssue}</p>:null}{tierIssue?<p className="notice">{tierIssue}</p>:null}
   <details className="settings-details settings-config-details"><summary>配置详情</summary><p className="path">用户配置文件：{snapshot.userFile??'无法确定'}</p>{keys.map(key=>{const field=snapshot.fields[key];return field?<div key={key}><h4>{labels[key]}</h4><dl><dt>用户文件原值</dt><dd>{display(field.userValue)}</dd><dt>当前有效值</dt><dd>{display(field.effectiveValue)}</dd>{field.defaultValue!==undefined?<><dt>官方默认值</dt><dd>{display(field.defaultValue)}</dd></>:null}<dt>来源</dt><dd>{field.origin?[field.origin.type,field.origin.file,field.origin.profile].filter(Boolean).join(' · '):'未知'}</dd></dl></div>:null;})}</details>
   {dirty?<div className="settings-changes"><h3>保存前比较（用户配置文件）</h3>{keys.filter(key=>key in draft).map(key=><p key={key}>{labels[key]}：{display(snapshot.fields[key]?.userValue)} → {display(draft[key])}</p>)}</div>:null}
   <div className="settings-save"><span>{dirty?`${Object.keys(draft).length} 项已修改`:'没有待保存的更改'}</span><div className="actions"><button type="button" disabled={busy||!dirty} onClick={()=>{setDraft({});onDirtyChange(false);}}>放弃更改</button><button className="primary" disabled={!canSave} aria-busy={busy}>{saving.current?'保存中…':'保存配置'}</button></div></div>
  </form></>:busy?<p role="status">读取配置…</p>:null}
  <button className="settings-reread" disabled={busy} onClick={()=>void read(dirty)}>{blocked==='unknown'?'先读回核对':blocked==='conflict'?'重新读取并比较':busy?'读取中…':'重新读取配置'}</button>
 </div>;
}
