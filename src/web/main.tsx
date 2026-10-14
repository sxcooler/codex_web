import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {LocaleProvider,useLocale} from './i18n/LocaleProvider.tsx';
import {LanguageSelect} from './i18n/LanguageSelect.tsx';
import {initialLocaleState} from './i18n/locale.ts';
import {msg,type UiText} from './i18n/text.ts';
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
const titleOf=(thread:Json,fallback:string)=>String(thread.name||thread.metadata?.web_title||thread.preview||fallback).replace(/\s+/g,' ').slice(0,80);
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
function SessionGroup({name,path,collapsed,onToggle,onMore,onLess,canMore,canLess,loading,children}:{name:string;path:string;collapsed:boolean;onToggle:()=>void;onMore:()=>void;onLess:()=>void;canMore:boolean;canLess:boolean;loading:boolean;children:ReactNode}){
  const {t}=useLocale();
  if(!name)return <section className="session-group">{children}</section>;
  return <details className="session-group project-session-group" open={!collapsed}><summary title={path||undefined} aria-expanded={!collapsed} onClick={event=>{event.preventDefault();onToggle();}}><h3 title={path||undefined}>{name}</h3></summary><div className="project-sessions">{children}{canMore||canLess?<div className="actions">{canMore?<button type="button" className="project-more" disabled={loading} onClick={onMore}>{t('app.more')}</button>:null}{canLess?<button type="button" className="project-more" onClick={event=>{const title=event.currentTarget.closest('details')?.querySelector('summary');title?.focus({preventScroll:true});title?.scrollIntoView({block:'nearest'});onLess();}}>{t('app.collapse')}</button>:null}</div>:null}</div></details>;
}
function ErrorBox({error}:{error:UiText}) { const {text}=useLocale();return error?<div role="alert" className="notice error">{text(error)}</div>:null; }
function AppNotice({message,label,error=false,onClose}:{message:UiText;label:string;error?:boolean;onClose:()=>void}){
  const {t,text}=useLocale();
  const previousFocus=useRef(document.activeElement as HTMLElement|null),box=useRef<HTMLDivElement>(null);
  return <div ref={box} role={error?'alert':'status'} className={'notice app-notification'+(error?' error':'')}><div className="app-notification-text" tabIndex={0}>{text(message)}</div><button type="button" aria-label={label} onClick={()=>{
    if(box.current?.contains(document.activeElement)){
      const target=previousFocus.current;
      (target?.isConnected&&target!==document.body&&target.getClientRects().length&&!target.closest('.app-notifications,[inert]')&&!target.matches(':disabled')?target:document.querySelector<HTMLElement>('.workspace-content'))?.focus({preventScroll:true});
    }
    onClose();
  }}>{t('common.close')}</button></div>;
}
function Brand(){return <div className="brand"><img src="/icon.svg" alt=""/><span>Codex Web</span></div>;}

