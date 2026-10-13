import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { submissionId, type Submission } from './submission.ts';
import { api, setCsrfToken } from './api.ts';
import { PaneLayout, PaneSeparator, PaneToolbar, usePanes } from './PaneLayout.tsx';
import { TurnOptions, type TurnSettings } from './TurnOptions.tsx';
import { loadTurnSettings, rememberNewTaskSettings } from './turnSettings.ts';
import { Attachments, type Attachment } from './Attachments.tsx';
import { Session } from './SessionView.tsx';
import { drafts } from './drafts.ts';
import { releaseOnLeave,markSessionWrite,clearSessionWrite } from './handoff.ts';
import { Settings } from './Settings.tsx';
import { navigate,requestLeave } from './navigation.ts';
import {readSendShortcut,shouldSubmit,readSessionSort,sessionSortKey,readSessionGrouping,writeSessionGrouping,sessionGroupingKey,readCollapsedProjects,writeCollapsedProjects,projectCollapseKey} from './preferences.ts';
import {forwardSharedState,sharedStateEvent,type SharedStateChange} from './sharedState.ts';
import {ProjectPicker,emptyCatalog,type ProjectCatalog} from './ProjectPicker.tsx';
import {sessionGroups} from './sessionGroups.ts';
import {notificationTarget,notificationFromRoute,consumedNotificationRoute,routeThreadId,type NotificationTarget} from '../codex/notificationTarget.ts';

type Project = {id:string;name:string;path:string};
type Json = Record<string, any>;
type SessionRecovery='foreground'|'stream-ready'|'shared-update'|'manual';
const releasedNavigation=new Set<string>();
const titleOf=(thread:Json)=>String(thread.name||thread.metadata?.web_title||thread.preview||'未命名会话').replace(/\s+/g,' ').slice(0,80);
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const phases:Record<string,string>={IDLE:'就绪',RUNNING:'运行中',WAITING_APPROVAL:'等待审批',WAITING_INPUT:'等待输入',RELEASED:'已释放，可继续',EXTERNAL:'其他客户端运行中',UNKNOWN:'状态待核实'};
function SessionGroup({name,path,collapsed,onToggle,onMore,onLess,canMore,canLess,loading,children}:{name:string;path:string;collapsed:boolean;onToggle:()=>void;onMore:()=>void;onLess:()=>void;canMore:boolean;canLess:boolean;loading:boolean;children:ReactNode}){
  if(!name)return <section className="session-group">{children}</section>;
  return <details className="session-group project-session-group" open={!collapsed}><summary title={path||undefined} aria-expanded={!collapsed} onClick={event=>{event.preventDefault();onToggle();}}><h3 title={path||undefined}>{name}</h3></summary><div className="project-sessions">{children}{canMore||canLess?<div className="actions">{canMore?<button type="button" className="project-more" disabled={loading} onClick={onMore}>更多</button>:null}{canLess?<button type="button" className="project-more" onClick={event=>{const title=event.currentTarget.closest('details')?.querySelector('summary');title?.focus({preventScroll:true});title?.scrollIntoView({block:'nearest'});onLess();}}>收起</button>:null}</div>:null}</div></details>;
}
function ErrorBox({error}:{error:string}) { return error?<div role="alert" className="notice error">{error}</div>:null; }
function AppNotice({message,label,error=false,onClose}:{message:string;label:string;error?:boolean;onClose:()=>void}){
  const previousFocus=useRef(document.activeElement as HTMLElement|null),box=useRef<HTMLDivElement>(null);
  return <div ref={box} role={error?'alert':'status'} className={'notice app-notification'+(error?' error':'')}><div className="app-notification-text" tabIndex={0}>{message}</div><button type="button" aria-label={label} onClick={()=>{
    if(box.current?.contains(document.activeElement)){
      const target=previousFocus.current;
      (target?.isConnected&&target!==document.body&&target.getClientRects().length&&!target.closest('.app-notifications,[inert]')&&!target.matches(':disabled')?target:document.querySelector<HTMLElement>('.workspace-content'))?.focus({preventScroll:true});
    }
    onClose();
  }}>关闭</button></div>;
}
function Brand(){return <div className="brand"><img src="/icon.svg" alt=""/><span>Codex Web</span></div>;}

