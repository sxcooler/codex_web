import {useEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {usePanes} from './PaneLayout.tsx';
import {Notifications} from './Notifications.tsx';
import {readSessionSort,writeSessionSort,type SessionSort} from './preferences.ts';
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
export function WebSettings({onChanged}:{onChanged:()=>void}){
 const panes=usePanes();
 const [settings,setSettings]=useState<Json|null>(null),[error,setError]=useState(''),[current,setCurrent]=useState(''),[next,setNext]=useState(''),[busy,setBusy]=useState(false);
 const [notice,setNotice]=useState(''),[confirmation,setConfirmation]=useState<{web:boolean}|null>(null),[checking,setChecking]=useState(false),[dialogError,setDialogError]=useState('');
 const [sort,setSort]=useState(readSessionSort),[sortError,setSortError]=useState(''),[passwordError,setPasswordError]=useState('');
 useEffect(()=>{const sync=()=>setSort(readSessionSort());window.addEventListener('session-sort-changed',sync);window.addEventListener('storage',sync);return()=>{window.removeEventListener('session-sort-changed',sync);window.removeEventListener('storage',sync);};},[]);
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement|null>(null),executing=useRef(false);
  const restartState=settings?.webRestart??{available:false,status:'idle'}, restartPending=['scheduled','unknown'].includes(restartState.status);
  const restartError=(e:any)=>e.status===404?'当前后端尚未加载重启接口，需先更新并重启 Web 服务。':e.message;
  const openRestart=(web:boolean,source:HTMLButtonElement)=>{opener.current=source;setChecking(true);setDialogError('');setConfirmation({web});};
  useEffect(()=>{
    const panel=dialog.current;
    if(!confirmation){if(panel?.open){panel.close();opener.current?.focus();}return;}
    if(!panel?.open)panel?.showModal();cancel.current?.focus();
    const controller=new AbortController();setChecking(true);setDialogError('');
    void Promise.all([api('/runtime/restart-check',undefined,controller.signal),confirmation.web?api('/server/restart',undefined,controller.signal):Promise.resolve(null)]).then(([activity,state])=>{
      if(controller.signal.aborted)return;
      if(state){setSettings(old=>({...old,webRestart:state}));if(!state.available)throw Error(state.reason||'当前启动方式不支持从页面重启 Web 服务。');if(['scheduled','unknown'].includes(state.status))throw Error('已有重启安排或结果待核实，请先检查重启结果。');}
      if(activity?.idle!==true)throw Error('无法确认本机 Codex App Server 的活动状态，请稍后重试。');
    }).catch(e=>{if(!controller.signal.aborted)setDialogError(restartError(e));}).finally(()=>{if(!controller.signal.aborted)setChecking(false);});
    return()=>controller.abort();
  },[confirmation]);
  const restart=async()=>{
    if(!confirmation||checking||dialogError||busy||executing.current)return;
    const web=confirmation.web;executing.current=true;setBusy(true);setError('');setNotice('');
    try{
      if(web){const state=await api('/server/restart',{confirmed:true});setSettings(old=>({...old,webRestart:state}));}
      else{await api('/models/reload',{});setNotice('Codex 已重启，模型列表已重新读取。');setSettings(await api('/settings'));}
      setConfirmation(null);
    }catch(e:any){setDialogError(restartError(e));if(web&&!e.status)setSettings(old=>({...old,webRestart:{...old?.webRestart,status:'unknown'}}));}
    finally{executing.current=false;setBusy(false);}
  };
  const checkRestart=async()=>{setBusy(true);setError('');try{const state=await api('/server/restart');setSettings(old=>({...old,webRestart:state}));}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  const restartMessage=restartState?.status==='scheduled'?`已安排 ${new Date(restartState.scheduledAt).toLocaleTimeString()} 重启 Web 服务。请勿新建或继续任务；稍后检查结果或刷新页面。`:
    restartState?.status==='success'?'Web 服务已重启，服务状态验证通过。':restartState?.status==='failed'?'Web 重启已取消或失败，可能出现活动会话或启动失败。请检查服务日志后再试。':restartState?.status==='unknown'?'Web 重启结果待核实，请检查结果或服务日志，勿重复安排。':'';
  useEffect(()=>{let disposed=false;void api('/settings').then(s=>{if(!disposed)setSettings(s);}).catch(e=>{if(!disposed)setError(e.message);});return()=>{disposed=true;};},[]);
 return <div className="web-settings">
 <div className="settings-group"><h3>浏览器偏好</h3><div className="settings-card"><div className="settings-row"><div><label htmlFor="session-sort">会话列表排序</label><p>收藏始终置顶，其他会话按所选时间降序排列。</p></div><select id="session-sort" value={sort} onChange={event=>{const value=event.target.value as SessionSort;if(writeSessionSort(value)){setSort(value);setSortError('');}else setSortError('排序未持久化，请检查此浏览器的存储权限。');}}><option value="updated_at">更新时间</option><option value="created_at">创建时间</option></select></div>{sortError?<p role="alert" className="notice error">{sortError}</p>:null}<div className="settings-row"><div><h4>工作区布局</h4><p>恢复此浏览器的面板尺寸和位置。</p></div><button onClick={panes.reset}>重置布局</button></div></div></div>
 <div className="settings-group"><div className="settings-card"><Notifications/></div></div>
 <div className="settings-group"><h3>运行状态</h3>{error?<div role="alert" className="notice error">{error}</div>:null}{settings?<div className="settings-card">
 <dl className="settings-status"><dt>Codex Web</dt><dd>{settings.appVersion??'未知'}</dd><dt>Node.js</dt><dd>{settings.nodeVersion??'未知'}</dd><dt>Codex CLI</dt><dd>{settings.modelSource?.version??'未加载'}</dd><dt>模型目录读取</dt><dd>{settings.modelSource?.readAt?new Date(settings.modelSource.readAt).toLocaleString():'尚未读取'}</dd></dl>
 <details className="settings-details"><summary>运行路径与权限详情</summary><dl><dt>访问地址</dt><dd>{settings.origin}</dd><dt>工作根目录</dt><dd>{settings.workRoot}</dd><dt>CLI 路径</dt><dd>{settings.modelSource?.executable??'未知'}</dd></dl>{settings.runtime?.note?<p>{settings.runtime.note}</p>:null}<pre>{pretty(settings.runtime)}</pre><p className="muted small">路径、端口与权限配置变更后需重启服务。</p></details>
 <div className="settings-maintenance"><p className="muted small">维护操作会先检查本机任务状态。</p><div className="actions"><button disabled={busy||restartPending} onClick={async()=>{setBusy(true);setError('');try{await api('/models?refresh=true');setSettings(await api('/settings'));}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>刷新模型列表</button><button disabled={busy||restartPending} onClick={e=>openRestart(false,e.currentTarget)}>重启Codex</button><button className="danger" disabled={busy||restartPending} onClick={e=>openRestart(true,e.currentTarget)}>重启 Web 服务</button></div>{notice?<p role="status" className="notice">{notice}</p>:null}{restartMessage?<div role="status" className={'notice'+(restartState.status==='failed'?' error':'')}>{restartMessage}<button disabled={busy} onClick={()=>void checkRestart()}>检查重启结果</button></div>:null}</div>
 </div>:<p role="status">读取运行状态…</p>}</div>
 {settings?<section className="settings-group" role="region" aria-labelledby="diagnostics-status-title"><h3 id="diagnostics-status-title">当前诊断状态</h3><div className="settings-card"><dl className="settings-status"><dt>诊断记录</dt><dd>{settings.diagnostics?.enabled===true?'已启用':settings.diagnostics?.enabled===false?'未启用':'未知（后端尚未提供状态）'}</dd><dt>最近成功写入</dt><dd data-testid="diagnostics-last-write">{settings.diagnostics?.lastWriteAt!=null?new Date(settings.diagnostics.lastWriteAt).toLocaleString():settings.diagnostics?'尚无成功写入':'未知'}</dd><dt>丢弃记录数</dt><dd>{settings.diagnostics?.dropped??'未知'}</dd><dt>写入失败数</dt><dd>{settings.diagnostics?.writeFailures??'未知'}</dd></dl></div></section>:null}
 <div className="settings-group"><h3>管理员密码</h3><div className="settings-card settings-password"><p className="muted small">修改后所有已登录设备需要重新登录。</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setPasswordError('');try{await api('/auth/password',{currentPassword:current,newPassword:next});setCurrent('');setNext('');onChanged();}catch(e:any){setPasswordError(e.message);}finally{setBusy(false);}}}><label>当前密码<input type="password" required minLength={12} maxLength={256} autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>新密码<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={next} onChange={e=>setNext(e.target.value)}/></label>{passwordError?<div role="alert" className="notice error">{passwordError}</div>:null}<button className="primary" disabled={busy}>{busy?'保存中…':'修改密码并退出'}</button></form></div></div>
    <dialog ref={dialog} className="restart-dialog" aria-labelledby="restart-title" aria-describedby="restart-warning" onCancel={e=>{e.preventDefault();if(!busy)setConfirmation(null);}} onClick={e=>{if(e.target===e.currentTarget&&!busy)setConfirmation(null);}}>
      <h2 id="restart-title">{confirmation?.web?'重启 Web 服务？':'重启Codex？'}</h2>
      <p className="muted">{confirmation?.web?'预检通过后将在 90 秒后重启 Web 服务，页面连接会暂时断开。':'重启 Codex 后台进程并重新读取模型列表，不会升级 CLI。'}</p>
      <p id="restart-warning" className="notice error">仅在本机 Codex App Server 无活动任务、待审批或待输入时允许重启。系统将在执行前再次检查，有活动任务时会拒绝操作。</p>
      {checking?<p role="status">正在查询本机 App Server 的活动状态…</p>:dialogError?<p role="alert" className="notice error">{dialogError}</p>:<p role="status" className="muted">本机 App Server 当前空闲。</p>}
      <div className="actions restart-actions"><button ref={cancel} type="button" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button>{dialogError?<button type="button" disabled={busy} onClick={()=>setConfirmation(old=>old?{...old}:null)}>重新检查</button>:null}<button type="button" className="danger" disabled={busy||checking||!!dialogError} onClick={()=>void restart()}>{busy?'正在执行…':'确认重启'}</button></div>
    </dialog>
 </div>;
}