function App() {
  const {t,text}=useLocale();
  const [authenticated,setAuthenticated]=useState<boolean|null>(null),[error,setError]=useState<UiText>(''),[notice,setNotice]=useState<UiText>('');
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
  const [sessionsPending,setSessionsPending]=useState(false),[sessionsLoading,setSessionsLoading]=useState(false),[sessionsError,setSessionsError]=useState<UiText>(''),sessionsRequest=useRef(0),sessionsController=useRef<AbortController|null>(null),sessionPages=useRef<{cursor?:string;result:Json}[]>([]),sessionsRefreshPending=useRef(false);
  const sessionsRecovery=useRef<SessionRecovery>('shared-update'),sessionsActiveRecovery=useRef<SessionRecovery|null>(null),sessionsWakeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const sessionsNeedsRecovery=useRef(document.visibilityState!=='visible'),sessionsErrorRef=useRef(sessionsError);sessionsErrorRef.current=sessionsError;
  const [sessionSort,setSessionSort]=useState(readSessionSort),[forksPending,setForksPending]=useState(false),[forkReadsFailed,setForkReadsFailed]=useState(false);
  const [releaseStates,setReleaseStates]=useState<Record<string,Json>>({}),[archived,setArchived]=useState(false),[includeHidden,setIncludeHidden]=useState(false),routeRef=useRef(route);
  const bootstrap=useCallback(async()=>{try{const data=await api('/auth/session');setCsrfToken(data.csrfToken);setAuthenticated(data.authenticated);setLoginExpired(!!data.expired);setError('');}catch(e:any){setError(e);}},[]);
  const releaseLeft=useCallback(async(id:string,force=false)=>{try{const result=await releaseOnLeave(id,force);if(result.status)setReleaseStates(old=>({...old,[id]:result}));}catch(e:any){setReleaseStates(old=>({...old,[id]:{error:e}}));}},[]);
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
      if(pages.some(page=>page.result.pending)){setSessionsPending(true);setSessionsError(msg('app.pendingSync'));sessionsNeedsRecovery.current=true;return;}
      setSessionsPending(false);
      const nextPages=nextCursor&&!resetPages?[...sessionPages.current,...pages]:pages,rows=new Map<string,Json>();
      for(const page of nextPages)for(const item of page.result.data)if(!rows.has(item.id))rows.set(item.id,item);
      const data=[...rows.values()];sessionPages.current=nextPages;
      const failedPage=nextPages.find(page=>page.result.stale||page.result.error);
      sessionsNeedsRecovery.current=!!failedPage;
      setSessionsError(failedPage?msg('app.syncFailed',failedPage.result.error?.message||msg('app.sharedPending')):'');
      setReleaseStates(old=>({...old,...Object.fromEntries(data.filter(item=>item.release).map(item=>[item.id,{...item.release,status:item.release.handoffReady?'released':item.release.requested?'pending':'skipped'}]))}));
      setSessions(data);setCursor(nextPages.at(-1)!.result.nextCursor);
      setForksPending(nextPages.some(page=>!!page.result.forksPending));setForkReadsFailed(nextPages.some(page=>!!page.result.forkReadsFailed));
    }catch(e:any){if(request===sessionsRequest.current&&!controller.signal.aborted){sessionsNeedsRecovery.current=true;setSessionsPending(false);setSessionsError(msg('app.syncFailed',e));}}
    finally{if(request===sessionsRequest.current){sessionsController.current=null;sessionsActiveRecovery.current=null;setSessionsLoading(false);if(sessionsRefreshPending.current){sessionsRefreshPending.current=false;void latestLoadSessions.current(undefined,true,false,sessionsRecovery.current);}}}
  },[includeHidden,archived,sessionSort,searchTerm,searchPending]);
  const latestLoadSessions=useRef(loadSessions);latestLoadSessions.current=loadSessions;
  const refreshSessions=useCallback(()=>latestLoadSessions.current(undefined,true),[]);
  const removeSession=(id:string)=>{sessionPages.current=sessionPages.current.map(page=>({...page,result:{...page.result,data:page.result.data.filter((item:Json)=>item.id!==id)}}));setSessions(old=>old.filter(item=>item.id!==id));};
  const toggleProject=(key:string)=>{const next=new Set(collapsedProjects);if(next.has(key))next.delete(key);else next.add(key);setCollapsedProjects(next);if(!writeCollapsedProjects(next))setError(msg('app.collapseUnsaved'));};
  const moreProject=(key:string,available:number)=>{if(sessionsLoading||searchPending)return;const next=Math.min(available,shownCounts.get(key)??3)+3;setShownCounts(old=>new Map(old).set(key,next));if(available<next&&cursor)void loadSessions(cursor);};
  const lessProject=(key:string)=>setShownCounts(old=>{const next=new Map(old);next.delete(key);return next;});
  useEffect(()=>{const changed=()=>setCollapsedProjects(readCollapsedProjects());const storage=(event:StorageEvent)=>{if(event.key===projectCollapseKey||event.key===null)changed();};window.addEventListener('project-collapse-changed',changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener('project-collapse-changed',changed);window.removeEventListener('storage',storage);};},[]);
  useEffect(()=>{const changed=()=>setSessionGrouping(readSessionGrouping());const storage=(event:StorageEvent)=>{if(event.key===sessionGroupingKey||event.key===null)changed();};window.addEventListener('session-grouping-changed',changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener('session-grouping-changed',changed);window.removeEventListener('storage',storage);};},[]);
  useEffect(()=>{const changed=()=>{const value=readSessionSort();if(value===sessionSort)return;++sessionsRequest.current;sessionsController.current?.abort();sessionsController.current=null;sessionsRefreshPending.current=false;setCursor(null);setSessionSort(value);};const storage=(event:StorageEvent)=>{if(event.key===sessionSortKey||event.key===null)changed();};window.addEventListener('session-sort-changed',changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener('session-sort-changed',changed);window.removeEventListener('storage',storage);};},[sessionSort]);
  const catalogRequest=useRef(0);
  const loadCatalog=useCallback(async()=>{const request=++catalogRequest.current;try{const value=await api('/project-catalog');if(!Array.isArray(value.projects)||!Array.isArray(value.workspaces))throw Object.assign(new Error('原生项目目录响应无效，归属待确认。'),{i18n:msg('app.catalogInvalid')});if(request===catalogRequest.current)setCatalog(value);}catch(e:any){if(request===catalogRequest.current)setCatalog(old=>({...old,state:'unavailable',error:e}));}},[]);
  const retryProject=async(id:string)=>{try{setCatalog(await api('/project-catalog/'+encodeURIComponent(id)+'/retry',{}));}catch(e:any){setError(e);await loadCatalog();}};
  useEffect(()=>{if(!authenticated)return;let timer:ReturnType<typeof setTimeout>|undefined;
    const schedule=()=>{if(document.visibilityState!=='visible'||timer)return;timer=setTimeout(()=>{timer=undefined;void loadCatalog();},100);};
    const changed=(event:Event)=>{if(['ready','project-catalog-invalidated'].includes((event as CustomEvent<SharedStateChange>).detail.kind))schedule();};
    window.addEventListener(sharedStateEvent,changed);window.addEventListener('focus',schedule);window.addEventListener('online',schedule);window.addEventListener('pageshow',schedule);document.addEventListener('visibilitychange',schedule);
    return()=>{clearTimeout(timer);window.removeEventListener(sharedStateEvent,changed);window.removeEventListener('focus',schedule);window.removeEventListener('online',schedule);window.removeEventListener('pageshow',schedule);document.removeEventListener('visibilitychange',schedule);};
  },[authenticated,loadCatalog]);
  const loadProjects=useCallback(async()=>{try{const result=await api('/projects');setProjects(result.projects);setWorkRoot(typeof result.workRoot==='string'?result.workRoot:null);setDesktopProjectlessRoot(typeof result.desktopProjectlessRoot==='string'?result.desktopProjectlessRoot:null);}catch(e:any){setError(e);}},[]);
  const refreshProjects=async()=>{setProjectsRefreshing(true);try{const result=await api('/projects/refresh',{});setProjects(result.projects);setWorkRoot(typeof result.workRoot==='string'?result.workRoot:null);setDesktopProjectlessRoot(typeof result.desktopProjectlessRoot==='string'?result.desktopProjectlessRoot:null);}catch(e:any){setError(e);}finally{setProjectsRefreshing(false);await loadCatalog();}};
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
  if(authenticated===null)return <main className="login"><Brand/><p>{t('app.connecting')}</p><ErrorBox error={error}/>{error?<button onClick={()=>void bootstrap()}>{t('app.reconnect')}</button>:null}</main>;
  if(!authenticated)return <Login expired={loginExpired} onLogin={()=>void bootstrap()}/>;
  const sessionTime=(thread:Json)=>Number(sessionSort==='created_at'?thread.createdAt:thread.recencyAt??thread.createdAt)||0;
  const orderedSessions=[...sessions].sort((a,b)=>Number(!!b.metadata?.favorite)-Number(!!a.metadata?.favorite)||sessionTime(b)-sessionTime(a)||String(a.id).localeCompare(String(b.id)));
  const groups=sessionGrouping!=='flat'?sessionGroups(orderedSessions,projects,workRoot,desktopProjectlessRoot,catalog):[{key:'flat',name:'',path:'',items:orderedSessions}];
  return <PaneLayout className="shell">
    <aside className="sidebar" id="left-sidebar" aria-label={t('app.sidebar')}><Brand/><button className="primary new-task" onClick={()=>navigate('/')}>{t('app.newTask')}</button>
      <div className="side-section"><span className="muted">{t('app.recent')}</span><button className="quiet" aria-label={t('app.refreshSessions')} disabled={sessionsLoading} onClick={()=>{setShownCounts(new Map());void loadSessions(undefined,false,true,'manual');}}>{sessionsLoading?t('common.refreshing'):t('common.refresh')}</button></div>
      <div className="session-search"><input type="search" aria-label={t('app.search')} placeholder={t('app.search')} maxLength={200} value={search} onChange={e=>{if(e.target.value.trim()!==search.trim())cancelList();setSearch(e.target.value);}}/>{search?<button type="button" className="quiet" aria-label={t('app.clearSearch')} onClick={()=>{if(search.trim())cancelList();setSearch('');setSearchTerm('');}}>×</button>:null}</div>
      <div className="session-list-options"><select aria-label={t('app.scope')} value={archived?'archived':'recent'} onChange={e=>{cancelList();setArchived(e.target.value==='archived');}}><option value="recent">{t('app.recent')}</option><option value="archived">{t('app.archived')}</option></select><select aria-label={t('app.grouping')} value={sessionGrouping} onChange={e=>{const value=e.target.value as typeof sessionGrouping;setSessionGrouping(value);if(!writeSessionGrouping(value))setError(msg('app.groupingUnsaved'));}}><option value="project">{t('app.byProject')}</option><option value="flat">{t('app.flat')}</option></select></div>
      {catalog.sessionSync?.failed?<p className="muted small" role="status">{t('app.syncIncomplete')}</p>:catalog.sessionSync?.pending?<p className="muted small" role="status">{t('app.syncPending')}</p>:null}
      {!archived?<label className="show-hidden"><input type="checkbox" checked={includeHidden} onChange={e=>{cancelList();setIncludeHidden(e.target.checked);}}/>{t('app.showHidden')}</label>:<p className="muted small">{t('app.restoreHint')}</p>}
      <nav className="recent" aria-label={t('app.recent')} aria-busy={sessionsLoading||sessionsPending||searchPending}>{sessions.length?groups.map(group=><SessionGroup key={group.key} name={group.key===''?t('app.noProject'):group.name} path={group.path} collapsed={collapsedProjects.has(group.key)} onToggle={()=>toggleProject(group.key)} onMore={()=>moreProject(group.key,group.items.length)} onLess={()=>lessProject(group.key)} canLess={group.items.length>3&&(shownCounts.get(group.key)??3)>3} canMore={group.items.length>(shownCounts.get(group.key)??3)||!!cursor} loading={sessionsLoading||searchPending}>{group.items.slice(0,group.name?(shownCounts.get(group.key)??3):group.items.length).map(s=><div className="recent-row" key={s.id}>{archived?<span className="session-link disabled" title={titleOf(s,t('app.unnamed'))}>{s.metadata?.favorite?'★ ':''}{titleOf(s,t('app.unnamed'))}{s.metadata?.hidden?t('app.hiddenSuffix'):''}</span>:<a href={'/sessions/'+s.id} title={titleOf(s,t('app.unnamed'))} className={'session-link'+(s.id===threadId?' selected':'')} aria-current={s.id===threadId?'page':undefined} onClick={e=>{if(e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();navigate('/sessions/'+s.id);}}>{s.metadata?.favorite?'★ ':''}{titleOf(s,t('app.unnamed'))}{s.metadata?.hidden?t('app.hiddenSuffix'):''}</a>}<SessionMenu thread={s} archived={archived} onChanged={async hiddenId=>{if(hiddenId){if(!includeHidden)removeSession(hiddenId);else{const hidden=(item:Json)=>item.id===hiddenId?{...item,metadata:{...item.metadata,hidden:true}}:item;sessionPages.current=sessionPages.current.map(page=>({...page,result:{...page.result,data:page.result.data.map(hidden)}}));setSessions(old=>old.map(hidden));}}await load();}} onArchive={async(id,value)=>{drafts.delete(id);removeSession(id);if(value&&/^\/sessions\/([a-zA-Z0-9-]+)$/.exec(location.pathname)?.[1]===id){releasedNavigation.add(id);navigate('/',true);}if(!value)setArchived(false);else await loadSessions();}}/>{releaseStates[s.id]?.error?<button className="release-warning" title={text(releaseStates[s.id].error)} onClick={()=>void releaseLeft(s.id,true)}>{t('app.releaseRetry')}</button>:releaseStates[s.id]?.status==='pending'?<span className="small muted">{t('app.releaseWaiting')}</span>:null}</div>)}</SessionGroup>):<p className="muted">{sessionsPending?t('app.listPending'):searchPending||sessionsLoading?(search.trim()?t('app.searching'):t('app.reading')):sessionsError?t('app.listFailed'):cursor?t('app.emptyPage'):searchTerm?t('app.noMatch'):t('app.noSessions')}</p>}{forksPending?<p className="small muted">{t('app.forksPending')}</p>:null}{forkReadsFailed?<p className="small muted">{t('app.forksFailed')}</p>:null}{cursor?<button disabled={sessionsLoading} onClick={()=>void loadSessions(cursor)}>{t('app.loadMore')}</button>:null}</nav>
      <div className="side-footer"><button onClick={()=>navigate('/settings')}>{t('app.settings')}</button><button onClick={()=>requestLeave(async()=>{try{await api('/auth/logout',{});setAuthenticated(false);}catch(e:any){setError(e);}})}>{t('app.logout')}</button></div>
    </aside>
    <PaneSeparator side="left"/>
    <div className="workspace">{!threadId?<PaneToolbar/>:null}<div className="workspace-content" tabIndex={-1}>{threadId?<Session catalog={catalog} projects={projects} workRoot={workRoot} desktopProjectlessRoot={desktopProjectlessRoot} key={threadId} id={threadId} notification={notification?.threadId===threadId?notification:undefined} onNotificationHandled={consumeNotification} onChanged={refreshSessions} onReleased={()=>{clearSessionWrite(threadId);releasedNavigation.add(threadId);navigate('/',true);setNotice(msg('app.released'));}}/>:route.split('?')[0]==='/settings'?<Settings route={route} projects={projects} onChanged={()=>setAuthenticated(false)}/>:<Home catalog={catalog} onRetryProject={retryProject} key={route} projects={projects} onRefreshProjects={refreshProjects} projectsRefreshing={projectsRefreshing} onChanged={load} onLeaveThread={releaseLeft} onNotice={setNotice}/>}</div></div>
    <div className="app-notifications" aria-label={t('app.notices')}>{error?<AppNotice message={error} label={t('app.closeError')} error onClose={()=>setError('')}/>:null}{sessionsError?<AppNotice message={sessionsError} label={t('app.closeSync')} error={!sessionsPending} onClose={()=>setSessionsError('')}/>:null}{notice?<AppNotice message={notice} label={t('app.closeSuccess')} onClose={()=>setNotice('')}/>:null}</div>
  </PaneLayout>;
}