function App() {
  const [authenticated,setAuthenticated]=useState<boolean|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [loginExpired,setLoginExpired]=useState(false);
  const [route,setRoute]=useState(location.pathname+location.search),[projects,setProjects]=useState<Project[]>([]),[sessions,setSessions]=useState<Json[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [catalog,setCatalog]=useState<ProjectCatalog>(emptyCatalog);
  const threadId=routeThreadId(route);
  const [notification,setNotification]=useState<(NotificationTarget&{token:number})|null>(()=>{const target=notificationFromRoute(location.pathname+location.search);return target?{...target,token:0}:null;});
  const notificationToken=useRef(0);
  const [workRoot,setWorkRoot]=useState<string|null>(null),[projectsRefreshing,setProjectsRefreshing]=useState(false);
  const [desktopProjectlessRoot,setDesktopProjectlessRoot]=useState<string|null>(null);
  const [search,setSearch]=useState(''),[searchTerm,setSearchTerm]=useState(''),[sessionGrouping,setSessionGrouping]=useState(readSessionGrouping),sessionsIdentity=useRef<string|null>(null);
  const [collapsedProjects,setCollapsedProjects]=useState(readCollapsedProjects),[shownCounts,setShownCounts]=useState(()=>new Map<string,number>());
  const searchPending=search.trim()!==searchTerm;
  const [sessionsPending,setSessionsPending]=useState(false),[sessionsLoading,setSessionsLoading]=useState(false),[sessionsError,setSessionsError]=useState(''),sessionsRequest=useRef(0),sessionsController=useRef<AbortController|null>(null),sessionPages=useRef<{cursor?:string;result:Json}[]>([]),sessionsRefreshPending=useRef(false);
  const sessionsRecovery=useRef<SessionRecovery>('shared-update'),sessionsActiveRecovery=useRef<SessionRecovery|null>(null),sessionsWakeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const sessionsNeedsRecovery=useRef(document.visibilityState!=='visible'),sessionsErrorRef=useRef(sessionsError);sessionsErrorRef.current=sessionsError;
  const [sessionSort,setSessionSort]=useState(readSessionSort),[forksPending,setForksPending]=useState(false),[forkReadsFailed,setForkReadsFailed]=useState(false);
  const [releaseStates,setReleaseStates]=useState<Record<string,Json>>({}),[archived,setArchived]=useState(false),[includeHidden,setIncludeHidden]=useState(false),routeRef=useRef(route);
  const bootstrap=useCallback(async()=>{try{const data=await api('/auth/session');setCsrfToken(data.csrfToken);setAuthenticated(data.authenticated);setLoginExpired(!!data.expired);setError('');}catch(e:any){setError(e.message);}},[]);
  const releaseLeft=useCallback(async(id:string,force=false)=>{try{const result=await releaseOnLeave(id,force);if(result.status)setReleaseStates(old=>({...old,[id]:result}));}catch(e:any){setReleaseStates(old=>({...old,[id]:{error:e.message}}));}},[]);
  const cancelList=()=>{++sessionsRequest.current;sessionsController.current?.abort();sessionsController.current=null;clearTimeout(sessionsWakeTimer.current);sessionsWakeTimer.current=undefined;sessionPages.current=[];sessionsRefreshPending.current=false;setSessions([]);setCursor(null);setSessionsError('');setSessionsPending(false);setSessionsLoading(false);setForksPending(false);setForkReadsFailed(false);};
  useEffect(()=>{const timer=setTimeout(()=>setSearchTerm(search.trim()),300);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>setShownCounts(new Map()),[searchTerm,archived,includeHidden]);
  const loadSessions=useCallback(async(nextCursor?:string,passive=false,fresh=false,recovery:SessionRecovery='shared-update')=>{
    if(searchPending)return;
    if(document.visibilityState!=='visible'){sessionsRefreshPending.current=true;sessionsNeedsRecovery.current=true;sessionsRecovery.current=recovery;return;}
    if(passive&&sessionsController.current){if(recovery==='foreground'&&sessionsActiveRecovery.current==='foreground')return;sessionsRefreshPending.current=true;sessionsRecovery.current=recovery;return;}
    clearTimeout(sessionsWakeTimer.current);sessionsWakeTimer.current=undefined;sessionsRefreshPending.current=false;sessionsRecovery.current='shared-update';sessionsActiveRecovery.current=recovery;
    const query=new URLSearchParams({sortKey:sessionSort});if(includeHidden)query.set('includeHidden','true');if(archived)query.set('archived','true');if(searchTerm)query.set('searchTerm',searchTerm);
    const identity=query.toString();if(sessionsIdentity.current!==identity){sessionsIdentity.current=identity;sessionPages.current=[];setSessions([]);setSessionsError('');setSessionsPending(false);setCursor(null);setForksPending(false);setForkReadsFailed(false);}
    const pageCursors=passive&&sessionPages.current.length?sessionPages.current.map(page=>page.cursor):[nextCursor];
    const request=++sessionsRequest.current;sessionsController.current?.abort();const controller=new AbortController();sessionsController.current=controller;setSessionsLoading(true);
    try {
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(40_000)]);
      const readPage=async(cursor?:string)=>{const pageQuery=new URLSearchParams(query);pageQuery.set('recovery',recovery);if(cursor)pageQuery.set('cursor',cursor);if(fresh)pageQuery.set('refresh','true');return {cursor,result:await api('/sessions?'+pageQuery,undefined,signal)};};
      let pages,resetPages=false;
      try{pages=await Promise.all(pageCursors.map(readPage));}catch(e:any){if(e.data?.code!=='SESSION_CURSOR_INVALID'||!pageCursors.some(Boolean))throw e;pages=[await readPage()];resetPages=true;}
      if(request!==sessionsRequest.current)return;
      if(pages.some(page=>page.result.pending)){setSessionsPending(true);setSessionsError('最近会话更新中');sessionsNeedsRecovery.current=true;return;}
      setSessionsPending(false);
      const nextPages=nextCursor&&!resetPages?[...sessionPages.current,...pages]:pages,rows=new Map<string,Json>();
      for(const page of nextPages)for(const item of page.result.data)if(!rows.has(item.id))rows.set(item.id,item);
      const data=[...rows.values()];sessionPages.current=nextPages;
      const failedPage=nextPages.find(page=>page.result.stale||page.result.error);
      sessionsNeedsRecovery.current=!!failedPage;
      setSessionsError(failedPage?'最近会话同步失败：'+(failedPage.result.error?.message||'共享数据待更新。'):'');
      setReleaseStates(old=>({...old,...Object.fromEntries(data.filter(item=>item.release).map(item=>[item.id,{...item.release,status:item.release.handoffReady?'released':item.release.requested?'pending':'skipped'}]))}));
      setSessions(data);setCursor(nextPages.at(-1)!.result.nextCursor);
      setForksPending(nextPages.some(page=>!!page.result.forksPending));setForkReadsFailed(nextPages.some(page=>!!page.result.forkReadsFailed));
    }catch(e:any){if(request===sessionsRequest.current&&!controller.signal.aborted){sessionsNeedsRecovery.current=true;setSessionsPending(false);setSessionsError('最近会话同步失败：'+e.message);}}
    finally{if(request===sessionsRequest.current){sessionsController.current=null;sessionsActiveRecovery.current=null;setSessionsLoading(false);if(sessionsRefreshPending.current){sessionsRefreshPending.current=false;void latestLoadSessions.current(undefined,true,false,sessionsRecovery.current);}}}
  },[includeHidden,archived,sessionSort,searchTerm,searchPending]);
  const latestLoadSessions=useRef(loadSessions);latestLoadSessions.current=loadSessions;
  const refreshSessions=useCallback(()=>latestLoadSessions.current(undefined,true),[]);
  const removeSession=(id:string)=>{sessionPages.current=sessionPages.current.map(page=>({...page,result:{...page.result,data:page.result.data.filter((item:Json)=>item.id!==id)}}));setSessions(old=>old.filter(item=>item.id!==id));};
  const toggleProject=(key:string)=>{const next=new Set(collapsedProjects);if(next.has(key))next.delete(key);else next.add(key);setCollapsedProjects(next);if(!writeCollapsedProjects(next))setError('折叠偏好未能保存；当前选择仍然有效。');};
  const moreProject=(key:string,available:number)=>{if(sessionsLoading||searchPending)return;const next=Math.min(available,shownCounts.get(key)??3)+3;setShownCounts(old=>new Map(old).set(key,next));if(available<next&&cursor)void loadSessions(cursor);};
  const lessProject=(key:string)=>setShownCounts(old=>{const next=new Map(old);next.delete(key);return next;});
  useEffect(()=>{const changed=()=>setCollapsedProjects(readCollapsedProjects());const storage=(event:StorageEvent)=>{if(event.key===projectCollapseKey||event.key===null)changed();};window.addEventListener('project-collapse-changed',changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener('project-collapse-changed',changed);window.removeEventListener('storage',storage);};},[]);
  useEffect(()=>{const changed=()=>setSessionGrouping(readSessionGrouping());const storage=(event:StorageEvent)=>{if(event.key===sessionGroupingKey||event.key===null)changed();};window.addEventListener('session-grouping-changed',changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener('session-grouping-changed',changed);window.removeEventListener('storage',storage);};},[]);
  useEffect(()=>{const changed=()=>{const value=readSessionSort();if(value===sessionSort)return;++sessionsRequest.current;sessionsController.current?.abort();sessionsController.current=null;sessionsRefreshPending.current=false;setCursor(null);setSessionSort(value);};const storage=(event:StorageEvent)=>{if(event.key===sessionSortKey||event.key===null)changed();};window.addEventListener('session-sort-changed',changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener('session-sort-changed',changed);window.removeEventListener('storage',storage);};},[sessionSort]);
  const catalogRequest=useRef(0);
  const loadCatalog=useCallback(async()=>{const request=++catalogRequest.current;try{const value=await api('/project-catalog');if(!Array.isArray(value.projects)||!Array.isArray(value.workspaces))throw new Error('原生项目目录响应无效，归属待确认。');if(request===catalogRequest.current)setCatalog(value);}catch(e:any){if(request===catalogRequest.current)setCatalog(old=>({...old,state:'unavailable',error:e.message}));}},[]);
  const retryProject=async(id:string)=>{try{setCatalog(await api('/project-catalog/'+encodeURIComponent(id)+'/retry',{}));}catch(e:any){setError(e.message);await loadCatalog();}};
  useEffect(()=>{if(!authenticated)return;let timer:ReturnType<typeof setTimeout>|undefined;
    const schedule=()=>{if(document.visibilityState!=='visible'||timer)return;timer=setTimeout(()=>{timer=undefined;void loadCatalog();},100);};
    const changed=(event:Event)=>{if(['ready','project-catalog-invalidated'].includes((event as CustomEvent<SharedStateChange>).detail.kind))schedule();};
    window.addEventListener(sharedStateEvent,changed);window.addEventListener('focus',schedule);window.addEventListener('online',schedule);window.addEventListener('pageshow',schedule);document.addEventListener('visibilitychange',schedule);
    return()=>{clearTimeout(timer);window.removeEventListener(sharedStateEvent,changed);window.removeEventListener('focus',schedule);window.removeEventListener('online',schedule);window.removeEventListener('pageshow',schedule);document.removeEventListener('visibilitychange',schedule);};
  },[authenticated,loadCatalog]);
  const loadProjects=useCallback(async()=>{try{const result=await api('/projects');setProjects(result.projects);setWorkRoot(typeof result.workRoot==='string'?result.workRoot:null);setDesktopProjectlessRoot(typeof result.desktopProjectlessRoot==='string'?result.desktopProjectlessRoot:null);}catch(e:any){setError(e.message);}},[]);
  const refreshProjects=async()=>{setProjectsRefreshing(true);try{const result=await api('/projects/refresh',{});setProjects(result.projects);setWorkRoot(typeof result.workRoot==='string'?result.workRoot:null);setDesktopProjectlessRoot(typeof result.desktopProjectlessRoot==='string'?result.desktopProjectlessRoot:null);}catch(e:any){setError(e.message);}finally{setProjectsRefreshing(false);await loadCatalog();}};
  const load=useCallback(async()=>{await Promise.all([loadProjects(),refreshSessions()]);},[loadProjects,refreshSessions]);
  useEffect(()=>{void bootstrap();const change=()=>{const next=location.pathname+location.search,oldId=routeThreadId(routeRef.current),nextId=routeThreadId(next);if(oldId&&oldId!==nextId){if(releasedNavigation.has(oldId))releasedNavigation.delete(oldId);else void releaseLeft(oldId);}routeRef.current=next;setRoute(next);const target=notificationFromRoute(next);setNotification(target?{...target,token:++notificationToken.current}:null);setNotice('');};const lost=()=>{drafts.clear();setLoginExpired(true);setAuthenticated(false);};window.addEventListener('popstate',change);window.addEventListener('auth-lost',lost);return()=>{window.removeEventListener('popstate',change);window.removeEventListener('auth-lost',lost);};},[bootstrap,releaseLeft]);
  useEffect(()=>{
    if(!('serviceWorker' in navigator))return;
    const receive=(event:MessageEvent)=>{
      const source=event.source as ServiceWorker|null;let trusted=false;try{const url=new URL(source?.scriptURL??'');trusted=url.origin===location.origin&&url.pathname==='/sw.js';}catch{}
      if(!trusted)return;
      if(event.data?.type==='codex-notification-route'){
        event.ports[0]?.postMessage({type:'codex-notification-route',threadId:routeThreadId(location.pathname)});event.ports[0]?.close();return;
      }
      if(event.data?.type!=='codex-notification-target')return;
      const target=notificationTarget(event.data.target);if(!target||target.threadId!==routeThreadId(location.pathname))return;
      const url=new URL(location.href);for(const key of ['notification','turnId','itemId','requestId','kind'])url.searchParams.delete(key);
      if(target.turnId||target.itemId||target.requestId||target.kind){url.searchParams.set('notification','1');for(const key of ['turnId','itemId','requestId','kind'] as const)if(target[key])url.searchParams.set(key,target[key]);}
      const next=url.pathname+url.search;history.replaceState(history.state,'',next+url.hash);routeRef.current=next;setRoute(next);
      setNotification({...target,token:++notificationToken.current});
      event.ports[0]?.postMessage({type:'codex-notification-accepted',target});event.ports[0]?.close();
    };
    navigator.serviceWorker.addEventListener('message',receive);navigator.serviceWorker.startMessages();let disposed=false;
    void navigator.serviceWorker.getRegistration().then(registration=>{if(!disposed)registration?.active?.postMessage({type:'codex-notification-ready'});}).catch(()=>{});
    return()=>{disposed=true;navigator.serviceWorker.removeEventListener('message',receive);};
  },[]);
  const consumeNotification=useCallback((target:NotificationTarget&{token:number})=>{
    if(target.token!==notificationToken.current)return;
    const next=consumedNotificationRoute(location.pathname+location.search+location.hash,target);if(next===null)return;
    // Keep the target object so URL consumption does not cancel its highlight timer.
    history.replaceState(history.state,'',next);routeRef.current=next.split('#')[0];setRoute(routeRef.current);
  },[]);
  useEffect(()=>{
    if(!authenticated)return;
    let timer:number|undefined,lastRenewed=0,disposed=false;
    const renew=()=>{timer=undefined;lastRenewed=Date.now();void api('/auth/renew',{}).catch(e=>{if(!disposed&&e.status===401)window.dispatchEvent(new Event('auth-lost'));});};
    // Coalesce activity to one request per minute, including the final interaction; polling and SSE never renew.
    const activity=(event:Event)=>{if(!event.isTrusted||document.visibilityState!=='visible'||timer!==undefined)return;const delay=Math.max(0,60_000-(Date.now()-lastRenewed));if(delay)timer=window.setTimeout(renew,delay);else renew();};
    const events=['pointerdown','pointermove','keydown','input','wheel','touchmove'];
    for(const event of events)window.addEventListener(event,activity,{passive:true,capture:true});
    return()=>{disposed=true;clearTimeout(timer);for(const event of events)window.removeEventListener(event,activity,true);};
  },[authenticated]);
  useEffect(()=>{if(authenticated){void loadProjects();void loadCatalog();}else{setProjects([]);setCatalog(emptyCatalog);}},[authenticated,loadProjects]);
  useEffect(()=>{setCursor(null);if(authenticated)void loadSessions(undefined,false,false,'foreground');else{drafts.clear();cancelList();}},[authenticated,loadSessions]);
  useEffect(()=>{
    if(!authenticated)return;
    const schedule=(recovery:SessionRecovery)=>{
      if(recovery==='foreground'||sessionsRecovery.current!=='foreground')sessionsRecovery.current=recovery;
      if(document.visibilityState!=='visible'){sessionsRefreshPending.current=true;sessionsNeedsRecovery.current=true;return;}
      if(sessionsWakeTimer.current!==undefined)return;
      sessionsWakeTimer.current=setTimeout(()=>{sessionsWakeTimer.current=undefined;void latestLoadSessions.current(undefined,true,false,sessionsRecovery.current);},100);
    };
    const wake=(event?:Event)=>{if(document.visibilityState==='visible'&&!(sessionsController.current&&sessionsActiveRecovery.current==='foreground')&&(sessionsNeedsRecovery.current||sessionsRefreshPending.current||sessionsErrorRef.current||(event as PageTransitionEvent|undefined)?.persisted))schedule('foreground');};
    const offline=()=>{sessionsNeedsRecovery.current=true;};
    const visibility=()=>{
      if(document.visibilityState==='visible'){wake();return;}
      clearTimeout(sessionsWakeTimer.current);sessionsWakeTimer.current=undefined;++sessionsRequest.current;sessionsController.current?.abort();sessionsController.current=null;sessionsRefreshPending.current=true;sessionsNeedsRecovery.current=true;sessionsRecovery.current='foreground';setSessionsLoading(false);
    };
    const change=(event:Event)=>{const {kind,value}=(event as CustomEvent<SharedStateChange>).detail;if(kind==='ready')schedule('stream-ready');else if(kind==='sessions'&&Number.isSafeInteger(value?.revision))schedule('shared-update');};
    window.addEventListener(sharedStateEvent,change);
    window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);window.addEventListener('online',wake);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',visibility);
    return()=>{clearTimeout(sessionsWakeTimer.current);sessionsWakeTimer.current=undefined;window.removeEventListener(sharedStateEvent,change);window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);window.removeEventListener('online',wake);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',visibility);};
  },[authenticated]);
  useEffect(()=>{
    if(!authenticated||threadId)return;
    let disposed=false,checking=false;
    const source=new EventSource('/api/state/events'),detach=forwardSharedState(source);
    source.onerror=()=>{if(disposed||checking)return;checking=true;void api('/auth/session').then(state=>{if(disposed)return;setCsrfToken(state.csrfToken);if(!state.authenticated)window.dispatchEvent(new Event('auth-lost'));}).catch(()=>{}).finally(()=>{checking=false;});};
    return()=>{disposed=true;detach();source.close();};
  },[authenticated,threadId]);
  if(authenticated===null)return <main className="login"><Brand/><p>连接你的开发机…</p><ErrorBox error={error}/>{error?<button onClick={()=>void bootstrap()}>重新连接</button>:null}</main>;
  if(!authenticated)return <Login expired={loginExpired} onLogin={()=>void bootstrap()}/>;
  const sessionTime=(thread:Json)=>Number(sessionSort==='created_at'?thread.createdAt:thread.recencyAt??thread.createdAt)||0;
  const orderedSessions=[...sessions].sort((a,b)=>Number(!!b.metadata?.favorite)-Number(!!a.metadata?.favorite)||sessionTime(b)-sessionTime(a)||String(a.id).localeCompare(String(b.id)));
  const groups=sessionGrouping!=='flat'?sessionGroups(orderedSessions,projects,workRoot,desktopProjectlessRoot,catalog):[{key:'flat',name:'',path:'',items:orderedSessions}];
  return <PaneLayout className="shell">
    <aside className="sidebar" id="left-sidebar" aria-label="左侧栏"><Brand/><button className="primary new-task" onClick={()=>navigate('/')}>＋ 新任务</button>
      <div className="side-section"><span className="muted">最近会话</span><button className="quiet" aria-label="刷新最近会话" disabled={sessionsLoading} onClick={()=>{setShownCounts(new Map());void loadSessions(undefined,false,true,'manual');}}>{sessionsLoading?'刷新中…':'刷新'}</button></div>
      <div className="session-search"><input type="search" aria-label="搜索会话标题" placeholder="搜索会话标题" maxLength={200} value={search} onChange={e=>{if(e.target.value.trim()!==search.trim())cancelList();setSearch(e.target.value);}}/>{search?<button type="button" className="quiet" aria-label="清空会话搜索" onClick={()=>{if(search.trim())cancelList();setSearch('');setSearchTerm('');}}>×</button>:null}</div>
      <div className="session-list-options"><select aria-label="会话列表范围" value={archived?'archived':'recent'} onChange={e=>{cancelList();setArchived(e.target.value==='archived');}}><option value="recent">最近会话</option><option value="archived">已归档</option></select><select aria-label="会话分组方式" value={sessionGrouping} onChange={e=>{const value=e.target.value as typeof sessionGrouping;setSessionGrouping(value);if(!writeSessionGrouping(value))setError('分组偏好未能保存；当前选择仍然有效。');}}><option value="project">按项目</option><option value="flat">平铺</option></select></div>
      {catalog.sessionSync?.failed?<p className="muted small" role="status">项目归属同步未完成，将自动重试。</p>:catalog.sessionSync?.pending?<p className="muted small" role="status">项目归属正在等待自动同步。</p>:null}
      {!archived?<label className="show-hidden"><input type="checkbox" checked={includeHidden} onChange={e=>{cancelList();setIncludeHidden(e.target.checked);}}/>显示已隐藏会话</label>:<p className="muted small">恢复归档后可继续会话。</p>}
      <nav className="recent" aria-label="最近会话" aria-busy={sessionsLoading||sessionsPending||searchPending}>{sessions.length?groups.map(group=><SessionGroup key={group.key} name={group.name} path={group.path} collapsed={collapsedProjects.has(group.key)} onToggle={()=>toggleProject(group.key)} onMore={()=>moreProject(group.key,group.items.length)} onLess={()=>lessProject(group.key)} canLess={group.items.length>3&&(shownCounts.get(group.key)??3)>3} canMore={group.items.length>(shownCounts.get(group.key)??3)||!!cursor} loading={sessionsLoading||searchPending}>{group.items.slice(0,group.name?(shownCounts.get(group.key)??3):group.items.length).map(s=><div className="recent-row" key={s.id}>{archived?<span className="session-link disabled" title={titleOf(s)}>{s.metadata?.favorite?'★ ':''}{titleOf(s)}{s.metadata?.hidden?'（已隐藏）':''}</span>:<a href={'/sessions/'+s.id} title={titleOf(s)} className={'session-link'+(s.id===threadId?' selected':'')} aria-current={s.id===threadId?'page':undefined} onClick={e=>{if(e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();navigate('/sessions/'+s.id);}}>{s.metadata?.favorite?'★ ':''}{titleOf(s)}{s.metadata?.hidden?'（已隐藏）':''}</a>}<SessionMenu thread={s} archived={archived} onChanged={async hiddenId=>{if(hiddenId){if(!includeHidden)removeSession(hiddenId);else{const hidden=(item:Json)=>item.id===hiddenId?{...item,metadata:{...item.metadata,hidden:true}}:item;sessionPages.current=sessionPages.current.map(page=>({...page,result:{...page.result,data:page.result.data.map(hidden)}}));setSessions(old=>old.map(hidden));}}await load();}} onArchive={async(id,value)=>{drafts.delete(id);removeSession(id);if(value&&/^\/sessions\/([a-zA-Z0-9-]+)$/.exec(location.pathname)?.[1]===id){releasedNavigation.add(id);navigate('/',true);}if(!value)setArchived(false);else await loadSessions();}}/>{releaseStates[s.id]?.error?<button className="release-warning" title={releaseStates[s.id].error} onClick={()=>void releaseLeft(s.id,true)}>释放未完成 · 重试</button>:releaseStates[s.id]?.status==='pending'?<span className="small muted">等待任务结束后释放</span>:null}</div>)}</SessionGroup>):<p className="muted">{sessionsPending?'会话列表更新中…':searchPending||sessionsLoading?(search.trim()?'搜索会话…':'读取会话…'):sessionsError?'会话读取失败，请刷新重试。':cursor?'本页暂无可显示会话，可继续加载。':searchTerm?'未找到匹配标题的会话':'暂无会话'}</p>}{forksPending?<p className="small muted">还有分支待核实；加载更多后会按时间插入列表。</p>:null}{forkReadsFailed?<p className="small muted">部分分支暂时无法核实，请刷新重试。</p>:null}{cursor?<button disabled={sessionsLoading} onClick={()=>void loadSessions(cursor)}>加载更多</button>:null}</nav>
      <div className="side-footer"><button onClick={()=>navigate('/settings')}>⚙　设置</button><button onClick={()=>requestLeave(async()=>{try{await api('/auth/logout',{});setAuthenticated(false);}catch(e:any){setError(e.message);}})}>↪　退出</button></div>
    </aside>
    <PaneSeparator side="left"/>
    <div className="workspace">{!threadId?<PaneToolbar/>:null}<div className="workspace-content" tabIndex={-1}>{threadId?<Session catalog={catalog} projects={projects} workRoot={workRoot} desktopProjectlessRoot={desktopProjectlessRoot} key={threadId} id={threadId} notification={notification?.threadId===threadId?notification:undefined} onNotificationHandled={consumeNotification} onChanged={refreshSessions} onReleased={()=>{clearSessionWrite(threadId);releasedNavigation.add(threadId);navigate('/',true);setNotice('会话已释放并关闭，可从最近会话重新打开继续。');}}/>:route.split('?')[0]==='/settings'?<Settings route={route} projects={projects} onChanged={()=>setAuthenticated(false)}/>:<Home catalog={catalog} onRetryProject={retryProject} key={route} projects={projects} onRefreshProjects={refreshProjects} projectsRefreshing={projectsRefreshing} onChanged={load} onLeaveThread={releaseLeft} onNotice={setNotice}/>}</div></div>
    <div className="app-notifications" aria-label="全局提醒">{error?<AppNotice message={error} label="关闭错误提醒" error onClose={()=>setError('')}/>:null}{sessionsError?<AppNotice message={sessionsError} label="关闭会话同步提醒" error={!sessionsPending} onClose={()=>setSessionsError('')}/>:null}{notice?<AppNotice message={notice} label="关闭成功提醒" onClose={()=>setNotice('')}/>:null}</div>
  </PaneLayout>;
}

