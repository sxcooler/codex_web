import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {formatDateTime} from './i18n/format.ts';
import type {UiText} from './i18n/text.ts';

export function WebRestartStatus({state,requested,onChange}:{state:Json;requested:boolean;onChange:(state:Json)=>void}){
 const {t,text,locale}=useLocale();
 const [dismissed,setDismissed]=useState(''),[checking,setChecking]=useState(false),[readError,setReadError]=useState<UiText>('');
 const pending=state.status==='scheduled'||state.status==='unknown',terminal=state.status==='success'||state.status==='failed';
 const identity=state.scheduledAt??'',resultKey=identity+'|'+state.status;
 const currentIdentity=useRef(identity),update=useRef(onChange),inflight=useRef<AbortController|null>(null);
 const currentNotice=useRef<HTMLDivElement>(null),historySummary=useRef<HTMLElement>(null),focusHistory=useRef(false);
 currentIdentity.current=identity;update.current=onChange;
 const read=useCallback(async()=>{
  if(inflight.current)return;
  const controller=new AbortController(),startedFor=currentIdentity.current,source=document.activeElement,fromNotice=!!currentNotice.current?.contains(source);inflight.current=controller;setChecking(true);setReadError('');
  try{const next=await api('/server/restart',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));if(!controller.signal.aborted&&startedFor===currentIdentity.current){if(fromNotice&&['success','failed'].includes(next.status)&&(document.activeElement===source||document.activeElement===document.body))focusHistory.current=true;update.current(next);}}
  catch(error:any){if(!controller.signal.aborted&&startedFor===currentIdentity.current)setReadError(error);}
  finally{if(inflight.current===controller){inflight.current=null;if(!controller.signal.aborted)setChecking(false);}}
 },[]);
 useEffect(()=>{inflight.current?.abort();inflight.current=null;setChecking(false);setReadError('');return()=>{inflight.current?.abort();inflight.current=null;};},[identity]);
 useEffect(()=>{
  if(!pending)return;
  const resume=()=>{if(document.visibilityState!=='hidden')void read();};
  window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  return()=>{window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
 },[pending,read]);
 useEffect(()=>{
  if(state.status!=='scheduled')return;
  const due=Date.parse(identity);if(!Number.isFinite(due))return;
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  // A hanging read must not extend the existing result-verification window.
  const deadline=setTimeout(()=>{inflight.current?.abort();inflight.current=null;setChecking(false);update.current({...state,status:'unknown'});},Math.max(0,due+120000-Date.now()));
  const verify=async()=>{
   if(stopped)return;
   if(Date.now()>due+120000){update.current({...state,status:'unknown'});return;}
   if(document.visibilityState!=='hidden')await read();
   if(!stopped)timer=setTimeout(()=>void verify(),5000);
  };
  timer=setTimeout(()=>void verify(),Math.max(0,due-Date.now()));
  return()=>{stopped=true;clearTimeout(timer);clearTimeout(deadline);};
 },[state.status,identity,read]);
 useEffect(()=>{if(!requested||state.status!=='success')return;const timer=setTimeout(()=>setDismissed(resultKey),5000);return()=>clearTimeout(timer);},[requested,state.status,resultKey]);
 useLayoutEffect(()=>{if(terminal&&focusHistory.current){focusHistory.current=false;historySummary.current?.focus({preventScroll:true});}},[terminal,resultKey]);
 const showCurrent=pending||(requested&&terminal&&dismissed!==resultKey);
 const message=state.status==='scheduled'?t('settings.restart.scheduled',formatDateTime(state.scheduledAt,locale,{timeStyle:'medium'})):state.status==='unknown'?t('settings.restart.webUnknown'):state.status==='success'?t('settings.restart.webSuccess'):t('settings.restart.webFailed');
 return <>
  {showCurrent?<div ref={currentNotice} role={state.status==='failed'?'alert':'status'} className={'notice web-restart-current'+(state.status==='failed'?' error':'')}>
   <div className="operation-notice"><div className="operation-notice-text">{message}{state.status==='failed'&&state.reason?<p className="small">{state.reason}</p>:null}</div>{state.status==='failed'?<button type="button" className="quiet" aria-label={t('common.closeNotice')} onClick={event=>{setDismissed(resultKey);event.currentTarget.closest('.settings-maintenance')?.querySelector<HTMLButtonElement>('button.danger')?.focus({preventScroll:true});}}>{t('common.close')}</button>:null}</div>
   {pending?<button type="button" disabled={checking} onClick={()=>void read()}>{checking?t('settings.loading'):t('settings.restart.checkResult')}</button>:null}
   {readError?<p role="alert" className="small">{text(readError)}</p>:null}
  </div>:null}
  {terminal?<details className="web-restart-history"><summary ref={historySummary}>{t('settings.restart.history')} · {state.status==='success'?t('settings.restart.succeeded'):t('settings.restart.failed')} · {formatDateTime(state.finishedAt??state.scheduledAt,locale,{dateStyle:'medium',timeStyle:'short'})}</summary><p>{state.reason??(state.status==='success'?t('settings.restart.webSuccess'):t('settings.restart.noReason'))}</p></details>:null}
 </>;
}