function SessionMenu({thread,archived,onChanged,onArchive}:{thread:Json;archived:boolean;onChanged:(hiddenId?:string)=>Promise<void>;onArchive:(id:string,archived:boolean)=>Promise<void>}){
  const {t}=useLocale();
  const [error,setError]=useState<UiText>(''),[busy,setBusy]=useState(false),[open,setOpen]=useState(false),menuId=useId(),menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const change=async(path:string,body:Json)=>{menu.current?.hidePopover();setBusy(true);setError('');try{await api('/sessions/'+thread.id+path,body);if(path==='/archive'||path==='/unarchive')await onArchive(thread.id,path==='/archive');else await onChanged(path==='/metadata'&&body.hidden===true?thread.id:undefined);}catch(e:any){setError(e);menu.current?.showPopover();}finally{setBusy(false);}};
  useEffect(()=>{if(!open)return;const close=(event:Event)=>{if(event.target instanceof Node&&menu.current?.contains(event.target))return;menu.current?.hidePopover();};window.addEventListener('resize',close);document.addEventListener('scroll',close,true);return()=>{window.removeEventListener('resize',close);document.removeEventListener('scroll',close,true);};},[open]);
  const position=()=>{if(!menu.current||!trigger.current)return;const rect=trigger.current.getBoundingClientRect(),height=menu.current.offsetHeight,width=menu.current.offsetWidth;menu.current.style.left=`${Math.max(8,Math.min(rect.right-width,innerWidth-width-8))}px`;menu.current.style.top=`${Math.max(8,Math.min(rect.bottom+4+height<=innerHeight-8?rect.bottom+4:rect.top-height-4,innerHeight-height-8))}px`;};
  return <div className="session-menu" onKeyDown={event=>{if(event.key==='Escape'&&menu.current?.matches(':popover-open')){event.preventDefault();event.stopPropagation();menu.current.hidePopover();trigger.current?.focus({preventScroll:true});}}}><button type="button" ref={trigger} aria-label={t('app.menu.label',titleOf(thread,t('app.unnamed')))} aria-controls={menuId} aria-expanded={open} disabled={busy} popoverTarget={menuId}>⋯</button><div id={menuId} ref={menu} popover="auto" onBeforeToggle={event=>{if(event.newState==='open'&&menu.current)menu.current.style.visibility='hidden';}} onToggle={event=>{setOpen(event.newState==='open');if(event.newState==='open'){position();if(menu.current)menu.current.style.visibility='visible';menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});}}}>{!archived?<><button autoFocus disabled={busy} onClick={()=>{const name=window.prompt(t('app.menu.name'),titleOf(thread,t('app.unnamed')));if(name?.trim())void change('/name',{name:name.trim()});}}>{t('app.menu.rename')}</button><button disabled={busy} onClick={()=>void change('/metadata',{favorite:!thread.metadata?.favorite})}>{thread.metadata?.favorite?t('app.menu.unfavorite'):t('app.menu.favorite')}</button><button disabled={busy} onClick={()=>void change('/metadata',{hidden:!thread.metadata?.hidden})}>{thread.metadata?.hidden?t('app.menu.show'):t('app.menu.hide')}</button><button disabled={busy} onClick={()=>{if(window.confirm(t('app.menu.clearConfirm')))void change('/metadata/clear',{});}}>{t('app.menu.clear')}</button></>:null}<button disabled={busy} onClick={()=>{if(window.confirm(archived?t('app.menu.restoreConfirm'):t('app.menu.archiveConfirm')))void change(archived?'/unarchive':'/archive',{});}}>{archived?t('app.menu.restore'):t('app.menu.archive')}</button><ErrorBox error={error}/></div></div>;
}