function SessionMenu({thread,archived,onChanged,onArchive}:{thread:Json;archived:boolean;onChanged:(hiddenId?:string)=>Promise<void>;onArchive:(id:string,archived:boolean)=>Promise<void>}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState(false),menuId=useId(),menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const change=async(path:string,body:Json)=>{menu.current?.hidePopover();setBusy(true);setError('');try{await api('/sessions/'+thread.id+path,body);if(path==='/archive'||path==='/unarchive')await onArchive(thread.id,path==='/archive');else await onChanged(path==='/metadata'&&body.hidden===true?thread.id:undefined);}catch(e:any){setError(e.message);menu.current?.showPopover();}finally{setBusy(false);}};
  useEffect(()=>{if(!open)return;const close=(event:Event)=>{if(event.target instanceof Node&&menu.current?.contains(event.target))return;menu.current?.hidePopover();};window.addEventListener('resize',close);document.addEventListener('scroll',close,true);return()=>{window.removeEventListener('resize',close);document.removeEventListener('scroll',close,true);};},[open]);
  const position=()=>{if(!menu.current||!trigger.current)return;const rect=trigger.current.getBoundingClientRect(),height=menu.current.offsetHeight,width=menu.current.offsetWidth;menu.current.style.left=`${Math.max(8,Math.min(rect.right-width,innerWidth-width-8))}px`;menu.current.style.top=`${Math.max(8,Math.min(rect.bottom+4+height<=innerHeight-8?rect.bottom+4:rect.top-height-4,innerHeight-height-8))}px`;};
  return <div className="session-menu" onKeyDown={event=>{if(event.key==='Escape'&&menu.current?.matches(':popover-open')){event.preventDefault();event.stopPropagation();menu.current.hidePopover();trigger.current?.focus({preventScroll:true});}}}><button type="button" ref={trigger} aria-label={'会话菜单 '+titleOf(thread)} aria-controls={menuId} aria-expanded={open} disabled={busy} popoverTarget={menuId}>⋯</button><div id={menuId} ref={menu} popover="auto" onBeforeToggle={event=>{if(event.newState==='open'&&menu.current)menu.current.style.visibility='hidden';}} onToggle={event=>{setOpen(event.newState==='open');if(event.newState==='open'){position();if(menu.current)menu.current.style.visibility='visible';menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});}}}>{!archived?<><button autoFocus disabled={busy} onClick={()=>{const name=window.prompt('会话名称',titleOf(thread));if(name?.trim())void change('/name',{name:name.trim()});}}>重命名</button><button disabled={busy} onClick={()=>void change('/metadata',{favorite:!thread.metadata?.favorite})}>{thread.metadata?.favorite?'取消收藏':'收藏'}</button><button disabled={busy} onClick={()=>void change('/metadata',{hidden:!thread.metadata?.hidden})}>{thread.metadata?.hidden?'恢复显示':'从 Web 隐藏'}</button><button disabled={busy} onClick={()=>{if(window.confirm('清除 Web 收藏、隐藏和标题偏好？原生聊天和项目文件会保留，会话可能再次出现在最近列表。'))void change('/metadata/clear',{});}}>清除 Web 元数据</button></>:null}<button disabled={busy} onClick={()=>{if(window.confirm(archived?'恢复此会话到最近会话？Web 隐藏偏好保持不变。':'归档此原生会话？历史和项目文件会保留，可从“已归档”恢复；本页草稿将清除。'))void change(archived?'/unarchive':'/archive',{});}}>{archived?'恢复归档':'归档会话'}</button><ErrorBox error={error}/></div></div>;
}

