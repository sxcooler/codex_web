import type {MessageKey} from './i18n/messages.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {emptyCatalog,type ProjectCatalog,type Workspace} from './ProjectPicker.tsx';
import {sessionGroups} from './sessionGroups.ts';
import {QuestionContext} from './Questions.tsx';
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {api,setCsrfToken,type Json} from './api.ts';
import {applyChange,mergeSnapshot,prependHistory} from './sessionSync.ts';
import {modelOverloadNotice} from './turnActivity.ts';
import {reconcileMessages,type Outgoing,type Submission} from './submission.ts';
import {drafts} from './drafts.ts';
import {writeSession,markSessionWrite} from './handoff.ts';
import {Attachments,type Attachment} from './Attachments.tsx';
import {TurnOptions,type TurnSettings} from './TurnOptions.tsx';
import {PaneSeparator,PaneToolbar,usePanes} from './PaneLayout.tsx';
import {Message,Pending,TurnMessages} from './Conversation.tsx';
import {GitPanel} from './GitPanel.tsx';
import {readSendShortcut,shouldSubmit} from './preferences.ts';
import {forwardSharedState} from './sharedState.ts';
import type {NotificationTarget} from '../codex/notificationTarget.ts';
const cwdKey=(path='')=>{const normal=path.replaceAll('\\','/').replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'').replace(/\/+$/,'');return /^[a-z]:\//i.test(normal)||normal.startsWith('//')?normal.toLowerCase():normal;};
const phases:Record<string,MessageKey>={IDLE:'session.phase.idle',RUNNING:'session.phase.running',WAITING_APPROVAL:'session.phase.approval',WAITING_INPUT:'session.phase.input',RELEASED:'session.phase.released',EXTERNAL:'session.phase.external',UNKNOWN:'session.phase.unknown'};
export function Session({catalog=emptyCatalog,projects=[],workRoot=null,desktopProjectlessRoot=null,id,onChanged,onReleased,notification,onNotificationHandled}:{catalog?:ProjectCatalog;projects?:Workspace[];workRoot?:string|null;desktopProjectlessRoot?:string|null;id:string;onChanged:()=>Promise<void>;onReleased:(result:Json)=>void;notification?:NotificationTarget&{token:number};onNotificationHandled:(target:NotificationTarget&{token:number})=>void}){
  const {t,text,locale}=useLocale();
  const saved=useRef(drafts.get(id));
  const [outgoing,setOutgoing]=useState<Outgoing[]>(saved.current?.outgoing??[]),outgoingRef=useRef(outgoing);
  const initial=saved.current?.initialSnapshot?.thread?.id===id?saved.current.initialSnapshot:null;
  const [snapshot,setSnapshot]=useState<Json|null>(initial),[error,setError]=useState<UiText>(''),[readError,setReadError]=useState<UiText>(''),[reading,setReading]=useState(false),[connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[draft,setDraft]=useState(saved.current?.text??''),[settings,setSettings]=useState<TurnSettings>(saved.current?.settings??{}),[attachments,setAttachments]=useState<Attachment[]>(saved.current?.attachments??[]),[gitTick,setGitTick]=useState(0),[aborting,setAborting]=useState(false),[uncertain,setUncertain]=useState(saved.current?.uncertain??false);
  const [contextTick,setContextTick]=useState(0);
  const [openFile,setOpenFile]=useState<{path:string;fragment?:string}>();
  const [historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState<UiText>('');
  const [opening,setOpening]=useState(false),[checking,setChecking]=useState(!initial),[openError,setOpenError]=useState<UiText>('');
  const [subagent,setSubagent]=useState(false);
  const [optionsError,setOptionsError]=useState<UiText>(''),[attachmentError,setAttachmentError]=useState<UiText>('');
  const earlier=useRef<(signal?:AbortSignal)=>Promise<boolean>>(async()=>false),prepend=useRef<{top:number;height:number}|null>(null);
  const resume=useRef<()=>void>(()=>{});
  const waitForRead=useRef<(signal:AbortSignal)=>Promise<void>>(async()=>{});
  const snapshotRef=useRef<Json|null>(null),notificationHold=useRef(false);
  const [notificationNotice,setNotificationNotice]=useState<UiText>(''),[reveal,setReveal]=useState<{turnId?:string;itemId?:string;token:number}>();
  const intent=useRef<Submission['current']>(saved.current?.intent??null),submitting=useRef(false),mounted=useRef(true),refresh=useRef<(restartHistory?:boolean)=>void>(()=>{}),recheck=useRef<()=>void>(()=>{}),pause=useRef<()=>void>(()=>{}),scroll=useRef<HTMLDivElement>(null),follow=useRef(saved.current?.follow??true),restored=useRef(false),panes=usePanes();
  const openDocument=useCallback((path:string,fragment?:string)=>{setOpenFile({path,fragment});if(!panes.rightVisible)panes.toggle('right');},[panes.rightVisible,panes.toggle]);
  const collapsed=panes.composerCollapsed,composerId=useId(),menuId=useId(),menu=useRef<HTMLDivElement>(null),menuButton=useRef<HTMLButtonElement>(null),[menuOpen,setMenuOpen]=useState(false),input=useRef<HTMLTextAreaElement>(null),expandButton=useRef<HTMLButtonElement>(null);
  const shortcutLabel=readSendShortcut()==='mod-enter'?'Ctrl/Cmd+Enter':'Enter';
  const composerScroll=useRef<{top:number;following:boolean}|null>(null),layoutScroll=useRef<number|null>(null);
  const setCollapsed=(value:boolean)=>{if(value===collapsed)return;if(scroll.current)composerScroll.current={top:scroll.current.scrollTop,following:follow.current};panes.setComposerCollapsed(value);};
  useLayoutEffect(()=>{const anchor=composerScroll.current;composerScroll.current=null;if(!anchor)return;const timeline=scroll.current;if(timeline){timeline.scrollTop=anchor.following?timeline.scrollHeight:anchor.top;layoutScroll.current=timeline.scrollTop;follow.current=anchor.following;}if(collapsed)expandButton.current?.focus({preventScroll:true});else if(!panes.mobile)input.current?.focus({preventScroll:true});},[collapsed]);
  useEffect(()=>{menu.current?.hidePopover();},[id,panes.drawer]);
  const closeMenu=()=>{menu.current?.hidePopover();menuButton.current?.focus({preventScroll:true});};
  const saveDraft=(text=draft,options=settings,files=attachments,unknown=uncertain)=>{drafts.set(id,{...drafts.get(id),text,settings:options,attachments:files,outgoing:outgoingRef.current,uncertain:unknown,intent:intent.current,top:scroll.current?.scrollTop??saved.current?.top,follow:follow.current});};
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
    mounted.current=true;let disposed=false,entryReady=true,inflight=false,paused=false,foregroundCheck=false,lastEvent=Date.now(),lastPhase='',baseline:Json|null=initial,source:EventSource|undefined,controller:AbortController|undefined,statusController:AbortController|undefined,historyController:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const readWaiters=new Set<()=>void>(),readIdle=()=>{if(!inflight&&!historyController)for(const finish of [...readWaiters])finish();};
    waitForRead.current=signal=>{signal.throwIfAborted();if(!inflight&&!historyController)return Promise.resolve();return new Promise((resolve,reject)=>{const cleanup=()=>{readWaiters.delete(finish);signal.removeEventListener('abort',abort);},finish=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason);};readWaiters.add(finish);signal.addEventListener('abort',abort,{once:true});});};
    let startupStopped=false;
    const accept=(next:Json)=>{if(baseline&&cwdKey(next.thread?.cwd)!==cwdKey(baseline.thread?.cwd)){setOpenFile(undefined);setContextTick(n=>n+1);setGitTick(n=>n+1);}let listChanged=!!baseline&&next.thread.name!==baseline.thread.name;baseline=next;if(!next.historyPending){startupStopped=false;const cached=drafts.get(id);if(cached?.initialSnapshot)drafts.set(id,{...cached,initialSnapshot:undefined});}snapshotRef.current=next;setSnapshot(next);updateOutgoing(messages=>reconcileMessages(messages,(next.thread?.turns??[]).flatMap((turn:Json)=>turn.items??[])),false);if(next.phase!==lastPhase&&['IDLE','RELEASED'].includes(next.phase)){setGitTick(n=>n+1);if(lastPhase)listChanged=true;}if(listChanged)void onChanged();lastPhase=next.phase;};
    let detachShared:(()=>void)|undefined;
    const disconnect=()=>{detachShared?.();detachShared=undefined;source?.close();source=undefined;};
    const schedule=(epoch?:string)=>{if(baseline?.historyPending&&inflight&&(!epoch||epoch===baseline.epoch))return;if(epoch&&epoch!==baseline?.epoch)controller?.abort();disconnect();if(!disposed&&!paused&&!startupStopped&&!timer)timer=setTimeout(()=>{timer=undefined;void load();},200);};
    const connect=()=>{
      disconnect();if(disposed||paused||!entryReady||!baseline)return;
      setConnected(false);lastEvent=Date.now();const stream=new EventSource('/api/sessions/'+id+'/events'+(baseline.syncCursor?'?cursor='+encodeURIComponent(baseline.syncCursor):''));source=stream;
      detachShared=forwardSharedState(stream);
      const alive=()=>!disposed&&!paused&&source===stream;
      for(const event of ['ready','ping'])stream.addEventListener(event,()=>{if(alive()){lastEvent=Date.now();setConnected(true);}});
      stream.addEventListener('resync',event=>{if(alive()){lastEvent=Date.now();let epoch:string|undefined;try{epoch=JSON.parse((event as MessageEvent).data).id?.split(':')[0];}catch{}schedule(epoch);}});
      stream.addEventListener('change',event=>{if(!alive())return;lastEvent=Date.now();try{const change=JSON.parse((event as MessageEvent).data);if(inflight)readChanges.push(change);const next=applyChange(baseline!,change);if(!next){schedule(change.id?.split(':')[0]);return;}setConnected(true);if(!startupStopped)setReadError('');if(next!==baseline){const changedCwd=cwdKey(next.thread?.cwd)!==cwdKey(baseline?.thread?.cwd);accept(changedCwd?{...next,project:null}:next);if(changedCwd)schedule();}}catch{schedule();}});
      stream.onerror=()=>{if(!alive())return;setConnected(false);void api('/auth/session').then(state=>{if(!alive())return;setCsrfToken(state.csrfToken);if(!state.authenticated)window.dispatchEvent(new Event('auth-lost'));}).catch(()=>{});};
    };
    let readChanges:Json[]=[];
    let pendingOpen=false,historyQueued=false,openFailures=0,openRetry:ReturnType<typeof setTimeout>|undefined;
    const cancelOpenRetry=()=>{if(openRetry)clearTimeout(openRetry);openRetry=undefined;};
    const load=async(checkOpen=false,restartHistory=false)=>{
      if(disposed||paused||!entryReady)return;
      if(historyController)try{await waitForRead.current(AbortSignal.timeout(30_000));}catch(e:any){if(!disposed){setReadError(e);setChecking(false);}return;}
      if(disposed||paused)return;if(inflight){if(checkOpen)pendingOpen=true;return;}inflight=true;readChanges=[];if(!baseline?.historyPending)disconnect();statusController?.abort();setHistoryError('');controller=new AbortController();const request=controller;setReading(true);
      let retryOpen=false;
      try{
        if(checkOpen){
          cancelOpenRetry();setOpening(true);
          const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]);
          try{const opened=await writeSession(id,()=>api('/sessions/'+id+'/open',{},signal));if(baseline?.historyPending&&opened.epoch!==baseline.epoch){baseline=null;setSnapshot(null);disconnect();}if(baseline&&!source)connect();if(!disposed&&!request.signal.aborted){openFailures=0;setOpenError('');setOpening(false);}}
          catch(e:any){
            if(e.data?.code==='RUNTIME_SUBAGENT_THREAD')throw e;
            if(!disposed&&!request.signal.aborted){
              retryOpen=++openFailures<3&&(!e.status||e.status>=500||e.data?.code==='RUNTIME_THREAD_BUSY');
              const detail=signal.reason?.name==='TimeoutError'?msg('session.open.timeout'):e;
              setOpenError(msg('session.open.failed',retryOpen,detail));
            }
          }
        }
        if(disposed||request.signal.aborted||paused)return;
        const snapshotUrl='/sessions/'+id+(restartHistory?'?restartHistory=true':'');let next:Json;try{next=await api(snapshotUrl,undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));}catch(e:any){if(e.data?.code!=='RUNTIME_SYNC_RESTARTED'||disposed||request.signal.aborted||paused)throw e;next=await api('/sessions/'+id,undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));}if(disposed||request.signal.aborted||paused)return;for(const change of readChanges){if(change.id?.split(':')[0]===next.epoch)next=applyChange(next,change)??(baseline?.epoch===next.epoch?baseline!:next);}next=mergeSnapshot(baseline,next);accept(next);setReadError(next.historyPending&&!['EXTERNAL','UNKNOWN'].includes(next.phase)?msg('session.history.startedPending'):'');connect();}
      catch(e:any){if(!disposed&&!request.signal.aborted&&!paused){if(baseline?.historyPending&&e.data?.code==='RUNTIME_HISTORY_NOT_MATERIALIZED')startupStopped=true;setReadError(e);if(e.data?.code==='RUNTIME_SUBAGENT_THREAD'){paused=true;setSubagent(true);}}if(baseline&&!source)connect();}
      finally{inflight=false;foregroundCheck=false;if(!disposed){setChecking(false);setReading(false);if(checkOpen)setOpening(false);if(pendingOpen){pendingOpen=false;void load(true);}else if(retryOpen&&!paused&&!request.signal.aborted)openRetry=setTimeout(()=>{openRetry=undefined;void load(true);},3000);}readIdle();}
    };
    earlier.current=async(signal)=>{
      signal?.throwIfAborted();
      if(!baseline?.history?.nextCursor||historyQueued||disposed||paused)return false;
      historyQueued=true;setHistoryLoading(true);setHistoryError('');follow.current=false;
      const request=new AbortController(),readSignal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000),...(signal?[signal]:[])]);
      try{
        await waitForRead.current(readSignal);readSignal.throwIfAborted();if(disposed||paused)return false;
        const cursor=baseline?.history?.nextCursor;if(!cursor)return false;historyController=request;
        const page=await api('/sessions/'+id+'/history?before='+encodeURIComponent(cursor),undefined,readSignal);
        if(disposed||paused||request.signal.aborted||signal?.aborted||historyController!==request||!baseline)return false;
        const next=prependHistory(baseline,page,cursor);if(next===baseline)return false;
        if(scroll.current)prepend.current={top:scroll.current.scrollTop,height:scroll.current.scrollHeight};accept(next);
        return true;
      }catch(e:any){if(!disposed&&!request.signal.aborted&&!signal?.aborted)setHistoryError(e);throw e;}
      finally{if(historyController===request)historyController=undefined;historyQueued=false;if(!disposed)setHistoryLoading(false);readIdle();}
    };
    const checkStatus=async(verify=false)=>{
      if(verify&&!disposed&&!paused&&!startupStopped){foregroundCheck=true;setChecking(true);}
      if(disposed||paused||startupStopped||!entryReady||inflight||statusController)return;
      if(!baseline?.syncCursor){void load();return;}
      const request=new AbortController();statusController=request;
      try{const status=await api('/sessions/'+id+'/status?epoch='+encodeURIComponent(baseline.epoch),undefined,AbortSignal.any([request.signal,AbortSignal.timeout(30_000)]));if(disposed||paused||request.signal.aborted)return;const versioned=typeof status.epoch==='string'&&Number.isSafeInteger(status.revision);if(status.resync||versioned&&(status.epoch!==baseline?.epoch||status.revision!==baseline?.revision)||foregroundCheck&&!versioned)await load();else setReadError('');}
      catch(e:any){if(!disposed&&!paused&&!request.signal.aborted)setReadError(e);}
      finally{if(statusController===request)statusController=undefined;if(!inflight){foregroundCheck=false;if(!disposed)setChecking(false);}}
    };
    refresh.current=(restartHistory=false)=>{paused=false;if(restartHistory)startupStopped=false;cancelOpenRetry();setChecking(true);setReadError('');void load(false,restartHistory);};
    resume.current=()=>{paused=false;startupStopped=false;openFailures=0;cancelOpenRetry();void load(true);};
    recheck.current=()=>{paused=false;if(!source&&!inflight)connect();void checkStatus();};
    pause.current=()=>{paused=true;cancelOpenRetry();disconnect();controller?.abort();statusController?.abort();historyController?.abort();if(timer)clearTimeout(timer);timer=undefined;};
    const wake=()=>{if(document.visibilityState==='visible'&&!paused){if(!source&&!inflight)connect();void checkStatus(true);}};
    const watchdog=setInterval(()=>{if(!disposed&&!paused&&document.visibilityState==='visible'&&Date.now()-lastEvent>45_000){connect();void checkStatus();}},5000);
    const poll=setInterval(()=>{if(document.visibilityState==='visible'&&baseline?.syncCursor)void checkStatus();},30_000);
    window.addEventListener('online',wake);window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);document.addEventListener('visibilitychange',wake);
    if(initial?.historyPending)connect();void load();
    return()=>{disposed=true;mounted.current=false;cancelOpenRetry();controller?.abort();statusController?.abort();historyController?.abort();for(const finish of [...readWaiters])finish();disconnect();if(timer)clearTimeout(timer);clearInterval(watchdog);clearInterval(poll);window.removeEventListener('online',wake);window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);document.removeEventListener('visibilitychange',wake);};
  },[id,onChanged]);
  useLayoutEffect(()=>{const anchor=prepend.current;if(anchor&&scroll.current){scroll.current.scrollTop=anchor.top+scroll.current.scrollHeight-anchor.height;prepend.current=null;}},[snapshot]);
  useEffect(()=>{if(!scroll.current||!snapshot)return;if(!restored.current){const locating=!!(notification?.turnId||notification?.itemId||notification?.requestId);if(locating)follow.current=false;scroll.current.scrollTop=saved.current?.top??(locating?0:scroll.current.scrollHeight);restored.current=true;}else if(follow.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[snapshot,outgoing,notification]);
  useEffect(()=>{const timeline=scroll.current,content=timeline?.firstElementChild;if(!timeline||!content)return;const observer=new ResizeObserver(()=>{if(restored.current&&follow.current)timeline.scrollTop=timeline.scrollHeight;});observer.observe(content);observer.observe(timeline);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!snapshot||!notification)return;
    if(!notification.turnId&&!notification.itemId&&!notification.requestId){onNotificationHandled(notification);return;}
    let disposed=false,highlight:HTMLElement|undefined,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    notificationHold.current=true;follow.current=false;setNotificationNotice(msg('session.notification.locating'));
    const resolve=():{turnId?:string;itemId?:string;requestId?:string;failed?:boolean}|null=>{
      const current=snapshotRef.current;if(!current)return null;
      if(notification.requestId&&current.pending?.some((p:Json)=>p.requestId===notification.requestId))return {requestId:notification.requestId};
      const turns=(current.thread?.turns??[]).filter((turn:Json)=>!notification.turnId||turn.id===notification.turnId);
      for(const turn of turns){
        if(notification.kind==='failed')return {turnId:turn.id,failed:true};
        if(notification.itemId){if(turn.items?.some((item:Json)=>item.id===notification.itemId))return {turnId:turn.id,itemId:notification.itemId};continue;}
        if(notification.requestId)continue;
        const messages=(turn.items??[]).filter((item:Json)=>item.type==='agentMessage'&&item.delivery!=='async');
        const item=messages.filter((item:Json)=>item.phase==='final_answer').at(-1)??messages.at(-1);
        return {turnId:turn.id,...(item?{itemId:item.id}:{})};
      }return null;
    };
    void (async()=>{
      try{
        const waitSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]);
        let position=resolve();for(let page=0;!position&&page<5&&!disposed;page++){await waitForRead.current(waitSignal);if(disposed)return;position=resolve();if(position)break;if(!await earlier.current(controller.signal))break;if(disposed)return;position=resolve();}
        if(disposed)return;if(!position){setNotificationNotice(msg('session.notification.notFound'));return;}
        setReveal({turnId:position.turnId,itemId:position.itemId,token:notification.token});
        for(let attempt=0;attempt<10&&!disposed;attempt++){
          await new Promise(resolve=>setTimeout(resolve,30));if(disposed)return;
          const timeline=scroll.current;if(!timeline)return;
          const attribute=position.requestId?'data-request-id':position.itemId?'data-item-id':'data-turn-id',value=position.requestId??position.itemId??position.turnId;
          const elements=[...timeline.querySelectorAll<HTMLElement>('['+attribute+']')];
          const target=elements.find(el=>el.getAttribute(attribute)===value&&(!position.failed||el.matches('.notice.error')));
          if(!target||!target.getClientRects().length)continue;
          highlight=target;target.classList.add('notification-target');target.scrollIntoView({block:'center'});target.focus({preventScroll:true});layoutScroll.current=timeline.scrollTop;follow.current=false;
          setNotificationNotice('');timer=setTimeout(()=>{target.classList.remove('notification-target');notificationHold.current=false;},3000);return;
        }
        if(!disposed)setNotificationNotice(msg('session.notification.notFound'));
      }catch(e:any){if(!disposed)setNotificationNotice(msg('session.notification.failed',e));}
      finally{if(!disposed){if(!timer)notificationHold.current=false;onNotificationHandled(notification);}}
    })();
    return()=>{disposed=true;controller.abort();clearTimeout(timer);highlight?.classList.remove('notification-target');notificationHold.current=false;};
  },[id,notification,!!snapshot,onNotificationHandled]);
  const action=async(path:string,payload:Json)=>{if(submitting.current||checking||opening||readError||(reading&&path!=='/abort'))return;if(path==='/abort')markSessionWrite(id);submitting.current=true;setBusy(true);setAborting(path==='/abort');setError('');if(path==='/release')pause.current();
    try{const result=await (path==='/release'||path==='/abort'?api('/sessions/'+id+path,payload,AbortSignal.timeout(30_000)):writeSession(id,()=>api('/sessions/'+id+path,payload,AbortSignal.timeout(30_000))));
      if(mounted.current){if(path==='/release'&&result.handoffReady){onReleased(result);return result;}recheck.current();}return result;
    }catch(e:any){if(mounted.current){setError(e);recheck.current();}}
    finally{submitting.current=false;if(mounted.current){setBusy(false);setAborting(false);}}};
  const phase=snapshot?.phase??'UNKNOWN',active=!!snapshot?.activeTurnId||['RUNNING','WAITING_APPROVAL','WAITING_INPUT'].includes(phase),canSteer=phase==='RUNNING'&&!!snapshot?.activeTurnId&&!snapshot?.pending?.length,canSend=!checking&&!opening&&!openError&&!readError&&(!reading||canSteer)&&!uncertain&&!outgoing.some(m=>m.status==='sending')&&!snapshot?.release?.inProgress&&(['IDLE','RELEASED'].includes(phase)||canSteer),filesReady=attachments.every(a=>a.status==='ready'),items=(snapshot?.thread?.turns??[]).flatMap((turn:Json)=>turn.items??[]);
  const sendMessage=async()=>{
    if(submitting.current||!canSend||!filesReady||(!draft.trim()&&!attachments.length))return;
    const message:Outgoing={id:crypto.randomUUID(),text:draft,settings:{...settings},attachments:[...attachments],...(canSteer?{expectedTurnId:snapshot!.activeTurnId}:{}),status:'sending'};
    submitting.current=true;setBusy(true);setError('');follow.current=true;intent.current=null;
    updateOutgoing(messages=>[...messages,message],false);setDraft('');setAttachments([]);if(!canSteer)setSettings({});saveDraft('',canSteer?settings:{},[],false);
    try{
      await writeSession(id,()=>api('/sessions/'+id+'/messages',{text:message.text,clientRequestId:message.id,attachmentIds:message.attachments.map(a=>a.uploadId),...(message.expectedTurnId?{expectedTurnId:message.expectedTurnId}:message.settings)},AbortSignal.timeout(45_000)));
      updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:'accepted'}:m));
    }catch(e:any){updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:!e.status||e.status>=500?'unknown':'failed',error:e}:m));}
    finally{submitting.current=false;if(mounted.current){setBusy(false);if(message.attachments.length)refresh.current();else recheck.current();}}
  };
  const editOutgoing=(message:Outgoing)=>{if(draft||attachments.length)return;setCollapsed(false);setDraft(message.text);setSettings(message.settings);setAttachments(message.attachments);intent.current=null;updateOutgoing(messages=>messages.filter(m=>m.id!==message.id));saveDraft(message.text,message.settings,message.attachments,false);};
  const title=subagent?t('session.title.subagent'):snapshot?(snapshot.thread.name||snapshot.metadata?.web_title||snapshot.thread.preview||t('session.title.unnamed')):readError?t('session.title.unavailable'):t('session.title.loading');
  useEffect(()=>{
    document.title=String(title).replace(/\s+/g,' ').trim()+' - Codex Web';
    return()=>{document.title='Codex Web';};
  },[title]);
  const projectPath=snapshot?.thread?.cwd??'',group=snapshot?sessionGroups([{...snapshot.thread,metadata:snapshot.metadata}],projects,workRoot,desktopProjectlessRoot,catalog)[0]:undefined,projectName=snapshot?group?.key===''?t('session.noProject'):group?.name??t('session.project.unconfirmed'):t('session.project.loading');
  const taskStatus=snapshot?.historyPending&&!['EXTERNAL','UNKNOWN'].includes(phase)?t('session.status.startedSyncing'):phase==='RELEASED'&&snapshot?.release?.handoffReady!==true?t('session.status.releasing'):snapshot?.thread?.status?.type==='notLoaded'&&['IDLE','RELEASED'].includes(phase)?t('session.status.history'):(phases[phase]?t(phases[phase]):phase);
  const releaseError=!readError&&!checking&&!opening&&snapshot?.release?.requested&&!snapshot.release.handoffReady?snapshot.release.error??'':'';
  const ownershipNotice=snapshot&&phase==='UNKNOWN'&&!checking&&!opening&&!reading&&!readError&&!openError?t('session.status.ownership'):'';
  const status=checking||opening?t('session.status.checking'):readError?t('session.status.syncFailed'):openError?t('session.phase.unknown'):taskStatus,statusDetail=`${connected?t('session.status.connected'):t('session.status.reconnecting')} · ${taskStatus}${reading?' · '+t('session.status.refreshing'):''}${busy?' · '+(aborting?t('session.status.aborting'):t('session.status.operating')):''}`;
  const emptyText=readError?t('session.empty.syncFailed'):openError?t('session.empty.openUnknown'):!snapshot?t('session.empty.loading'):opening||reading?t('session.empty.syncing'):!connected?t('session.empty.reconnecting'):phase==='WAITING_APPROVAL'?t('session.empty.approval'):phase==='WAITING_INPUT'?t('session.empty.input'):active?t('session.empty.active'):phase==='EXTERNAL'?t('session.empty.external'):phase==='UNKNOWN'?t('session.empty.unknown'):t('session.empty.none');
  const emptyLoading=!readError&&!openError&&(!snapshot||opening||reading||!connected||phase==='RUNNING');
  const notices=[uncertain?t('session.submit.unknown'):'',error,openError||(opening?t('session.ownership.checking'):phase==='EXTERNAL'?t('session.ownership.externalNotice'):ownershipNotice),readError,!connected&&!checking?t('session.connection.recovering'):'',releaseError,snapshot?.retry?t('session.retrying',snapshot.retry.message):'',attachmentError,optionsError].filter(Boolean).map(value=>text(value));
  const attachmentStatus=[attachments.some(file=>file.status==='uploading')?t('session.attachment.uploading'):'',attachments.some(file=>file.status==='failed')?t('session.attachment.failed'):''].filter(Boolean).join(' · ');
  const stopButton=active?<button type="button" className="danger" disabled={busy||checking||opening||!!readError} onClick={()=>void action('/abort',{})}>{aborting?t('session.abort.pending'):t('session.abort.label')}</button>:null;
  const sendButton=<button className="primary" disabled={busy||!canSend||!filesReady||(!draft.trim()&&!attachments.length)}>{busy&&!aborting?t('session.submit.pending'):canSteer?t('session.submit.steer'):t('session.submit.send')}</button>;
  if(subagent)return <main className="settings"><PaneToolbar/><h1>{title}</h1><p>{t('session.subagent.help')}</p><a href="/">{t('session.home')}</a></main>;
  return <QuestionContext.Provider value={{canSend:canSend&&!busy,expectedTurnId:canSteer?snapshot.activeTurnId:undefined,states:snapshot?.inputAnswers??{},onSent:()=>refresh.current(),threadId:id,projectRoot:snapshot?.project?.path,onOpenFile:openDocument}}><div className={`session-layout ${snapshot?.project&&panes.rightVisible?'with-git':''}`}><div className="session-center"><PaneToolbar>
    <span className="session-project muted" title={[projectName,projectPath].filter(Boolean).join('\n')}>{t('session.project.label',projectName)}</span><h1 className="session-title" title={title}>{title}</h1>{snapshot?.titlePending?<span className="muted small" role="status">{t('session.title.naming')}</span>:null}
    <button type="button" ref={menuButton} className="session-actions-trigger" aria-label={t('session.actions.label')} aria-expanded={menuOpen} aria-controls={menuId} aria-haspopup="true" aria-busy={reading||busy} popoverTarget={menuId} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect(),width=Math.min(192,window.innerWidth-16);if(menu.current){menu.current.style.top=`${rect.bottom+4}px`;menu.current.style.left=`${Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8))}px`;}}}>{reading?t('session.status.refreshing'):busy?aborting?t('session.actions.aborting'):t('session.status.operating'):t('session.actions.label')}<span aria-hidden="true"> ▾</span></button>
    <div id={menuId} ref={menu} popover="auto" className="session-actions-menu" onToggle={event=>setMenuOpen(event.newState==='open')}>
      <button type="button" autoFocus aria-label={t('session.actions.refresh')} aria-busy={reading} onClick={()=>{closeMenu();refresh.current(true);}}>{t('session.actions.refresh')}</button>
      <button type="button" disabled={busy||checking||opening||reading||!snapshot} onClick={()=>{closeMenu();void action('/release',{});}}>{t('session.actions.release')}</button>
    </div>
    <span role="status" className={`connection ${connected&&!readError?'online':''}`} title={statusDetail} aria-label={`${status} · ${statusDetail}`}>{status}</span>
  </PaneToolbar><main className="session-main" inert={panes.mobile&&panes.drawer!==null}>
    <div className="timeline" ref={scroll} onScroll={()=>{const el=scroll.current!;if(layoutScroll.current!==null){const expected=layoutScroll.current;layoutScroll.current=null;if(Math.abs(el.scrollTop-expected)<1){saveDraft();return;}}follow.current=!notificationHold.current&&el.scrollHeight-el.scrollTop-el.clientHeight<120;saveDraft();}}>
      <div className="timeline-content"><p className="muted small session-directory">{t('session.project.assignment',projectName)}</p><p className="muted small session-directory">{t('session.project.cwd',projectPath)}</p>{notificationNotice?<p role="status" className="notice">{text(notificationNotice)}</p>:null}{snapshot?.history?.nextCursor?<div className="history-loader"><button type="button" disabled={historyLoading} onClick={()=>void earlier.current().catch(()=>{})}>{historyLoading?t('session.history.loading'):t('session.history.more')}</button>{historyError?<p role="alert" className="notice error">{text(historyError)}</p>:null}</div>:null}{snapshot?.historyPending&&readError?<button type="button" className="quiet" onClick={()=>refresh.current(true)}>{t('session.history.resync')}</button>:null}{snapshot?.warning?<div className="notice">{snapshot.warning}</div>:null}{snapshot?.error?<div role="alert" className="notice error" title={snapshot.error.message}>{modelOverloadNotice(snapshot.error,locale)??snapshot.error.message??JSON.stringify(snapshot.error)}</div>:null}
      {(snapshot?.thread?.turns??[]).filter((turn:Json)=>turn.error||turn.status==='failed').map((turn:Json)=><div className="notice error" role="alert" key={turn.id} data-turn-id={turn.id} tabIndex={-1} title={turn.error?.message}>{modelOverloadNotice(turn.error,locale)??turn.error?.message??(turn.error?JSON.stringify(turn.error):t('session.turn.failed'))}</div>)}
      {!items.length&&!outgoing.length?<div className="empty muted session-empty" role="status">{emptyLoading?<progress aria-hidden="true"/>:null}<p>{emptyText}</p>{readError||openError||(!opening&&phase==='UNKNOWN')?<button type="button" className="quiet" onClick={()=>refresh.current(true)}>{t('session.history.resync')}</button>:null}</div>:(snapshot?.thread?.turns??[]).map((turn:Json)=><TurnMessages key={turn.id} turn={turn} threadId={id} attachments={snapshot?.attachmentPreviews} onChanged={onChanged} projectRoot={snapshot?.project?.path} onOpenFile={openDocument} phase={turn.id===snapshot?.activeTurnId?phase:undefined} revealItemId={reveal?.turnId===turn.id?reveal?.itemId:undefined} revealToken={reveal?.turnId===turn.id?reveal?.token:undefined}/>)}
      {reconcileMessages(outgoing,items).map(message=><div key={message.id} className="outgoing-message" data-client-id={message.id}><Message threadId={id} item={{type:'userMessage',content:[{type:'text',text:message.text},...message.attachments.map(file=>({type:'text',text:'📎 '+file.name}))]}}/><div className="outgoing-status small" role="status">{{sending:t('session.outgoing.sending'),accepted:t('session.outgoing.accepted'),failed:t('session.outgoing.failed'),unknown:t('session.outgoing.unknown')}[message.status]}{message.error?<span>{t('session.outgoing.error',text(message.error))}</span>:null}{message.status==='failed'?<button type="button" disabled={!!draft||!!attachments.length} title={draft||attachments.length?t('session.outgoing.draftFirst'):t('session.outgoing.restore')} onClick={()=>editOutgoing(message)}>{t('session.outgoing.edit')}</button>:null}{message.status==='unknown'?<button type="button" onClick={()=>updateOutgoing(messages=>messages.map(m=>m.id===message.id?{...m,status:'failed'}:m))}>{t('session.outgoing.checked')}</button>:null}</div></div>)}
      {(snapshot?.pending??[]).map((pending:Json)=><div key={pending.requestId} data-request-id={pending.requestId} tabIndex={-1}><Pending pending={pending} items={items} busy={busy||checking||opening||reading||!!readError} respond={async answer=>{await action('/requests/'+encodeURIComponent(pending.requestId)+'/respond',{answer});}}/></div>)}
      </div>
    </div>
    <form className={'composer'+(collapsed?' is-collapsed':'')} onSubmit={e=>{e.preventDefault();void sendMessage();}}>
      {collapsed&&notices.length?<div className={'composer-notice notice'+(uncertain||error||readError||openError||attachmentError||optionsError||releaseError?' error':'')} role={releaseError?'alert':'status'}><span>{notices[0]}{notices.length>1?t('session.notices.more',notices.length-1):''}</span><button type="button" onClick={()=>setCollapsed(false)}>{t('session.details.show')}</button></div>:null}
      <div id={composerId} className="composer-notices" hidden={collapsed}>
      {error||readError?<div role="alert" className="notice error">{[error,readError].filter(Boolean).map(value=>text(value)).join('\n')}{readError&&!snapshot?.historyPending?<button type="button" onClick={()=>refresh.current(true)}>{t('session.history.resync')}</button>:null}</div>:null}
      {!connected&&!checking?<div role="status" className="notice">{t('session.connection.recovering')}</div>:null}{snapshot?.retry?<div role="status" className="notice">{t('session.retrying',snapshot.retry.message)}</div>:null}
      {openError?<div role="alert" className="notice error">{text(openError)}<button type="button" disabled={checking||opening||reading} onClick={()=>resume.current()}>{t('session.ownership.resume')}</button></div>:opening?<div role="status" className="notice">{t('session.ownership.checking')}</div>:phase==='EXTERNAL'?<div role="status" className="notice session-locked"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V4a3 3 0 0 1 6 0v3"/></svg><span><strong>{t('session.ownership.external')}</strong><br/>{t('session.ownership.closeElsewhere')}</span><button type="button" disabled={checking||opening||reading} onClick={()=>resume.current()}>{t('session.ownership.resume')}</button></div>:ownershipNotice?<div className="notice" role="status">{ownershipNotice}<button type="button" disabled={checking||opening||reading} onClick={()=>resume.current()}>{t('session.ownership.resume')}</button></div>:null}
      {releaseError?<div role="alert" className="notice error">{releaseError}</div>:null}
      </div>
      <div className="composer-input-row">
      <Attachments items={attachments} onChange={next=>{setAttachments(next);saveDraft(draft,settings,next);}} onError={setAttachmentError} disabled={busy} compact={collapsed}><button type="button" className="quiet composer-collapse" aria-label={t('session.composer.collapse')} title={t('session.composer.collapse')} aria-expanded={!collapsed} aria-controls={composerId+' '+composerId+'-options'} onClick={()=>setCollapsed(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></Attachments>
      <label className="sr-only" htmlFor="message">{t('session.composer.label')}</label><textarea ref={input} id="message" enterKeyHint={panes.mobile?'enter':'send'} placeholder={t('session.composer.placeholder')} maxLength={12000} rows={3} value={draft} onChange={e=>{setDraft(e.target.value);saveDraft(e.target.value);}} onKeyDown={e=>{if(shouldSubmit(e.nativeEvent,{mobile:panes.mobile,shortcut:readSendShortcut()})){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
      {collapsed?<div className="composer-actions">{stopButton}{sendButton}<button ref={expandButton} type="button" className="quiet composer-expand" aria-label={t('session.composer.expand')} title={t('session.composer.expandHint')} aria-expanded={!collapsed} aria-controls={composerId+' '+composerId+'-options'} onClick={()=>setCollapsed(false)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button></div>:null}
      </div>
      <div id={composerId+'-options'} hidden={collapsed}>
      <TurnOptions refreshKey={contextTick} value={settings} onChange={next=>{setSettings(next);saveDraft(draft,next);}} onError={setOptionsError} projectId={snapshot?.project?.id} permissions={['RELEASED','EXTERNAL','UNKNOWN'].includes(phase)||snapshot?.thread?.status?.type==='notLoaded'?undefined:snapshot?.permissions} effectiveModel={snapshot?.model??snapshot?.thread?.model??null} effectiveEffort={snapshot?.reasoningEffort!==undefined?snapshot.reasoningEffort:snapshot?.thread?.reasoningEffort??null} disabled={busy||active} hidden={collapsed}/>
      {uncertain&&!outgoing.some(m=>m.status==='unknown')?<div className="notice">{t('session.submit.unknown')}<button type="button" onClick={()=>{setUncertain(false);saveDraft(draft,settings,attachments,false);}}>{t('session.submit.checked')}</button></div>:null}
      <div className="composer-bottom"><span className="muted small">{openError?t('session.composer.unknown'):opening?t('session.composer.checking'):canSteer&&canSend?(panes.mobile?t('session.composer.mobileSteer'):t('session.composer.steerShortcut',shortcutLabel)):canSend?(panes.mobile?t('session.composer.mobileSend'):t('session.composer.sendShortcut',shortcutLabel)):active?t('session.composer.active'):t('session.composer.checking')}</span><div className="composer-actions">{!collapsed?<>{stopButton}{sendButton}</>:null}</div></div>
      </div>
      {collapsed&&(attachmentStatus||snapshot?.pending?.length)?<div className="composer-compact"><span className="muted small" role="status">{attachmentStatus}</span>{snapshot?.pending?.length?<button type="button" className="quiet" onClick={()=>{const card=scroll.current?.querySelector<HTMLElement>('.approval');card?.scrollIntoView({block:'nearest'});card?.querySelector<HTMLElement>('button,input,select')?.focus({preventScroll:true});}}>{t('session.approval.show')}</button>:null}</div>:null}
    </form>
  </main></div>{snapshot?.project?<><PaneSeparator side="right"/><GitPanel key={snapshot.project.id+':'+cwdKey(snapshot.thread?.cwd)} id={id} projectId={snapshot.project.id} projectRoot={snapshot.project.path} tick={gitTick} visible={panes.rightVisible} openFile={openFile}/></>:null}</div></QuestionContext.Provider>;
}
