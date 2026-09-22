import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
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
const phases:Record<string,string>={IDLE:'空闲',RUNNING:'运行中',WAITING_APPROVAL:'等待审批',WAITING_INPUT:'等待输入',RELEASED:'已释放',EXTERNAL:'被占用',UNKNOWN:'待核实'};
export function Session({id,onChanged,onReleased}:{id:string;onChanged:()=>Promise<void>;onReleased:(result:Json)=>void}){
  const saved=useRef(drafts.get(id));
  const [outgoing,setOutgoing]=useState<Outgoing[]>(saved.current?.outgoing??[]),outgoingRef=useRef(outgoing);
  const [snapshot,setSnapshot]=useState<Json|null>(null),[error,setError]=useState(''),[readError,setReadError]=useState(''),[reading,setReading]=useState(false),[connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[draft,setDraft]=useState(saved.current?.text??''),[settings,setSettings]=useState<TurnSettings>(saved.current?.settings??{}),[attachments,setAttachments]=useState<Attachment[]>(saved.current?.attachments??[]),[gitTick,setGitTick]=useState(0),[aborting,setAborting]=useState(false),[uncertain,setUncertain]=useState(saved.current?.uncertain??false);
  const [openFile,setOpenFile]=useState<{path:string}>();
  const [historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState('');
  const [opening,setOpening]=useState(true),[openError,setOpenError]=useState('');
  const [optionsError,setOptionsError]=useState(''),[attachmentError,setAttachmentError]=useState('');
  const earlier=useRef<()=>void>(()=>{}),prepend=useRef<{top:number;height:number}|null>(null);
  const intent=useRef<Submission['current']>(saved.current?.intent??null),submitting=useRef(false),mounted=useRef(true),refresh=useRef<()=>void>(()=>{}),recheck=useRef<()=>void>(()=>{}),pause=useRef<()=>void>(()=>{}),scroll=useRef<HTMLDivElement>(null),follow=useRef(saved.current?.follow??true),restored=useRef(false),panes=usePanes();
  const openDocument=useCallback((path:string)=>{setOpenFile({path});if(!panes.rightVisible)panes.toggle('right');},[panes.rightVisible,panes.toggle]);
  const collapsed=panes.composerCollapsed,composerId=useId(),menuId=useId(),menu=useRef<HTMLDivElement>(null),menuButton=useRef<HTMLButtonElement>(null),[menuOpen,setMenuOpen]=useState(false),input=useRef<HTMLTextAreaElement>(null),expandButton=useRef<HTMLButtonElement>(null);
  const composerScroll=useRef<{top:number;following:boolean}|null>(null),layoutScroll=useRef<number|null>(null);
  const setCollapsed=(value:boolean)=>{if(value===collapsed)return;if(scroll.current)composerScroll.current={top:scroll.current.scrollTop,following:follow.current};panes.setComposerCollapsed(value);};
  useLayoutEffect(()=>{const anchor=composerScroll.current;composerScroll.current=null;if(!anchor)return;const timeline=scroll.current;if(timeline){timeline.scrollTop=anchor.following?timeline.scrollHeight:anchor.top;layoutScroll.current=timeline.scrollTop;follow.current=anchor.following;}if(collapsed)expandButton.current?.focus({preventScroll:true});else if(!panes.mobile)input.current?.focus({preventScroll:true});},[collapsed]);
  useEffect(()=>{menu.current?.hidePopover();},[id,panes.drawer]);
  const closeMenu=()=>{menu.current?.hidePopover();menuButton.current?.focus({preventScroll:true});};
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
    let pendingOpen=false;
    const load=async(checkOpen=false)=>{
      if(disposed||paused||!entryReady)return;if(inflight){if(checkOpen)pendingOpen=true;return;}inflight=true;disconnect();statusController?.abort();historyController?.abort();historyController=undefined;setHistoryLoading(false);setHistoryError('');prepend.current=null;controller=new AbortController();const request=controller;setReading(true);
      try{
        if(checkOpen){setOpening(true);setOpenError('');try{await api('/sessions/'+id+'/open',{},AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));}catch{if(!disposed&&!request.signal.aborted)setOpenError('会话占用状态未确认，请重试。历史仍可查看。');}finally{if(!disposed)setOpening(false);}}
        if(disposed||request.signal.aborted||paused)return;
        let next:Json;try{next=await api('/sessions/'+id,undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));}catch(e:any){if(e.data?.code!=='RUNTIME_SYNC_RESTARTED'||disposed||request.signal.aborted||paused)throw e;next=await api('/sessions/'+id,undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));}if(disposed||request.signal.aborted||paused)return;accept(next);setReadError('');connect();}
      catch(e:any){if(!disposed&&!request.signal.aborted&&!paused)setReadError(e.message);}
      finally{inflight=false;if(!disposed){setReading(false);if(checkOpen)setOpening(false);if(pendingOpen){pendingOpen=false;void load(true);}}}
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
    refresh.current=()=>{paused=false;setReadError('');void load(true);};
    recheck.current=()=>{paused=false;if(!source&&!inflight)connect();void checkStatus();};
    pause.current=()=>{paused=true;disconnect();controller?.abort();statusController?.abort();historyController?.abort();if(timer)clearTimeout(timer);timer=undefined;};
    const wake=()=>{if(document.visibilityState==='visible'&&!paused)recheck.current();};
    const watchdog=setInterval(()=>{if(!disposed&&!paused&&document.visibilityState==='visible'&&Date.now()-lastEvent>45_000){connect();void checkStatus();}},5000);
    const poll=setInterval(()=>{if(document.visibilityState==='visible'&&baseline?.syncCursor)void checkStatus();},30_000);
    window.addEventListener('online',wake);window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);document.addEventListener('visibilitychange',wake);
    let entering:Promise<void>|undefined;const enter=()=>entering??(entering=cancelReleaseOnReturn(id,()=>!disposed).then(()=>{if(!disposed){entryReady=true;void load(true);}}).catch(e=>{if(!disposed)setError(e.message);}).finally(()=>{entering=undefined;}));
    const normalRefresh=refresh.current;refresh.current=()=>{if(!entryReady){void enter();return;}normalRefresh();};
    void enter();
    return()=>{disposed=true;mounted.current=false;controller?.abort();statusController?.abort();historyController?.abort();disconnect();if(timer)clearTimeout(timer);clearInterval(watchdog);clearInterval(poll);window.removeEventListener('online',wake);window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);document.removeEventListener('visibilitychange',wake);};
  },[id,onChanged]);
  useLayoutEffect(()=>{const anchor=prepend.current;if(anchor&&scroll.current){scroll.current.scrollTop=anchor.top+scroll.current.scrollHeight-anchor.height;prepend.current=null;}},[snapshot]);
  useEffect(()=>{if(!scroll.current||!snapshot)return;if(!restored.current){scroll.current.scrollTop=saved.current?.top??scroll.current.scrollHeight;restored.current=true;}else if(follow.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[snapshot,outgoing]);
  useEffect(()=>{const timeline=scroll.current,content=timeline?.firstElementChild;if(!timeline||!content)return;const observer=new ResizeObserver(()=>{if(restored.current&&follow.current)timeline.scrollTop=timeline.scrollHeight;});observer.observe(content);observer.observe(timeline);return()=>observer.disconnect();},[]);
  const action=async(path:string,payload:Json)=>{if(submitting.current)return;submitting.current=true;setBusy(true);setAborting(path==='/abort');setError('');if(path==='/release')pause.current();
    try{const result=await api('/sessions/'+id+path,payload);
      if(mounted.current){if(path==='/release'&&result.handoffReady){onReleased(result);return result;}if(path==='/release')setError(result.warning??'订阅已取消，仍在等待释放占用。');recheck.current();}return result;
    }catch(e:any){if(mounted.current){setError(e.message);recheck.current();}}
    finally{submitting.current=false;if(mounted.current){setBusy(false);setAborting(false);}}};
  const phase=snapshot?.phase??'UNKNOWN',active=!!snapshot?.activeTurnId||['RUNNING','WAITING_APPROVAL','WAITING_INPUT'].includes(phase),canSteer=phase==='RUNNING'&&!!snapshot?.activeTurnId&&!snapshot?.pending?.length,canSend=!opening&&!openError&&!readError&&(!reading||canSteer)&&!uncertain&&!outgoing.some(m=>m.status==='sending')&&!snapshot?.release?.inProgress&&(['IDLE','RELEASED'].includes(phase)||canSteer),filesReady=attachments.every(a=>a.status==='ready'),items=(snapshot?.thread?.turns??[]).flatMap((turn:Json)=>turn.items??[]);
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
  const editOutgoing=(message:Outgoing)=>{if(draft||attachments.length)return;setCollapsed(false);setDraft(message.text);setSettings(message.settings);setAttachments(message.attachments);intent.current=null;updateOutgoing(messages=>messages.filter(m=>m.id!==message.id));saveDraft(message.text,message.settings,message.attachments,false);};
  const title=snapshot?(snapshot.thread.name||snapshot.metadata?.web_title||snapshot.thread.preview||'未命名会话'):readError?'会话暂不可用':'读取会话…';
  const projectPath=snapshot?.project?.path??snapshot?.thread?.cwd??'',projectName=snapshot?.project?.name||projectPath.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'未关联项目';
  const taskStatus=snapshot?.thread?.status?.type==='notLoaded'&&['IDLE','RELEASED'].includes(phase)?'历史浏览':phases[phase];
  const status=readError?'同步失败':!connected?'重连中':opening?'核对中':openError?'待核实':taskStatus,statusDetail=`${connected?'已连接':'正在重连'} · ${taskStatus}${reading?' · 刷新中':''}${busy?aborting?' · 正在中止':' · 操作中':''}`;
  const notices=[uncertain?'提交结果待核实，请先检查历史。':'',error,opening?'正在核对会话占用…':openError|| (phase==='EXTERNAL'?'已在另一个应用中打开，请先关闭该会话。':''),readError,!connected?'正在恢复连接，消息不会自动重发。':'',snapshot?.release?.requested?snapshot.release.error??'等待释放占用':'',snapshot?.retry?`Codex 正在重试：${snapshot.retry.message}`:'',attachmentError,optionsError,snapshot?.thread?.status?.type==='notLoaded'&&['IDLE','RELEASED'].includes(phase)?'会话已从运行时卸载，可刷新核对最新占用状态。':''].filter(Boolean);
  const stopButton=active?<button type="button" className="danger" disabled={busy} onClick={()=>void action('/abort',{})}>{aborting?'正在中止…':'中止'}</button>:null;
  const sendButton=<button className="primary" disabled={busy||!canSend||!filesReady||(!draft.trim()&&!attachments.length)}>{busy&&!aborting?'提交中…':canSteer?'插话':'发送'}</button>;
  return <div className={`session-layout ${snapshot?.project&&panes.rightVisible?'with-git':''}`}><div className="session-center"><PaneToolbar>
    <span className="session-project muted" title={[projectName,projectPath].filter(Boolean).join('\n')}>{projectName}</span><h1 className="session-title" title={title}>{title}</h1>
    <button type="button" ref={menuButton} className="session-actions-trigger" aria-label="操作" aria-expanded={menuOpen} aria-controls={menuId} aria-haspopup="true" aria-busy={reading||busy} popoverTarget={menuId} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();if(menu.current){menu.current.style.top=`${rect.bottom+4}px`;menu.current.style.left=`${Math.max(8,Math.min(rect.right-128,window.innerWidth-136))}px`;}}}>{reading?'刷新中':busy?aborting?'中止中':'操作中':'操作'}<span aria-hidden="true"> ▾</span></button>
    <div id={menuId} ref={menu} popover="auto" className="session-actions-menu" onToggle={event=>setMenuOpen(event.newState==='open')}>
      <button type="button" autoFocus aria-label="刷新当前会话" aria-busy={reading} onClick={()=>{closeMenu();refresh.current();}}>刷新</button>
      <button type="button" disabled={busy||!snapshot} onClick={()=>{closeMenu();void action('/release',{});}}>释放</button>
    </div>
    <span role="status" className={`connection ${connected&&!readError?'online':''}`} title={statusDetail} aria-label={`${status} · ${statusDetail}`}>{status}</span>
  </PaneToolbar><main className="session-main" inert={panes.mobile&&panes.drawer!==null}>
    <div className="timeline" ref={scroll} onScroll={()=>{const el=scroll.current!;if(layoutScroll.current!==null){const expected=layoutScroll.current;layoutScroll.current=null;if(Math.abs(el.scrollTop-expected)<1){saveDraft();return;}}follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;saveDraft();}}>
      <div className="timeline-content">{snapshot?.history?.nextCursor?<div className="history-loader"><button type="button" disabled={historyLoading||reading} onClick={()=>earlier.current()}>{historyLoading?'正在加载更早消息…':'加载更早消息'}</button>{historyError?<p role="alert" className="notice error">{historyError}</p>:null}</div>:null}{snapshot?.warning?<div className="notice">{snapshot.warning}</div>:null}{snapshot?.error?<div role="alert" className="notice error">{snapshot.error.message??JSON.stringify(snapshot.error)}</div>:null}
      {snapshot?.unmaterialized?<p className="notice">发送首条消息后保存原生历史。</p>:null}
      {(snapshot?.thread?.turns??[]).filter((t:Json)=>t.error||t.status==='failed').map((t:Json)=><div className="notice error" role="alert" key={t.id}>{t.error?.message??(t.error?JSON.stringify(t.error):'本轮执行失败')}</div>)}
      {!items.length&&!outgoing.length?<p className="empty muted">{snapshot?'输入第一条任务。':'正在读取原生历史…'}</p>:(snapshot?.thread?.turns??[]).map((turn:Json)=><TurnMessages key={turn.id} turn={turn} threadId={id} attachments={snapshot?.attachmentPreviews} projectRoot={snapshot?.project?.path} onOpenFile={openDocument} phase={turn.id===snapshot?.activeTurnId?phase:undefined}/>)}
      {reconcileMessages(outgoing,items).map(message=><div key={message.id} className="outgoing-message" data-client-id={message.id}><Message threadId={id} item={{type:'userMessage',content:[{type:'text',text:message.text},...message.attachments.map(file=>({type:'text',text:'📎 '+file.name}))]}}/><div className="outgoing-status small" role="status">{{sending:'发送中…',accepted:'已发送，等待历史同步',failed:'发送失败',unknown:'提交结果待核实，请先刷新历史'}[message.status]}{message.error?<span>：{message.error}</span>:null}{message.status==='failed'?<button type="button" disabled={!!draft||!!attachments.length} title={draft||attachments.length?'先处理输入框中的草稿，避免覆盖':'恢复原文和附件到输入框'} onClick={()=>editOutgoing(message)}>重新编辑</button>:null}{message.status==='unknown'?<button type="button" onClick={()=>updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:'failed'}:m))}>已核对历史，允许重新编辑</button>:null}</div></div>)}
      {(snapshot?.pending??[]).map((pending:Json)=><Pending key={pending.requestId} pending={pending} items={items} busy={busy} respond={async answer=>{await action('/requests/'+encodeURIComponent(pending.requestId)+'/respond',{answer});}}/>)}
      </div>
    </div>
    <form className={'composer'+(collapsed?' is-collapsed':'')} onSubmit={e=>{e.preventDefault();void sendMessage();}}>
      {collapsed&&notices.length?<div className={'composer-notice notice'+(uncertain||error||readError||openError||attachmentError||optionsError?' error':'')} role="status"><span>{notices[0]}{notices.length>1?`（另有 ${notices.length-1} 条提示）`:''}</span><button type="button" onClick={()=>setCollapsed(false)}>查看详情</button></div>:null}
      <div id={composerId} hidden={collapsed}>
      {error||readError?<div role="alert" className="notice error">{[error,readError].filter(Boolean).join('\n')}</div>:null}
      {!connected?<div role="status" className="notice">正在恢复连接，消息不会自动重发。</div>:null}{snapshot?.retry?<div role="status" className="notice">Codex 正在重试：{snapshot.retry.message}</div>:null}
      {snapshot?.thread?.status?.type==='notLoaded'&&['IDLE','RELEASED'].includes(phase)?<div role="status" className="notice">会话已从运行时卸载，可刷新核对最新占用状态。</div>:null}
      {opening?<p role="status" className="muted">正在核对会话占用…</p>:openError?<div role="alert" className="notice error">{openError}<button type="button" onClick={()=>refresh.current()}>重试</button></div>:phase==='EXTERNAL'?<div role="status" className="notice session-locked"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V4a3 3 0 0 1 6 0v3"/></svg><span><strong>已在另一个应用中打开</strong><br/>请先在那里关闭会话，才能在这里继续。</span><button type="button" onClick={()=>refresh.current()}>重试</button></div>:null}
      {snapshot?.release?.requested?<div role="status" className="notice">{snapshot.release.error??'等待释放占用'}</div>:null}
      </div>
      <div className="composer-input-row">
      <Attachments items={attachments} onChange={next=>{setAttachments(next);saveDraft(draft,settings,next);}} onError={setAttachmentError} disabled={busy} compact={collapsed}><button type="button" className="quiet composer-collapse" aria-label="收起输入区" title="收起输入区" aria-expanded={!collapsed} aria-controls={composerId+' '+composerId+'-options'} onClick={()=>setCollapsed(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></Attachments>
      <label className="sr-only" htmlFor="message">继续这个会话</label><textarea ref={input} id="message" enterKeyHint={panes.mobile?'enter':'send'} placeholder="继续这个会话…" maxLength={12000} rows={3} value={draft} onChange={e=>{setDraft(e.target.value);saveDraft(e.target.value);}} onKeyDown={e=>{if(!panes.mobile&&e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
      {collapsed?<div className="composer-actions">{stopButton}{sendButton}<button ref={expandButton} type="button" className="quiet composer-expand" aria-label="展开输入" title="展开附件和输入设置" aria-expanded={!collapsed} aria-controls={composerId+' '+composerId+'-options'} onClick={()=>setCollapsed(false)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button></div>:null}
      </div>
      <div id={composerId+'-options'} hidden={collapsed}>
      <TurnOptions value={settings} onChange={next=>{setSettings(next);saveDraft(draft,next);}} onError={setOptionsError} projectId={snapshot?.project?.id} permissions={['RELEASED','EXTERNAL','UNKNOWN'].includes(phase)||snapshot?.thread?.status?.type==='notLoaded'?undefined:snapshot?.permissions} effectiveModel={snapshot?.thread?.model??snapshot?.model??null} effectiveEffort={snapshot?.thread?.reasoningEffort??null} disabled={busy||active} hidden={collapsed}/>
      {uncertain&&!outgoing.some(m=>m.status==='unknown')?<div className="notice">提交结果待核实，请先检查历史。<button type="button" onClick={()=>{setUncertain(false);saveDraft(draft,settings,attachments,false);}}>已核对历史，允许再次提交</button></div>:null}
      <div className="composer-bottom"><span className="muted small">{canSteer?(panes.mobile?'回车换行 · 点击插话 · 沿用本轮模型和权限':'Enter 插话 · 沿用本轮模型和权限'):canSend?(panes.mobile?'回车换行 · 点击发送':'Enter 发送 · Shift+Enter 换行'):active?'任务进行中':'正在核对会话状态'}</span><div className="composer-actions">{!collapsed?<>{stopButton}{sendButton}</>:null}</div></div>
      </div>
      {collapsed&&(attachments.length||snapshot?.pending?.length)?<div className="composer-compact"><span className="muted small">{attachments.length?`${attachments.length} 个附件`:''}{attachments.some(file=>file.status==='uploading')?' · 上传中…':''}{attachments.some(file=>file.status==='failed')?' · 上传失败':''}</span>{snapshot?.pending?.length?<button type="button" className="quiet" onClick={()=>{const card=scroll.current?.querySelector<HTMLElement>('.approval');card?.scrollIntoView({block:'nearest'});card?.querySelector<HTMLElement>('button,input,select')?.focus({preventScroll:true});}}>查看待处理</button>:null}</div>:null}
    </form>
  </main></div>{snapshot?.project?<><PaneSeparator side="right"/><GitPanel key={snapshot.project.id} id={id} projectId={snapshot.project.id} tick={gitTick} visible={panes.rightVisible} openFile={openFile}/></>:null}</div>;
}