function Login({onLogin,expired}:{onLogin:()=>void;expired:boolean}) {
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/login',{password});setPassword('');onLogin();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <main className="login"><Brand/><h1>连接你的开发机</h1><p className="muted">登录后继续项目与 Codex 会话。</p>{expired?<p role="status" className="notice">登录已过期或失效，请重新登录。</p>:null}<form onSubmit={submit}><label>管理员密码<input type="password" autoComplete="current-password" required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label><ErrorBox error={error}/><button className="primary" disabled={busy}>{busy?'正在登录…':'登录'}</button></form><p className="muted small">跨设备访问须连接到同一局域网或虚拟网络 · 无默认密码</p></main>;
}

function Home({catalog,onRetryProject,projects,onRefreshProjects,projectsRefreshing,onChanged,onLeaveThread,onNotice}:{catalog:ProjectCatalog;onRetryProject:(id:string)=>void;projects:Project[];onRefreshProjects:()=>Promise<void>;projectsRefreshing:boolean;onChanged:()=>Promise<void>;onLeaveThread:(id:string)=>Promise<void>;onNotice:(notice:string)=>void}) {
  const panes=usePanes();
  const saved=useRef(drafts.get('new:'+location.search));
  const settingsEdited=useRef(!!Object.keys(saved.current?.settings??{}).length);
  const [mode,setMode]=useState(saved.current?.creation?.mode??'existing'),[projectId,setProjectId]=useState(()=>saved.current?.creation?.projectId??new URLSearchParams(location.search).get('project')??''),[name,setName]=useState(saved.current?.creation?.name??''),[folder,setFolder]=useState(saved.current?.creation?.folder??''),[repo,setRepo]=useState(saved.current?.creation?.repo??''),[prompt,setPrompt]=useState(()=>drafts.get('new:'+location.search)?.text??'');
  const [nativeSelection,setNativeSelection]=useState(saved.current?.creation?.nativeSelection??''),[selectedWorkspace,setSelectedWorkspace]=useState(saved.current?.creation?.selectedWorkspace??'');
  const matchedProject=catalog.workspaces.find(row=>row.workspaceId===projectId&&row.status==='synced')?.nativeProjectId;
  const selectedMatch=catalog.workspaces.find(row=>'workspace:'+row.workspaceId===nativeSelection&&row.status==='synced')?.nativeProjectId;
  const selection=selectedMatch?'native:'+selectedMatch:nativeSelection||(matchedProject?'native:'+matchedProject:projectId?'workspace:'+projectId:'');
  const selectedNative=catalog.projects.find(p=>'native:'+p.id===selection),workspaceId=nativeSelection?selectedWorkspace:projectId;
  const selectionReady=!selection||(selectedNative?catalog.state==='ready'&&selectedNative.roots.some(root=>root.available&&root.workspaceId===workspaceId):selection.startsWith('workspace:')&&catalog.workspaces.some(p=>p.workspaceId===workspaceId&&['syncing','synced'].includes(p.status)));
  const draftKey=useRef('new:'+location.search),[settings,setSettings]=useState<TurnSettings>(()=>Object.keys(saved.current?.settings??{}).length?saved.current!.settings:loadTurnSettings()),[attachments,setAttachments]=useState<Attachment[]>(()=>drafts.get(draftKey.current)?.attachments??[]);
  useEffect(()=>{drafts.set(draftKey.current,{...drafts.get(draftKey.current),text:prompt,settings:settingsEdited.current?settings:{},attachments,creation:{mode,projectId,nativeSelection,selectedWorkspace,name,folder,repo}});},[prompt,settings,attachments,mode,projectId,nativeSelection,selectedWorkspace,name,folder,repo]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[partial,setPartial]=useState<Json|null>(null);
  const models=useRef<Json[]>([]),modelCatalog=useRef<Json>({});
  const defaultsVersion=useRef<string|null>(null);
  useEffect(()=>{defaultsVersion.current=null;},[mode==='existing'?projectId:undefined]);
  const intent=useRef<Submission['current']>(drafts.get(draftKey.current)?.intent??null),mounted=useRef(true),submitting=useRef(false),createdPartial=useRef<string|undefined>(undefined);
  const [uncertain,setUncertain]=useState(drafts.get(draftKey.current)?.uncertain??false);
  const canSubmit=(mode!=='existing'||selectionReady)&&!busy&&!uncertain&&!partial?.project&&attachments.every(a=>a.status==='ready')&&(!!prompt.trim()||attachments.length>0);
  useEffect(()=>{const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,uncertain,intent:intent.current});},[uncertain]);
  useEffect(()=>()=>{mounted.current=false;const id=createdPartial.current;if(id&&location.pathname!=='/sessions/'+id)void onLeaveThread(id).then(onChanged);},[]);
  const submit=async(e:FormEvent)=>{
    e.preventDefault();if(submitting.current||!canSubmit)return;let submittedId:string|undefined;const expectedVersion=defaultsVersion.current;submitting.current=true;setBusy(true);setError('');setPartial(null);
    try {
      const clientRequestId=submissionId(intent,{mode,projectId,nativeProjectId:selectedNative?.id,nativeSelection,selectedWorkspace,name,folder,repo,prompt,...settings,attachmentIds:attachments.map(a=>a.uploadId)});
      submittedId=clientRequestId;const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,intent:intent.current,uncertain:true});
      let result,createdProjectId=projectId;
      if(mode==='existing')result=await api('/sessions',{...(workspaceId?{projectId:workspaceId}:{}),...(selectedNative?{nativeProjectId:selectedNative.id}:!selection?{nativeProjectId:null}:{}),clientRequestId,...(prompt.trim()?{prompt}:{}),...settings,attachmentIds:attachments.map(a=>a.uploadId)});
      else {const created=await api(mode==='clone'?'/projects/clone':'/projects',{name,folderName:folder,clientRequestId,...(prompt.trim()?{initialPrompt:prompt}:{}),...(mode==='clone'?{repoUrl:repo}:{}),...settings,attachmentIds:attachments.map(a=>a.uploadId)});result=created.session;createdProjectId=created.project.id;}
      markSessionWrite(result.threadId);
      intent.current=null;const latest=drafts.get(draftKey.current);if(latest?.intent?.id===clientRequestId&&latest.text===prompt&&JSON.stringify(latest.settings)===JSON.stringify(settingsEdited.current?settings:{})&&JSON.stringify(latest.creation)===JSON.stringify({mode,projectId,nativeSelection,selectedWorkspace,name,folder,repo})&&JSON.stringify(latest.attachments.map(a=>a.uploadId))===JSON.stringify(attachments.map(a=>a.uploadId)))drafts.delete(draftKey.current);
      if(result.status!=='idle')drafts.set(result.threadId,{initialSnapshot:result.initialSnapshot,text:'',settings:{},attachments:[],outgoing:[{id:clientRequestId,text:prompt,settings,attachments,status:'accepted'}]});
      const model=settings.model??modelCatalog.current.model??models.current.find(m=>m.isDefault)?.model;
      const entry=models.current.find(m=>m.model===model),effort=settings.effort??(settings.model&&settings.model!==modelCatalog.current.model?entry?.defaultReasoningEffort:modelCatalog.current.effort??entry?.defaultReasoningEffort);
      if(model){rememberNewTaskSettings({model,effort,permissionMode:settings.permissionMode});if(expectedVersion)void api('/model-defaults',{model,expectedVersion,...(effort?{effort}:{}),...(createdProjectId?{projectId:createdProjectId}:{})}).then(saved=>{if(saved.effectiveModel!==saved.model||saved.effectiveEffort!==saved.effort)onNotice('Codex 用户默认值已保存；当前项目配置覆盖了模型或推理强度。');}).catch(e=>onNotice('任务已创建，但保存 Codex 默认值失败：'+e.message));}
      void onChanged();if(mounted.current)navigate('/sessions/'+result.threadId);else if(location.pathname!=='/sessions/'+result.threadId)void onLeaveThread(result.threadId).then(onChanged);
      if(model&&!expectedVersion)onNotice('任务已创建，但未取得配置版本，Codex 全局默认值未保存；请刷新页面后核对。');
    }catch(e:any){if(e.data?.partial?.threadId){markSessionWrite(e.data.partial.threadId);if(mounted.current){const previous=createdPartial.current;if(previous&&previous!==e.data.partial.threadId)void onLeaveThread(previous).then(onChanged);createdPartial.current=e.data.partial.threadId;}}const unknown=!e.status||e.status>=500;if(e.status&&e.status<500)intent.current=null;const cached=drafts.get(draftKey.current);if(cached&&cached.intent?.id===submittedId)drafts.set(draftKey.current,{...cached,intent:intent.current,uncertain:unknown});if(mounted.current){setError(e.message);setPartial(e.data??null);setUncertain(unknown);}else if(e.data?.partial?.threadId&&location.pathname!=='/sessions/'+e.data.partial.threadId)void onLeaveThread(e.data.partial.threadId).then(onChanged);void onChanged();}finally{submitting.current=false;if(mounted.current)setBusy(false);}
  };
  return <main className="home" inert={panes.mobile&&panes.drawer!==null}><div className="page-heading"><h1>新任务</h1><p className="muted">选择工作目录，开始一个持久化的 Codex 会话。</p></div><form className="home-form" onSubmit={submit}><fieldset className="creation-fields" disabled={busy}>
    <div className="tabs" role="group" aria-label="任务类型">{[['existing','已有项目 / 无项目'],['new','新建项目'],['clone','Clone 仓库']].map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} className={mode===value?'active':''} onClick={()=>{setMode(value);setPartial(null);setError('');}} disabled={busy}>{label}</button>)}</div>
    {mode==='existing'?<><div className="project-picker"><ProjectPicker projects={projects} catalog={catalog} value={selection} workspaceId={workspaceId} disabled={busy} onRetry={onRetryProject} onChange={(value,root)=>{setNativeSelection(value);setSelectedWorkspace(root);setProjectId(root);}}/><button type="button" className="quiet" aria-label="刷新项目" disabled={projectsRefreshing} onClick={()=>void onRefreshProjects()}>{projectsRefreshing?'刷新中…':'刷新'}</button></div><p className="muted small">{selection?projects.find(p=>p.id===workspaceId)?.path:'无项目模式使用 WORK_ROOT，仍可执行宿主机上的系统任务。'}</p></>:<><div className="form-row"><label>显示名称<input required maxLength={120} placeholder="Example Review Tool" value={name} onChange={e=>setName(e.target.value)}/></label><label>目录名称<input required maxLength={80} placeholder="example-review-tool" value={folder} onChange={e=>setFolder(e.target.value)}/></label></div>{mode==='clone'?<label>仓库地址<input type="text" required maxLength={2048} placeholder="https://github.com/owner/repo.git" value={repo} onChange={e=>setRepo(e.target.value)}/><span className="muted small">HTTPS 或 SSH，使用本机 Git 凭据。</span></label>:<p className="muted small">在 WORK_ROOT 下创建目录并执行 git init。</p>}</>}
    <label>任务<textarea aria-label="任务" rows={7} maxLength={12000} enterKeyHint={panes.mobile?'enter':'send'} placeholder="描述要完成的工作…" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(shouldSubmit(e.nativeEvent,{mobile:panes.mobile,shortcut:readSendShortcut()})){e.preventDefault();if(canSubmit)e.currentTarget.form?.requestSubmit();}}}/></label>
    <Attachments items={attachments} onChange={next=>{setAttachments(next);const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,attachments:next});}} disabled={busy}/><TurnOptions value={settings} onChange={next=>{settingsEdited.current=true;setSettings(next);}} onModels={items=>{models.current=items;}} onCatalog={value=>{modelCatalog.current=value;defaultsVersion.current=typeof value.userVersion==='string'?value.userVersion:null;}} projectId={mode==='existing'?workspaceId:undefined} disabled={busy}/>
    <ErrorBox error={error}/>{partial?.partial?.threadId?<button type="button" onClick={()=>navigate('/sessions/'+partial.partial.threadId)}>打开已创建的会话</button>:null}{partial?.project?<div className="notice">项目已创建：{partial.project.path}<button type="button" onClick={()=>onRetryProject(partial.project.id)}>重试项目同步</button><button type="button" onClick={()=>{setMode('existing');setProjectId(partial.project.id);setNativeSelection('workspace:'+partial.project.id);setSelectedWorkspace(partial.project.id);setPartial(null);setError('请先在最近会话核对已创建的 Thread；确认没有重复任务后再继续。');}}>使用已创建项目</button></div>:partial?.partial?<pre>{pretty(partial.partial)}</pre>:null}
    {uncertain?<div className="notice">提交结果尚未确认，请先检查最近会话和项目目录。<button type="button" onClick={()=>setUncertain(false)}>已核对历史，允许再次提交</button></div>:null}
    <button className="primary" disabled={!canSubmit}>{busy?'正在创建，请勿重复提交…':'开始任务 →'}</button>
  </fieldset></form></main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
if(import.meta.env.PROD&&'serviceWorker' in navigator)window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});});
