import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {api,setCsrfToken,type Json} from './api.ts';
import {applyChange,prependHistory} from './sessionSync.ts';
import {reconcileMessages,type Outgoing,type Submission} from './submission.ts';
import {drafts} from './drafts.ts';
import {cancelReleaseOnReturn} from './handoff.ts';
import {Attachments,type Attachment} from './Attachments.tsx';
import {TurnOptions,type TurnSettings} from './TurnOptions.tsx';
import {PaneSeparator,PaneToolbar,usePanes} from './PaneLayout.tsx';
import {Message,Pending,TurnMessages} from './Conversation.tsx';
import {GitPanel} from './GitPanel.tsx';
const phases:Record<string,string>={IDLE:'就绪',RUNNING:'运行中',WAITING_APPROVAL:'等待审批',WAITING_INPUT:'等待输入',RELEASED:'已释放，可继续',EXTERNAL:'其他客户端占用',UNKNOWN:'状态待核实'};
export function Session({id,onChanged,onReleased}:{id:string;onChanged:()=>Promise<void>;onReleased:(result:Json)=>void}){
  const saved=useRef(drafts.get(id));
  const [outgoing,setOutgoing]=useState<Outgoing[]>(saved.current?.outgoing??[]),outgoingRef=useRef(outgoing);
  const [snapshot,setSnapshot]=useState<Json|null>(null),[error,setError]=useState(''),[readError,setReadError]=useState(''),[reading,setReading]=useState(false),[connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[draft,setDraft]=useState(saved.current?.text??''),[settings,setSettings]=useState<TurnSettings>(saved.current?.settings??{}),[attachments,setAttachments]=useState<Attachment[]>(saved.current?.attachments??[]),[gitTick,setGitTick]=useState(0),[aborting,setAborting]=useState(false),[uncertain,setUncertain]=useState(saved.current?.uncertain??false);
  const [historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState('');
  const earlier=useRef<()=>void>(()=>{}),prepend=useRef<{top:number;height:number}|null>(null);
  const intent=useRef<Submission['current']>(saved.current?.intent??null),submitting=useRef(false),mounted=useRef(true),refresh=useRef<()=>void>(()=>{}),recheck=useRef<()=>void>(()=>{}),pause=useRef<()=>void>(()=>{}),scroll=useRef<HTMLDivElement>(null),follow=useRef(saved.current?.follow??true),restored=useRef(false),panes=usePanes();
  const saveDraft=(text=draft,options=settings,files=attachments,unknown=uncertain)=>{drafts.set(id,{text,settings:options,attachments:files,outgoing:outgoingRef.current,uncertain:unknown,intent:intent.current,top:scroll.current?.scrollTop??saved.current?.top,follow:follow.current});};
  const updateOutgoing=(change:(messages:Outgoing[])=>Outgoing[],notify=true)=>{
    const previous=drafts.get(id)?.outgoing??outgoingRef.current,next=change(previous);if(next===previous)return;
    outgoingRef.current=next;const unknown=next.some(message=>message.status==='unknown'),cached=drafts.get(id);
    if(cached)drafts.set(id,{...cached,outgoing:next,uncertain:unknown});
    if(mounted.current){setOutgoing(next);setUncertain(unknown);}
    if(notify)window.dispatchEvent(new CustomEvent('outgoing-changed',{detail:id}));
  };
  useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent).detail!==id)return;outgoingRef.current=drafts.get(id)?.outgoing??[];setOutgoing(outgoingRef.current);setUncertain(outgoingRef.current.some(m=>m.status==='unknown'));recheck.current();};window.addEventListener('outgoing-changed',changed);return()=>window.removeEventListener('outgoing-changed',changed);},[id]);
  useEffect(()=>{saveDraft();},[draft,settings,attachments,uncertain]);
  useEffect(()=>{panes.setRightAvailable(!!snapshot?.project);return()=>panes.setRightAvailable(false);},[snapshot?.project?.id,panes.setRightAvailable]);
  useEffect(()=>{
    mounted.current=true;let disposed=false,entryReady=false,inflight=false,paused=false,lastEvent=Date.now(),lastPhase='',baseline:Json|null=null,source:EventSource|undefined,controller:AbortController|undefined,statusController:AbortController|undefined,historyController:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const accept=(next:Json)=>{baseline=next;setSnapshot(next);updateOutgoing(messages=>reconcileMessages(messages,(next.thread?.turns??[]).flatMap((turn:Json)=>turn.items??[])),false);if(next.phase!==lastPhase&&['IDLE','RELEASED'].includes(next.phase)){setGitTick(n=>n+1);if(lastPhase)void onChanged();}lastPhase=next.phase;};
    const disconnect=()=>{source?.close();source=undefined;};
    const schedule=()=>{disconnect();if(!disposed&&!paused&&!timer)timer=setTimeout(()=>{timer=undefined;void load();},200);};
    const connect=()=>{
      disconnect();if(disposed||paused||!entryReady||!baseline)return;
      setConnected(false);lastEvent=Date.now();const stream=new EventSource('/api/sessions/'+id+'/events'+(baseline.syncCursor?'?cursor='+encodeURIComponent(baseline.syncCursor):''));source=stream;
      const alive=()=>!disposed&&!paused&&source===stream;
      for(const event of ['ready','ping'])stream.addEventListener(event,()=>{if(alive()){lastEvent=Date.now();setConnected(true);}});
      stream.addEventListener('resync',()=>{if(alive()){lastEvent=Date.now();schedule();}});
      stream.addEventListener('change',event=>{if(!alive())return;lastEvent=Date.now();try{const next=applyChange(baseline!,JSON.parse((event as MessageEvent).data));if(!next){schedule();return;}setConnected(true);setReadError('');if(next!==baseline)accept(next);}catch{schedule();}});
      stream.onerror=()=>{if(!alive())return;setConnected(false);void api('/auth/session').then(state=>{if(!alive())return;setCsrfToken(state.csrfToken);if(!state.authenticated)window.dispatchEvent(new Event('auth-lost'));}).catch(()=>{});};
    };
    const load=async()=>{
      if(disposed||paused||!entryReady||inflight)return;inflight=true;disconnect();statusController?.abort();historyController?.abort();historyController=undefined;setHistoryLoading(false);setHistoryError('');prepend.current=null;controller=new AbortController();const request=controller;setReading(true);
      try{const next=await api('/sessions/'+id,undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));if(disposed||request.signal.aborted||paused)return;accept(next);setReadError('');connect();}
      catch(e:any){if(!disposed&&!request.signal.aborted&&!paused)setReadError(e.message);}
      finally{inflight=false;if(!disposed)setReading(false);}
    };
    earlier.current=()=>{void (async()=>{
      const cursor=baseline?.history?.nextCursor;if(!cursor||historyController||inflight||disposed||paused)return;
      const request=new AbortController();historyController=request;setHistoryLoading(true);setHistoryError('');follow.current=false;
      try{
        const page=await api('/sessions/'+id+'/history?before='+encodeURIComponent(cursor),undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));
        if(disposed||paused||request.signal.aborted||historyController!==request||!baseline)return;
        const next=prependHistory(baseline,page,cursor);if(next===baseline)return;
        if(scroll.current)prepend.current={top:scroll.current.scrollTop,height:scroll.current.scrollHeight};accept(next);
      }catch(e:any){if(!disposed&&!request.signal.aborted)setHistoryError(e.message);}
      finally{if(historyController===request){historyController=undefined;if(!disposed)setHistoryLoading(false);}}
    })();};
    const checkStatus=async()=>{
      if(disposed||paused||!entryReady||inflight||statusController)return;
      if(!baseline?.syncCursor){void load();return;}
      const request=new AbortController();statusController=request;
      try{const status=await api('/sessions/'+id+'/status?epoch='+encodeURIComponent(baseline.epoch),undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));if(disposed||paused||request.signal.aborted)return;if(status.resync)await load();else setReadError('');}
      catch(e:any){if(!disposed&&!paused&&!request.signal.aborted)setReadError(e.message);}
      finally{if(statusController===request)statusController=undefined;}
    };
    refresh.current=()=>{paused=false;setReadError('');void load();};
    recheck.current=()=>{paused=false;if(!source&&!inflight)connect();void checkStatus();};
    pause.current=()=>{paused=true;disconnect();controller?.abort();statusController?.abort();historyController?.abort();if(timer)clearTimeout(timer);timer=undefined;};
    const wake=()=>{if(document.visibilityState==='visible'&&!paused)recheck.current();};
    const watchdog=setInterval(()=>{if(!disposed&&!paused&&document.visibilityState==='visible'&&Date.now()-lastEvent>45_000){connect();void checkStatus();}},5000);
    const poll=setInterval(()=>{if(document.visibilityState==='visible'&&baseline?.syncCursor)void checkStatus();},30_000);
    window.addEventListener('online',wake);window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);document.addEventListener('visibilitychange',wake);
    let entering:Promise<void>|undefined;const enter=()=>entering??(entering=cancelReleaseOnReturn(id,()=>!disposed).then(()=>{if(!disposed){entryReady=true;void load();}}).catch(e=>{if(!disposed)setError(e.message);}).finally(()=>{entering=undefined;}));
    const normalRefresh=refresh.current;refresh.current=()=>{if(!entryReady){void enter();return;}normalRefresh();};
    void enter();
    return()=>{disposed=true;mounted.current=false;controller?.abort();statusController?.abort();historyController?.abort();disconnect();if(timer)clearTimeout(timer);clearInterval(watchdog);clearInterval(poll);window.removeEventListener('online',wake);window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);document.removeEventListener('visibilitychange',wake);};
  },[id,onChanged]);
  useLayoutEffect(()=>{const anchor=prepend.current;if(anchor&&scroll.current){scroll.current.scrollTop=anchor.top+scroll.current.scrollHeight-anchor.height;prepend.current=null;}},[snapshot]);
  useEffect(()=>{if(!scroll.current||!snapshot)return;if(!restored.current){scroll.current.scrollTop=saved.current?.top??scroll.current.scrollHeight;restored.current=true;}else if(follow.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[snapshot,outgoing]);
  useEffect(()=>{const timeline=scroll.current,content=timeline?.firstElementChild;if(!timeline||!content)return;const observer=new ResizeObserver(()=>{if(restored.current&&follow.current)timeline.scrollTop=timeline.scrollHeight;});observer.observe(content);return()=>observer.disconnect();},[]);
  const action=async(path:string,payload:Json)=>{if(submitting.current)return;submitting.current=true;setBusy(true);setAborting(path==='/abort');setError('');if(path==='/release')pause.current();
    try{const result=await api('/sessions/'+id+path,payload);
      if(mounted.current){if(path==='/release'&&result.handoffReady){onReleased(result);return result;}if(path==='/release')setError(result.warning??'订阅已取消，仍在等待释放占用。');recheck.current();}return result;
    }catch(e:any){if(mounted.current){setError(e.message);recheck.current();}}
    finally{submitting.current=false;if(mounted.current){setBusy(false);setAborting(false);}}};
  const phase=snapshot?.phase??'UNKNOWN',active=!!snapshot?.activeTurnId||['RUNNING','WAITING_APPROVAL','WAITING_INPUT'].includes(phase),canSteer=phase==='RUNNING'&&!!snapshot?.activeTurnId&&!snapshot?.pending?.length,canSend=!readError&&(!reading||canSteer)&&!uncertain&&!outgoing.some(m=>m.status==='sending')&&!snapshot?.release?.inProgress&&(['IDLE','RELEASED'].includes(phase)||canSteer),filesReady=attachments.every(a=>a.status==='ready'),items=(snapshot?.thread?.turns??[]).flatMap((turn:Json)=>turn.items??[]);
  const sendMessage=async()=>{
    if(submitting.current||!canSend||!filesReady||(!draft.trim()&&!attachments.length))return;
    const message:Outgoing={id:crypto.randomUUID(),text:draft,settings:{...settings},attachments:[...attachments],...(canSteer?{expectedTurnId:snapshot!.activeTurnId}:{}),status:'sending'};
    submitting.current=true;setBusy(true);setError('');follow.current=true;intent.current=null;
    updateOutgoing(messages=>[...messages,message],false);setDraft('');setAttachments([]);if(!canSteer)setSettings({});saveDraft('',canSteer?settings:{},[],false);
    try{
      await api('/sessions/'+id+'/messages',{text:message.text,clientRequestId:message.id,attachmentIds:message.attachments.map(a=>a.uploadId),...(message.expectedTurnId?{expectedTurnId:message.expectedTurnId}:message.settings)},AbortSignal.timeout(45_000));
      updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:'accepted'}:m));
    }catch(e:any){updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:!e.status||e.status>=500?'unknown':'failed',error:e.message}:m));}
    finally{submitting.current=false;if(mounted.current){setBusy(false);if(message.attachments.length)refresh.current();else recheck.current();}}
  };
  const editOutgoing=(message:Outgoing)=>{if(draft||attachments.length)return;setDraft(message.text);setSettings(message.settings);setAttachments(message.attachments);intent.current=null;updateOutgoing(messages=>messages.filter(m=>m.id!==message.id));saveDraft(message.text,message.settings,message.attachments,false);};
  return <div className={`session-layout ${snapshot?.project&&panes.rightVisible?'with-git':''}`}><div className="session-center"><PaneToolbar/><main className="session-main" inert={panes.mobile&&panes.drawer!==null}><header className="session-header"><div><h1>{snapshot?(snapshot.thread.name||snapshot.metadata?.web_title||snapshot.thread.preview||'未命名会话'):readError?'会话暂不可用':'读取会话…'}</h1><p className="path">{snapshot?.thread?.cwd??id}</p></div><div className="session-controls"><span className={`connection ${connected?'online':''}`}>{connected?'已连接':'正在重连'} · {readError?'同步失败':phases[phase]}</span><div className="actions"><button disabled={busy||!snapshot} onClick={()=>void action('/release',{})}>释放并关闭</button><button className="quiet" aria-label="刷新当前会话" aria-busy={reading} onClick={()=>refresh.current()}>{reading?'刷新中…':'刷新'}</button></div></div></header>
    <div className="timeline" ref={scroll} onScroll={()=>{const el=scroll.current!;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;saveDraft();}}>
      <div className="timeline-content">{snapshot?.history?.nextCursor?<div className="history-loader"><button type="button" disabled={historyLoading||reading} onClick={()=>earlier.current()}>{historyLoading?'正在加载更早消息…':'加载更早消息'}</button>{historyError?<p role="alert" className="notice error">{historyError}</p>:null}</div>:null}{snapshot?.warning?<div className="notice">{snapshot.warning}</div>:null}{snapshot?.error?<div role="alert" className="notice error">{snapshot.error.message??JSON.stringify(snapshot.error)}</div>:null}
      {snapshot?.unmaterialized?<p className="notice">发送首条消息后保存原生历史。</p>:null}
      {(snapshot?.thread?.turns??[]).filter((t:Json)=>t.error||t.status==='failed').map((t:Json)=><div className="notice error" role="alert" key={t.id}>{t.error?.message??(t.error?JSON.stringify(t.error):'本轮执行失败')}</div>)}
      {!items.length&&!outgoing.length?<p className="empty muted">{snapshot?'输入第一条任务。':'正在读取原生历史…'}</p>:(snapshot?.thread?.turns??[]).map((turn:Json)=><TurnMessages key={turn.id} turn={turn} threadId={id} attachments={snapshot?.attachmentPreviews} phase={turn.id===snapshot?.activeTurnId?phase:undefined}/>)}
      {reconcileMessages(outgoing,items).map(message=><div key={message.id} className="outgoing-message" data-client-id={message.id}><Message threadId={id} item={{type:'userMessage',content:[{type:'text',text:message.text},...message.attachments.map(file=>({type:'text',text:'📎 '+file.name}))]}}/><div className="outgoing-status small" role="status">{{sending:'发送中…',accepted:'已发送，等待历史同步',failed:'发送失败',unknown:'提交结果待核实，请先刷新历史'}[message.status]}{message.error?<span>：{message.error}</span>:null}{message.status==='failed'?<button type="button" disabled={!!draft||!!attachments.length} title={draft||attachments.length?'先处理输入框中的草稿，避免覆盖':'恢复原文和附件到输入框'} onClick={()=>editOutgoing(message)}>重新编辑</button>:null}{message.status==='unknown'?<button type="button" onClick={()=>updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:'failed'}:m))}>已核对历史，允许重新编辑</button>:null}</div></div>)}
      {(snapshot?.pending??[]).map((pending:Json)=><Pending key={pending.requestId} pending={pending} items={items} busy={busy} respond={async answer=>{await action('/requests/'+encodeURIComponent(pending.requestId)+'/respond',{answer});}}/>)}
      </div>
    </div>
    <form className="composer" onSubmit={e=>{e.preventDefault();void sendMessage();}}>
      {error||readError?<div role="alert" className="notice error">{[error,readError].filter(Boolean).join('\n')}</div>:null}
      {!connected?<div role="status" className="notice">正在恢复连接，消息不会自动重发。</div>:null}{snapshot?.retry?<div role="status" className="notice">Codex 正在重试：{snapshot.retry.message}</div>:null}
      {phase==='EXTERNAL'?<div role="status" className="notice">会话已在其他客户端打开。请在那里释放后重试。<button type="button" onClick={()=>refresh.current()}>重试</button></div>:null}
      {snapshot?.release?.requested?<div role="status" className="notice">{snapshot.release.error??'等待释放占用'}</div>:null}
      <Attachments items={attachments} onChange={next=>{setAttachments(next);saveDraft(draft,settings,next);}} disabled={busy}/>
      <label className="sr-only" htmlFor="message">继续这个会话</label><textarea id="message" placeholder="继续这个会话…" maxLength={12000} rows={3} value={draft} onChange={e=>{setDraft(e.target.value);saveDraft(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
      <TurnOptions value={settings} onChange={next=>{setSettings(next);saveDraft(draft,next);}} projectId={snapshot?.project?.id} permissions={['RELEASED','EXTERNAL','UNKNOWN'].includes(phase)||snapshot?.thread?.status?.type==='notLoaded'?undefined:snapshot?.permissions} effectiveModel={snapshot?.thread?.model??snapshot?.model??null} effectiveEffort={snapshot?.thread?.reasoningEffort??null} disabled={busy||active}/>
      {uncertain&&!outgoing.some(m=>m.status==='unknown')?<div className="notice">提交结果待核实，请先检查历史。<button type="button" onClick={()=>{setUncertain(false);saveDraft(draft,settings,attachments,false);}}>已核对历史，允许再次提交</button></div>:null}
      <div className="composer-bottom"><span className="muted small">{canSteer?'Enter 插话 · 沿用本轮模型和权限':canSend?'Enter 发送 · Shift+Enter 换行':active?'任务进行中':'正在核对会话状态'}</span><div className="composer-actions">{active?<button type="button" className="danger" disabled={busy} onClick={()=>void action('/abort',{})}>{aborting?'正在中止…':'中止'}</button>:null}<button className="primary" disabled={busy||!canSend||!filesReady||(!draft.trim()&&!attachments.length)}>{busy&&!aborting?'提交中…':canSteer?'插话':'发送'}</button></div></div>
    </form>
  </main></div>{snapshot?.project?<><PaneSeparator side="right"/><GitPanel key={snapshot.project.id} id={id} projectId={snapshot.project.id} tick={gitTick} visible={panes.rightVisible}/></>:null}</div>;
}
