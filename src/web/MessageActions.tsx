import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {useEffect,useId,useRef,useState} from 'react';
import {api} from './api.ts';
import {drafts,type ForkResult} from './drafts.ts';
import {navigate} from './navigation.ts';
import {markSessionWrite,releaseOnLeave} from './handoff.ts';

type Entry={path:string;lineStart:number;lineEnd:number;note:string};
type Props={threadId:string;turnId?:string;canFork:boolean;memoryCitation?:unknown;onChanged?:()=>Promise<void>};
const threadIdValid=(id:unknown,source:string):id is string=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,120}$/.test(id)&&id!==source;
export function MessageActions({threadId,turnId,canFork,memoryCitation,onChanged}:Props){
  const {t,text}=useLocale();
  const [result,setResult]=useState<ForkResult|undefined>(()=>turnId?drafts.get(threadId)?.forkResults?.[turnId]:undefined);
  const mounted=useRef(false),panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panelId=useId(),[open,setOpen]=useState(false);
  const entries:Entry[]=memoryCitation&&typeof memoryCitation==='object'&&Array.isArray((memoryCitation as {entries?:unknown}).entries)
    ?(memoryCitation as {entries:unknown[]}).entries.filter((entry):entry is Entry=>!!entry&&typeof entry==='object'&&typeof (entry as Entry).path==='string'&&!!(entry as Entry).path.trim()&&typeof (entry as Entry).note==='string'&&Number.isSafeInteger((entry as Entry).lineStart)&&(entry as Entry).lineStart>0&&Number.isSafeInteger((entry as Entry).lineEnd)&&(entry as Entry).lineEnd>=(entry as Entry).lineStart):[];
  useEffect(()=>{
    if(!canFork)return;
    mounted.current=true;
    const changed=()=>setResult(turnId?drafts.get(threadId)?.forkResults?.[turnId]:undefined);
    changed();window.addEventListener('fork-result-changed',changed);
    return()=>{mounted.current=false;window.removeEventListener('fork-result-changed',changed);};
  },[threadId,turnId,canFork]);
  useEffect(()=>{
    if(!open)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){panel.current?.hidePopover();trigger.current?.focus({preventScroll:true});}};
    document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);
  },[open]);
  useEffect(()=>{panel.current?.hidePopover();},[memoryCitation]);
  const save=(next:ForkResult)=>{
    // Logout/archiving may have removed the draft; do not restore discarded state.
    const cached=drafts.get(threadId);if(!cached||!turnId)return;
    drafts.set(threadId,{...cached,forkResults:{...cached.forkResults,[turnId]:next}});
    window.dispatchEvent(new Event('fork-result-changed'));
  };
  const fork=async()=>{
    if(!canFork||!turnId)return;
    const previous=drafts.get(threadId)?.forkResults?.[turnId];
    if(previous&&previous.status!=='failed')return;
    save({status:'pending'});
    try{
      const response=await api('/sessions/'+encodeURIComponent(threadId)+'/fork',{lastTurnId:turnId,clientRequestId:crypto.randomUUID()},AbortSignal.timeout(45_000));
      if(!threadIdValid(response.threadId,threadId))throw Object.assign(new Error('服务器未返回有效的新会话。'),{i18n:msg('session.fork.invalidThread')});
      markSessionWrite(response.threadId);
      if(response.status!=='idle')throw Object.assign(new Error('服务器未返回有效的新会话状态。'),{i18n:msg('session.fork.invalidStatus'),data:{partial:{threadId:response.threadId}}});
      save({status:'created',threadId:response.threadId,message:typeof response.warning==='string'?response.warning:undefined});
      void onChanged?.().catch(()=>{});
      if(mounted.current&&location.pathname==='/sessions/'+threadId)navigate('/sessions/'+response.threadId);
      else if(location.pathname!=='/sessions/'+response.threadId)void releaseOnLeave(response.threadId).catch(()=>{});
    }catch(error:any){
      const partial=threadIdValid(error.data?.partial?.threadId,threadId)?error.data.partial.threadId:undefined;
      if(partial){markSessionWrite(partial);if(location.pathname!=='/sessions/'+partial)void releaseOnLeave(partial).catch(()=>{});}
      const definite=!partial&&typeof error.data?.error==='string'&&(
        !error.data.code&&[400,401,403].includes(error.status)||
        ['AUTH_REQUIRED','REQUEST_FORBIDDEN','REQUEST_VALIDATION_FAILED','RUNTIME_NOT_FOUND','RUNTIME_SUBAGENT_THREAD','RUNTIME_FORK_TURN_INCOMPLETE','RUNTIME_IDEMPOTENCY_CONFLICT','RUNTIME_FORK_UNSUPPORTED','RUNTIME_THREAD_CONFLICT'].includes(error.data.code)&&error.status>=400&&error.status<500);
      save({status:definite?'failed':'unknown',threadId:partial,message:error});
    }
  };
  return <>{canFork?<button type="button" className="quiet" disabled={!!result&&result.status!=='failed'} aria-busy={result?.status==='pending'} onClick={()=>void fork()}>{result?.status==='failed'?t('session.fork.retry'):t('session.fork.create')}</button>:null}
    {entries.length?<><button ref={trigger} type="button" className="quiet" aria-expanded={open} aria-controls={panelId} popoverTarget={panelId} onClick={event=>{if(panel.current){const rect=event.currentTarget.getBoundingClientRect();panel.current.style.top=Math.min(rect.bottom+6,window.innerHeight-200)+'px';panel.current.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-368))+'px';}}}>{t('session.memory.title')}</button>
      <div ref={panel} id={panelId} popover="auto" role="dialog" aria-label={t('session.memory.title')} className="memory-citation-panel" onToggle={event=>setOpen(event.newState==='open')}><strong>{t('session.memory.title')}</strong><ul>{entries.map((entry,index)=><li key={index}><p>{entry.note}</p><small className="muted">{entry.path}:{entry.lineStart}{entry.lineEnd!==entry.lineStart?'-'+entry.lineEnd:''}</small></li>)}</ul></div></>:null}
    {canFork&&result&&result.status!=='pending'?<span className="fork-result" role="status">{result.message?text(result.message):null}{result.status==='unknown'?<span>{t('session.fork.unknown')}</span>:null}{result.threadId?<button type="button" className="quiet" onClick={()=>navigate('/sessions/'+result.threadId)}>{t('session.fork.open')}</button>:null}</span>:null}
  </>;
}
