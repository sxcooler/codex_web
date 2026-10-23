import {formatDateTime,formatNumber} from './i18n/format.ts';
import {LanguageSelect} from './i18n/LanguageSelect.tsx';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {WebRestartStatus} from './WebRestartStatus.tsx';
import {msg} from './i18n/messages.ts';
import type {UiText} from './i18n/types.ts';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {usePanes} from './PaneLayout.tsx';
import {Notifications} from './Notifications.tsx';
import {readSessionSort,writeSessionSort,type SessionSort} from './preferences.ts';
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const isRestartInspection=(value:any):boolean=>value&&typeof value.complete==='boolean'&&typeof value.canRestart==='boolean'&&typeof value.canForce==='boolean'&&typeof value.checkedAt==='string'&&Number.isFinite(Date.parse(value.checkedAt))&&/^[a-f0-9]{64}$/.test(value.version)&&Array.isArray(value.sessions)&&value.sessions.every((session:any)=>typeof session?.threadId==='string')&&Array.isArray(value.issues)&&Array.isArray(value.blockers);
const restartKinds={running:'settings.restart.kind.running',approval:'settings.restart.kind.approval',input:'settings.restart.kind.input',writing:'settings.restart.kind.writing',ending:'settings.restart.kind.ending',unknown:'settings.restart.kind.unknown'} as const;
const restartBlockers={lifecycle:'settings.restart.blocker.lifecycle',maintenance:'settings.restart.blocker.maintenance',write:'settings.restart.blocker.write','thread-write':'settings.restart.blocker.write','native-cleanup':'settings.restart.blocker.cleanup','external-writer':'settings.restart.blocker.external'} as const;
export function WebSettings({onChanged}:{onChanged:()=>void}){
 const {t,text,locale}=useLocale();
 const panes=usePanes();
 const [settings,setSettings]=useState<Json|null>(null),[error,setError]=useState<UiText>(''),[current,setCurrent]=useState(''),[next,setNext]=useState(''),[busy,setBusy]=useState(false);
 const [notice,setNotice]=useState<UiText>(''),[confirmation,setConfirmation]=useState<{web:boolean}|null>(null),[checking,setChecking]=useState(false),[dialogError,setDialogError]=useState<UiText>('');
 const [inspection,setInspection]=useState<Json|null>(null),[activityChanged,setActivityChanged]=useState(false);
 const [restartRequested,setRestartRequested]=useState(false);
 const updateRestart=useCallback((state:Json)=>setSettings(old=>({...old,webRestart:state})),[]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(timer);},[notice]);
 const [sort,setSort]=useState(readSessionSort),[sortError,setSortError]=useState<UiText>(''),[passwordError,setPasswordError]=useState<UiText>('');
 useEffect(()=>{const sync=()=>setSort(readSessionSort());window.addEventListener('session-sort-changed',sync);window.addEventListener('storage',sync);return()=>{window.removeEventListener('session-sort-changed',sync);window.removeEventListener('storage',sync);};},[]);
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement|null>(null),executing=useRef(false);
  const restartState=settings?.webRestart??{available:false,status:'idle'}, restartPending=['scheduled','unknown'].includes(restartState.status);
  const restartError=(e:any)=>e.status===404?msg("settings.restart.missingApi"):e;
  const openRestart=(web:boolean,source:HTMLButtonElement)=>{opener.current=source;setInspection(null);setActivityChanged(false);setChecking(true);setDialogError('');setConfirmation({web});};
  useEffect(()=>{
    const panel=dialog.current;
    if(!confirmation){if(panel?.open){panel.close();opener.current?.focus();}return;}
    if(!panel?.open)panel?.showModal();cancel.current?.focus();
    const controller=new AbortController();setChecking(true);setDialogError('');setActivityChanged(false);
    void Promise.allSettled([api('/runtime/restart-check',undefined,controller.signal),confirmation.web?api('/server/restart',undefined,controller.signal):Promise.resolve(null)]).then(([activity,result])=>{
      if(controller.signal.aborted)return;
      let failure:UiText='';
      if(activity.status==='fulfilled'){if(isRestartInspection(activity.value))setInspection(activity.value);else failure=msg('settings.restart.missingApi');}else failure=restartError(activity.reason);
      if(result.status==='fulfilled'&&result.value){const state=result.value;setSettings(old=>({...old,webRestart:state}));if(!state.available)failure ||= state.reason||msg('settings.restart.unavailable');else if(['scheduled','unknown'].includes(state.status))failure ||= msg('settings.restart.pending');}
      else if(result.status==='rejected')failure ||= restartError(result.reason);
      setDialogError(failure);
    }).catch(e=>{if(!controller.signal.aborted)setDialogError(restartError(e));}).finally(()=>{if(!controller.signal.aborted)setChecking(false);});
    return()=>controller.abort();
  },[confirmation]);
  const restart=async()=>{
    if(!confirmation||!inspection||!inspection.complete||inspection.blockers.length||(!inspection.canRestart&&!inspection.canForce)||checking||dialogError||busy||executing.current)return;
    const web=confirmation.web;executing.current=true;setBusy(true);setError('');setNotice('');
    try{
      const selection={mode:inspection.sessions.length?'force':'normal',version:inspection.version};
      if(web){const state=await api('/server/restart',{confirmed:true,...selection});setRestartRequested(true);updateRestart(state);}
      else{await api('/models/reload',selection);setNotice(msg("settings.restart.codexSuccess"));setSettings(await api('/settings'));}
      setConfirmation(null);
    }catch(e:any){if(e.data?.code==='RUNTIME_RESTART_CHANGED'&&isRestartInspection(e.data.inspection)){setInspection(e.data.inspection);setActivityChanged(true);setDialogError('');}else{setDialogError(restartError(e));if(web&&!e.status){setRestartRequested(true);setSettings(old=>({...old,webRestart:{...old?.webRestart,status:'unknown'}}));}}}
    finally{executing.current=false;setBusy(false);}
  };
  useEffect(()=>{let disposed=false;void api('/settings').then(s=>{if(!disposed)setSettings(s);}).catch(e=>{if(!disposed)setError(e);});return()=>{disposed=true;};},[]);
 return <div className="web-settings">
 <div className="settings-group"><h3>{t("settings.browser.title")}</h3><div className="settings-card"><div className="settings-row"><LanguageSelect/></div><div className="settings-row"><div><label htmlFor="session-sort">{t("settings.sort.label")}</label><p>{t("settings.sort.help")}</p></div><select id="session-sort" value={sort} onChange={event=>{const value=event.target.value as SessionSort;if(writeSessionSort(value)){setSort(value);setSortError('');}else setSortError(msg("settings.sort.failed"));}}><option value="updated_at">{t("settings.sort.updated")}</option><option value="created_at">{t("settings.sort.created")}</option></select></div>{sortError?<p role="alert" className="notice error">{text(sortError)}</p>:null}<div className="settings-row"><div><h4>{t("settings.layout.title")}</h4><p>{t("settings.layout.help")}</p></div><button onClick={panes.reset}>{t("settings.layout.reset")}</button></div></div></div>
 <div className="settings-group"><div className="settings-card"><Notifications/></div></div>
 <div className="settings-group"><h3>{t("settings.runtime.title")}</h3>{error?<div role="alert" className="notice error">{text(error)}</div>:null}{settings?<div className="settings-card">
 <dl className="settings-status"><dt>Codex Web</dt><dd>{settings.appVersion??t("settings.unknown")}</dd><dt>Node.js</dt><dd>{settings.nodeVersion??t("settings.unknown")}</dd><dt>Codex CLI</dt><dd>{settings.modelSource?.version??t("settings.runtime.unloaded")}</dd><dt>{t("settings.runtime.modelsRead")}</dt><dd>{settings.modelSource?.readAt?formatDateTime(settings.modelSource.readAt,locale):t("settings.runtime.unread")}</dd></dl>
 <details className="settings-details"><summary>{t("settings.runtime.details")}</summary><dl><dt>{t("settings.runtime.origin")}</dt><dd>{settings.origin}</dd><dt>{t("settings.runtime.root")}</dt><dd>{settings.workRoot}</dd><dt>{t("settings.runtime.cli")}</dt><dd>{settings.modelSource?.executable??t("settings.unknown")}</dd></dl>{settings.runtime?.note?<p>{settings.runtime.note}</p>:null}<pre>{pretty(settings.runtime)}</pre><p className="muted small">{t("settings.runtime.restartHelp")}</p></details>
 <div className="settings-maintenance"><p className="muted small">{t("settings.runtime.maintenanceHelp")}</p><div className="actions"><button disabled={busy||restartPending} onClick={async()=>{setBusy(true);setError('');try{await api('/models?refresh=true');setSettings(await api('/settings'));}catch(e:any){setError(e);}finally{setBusy(false);}}}>{t("settings.runtime.refreshModels")}</button><button disabled={busy||restartPending} onClick={e=>openRestart(false,e.currentTarget)}>{t("settings.runtime.restartCodex")}</button><button className="danger" disabled={busy||restartPending} onClick={e=>openRestart(true,e.currentTarget)}>{t("settings.runtime.restartWeb")}</button></div>{notice?<p role="status" className="notice">{text(notice)}</p>:null}<WebRestartStatus state={restartState} requested={restartRequested} onChange={updateRestart}/></div>
 </div>:<p role="status">{t("settings.runtime.loading")}</p>}</div>
 {settings?<section className="settings-group" role="region" aria-labelledby="diagnostics-status-title"><h3 id="diagnostics-status-title">{t("settings.diagnostics.title")}</h3><div className="settings-card"><dl className="settings-status"><dt>{t("settings.diagnostics.recording")}</dt><dd>{settings.diagnostics?.enabled===true?t("settings.enabled"):settings.diagnostics?.enabled===false?t("settings.diagnostics.notEnabled"):t("settings.diagnostics.unavailable")}</dd><dt>{t("settings.diagnostics.lastWrite")}</dt><dd data-testid="diagnostics-last-write">{settings.diagnostics?.lastWriteAt!=null?formatDateTime(settings.diagnostics.lastWriteAt,locale):settings.diagnostics?t("settings.diagnostics.noWrites"):t("settings.unknown")}</dd><dt>{t("settings.diagnostics.dropped")}</dt><dd>{typeof settings.diagnostics?.dropped==='number'?formatNumber(settings.diagnostics.dropped,locale):t("settings.unknown")}</dd><dt>{t("settings.diagnostics.failed")}</dt><dd>{typeof settings.diagnostics?.writeFailures==='number'?formatNumber(settings.diagnostics.writeFailures,locale):t("settings.unknown")}</dd></dl></div></section>:null}
 <div className="settings-group"><h3>{t("settings.password.title")}</h3><div className="settings-card settings-password"><p className="muted small">{t("settings.password.help")}</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setPasswordError('');try{await api('/auth/password',{currentPassword:current,newPassword:next});setCurrent('');setNext('');onChanged();}catch(e:any){setPasswordError(e);}finally{setBusy(false);}}}><label>{t("settings.password.current")}<input type="password" required minLength={12} maxLength={256} autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>{t("settings.password.new")}<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={next} onChange={e=>setNext(e.target.value)}/></label>{passwordError?<div role="alert" className="notice error">{text(passwordError)}</div>:null}<button className="primary" disabled={busy}>{busy?t("settings.saving"):t("settings.password.change")}</button></form></div></div>
    <dialog ref={dialog} className="restart-dialog" aria-labelledby="restart-title" aria-describedby="restart-help restart-summary" onCancel={e=>{e.preventDefault();if(!busy)setConfirmation(null);}} onClick={e=>{if(e.target===e.currentTarget&&!busy)setConfirmation(null);}}>
      <h2 id="restart-title">{confirmation?.web?t("settings.restart.webTitle"):t("settings.restart.codexTitle")}</h2>
      <div className="restart-dialog-body" aria-busy={checking}>
      <p id="restart-help" className="muted">{confirmation?.web?t("settings.restart.webHelp"):t("settings.restart.codexHelp")}</p><p className="muted small">{t('settings.restart.scope')}</p>
      <div id="restart-summary" role={dialogError||inspection&&!inspection.complete?'alert':'status'} className={'notice'+(dialogError||inspection&&!inspection.complete?' error':inspection?.sessions.length?' restart-warning':'')}>
        {checking?t('settings.restart.checking'):dialogError?text(dialogError):!inspection?t('settings.restart.activityUnknown'):!inspection.complete?t('settings.restart.incomplete'):inspection.blockers.length?t('settings.restart.blocked'):inspection.sessions.length?<>{t('settings.restart.activeCount',inspection.sessions.length)}<p>{t('settings.restart.forceWarning')}</p></>:t('settings.restart.idle')}
      </div>
      {activityChanged?<p role="status" className="small">{t('settings.restart.changed')}</p>:null}
      {inspection?<><p className="small muted restart-checked">{t('settings.restart.checkedAt',formatDateTime(inspection.checkedAt,locale))}</p>
      {inspection.sessions.length?<ul className="restart-sessions">{inspection.sessions.map((session:Json)=><li key={session.threadId}><div><a href={'/sessions/'+encodeURIComponent(session.threadId)} onClick={()=>setConfirmation(null)}>{session.name||session.threadId.slice(0,12)}</a><span className="small">{t(restartKinds[session.kind as keyof typeof restartKinds]??restartKinds.unknown)}</span></div>
        {session.projectName?<p className="muted small">{session.projectName}</p>:null}{session.category!=='session'?<p className="muted small">{t(session.category==='subagent'?'settings.restart.subagent':'settings.restart.temporary')}{session.parentThreadId?' · '+t('settings.restart.parent',inspection.sessions.find((parent:Json)=>parent.threadId===session.parentThreadId)?.name??session.parentThreadId.slice(0,12)):''}</p>:null}
      </li>)}</ul>:null}
      {inspection.blockers.length?<ul className="restart-blockers small">{[...new Set<string>(inspection.blockers.map((code:string)=>t(restartBlockers[code as keyof typeof restartBlockers]??'settings.restart.activityUnknown')))].map(label=><li key={label}>{label}</li>)}</ul>:null}
      {inspection.issues.length?<details className="restart-issues"><summary>{t('settings.restart.issueDetails',inspection.issues.length)}</summary>{inspection.issues.map((issue:Json,index:number)=><pre key={index}>{[issue.threadId,issue.stage,issue.code,issue.message].filter(value=>value!==undefined).join('\n')}</pre>)}</details>:null}</>:null}
      </div>
      <div className="actions restart-actions"><button ref={cancel} type="button" disabled={busy} onClick={()=>setConfirmation(null)}>{t("settings.cancel")}</button><button type="button" disabled={busy||checking} onClick={()=>setConfirmation(old=>old?{...old}:null)}>{t("settings.restart.recheck")}</button><button type="button" className={'restart-execute '+(inspection?.sessions.length?'warning':'primary')} disabled={busy||checking||!!dialogError||!inspection?.complete||!!inspection?.blockers.length||!(inspection?.sessions.length?inspection.canForce:inspection?.canRestart)} onClick={()=>void restart()}>{busy?t("settings.restart.executing"):checking?t('settings.restart.checkingButton'):t(inspection?.sessions.length?'settings.restart.force':'settings.restart.confirm')}</button></div>
    </dialog>
 </div>;
}
