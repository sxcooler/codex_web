import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
import type {InstalledPluginsSnapshot} from '../codex/installed-plugins.ts';
const reasons={disabled_by_admin:'管理员已禁用',plan_not_eligible:'账户方案不符合要求',required_app_unavailable:'所需应用不可用'};
export function InstalledPlugins(){
 const [snapshot,setSnapshot]=useState<InstalledPluginsSnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[search,setSearch]=useState('');const errorBox=useRef<HTMLDivElement>(null),reading=useRef(false);
 const read=async(signal?:AbortSignal)=>{if(reading.current)return;reading.current=true;setBusy(true);setError('');try{const result=await api('/codex/plugins',undefined,signal);if(!signal?.aborted)setSnapshot(result);}catch(e:any){if(!signal?.aborted)setError(e.message);}finally{reading.current=false;if(!signal?.aborted)setBusy(false);}};
 useEffect(()=>{const controller=new AbortController();void read(controller.signal);return()=>controller.abort();},[]);
 useEffect(()=>{if(error)errorBox.current?.focus();},[error]);
 const items=snapshot?.items.filter(plugin=>(plugin.name??plugin.id).toLocaleLowerCase().includes(search.toLocaleLowerCase()))??[];
 return <div className="settings-editor"><p className="muted">显示原生配置的启用状态；本会话工具是否可用取决于连接与授权。</p>
  <div className="actions"><button disabled={busy} aria-busy={busy} onClick={()=>void read()}>{busy?'刷新中…':'刷新插件'}</button></div>
  {error?<div ref={errorBox} tabIndex={-1} role="alert" className="notice error">{error}{snapshot?.supported?'；列表待更新，保留上次成功结果。':''}</div>:null}
  {snapshot?.supported?<><p className="muted small" data-testid="plugins-updated">最后成功读取：{snapshot.updatedAt===null?'未知':new Date(snapshot.updatedAt).toLocaleString()}</p>{snapshot.partial?<p className="notice">部分市场读取失败：{snapshot.errorCount} 个；当前列表不完整。</p>:null}
   <label>搜索已安装插件<input type="search" aria-label="搜索已安装插件" value={search} onChange={event=>setSearch(event.target.value)}/></label>
   {items.length?<ul className="installed-plugins settings-card">{items.map(plugin=><li key={plugin.key}><details className="plugin-details"><summary className="settings-row"><div><h3>{plugin.name??plugin.id}</h3><p className="plugin-summary-description">{plugin.description??'描述未知'}</p></div><span className="plugin-status">{plugin.enabled===true?'已启用':plugin.enabled===false?'已禁用':'状态未知'}<span className="plugin-detail-hint">详情</span></span></summary><div className="settings-details"><p>{plugin.description??'描述未知'}</p><p>版本：{plugin.localVersion??'未知'}</p><p>市场：{plugin.marketplace??'来源未知'}</p><p className="path">插件 id：{plugin.id} · 市场标识：{plugin.key}</p><p className="muted small">可用性：{plugin.availability==='AVAILABLE'?'原生报告可用':plugin.availability==='DISABLED_BY_ADMIN'?'管理员已禁用':'未知'}；原因：{plugin.reason?reasons[plugin.reason]:'未知'}</p></div></details></li>)}</ul>:search?<p>没有匹配的已安装插件</p>:!snapshot.partial?<p>暂无已安装插件</p>:<p>已读取的部分市场没有已安装条目。</p>}
  </>:snapshot?<p className="notice">当前 Codex 版本不支持读取已安装插件</p>:busy?<p role="status">读取已安装插件…</p>:null}
 </div>;
}
