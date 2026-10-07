import {useEffect,useId,useRef,useState} from 'react';
import {api} from './api.ts';
import {drafts,type ForkResult} from './drafts.ts';
import {navigate} from './navigation.ts';

type Entry={path:string;lineStart:number;lineEnd:number;note:string};
type Props={threadId:string;turnId?:string;canFork:boolean;memoryCitation?:unknown;onChanged?:()=>Promise<void>};
const threadIdValid=(id:unknown,source:string):id is string=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,120}$/.test(id)&&id!==source;
export function MessageActions({threadId,turnId,canFork,memoryCitation,onChanged}:Props){
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
      if(!threadIdValid(response.threadId,threadId))throw new Error('服务器未返回有效的新会话。');
      if(response.status!=='idle')throw Object.assign(new Error('服务器未返回有效的新会话状态。'),{data:{partial:{threadId:response.threadId}}});
      save({status:'created',threadId:response.threadId,message:typeof response.warning==='string'?response.warning:undefined});
      void onChanged?.().catch(()=>{});
      if(mounted.current&&location.pathname==='/sessions/'+threadId)navigate('/sessions/'+response.threadId);
    }catch(error:any){
      const partial=threadIdValid(error.data?.partial?.threadId,threadId)?error.data.partial.threadId:undefined;
      const definite=!partial&&typeof error.data?.error==='string'&&(
        !error.data.code&&[400,401,403].includes(error.status)||
        ['RUNTIME_NOT_FOUND','RUNTIME_SUBAGENT_THREAD','RUNTIME_FORK_TURN_INCOMPLETE','RUNTIME_IDEMPOTENCY_CONFLICT','RUNTIME_FORK_UNSUPPORTED','RUNTIME_THREAD_CONFLICT'].includes(error.data.code)&&error.status>=400&&error.status<500);
      save({status:definite?'failed':'unknown',threadId:partial,message:error.message});
    }
  };
  return <>{canFork?<button type="button" className="quiet" disabled={!!result&&result.status!=='failed'} aria-busy={result?.status==='pending'} onClick={()=>void fork()}>{result?.status==='failed'?'重试分支':'分支到新聊天'}</button>:null}
    {entries.length?<><button ref={trigger} type="button" className="quiet" aria-expanded={open} aria-controls={panelId} popoverTarget={panelId} onClick={event=>{if(panel.current){const rect=event.currentTarget.getBoundingClientRect();panel.current.style.top=Math.min(rect.bottom+6,window.innerHeight-200)+'px';panel.current.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-368))+'px';}}}>引用的记忆</button>
      <div ref={panel} id={panelId} popover="auto" role="dialog" aria-label="引用的记忆" className="memory-citation-panel" onToggle={event=>setOpen(event.newState==='open')}><strong>引用的记忆</strong><ul>{entries.map((entry,index)=><li key={index}><p>{entry.note}</p><small className="muted">{entry.path}:{entry.lineStart}{entry.lineEnd!==entry.lineStart?'-'+entry.lineEnd:''}</small></li>)}</ul></div></>:null}
    {canFork&&result&&result.status!=='pending'?<span className="fork-result" role="status">{result.message}{result.status==='unknown'?<span> 分支结果待核实，请先核对会话列表，不要重复创建。</span>:null}{result.threadId?<button type="button" className="quiet" onClick={()=>navigate('/sessions/'+result.threadId)}>打开已创建的会话</button>:null}</span>:null}
  </>;
}
