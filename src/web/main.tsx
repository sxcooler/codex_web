import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { submissionId, type Submission } from './submission.ts';
import { api, setCsrfToken } from './api.ts';
import { PaneLayout, PaneSeparator, PaneToolbar, usePanes } from './PaneLayout.tsx';
import { TurnOptions, type TurnSettings } from './TurnOptions.tsx';
import { Attachments, type Attachment } from './Attachments.tsx';
import { Session } from './SessionView.tsx';
import { drafts } from './drafts.ts';
import { releaseOnLeave } from './handoff.ts';
import { Notifications } from './Notifications.tsx';

type Project = {id:string;name:string;path:string};
type Json = Record<string, any>;
const releasedNavigation=new Set<string>();
function navigate(path:string,replace=false) { if(replace)history.replaceState(null,'',path);else history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate')); }
const titleOf=(thread:Json)=>String(thread.name||thread.metadata?.web_title||thread.preview||'未命名会话').replace(/\s+/g,' ').slice(0,80);
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const phases:Record<string,string>={IDLE:'就绪',RUNNING:'运行中',WAITING_APPROVAL:'等待审批',WAITING_INPUT:'等待输入',RELEASED:'已释放，可继续',EXTERNAL:'其他客户端运行中',UNKNOWN:'状态待核实'};
function ErrorBox({error}:{error:string}) { return error?<div role="alert" className="notice error">{error}</div>:null; }
function Brand(){return <div className="brand"><img src="/icon.svg" alt=""/><span>Codex Web</span></div>;}

function App() {
  const [authenticated,setAuthenticated]=useState<boolean|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [route,setRoute]=useState(location.pathname+location.search),[projects,setProjects]=useState<Project[]>([]),[sessions,setSessions]=useState<Json[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [sessionsLoading,setSessionsLoading]=useState(false),[sessionsError,setSessionsError]=useState(''),sessionsRequest=useRef(0),sessionsQuery=useRef<string|null>(null);
  const [releaseStates,setReleaseStates]=useState<Record<string,Json>>({}),[includeHidden,setIncludeHidden]=useState(false),routeRef=useRef(route);
  const bootstrap=useCallback(async()=>{try{const data=await api('/auth/session');setCsrfToken(data.csrfToken);setAuthenticated(data.authenticated);setError('');}catch(e:any){setError(e.message);}},[]);
  const releaseLeft=useCallback(async(id:string)=>{try{const result=await releaseOnLeave(id);setReleaseStates(old=>({...old,[id]:result}));}catch(e:any){setReleaseStates(old=>({...old,[id]:{error:e.message}}));}},[]);
  const loadSessions=useCallback(async(nextCursor?:string,passive=false)=>{
    const query=new URLSearchParams();if(nextCursor)query.set('cursor',nextCursor);if(includeHidden)query.set('includeHidden','true');const path='/sessions'+(query.size?'?'+query:'');
    if(passive&&sessionsQuery.current===path)return;sessionsQuery.current=path;
    const request=++sessionsRequest.current;setSessionsLoading(true);setSessionsError('');
    try {
      const result=await api(path);
      if(request!==sessionsRequest.current)return;
      setReleaseStates(old=>({...old,...Object.fromEntries(result.data.filter((item:Json)=>item.release).map((item:Json)=>[item.id,{...item.release,status:item.release.handoffReady?'released':item.release.requested?'pending':'skipped'}]))}));
      setSessions(old=>nextCursor?[...old,...result.data.filter((item:Json)=>!old.some(s=>s.id===item.id))]:result.data);
      setCursor(result.nextCursor);
    }catch(e:any){if(request===sessionsRequest.current)setSessionsError(e.message);}
    finally{if(request===sessionsRequest.current){sessionsQuery.current=null;setSessionsLoading(false);}}
  },[includeHidden]);
  useEffect(()=>{if(!authenticated||!Object.values(releaseStates).some(state=>state.status==='pending'))return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void loadSessions(undefined,true);},5000);return()=>clearInterval(timer);},[authenticated,releaseStates,loadSessions]);
  const load=useCallback(async()=>{
    const results=await Promise.allSettled([api('/projects'),loadSessions()]);
    if(results[0].status==='fulfilled')setProjects(results[0].value.projects);else setError(results[0].reason.message);
  },[loadSessions]);
  useEffect(()=>{void bootstrap();const change=()=>{const next=location.pathname+location.search,oldId=/^\/sessions\/([a-zA-Z0-9-]+)$/.exec(routeRef.current)?.[1],nextId=/^\/sessions\/([a-zA-Z0-9-]+)$/.exec(next)?.[1];if(oldId&&oldId!==nextId){if(releasedNavigation.has(oldId))releasedNavigation.delete(oldId);else void releaseLeft(oldId);}routeRef.current=next;setRoute(next);setNotice('');};const lost=()=>{drafts.clear();setAuthenticated(false);};window.addEventListener('popstate',change);window.addEventListener('auth-lost',lost);return()=>{window.removeEventListener('popstate',change);window.removeEventListener('auth-lost',lost);};},[bootstrap,releaseLeft]);
  useEffect(()=>{if(authenticated)void load();else{drafts.clear();++sessionsRequest.current;sessionsQuery.current=null;setProjects([]);setSessions([]);setCursor(null);setSessionsLoading(false);setSessionsError('');}},[authenticated,load]);
  useEffect(()=>{if(!authenticated)return;const wake=()=>{if(document.visibilityState==='visible')void loadSessions(undefined,true);};window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);return()=>{window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};},[authenticated,loadSessions]);
  useEffect(()=>{const close=(event:PointerEvent)=>{for(const menu of document.querySelectorAll<HTMLDetailsElement>('.session-menu[open]'))if(event.target instanceof Node&&!menu.contains(event.target))menu.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
  if(authenticated===null)return <main className="login"><Brand/><p>连接你的开发机…</p><ErrorBox error={error}/>{error?<button onClick={()=>void bootstrap()}>重新连接</button>:null}</main>;
  if(!authenticated)return <Login onLogin={()=>void bootstrap()}/>;
  const threadId=/^\/sessions\/([a-zA-Z0-9-]+)$/.exec(route)?.[1];
  return <PaneLayout className="shell">
    <aside className="sidebar" id="left-sidebar" aria-label="左侧栏"><Brand/><button className="primary new-task" onClick={()=>navigate('/')}>＋ 新任务</button>
      <div className="side-section"><span className="muted">项目</span><button className="quiet" onClick={async()=>{try{const result=await api('/projects/refresh',{});setProjects(result.projects);}catch(e:any){setError(e.message);}}}>刷新</button></div>
      <select aria-label="打开项目新任务" value="" onChange={e=>navigate('/?project='+encodeURIComponent(e.target.value))}><option value="" disabled>选择项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button className="no-project" onClick={()=>navigate('/')}>无项目</button>
      <div className="side-section"><span className="muted">最近会话</span><button className="quiet" aria-label="刷新最近会话" disabled={sessionsLoading} onClick={()=>void loadSessions()}>{sessionsLoading?'刷新中…':'刷新'}</button></div>
      <label className="show-hidden"><input type="checkbox" checked={includeHidden} onChange={e=>setIncludeHidden(e.target.checked)}/>显示已隐藏会话</label>
      <nav className="recent" aria-label="最近会话" aria-busy={sessionsLoading}>{sessions.length?[...sessions].sort((a,b)=>Number(!!b.metadata?.favorite)-Number(!!a.metadata?.favorite)).map(s=><div className="recent-row" key={s.id}><button title={titleOf(s)} className={s.id===threadId?'selected':''} onClick={()=>navigate('/sessions/'+s.id)}>{s.metadata?.favorite?'★ ':''}{titleOf(s)}{s.metadata?.hidden?'（已隐藏）':''}</button><SessionMenu thread={s} onChanged={load}/>{releaseStates[s.id]?.error?<button className="release-warning" title={releaseStates[s.id].error} onClick={()=>void releaseLeft(s.id)}>释放未完成 · 重试</button>:releaseStates[s.id]?.status==='pending'?<span className="small muted">等待任务结束后释放</span>:null}</div>):<p className="muted">{sessionsLoading?'读取会话…':'暂无会话'}</p>}{cursor?<button disabled={sessionsLoading} onClick={()=>void loadSessions(cursor)}>加载更多</button>:null}</nav>
      <div className="side-footer"><button onClick={()=>navigate('/settings')}>⚙　设置</button><button onClick={async()=>{try{await api('/auth/logout',{});setAuthenticated(false);}catch(e:any){setError(e.message);}}}>↪　退出</button></div>
    </aside>
    <PaneSeparator side="left"/>
    <div className="workspace">{!threadId?<PaneToolbar/>:null}<div className="workspace-content"><ErrorBox error={error}/><ErrorBox error={sessionsError}/>{notice?<div role="status" className="notice">{notice}</div>:null}{threadId?<Session key={threadId} id={threadId} onChanged={loadSessions} onReleased={()=>{releasedNavigation.add(threadId);navigate('/',true);setNotice('会话已释放并关闭，可从最近会话重新打开继续。');}}/>:route==='/settings'?<Settings onChanged={()=>setAuthenticated(false)}/>:<Home key={route} projects={projects} onChanged={load} onLeaveThread={releaseLeft}/>}</div></div>
  </PaneLayout>;
}

function SessionMenu({thread,onChanged}:{thread:Json;onChanged:()=>Promise<void>}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const change=async(path:string,body:Json)=>{setBusy(true);setError('');try{await api('/sessions/'+thread.id+path,body);await onChanged();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <details className="session-menu"><summary aria-label={'会话菜单 '+titleOf(thread)}>⋯</summary><div><button disabled={busy} onClick={()=>{const name=window.prompt('会话名称',titleOf(thread));if(name?.trim())void change('/name',{name:name.trim()});}}>重命名</button><button disabled={busy} onClick={()=>void change('/metadata',{favorite:!thread.metadata?.favorite})}>{thread.metadata?.favorite?'取消收藏':'收藏'}</button><button disabled={busy} onClick={()=>void change('/metadata',{hidden:!thread.metadata?.hidden})}>{thread.metadata?.hidden?'恢复显示':'从 Web 隐藏'}</button><button disabled={busy} onClick={()=>{if(window.confirm('清除 Web 收藏、隐藏和标题偏好？原生聊天和项目文件会保留，会话可能再次出现在最近列表。'))void change('/metadata/clear',{});}}>清除 Web 元数据</button><ErrorBox error={error}/></div></details>;
}

function Login({onLogin}:{onLogin:()=>void}) {
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/login',{password});setPassword('');onLogin();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <main className="login"><Brand/><h1>连接你的开发机</h1><p className="muted">登录后继续项目与 Codex 会话。</p><form onSubmit={submit}><label>管理员密码<input type="password" autoComplete="current-password" required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label><ErrorBox error={error}/><button className="primary" disabled={busy}>{busy?'正在登录…':'登录'}</button></form><p className="muted small">跨设备访问须连接到同一局域网或虚拟网络 · 无默认密码</p></main>;
}

function Home({projects,onChanged,onLeaveThread}:{projects:Project[];onChanged:()=>Promise<void>;onLeaveThread:(id:string)=>Promise<void>}) {
  const panes=usePanes();
  const saved=useRef(drafts.get('new:'+location.search));
  const [mode,setMode]=useState(saved.current?.creation?.mode??'existing'),[projectId,setProjectId]=useState(()=>saved.current?.creation?.projectId??new URLSearchParams(location.search).get('project')??''),[name,setName]=useState(saved.current?.creation?.name??''),[folder,setFolder]=useState(saved.current?.creation?.folder??''),[repo,setRepo]=useState(saved.current?.creation?.repo??''),[prompt,setPrompt]=useState(()=>drafts.get('new:'+location.search)?.text??'');
  const draftKey=useRef('new:'+location.search),[settings,setSettings]=useState<TurnSettings>(()=>drafts.get(draftKey.current)?.settings??{}),[attachments,setAttachments]=useState<Attachment[]>(()=>drafts.get(draftKey.current)?.attachments??[]);
  useEffect(()=>{drafts.set(draftKey.current,{...drafts.get(draftKey.current),text:prompt,settings,attachments,creation:{mode,projectId,name,folder,repo}});},[prompt,settings,attachments,mode,projectId,name,folder,repo]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[partial,setPartial]=useState<Json|null>(null);
  const intent=useRef<Submission['current']>(drafts.get(draftKey.current)?.intent??null),mounted=useRef(true),submitting=useRef(false);
  const [uncertain,setUncertain]=useState(drafts.get(draftKey.current)?.uncertain??false);
  useEffect(()=>{const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,uncertain,intent:intent.current});},[uncertain]);
  useEffect(()=>()=>{mounted.current=false;},[]);
  const submit=async(e:FormEvent)=>{
    e.preventDefault();if(submitting.current||uncertain)return;let submittedId:string|undefined;submitting.current=true;setBusy(true);setError('');setPartial(null);
    try {
      const clientRequestId=submissionId(intent,{mode,projectId,name,folder,repo,prompt,...settings,attachmentIds:attachments.map(a=>a.uploadId)});
      submittedId=clientRequestId;const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,intent:intent.current,uncertain:true});
      let result;
      if(mode==='existing')result=await api('/sessions',{...(projectId?{projectId}:{}),clientRequestId,...(prompt.trim()?{prompt}:{}),...settings,attachmentIds:attachments.map(a=>a.uploadId)});
      else {const created=await api(mode==='clone'?'/projects/clone':'/projects',{name,folderName:folder,clientRequestId,...(prompt.trim()?{initialPrompt:prompt}:{}),...(mode==='clone'?{repoUrl:repo}:{}),...settings,attachmentIds:attachments.map(a=>a.uploadId)});result=created.session;}
      intent.current=null;const latest=drafts.get(draftKey.current);if(latest?.intent?.id===clientRequestId&&latest.text===prompt&&JSON.stringify(latest.settings)===JSON.stringify(settings)&&JSON.stringify(latest.creation)===JSON.stringify({mode,projectId,name,folder,repo})&&JSON.stringify(latest.attachments.map(a=>a.uploadId))===JSON.stringify(attachments.map(a=>a.uploadId)))drafts.delete(draftKey.current);void onChanged();if(mounted.current)navigate('/sessions/'+result.threadId);else if(location.pathname!=='/sessions/'+result.threadId)void onLeaveThread(result.threadId).then(onChanged);
    }catch(e:any){const unknown=!e.status||e.status>=500;if(e.status&&e.status<500)intent.current=null;const cached=drafts.get(draftKey.current);if(cached&&cached.intent?.id===submittedId)drafts.set(draftKey.current,{...cached,intent:intent.current,uncertain:unknown});if(mounted.current){setError(e.message);setPartial(e.data??null);setUncertain(unknown);}else if(e.data?.partial?.threadId&&location.pathname!=='/sessions/'+e.data.partial.threadId)void onLeaveThread(e.data.partial.threadId).then(onChanged);void onChanged();}finally{submitting.current=false;if(mounted.current)setBusy(false);}
  };
  return <main className="home" inert={panes.mobile&&panes.drawer!==null}><div className="page-heading"><h1>新任务</h1><p className="muted">选择工作目录，开始一个持久化的 Codex 会话。</p></div><form className="home-form" onSubmit={submit}><fieldset className="creation-fields" disabled={busy}>
    <div className="tabs" role="group" aria-label="任务类型">{[['existing','已有项目 / 无项目'],['new','新建项目'],['clone','Clone 仓库']].map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} className={mode===value?'active':''} onClick={()=>{setMode(value);setPartial(null);setError('');}} disabled={busy}>{label}</button>)}</div>
    {mode==='existing'?<><label>项目<select value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">无项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><p className="muted small">{projectId?projects.find(p=>p.id===projectId)?.path:'无项目模式使用 WORK_ROOT，仍可执行宿主机上的系统任务。'}</p></>:<><div className="form-row"><label>显示名称<input required maxLength={120} placeholder="Example Review Tool" value={name} onChange={e=>setName(e.target.value)}/></label><label>目录名称<input required maxLength={80} placeholder="example-review-tool" value={folder} onChange={e=>setFolder(e.target.value)}/></label></div>{mode==='clone'?<label>仓库地址<input type="text" required maxLength={2048} placeholder="https://github.com/owner/repo.git" value={repo} onChange={e=>setRepo(e.target.value)}/><span className="muted small">HTTPS 或 SSH，使用本机 Git 凭据。</span></label>:<p className="muted small">在 WORK_ROOT 下创建目录并执行 git init。</p>}</>}
    <label>任务<textarea rows={7} maxLength={12000} placeholder="描述要完成的工作…" value={prompt} onChange={e=>setPrompt(e.target.value)}/></label>
    <Attachments items={attachments} onChange={next=>{setAttachments(next);const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,attachments:next});}} disabled={busy}/><TurnOptions value={settings} onChange={setSettings} projectId={mode==='existing'?projectId:undefined} disabled={busy}/>
    <ErrorBox error={error}/>{partial?.partial?.threadId?<button type="button" onClick={()=>navigate('/sessions/'+partial.partial.threadId)}>打开已创建的会话</button>:null}{partial?.project?<div className="notice">项目已创建：{partial.project.path}<button type="button" onClick={()=>{setMode('existing');setProjectId(partial.project.id);setPartial(null);setError('请先在最近会话核对已创建的 Thread；确认没有重复任务后再继续。');}}>使用已创建项目</button></div>:partial?.partial?<pre>{pretty(partial.partial)}</pre>:null}
    {uncertain?<div className="notice">提交结果尚未确认，请先检查最近会话和项目目录。<button type="button" onClick={()=>setUncertain(false)}>已核对历史，允许再次提交</button></div>:null}
    <button className="primary" disabled={busy||uncertain||!!partial?.project||attachments.some(a=>a.status!=='ready')||(!prompt.trim()&&!attachments.length)}>{busy?'正在创建，请勿重复提交…':'开始任务 →'}</button>
  </fieldset></form></main>;
}