function Login({onLogin,expired}:{onLogin:()=>void;expired:boolean}) {
  const {t}=useLocale();
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<UiText>('');
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/login',{password});setPassword('');onLogin();}catch(e:any){setError(e);}finally{setBusy(false);}};
  return <main className="login"><Brand/><h1>{t('app.login.heading')}</h1><p className="muted">{t('app.login.description')}</p>{expired?<p role="status" className="notice">{t('app.login.expired')}</p>:null}<form onSubmit={submit}><label>{t('app.login.password')}<input type="password" autoComplete="current-password" required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label><ErrorBox error={error}/><button className="primary" disabled={busy}>{busy?t('app.login.busy'):t('app.login.submit')}</button></form><p className="muted small">{t('app.login.network')}</p><LanguageSelect/></main>;
}

function Home({catalog,onRetryProject,projects,onRefreshProjects,projectsRefreshing,onChanged,onLeaveThread,onNotice}:{catalog:ProjectCatalog;onRetryProject:(id:string)=>void;projects:Project[];onRefreshProjects:()=>Promise<void>;projectsRefreshing:boolean;onChanged:()=>Promise<void>;onLeaveThread:(id:string)=>Promise<void>;onNotice:(notice:UiText)=>void}) {
  const panes=usePanes(),{t}=useLocale();
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
  const [busy,setBusy]=useState(false),[error,setError]=useState<UiText>(''),[partial,setPartial]=useState<Json|null>(null);
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
      if(model){rememberNewTaskSettings({model,effort,permissionMode:settings.permissionMode});if(expectedVersion)void api('/model-defaults',{model,expectedVersion,...(effort?{effort}:{}),...(createdProjectId?{projectId:createdProjectId}:{})}).then(saved=>{if(saved.effectiveModel!==saved.model||saved.effectiveEffort!==saved.effort)onNotice(msg('app.defaultsOverride'));}).catch(e=>onNotice(msg('app.defaultsFailed',e)));}
      void onChanged();if(mounted.current)navigate('/sessions/'+result.threadId);else if(location.pathname!=='/sessions/'+result.threadId)void onLeaveThread(result.threadId).then(onChanged);
      if(model&&!expectedVersion)onNotice(msg('app.defaultsNoVersion'));
    }catch(e:any){if(e.data?.partial?.threadId){markSessionWrite(e.data.partial.threadId);if(mounted.current){const previous=createdPartial.current;if(previous&&previous!==e.data.partial.threadId)void onLeaveThread(previous).then(onChanged);createdPartial.current=e.data.partial.threadId;}}const unknown=!e.status||e.status>=500;if(e.status&&e.status<500)intent.current=null;const cached=drafts.get(draftKey.current);if(cached&&cached.intent?.id===submittedId)drafts.set(draftKey.current,{...cached,intent:intent.current,uncertain:unknown});if(mounted.current){setError(e);setPartial(e.data??null);setUncertain(unknown);}else if(e.data?.partial?.threadId&&location.pathname!=='/sessions/'+e.data.partial.threadId)void onLeaveThread(e.data.partial.threadId).then(onChanged);void onChanged();}finally{submitting.current=false;if(mounted.current)setBusy(false);}
  };
  return <main className="home" inert={panes.mobile&&panes.drawer!==null}><div className="page-heading"><h1>{t('app.home.heading')}</h1><p className="muted">{t('app.home.description')}</p></div><form className="home-form" onSubmit={submit}><fieldset className="creation-fields" disabled={busy}>
    <div className="tabs" role="group" aria-label={t('app.home.type')}>{[['existing',t('app.home.existing')],['new',t('app.home.new')],['clone',t('app.home.clone')]].map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} className={mode===value?'active':''} onClick={()=>{setMode(value);setPartial(null);setError('');}} disabled={busy}>{label}</button>)}</div>
    {mode==='existing'?<><div className="project-picker"><ProjectPicker projects={projects} catalog={catalog} value={selection} workspaceId={workspaceId} disabled={busy} onRetry={onRetryProject} onChange={(value,root)=>{setNativeSelection(value);setSelectedWorkspace(root);setProjectId(root);}}/><button type="button" className="quiet" aria-label={t('app.home.refresh')} disabled={projectsRefreshing} onClick={()=>void onRefreshProjects()}>{projectsRefreshing?t('common.refreshing'):t('common.refresh')}</button></div><p className="muted small">{selection?projects.find(p=>p.id===workspaceId)?.path:t('app.home.noProject')}</p></>:<><div className="form-row"><label>{t('app.home.displayName')}<input required maxLength={120} placeholder="Example Review Tool" value={name} onChange={e=>setName(e.target.value)}/></label><label>{t('app.home.folder')}<input required maxLength={80} placeholder="example-review-tool" value={folder} onChange={e=>setFolder(e.target.value)}/></label></div>{mode==='clone'?<label>{t('app.home.repository')}<input type="text" required maxLength={2048} placeholder="https://github.com/owner/repo.git" value={repo} onChange={e=>setRepo(e.target.value)}/><span className="muted small">{t('app.home.credentials')}</span></label>:<p className="muted small">{t('app.home.initialize')}</p>}</>}
    <label>{t('app.home.task')}<textarea aria-label={t('app.home.task')} rows={7} maxLength={12000} enterKeyHint={panes.mobile?'enter':'send'} placeholder={t('app.home.placeholder')} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(shouldSubmit(e.nativeEvent,{mobile:panes.mobile,shortcut:readSendShortcut()})){e.preventDefault();if(canSubmit)e.currentTarget.form?.requestSubmit();}}}/></label>
    <Attachments items={attachments} onChange={next=>{setAttachments(next);const cached=drafts.get(draftKey.current);if(cached)drafts.set(draftKey.current,{...cached,attachments:next});}} disabled={busy}/><TurnOptions value={settings} onChange={next=>{settingsEdited.current=true;setSettings(next);}} onModels={items=>{models.current=items;}} onCatalog={value=>{modelCatalog.current=value;defaultsVersion.current=typeof value.userVersion==='string'?value.userVersion:null;}} projectId={mode==='existing'?workspaceId:undefined} disabled={busy}/>
    <ErrorBox error={error}/>{partial?.partial?.threadId?<button type="button" onClick={()=>navigate('/sessions/'+partial.partial.threadId)}>{t('app.home.openCreated')}</button>:null}{partial?.project?<div className="notice">{t('app.home.projectCreated')}{partial.project.path}<button type="button" onClick={()=>onRetryProject(partial.project.id)}>{t('app.home.retrySync')}</button><button type="button" onClick={()=>{setMode('existing');setProjectId(partial.project.id);setNativeSelection('workspace:'+partial.project.id);setSelectedWorkspace(partial.project.id);setPartial(null);setError(msg('app.checkCreated'));}}>{t('app.home.useCreated')}</button></div>:partial?.partial?<pre>{pretty(partial.partial)}</pre>:null}
    {uncertain?<div className="notice">{t('app.home.uncertain')}<button type="button" onClick={()=>setUncertain(false)}>{t('app.home.checked')}</button></div>:null}
    <button className="primary" disabled={!canSubmit}>{busy?t('app.home.creating'):t('app.home.start')}</button>
  </fieldset></form></main>;
}

const initialLocale=initialLocaleState();
document.documentElement.lang=initialLocale.locale;document.documentElement.dir='ltr';
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={initialLocale}><App/></LocaleProvider>);
if(import.meta.env.PROD&&'serviceWorker' in navigator)window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});});
