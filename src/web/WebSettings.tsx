import {formatDateTime,formatNumber} from './i18n/format.ts';
import {LanguageSelect} from './i18n/LanguageSelect.tsx';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg} from './i18n/messages.ts';
import type {UiText} from './i18n/types.ts';
import {useEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {usePanes} from './PaneLayout.tsx';
import {Notifications} from './Notifications.tsx';
import {readSessionSort,writeSessionSort,type SessionSort} from './preferences.ts';
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
export function WebSettings({onChanged}:{onChanged:()=>void}){
 const {t,text,locale}=useLocale();
 const panes=usePanes();
 const [settings,setSettings]=useState<Json|null>(null),[error,setError]=useState<UiText>(''),[current,setCurrent]=useState(''),[next,setNext]=useState(''),[busy,setBusy]=useState(false);
 const [notice,setNotice]=useState<UiText>(''),[confirmation,setConfirmation]=useState<{web:boolean}|null>(null),[checking,setChecking]=useState(false),[dialogError,setDialogError]=useState<UiText>('');
 const [sort,setSort]=useState(readSessionSort),[sortError,setSortError]=useState<UiText>(''),[passwordError,setPasswordError]=useState<UiText>('');
 useEffect(()=>{const sync=()=>setSort(readSessionSort());window.addEventListener('session-sort-changed',sync);window.addEventListener('storage',sync);return()=>{window.removeEventListener('session-sort-changed',sync);window.removeEventListener('storage',sync);};},[]);
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement|null>(null),executing=useRef(false);
  const restartState=settings?.webRestart??{available:false,status:'idle'}, restartPending=['scheduled','unknown'].includes(restartState.status);
  const restartError=(e:any)=>e.status===404?msg("settings.restart.missingApi"):e;
  const openRestart=(web:boolean,source:HTMLButtonElement)=>{opener.current=source;setChecking(true);setDialogError('');setConfirmation({web});};
  useEffect(()=>{
    const panel=dialog.current;
    if(!confirmation){if(panel?.open){panel.close();opener.current?.focus();}return;}
    if(!panel?.open)panel?.showModal();cancel.current?.focus();
    const controller=new AbortController();setChecking(true);setDialogError('');
    void Promise.all([api('/runtime/restart-check',undefined,controller.signal),confirmation.web?api('/server/restart',undefined,controller.signal):Promise.resolve(null)]).then(([activity,state])=>{
      if(controller.signal.aborted)return;
      if(state){setSettings(old=>({...old,webRestart:state}));if(!state.available)throw state.reason||msg("settings.restart.unavailable");if(['scheduled','unknown'].includes(state.status))throw msg("settings.restart.pending");}
      if(activity?.idle!==true)throw msg("settings.restart.activityUnknown");
    }).catch(e=>{if(!controller.signal.aborted)setDialogError(restartError(e));}).finally(()=>{if(!controller.signal.aborted)setChecking(false);});
    return()=>controller.abort();
  },[confirmation]);
  const restart=async()=>{
    if(!confirmation||checking||dialogError||busy||executing.current)return;
    const web=confirmation.web;executing.current=true;setBusy(true);setError('');setNotice('');
    try{
      if(web){const state=await api('/server/restart',{confirmed:true});setSettings(old=>({...old,webRestart:state}));}
      else{await api('/models/reload',{});setNotice(msg("settings.restart.codexSuccess"));setSettings(await api('/settings'));}
      setConfirmation(null);
    }catch(e:any){setDialogError(restartError(e));if(web&&!e.status)setSettings(old=>({...old,webRestart:{...old?.webRestart,status:'unknown'}}));}
    finally{executing.current=false;setBusy(false);}
  };
  const checkRestart=async()=>{setBusy(true);setError('');try{const state=await api('/server/restart');setSettings(old=>({...old,webRestart:state}));}catch(e:any){setError(e);}finally{setBusy(false);}};
  const restartMessage=restartState?.status==='scheduled'?t('settings.restart.scheduled',formatDateTime(restartState.scheduledAt,locale,{timeStyle:'medium'})):
    restartState?.status==='success'?t("settings.restart.webSuccess"):restartState?.status==='failed'?t("settings.restart.webFailed"):restartState?.status==='unknown'?t("settings.restart.webUnknown"):'';
  useEffect(()=>{let disposed=false;void api('/settings').then(s=>{if(!disposed)setSettings(s);}).catch(e=>{if(!disposed)setError(e);});return()=>{disposed=true;};},[]);
 return <div className="web-settings">
 <div className="settings-group"><h3>{t("settings.browser.title")}</h3><div className="settings-card"><div className="settings-row"><LanguageSelect/></div><div className="settings-row"><div><label htmlFor="session-sort">{t("settings.sort.label")}</label><p>{t("settings.sort.help")}</p></div><select id="session-sort" value={sort} onChange={event=>{const value=event.target.value as SessionSort;if(writeSessionSort(value)){setSort(value);setSortError('');}else setSortError(msg("settings.sort.failed"));}}><option value="updated_at">{t("settings.sort.updated")}</option><option value="created_at">{t("settings.sort.created")}</option></select></div>{sortError?<p role="alert" className="notice error">{text(sortError)}</p>:null}<div className="settings-row"><div><h4>{t("settings.layout.title")}</h4><p>{t("settings.layout.help")}</p></div><button onClick={panes.reset}>{t("settings.layout.reset")}</button></div></div></div>
 <div className="settings-group"><div className="settings-card"><Notifications/></div></div>
 <div className="settings-group"><h3>{t("settings.runtime.title")}</h3>{error?<div role="alert" className="notice error">{text(error)}</div>:null}{settings?<div className="settings-card">
 <dl className="settings-status"><dt>Codex Web</dt><dd>{settings.appVersion??t("settings.unknown")}</dd><dt>Node.js</dt><dd>{settings.nodeVersion??t("settings.unknown")}</dd><dt>Codex CLI</dt><dd>{settings.modelSource?.version??t("settings.runtime.unloaded")}</dd><dt>{t("settings.runtime.modelsRead")}</dt><dd>{settings.modelSource?.readAt?formatDateTime(settings.modelSource.readAt,locale):t("settings.runtime.unread")}</dd></dl>
 <details className="settings-details"><summary>{t("settings.runtime.details")}</summary><dl><dt>{t("settings.runtime.origin")}</dt><dd>{settings.origin}</dd><dt>{t("settings.runtime.root")}</dt><dd>{settings.workRoot}</dd><dt>{t("settings.runtime.cli")}</dt><dd>{settings.modelSource?.executable??t("settings.unknown")}</dd></dl>{settings.runtime?.note?<p>{settings.runtime.note}</p>:null}<pre>{pretty(settings.runtime)}</pre><p className="muted small">{t("settings.runtime.restartHelp")}</p></details>
 <div className="settings-maintenance"><p className="muted small">{t("settings.runtime.maintenanceHelp")}</p><div className="actions"><button disabled={busy||restartPending} onClick={async()=>{setBusy(true);setError('');try{await api('/models?refresh=true');setSettings(await api('/settings'));}catch(e:any){setError(e);}finally{setBusy(false);}}}>{t("settings.runtime.refreshModels")}</button><button disabled={busy||restartPending} onClick={e=>openRestart(false,e.currentTarget)}>{t("settings.runtime.restartCodex")}</button><button className="danger" disabled={busy||restartPending} onClick={e=>openRestart(true,e.currentTarget)}>{t("settings.runtime.restartWeb")}</button></div>{notice?<p role="status" className="notice">{text(notice)}</p>:null}{restartMessage?<div role="status" className={'notice'+(restartState.status==='failed'?' error':'')}>{restartMessage}<button disabled={busy} onClick={()=>void checkRestart()}>{t("settings.restart.checkResult")}</button></div>:null}</div>
 </div>:<p role="status">{t("settings.runtime.loading")}</p>}</div>
 {settings?<section className="settings-group" role="region" aria-labelledby="diagnostics-status-title"><h3 id="diagnostics-status-title">{t("settings.diagnostics.title")}</h3><div className="settings-card"><dl className="settings-status"><dt>{t("settings.diagnostics.recording")}</dt><dd>{settings.diagnostics?.enabled===true?t("settings.enabled"):settings.diagnostics?.enabled===false?t("settings.diagnostics.notEnabled"):t("settings.diagnostics.unavailable")}</dd><dt>{t("settings.diagnostics.lastWrite")}</dt><dd data-testid="diagnostics-last-write">{settings.diagnostics?.lastWriteAt!=null?formatDateTime(settings.diagnostics.lastWriteAt,locale):settings.diagnostics?t("settings.diagnostics.noWrites"):t("settings.unknown")}</dd><dt>{t("settings.diagnostics.dropped")}</dt><dd>{typeof settings.diagnostics?.dropped==='number'?formatNumber(settings.diagnostics.dropped,locale):t("settings.unknown")}</dd><dt>{t("settings.diagnostics.failed")}</dt><dd>{typeof settings.diagnostics?.writeFailures==='number'?formatNumber(settings.diagnostics.writeFailures,locale):t("settings.unknown")}</dd></dl></div></section>:null}
 <div className="settings-group"><h3>{t("settings.password.title")}</h3><div className="settings-card settings-password"><p className="muted small">{t("settings.password.help")}</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setPasswordError('');try{await api('/auth/password',{currentPassword:current,newPassword:next});setCurrent('');setNext('');onChanged();}catch(e:any){setPasswordError(e);}finally{setBusy(false);}}}><label>{t("settings.password.current")}<input type="password" required minLength={12} maxLength={256} autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>{t("settings.password.new")}<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={next} onChange={e=>setNext(e.target.value)}/></label>{passwordError?<div role="alert" className="notice error">{text(passwordError)}</div>:null}<button className="primary" disabled={busy}>{busy?t("settings.saving"):t("settings.password.change")}</button></form></div></div>
    <dialog ref={dialog} className="restart-dialog" aria-labelledby="restart-title" aria-describedby="restart-warning" onCancel={e=>{e.preventDefault();if(!busy)setConfirmation(null);}} onClick={e=>{if(e.target===e.currentTarget&&!busy)setConfirmation(null);}}>
      <h2 id="restart-title">{confirmation?.web?t("settings.restart.webTitle"):t("settings.restart.codexTitle")}</h2>
      <p className="muted">{confirmation?.web?t("settings.restart.webHelp"):t("settings.restart.codexHelp")}</p>
      <p id="restart-warning" className="notice error">{t("settings.restart.warning")}</p>
      {checking?<p role="status">{t("settings.restart.checking")}</p>:dialogError?<p role="alert" className="notice error">{text(dialogError)}</p>:<p role="status" className="muted">{t("settings.restart.idle")}</p>}
      <div className="actions restart-actions"><button ref={cancel} type="button" disabled={busy} onClick={()=>setConfirmation(null)}>{t("settings.cancel")}</button>{dialogError?<button type="button" disabled={busy} onClick={()=>setConfirmation(old=>old?{...old}:null)}>{t("settings.restart.recheck")}</button>:null}<button type="button" className="danger" disabled={busy||checking||!!dialogError} onClick={()=>void restart()}>{busy?t("settings.restart.executing"):t("settings.restart.confirm")}</button></div>
    </dialog>
 </div>;
}