function Settings({onChanged}:{onChanged:()=>void}) {
  const panes=usePanes();
  const [settings,setSettings]=useState<Json|null>(null),[error,setError]=useState(''),[current,setCurrent]=useState(''),[next,setNext]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let disposed=false;void api('/settings').then(s=>{if(!disposed)setSettings(s);}).catch(e=>{if(!disposed)setError(e.message);});return()=>{disposed=true;};},[]);
  return <main className="settings" inert={panes.mobile&&panes.drawer!==null}><h1>设置</h1><p className="muted">当前开发机与 Codex 运行时状态。</p><ErrorBox error={error}/>{settings?<><dl><dt>访问地址</dt><dd>{settings.origin}</dd><dt>Node.js</dt><dd>{settings.nodeVersion}</dd><dt>工作根目录</dt><dd>{settings.workRoot}</dd></dl><details open><summary>Codex 诊断与有效权限</summary><pre>{pretty(settings.runtime)}</pre></details><p className="muted small">路径、端口与权限配置变更后需重启服务。</p></>:<p>读取诊断…</p>}<Notifications/><button onClick={panes.reset}>重置布局</button><hr/><h2>修改管理员密码</h2><p className="muted">修改后所有已登录设备需要重新登录。</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/password',{currentPassword:current,newPassword:next});setCurrent('');setNext('');onChanged();}catch(e:any){setError(e.message);}finally{setBusy(false);}}}><label>当前密码<input type="password" required minLength={12} maxLength={256} autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>新密码<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={next} onChange={e=>setNext(e.target.value)}/></label><button className="primary" disabled={busy}>{busy?'保存中…':'修改密码并退出'}</button></form></main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
if(import.meta.env.PROD&&'serviceWorker' in navigator)window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});});
