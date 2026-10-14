import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {PreviewShell} from './PreviewShell.tsx';
import {ImagePreview,ImageDiff,imagePath} from './ImagePreview.tsx';
import {GitHistory,DiffView} from './GitHistory.tsx';
import {fileUrl,fileImageUrl,linkedFile,linkFragment,previewFilePath} from './fileLinks.ts';
import {MarkdownView} from './MarkdownView.tsx';
import {SourcePreview} from './SourcePreview.tsx';
import {cacheEntry,loadPanelState,openPanelFile,savePanelState,type PanelState,type PanelTab,type StorageLike} from './panelState.ts';

const fileNameOrder=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const lineAnchor=(fragment='')=>/^L([1-9]\d*)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/.exec(fragment);
const markdownPath=(path:string)=>/\.(md|markdown)$/i.test(path);
const browserStorage=():StorageLike=>{try{return localStorage;}catch{return {getItem:()=>null,setItem:()=>{}};}};

export function GitPanel({id,projectId,projectRoot,tick,visible,openFile}:{id:string;projectId:string;projectRoot?:string;tick:number;visible:boolean;openFile?:{path:string;fragment?:string}}){
  const {t,text}=useLocale();
  const [state,setViewState]=useState<PanelState>(()=>loadPanelState(browserStorage(),projectId)),stateRef=useRef(state),saveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const setState=(change:(current:PanelState)=>PanelState)=>setViewState(current=>{if(saveTimer.current){clearTimeout(saveTimer.current);saveTimer.current=undefined;}const next=change(stateRef.current??current);stateRef.current=next;return next;});
  const remember=(change:Partial<PanelState>)=>{stateRef.current={...stateRef.current,...change};if(saveTimer.current)clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>{saveTimer.current=undefined;savePanelState(browserStorage(),projectId,stateRef.current);},50);};
  const rememberSection=(tab:'changes'|'files',change:Partial<PanelState[typeof tab]>)=>remember({[tab]:{...stateRef.current[tab],...change}});
  const rememberHistory=(change:Partial<PanelState['history']>)=>remember({history:{...stateRef.current.history,...change}});
  const [lists,setLists]=useState<Record<string,Json[]>>({}),[contents,setContents]=useState<Record<string,Json>>({}),[failures,setFailures]=useState<Record<string,UiText>>({}),[error,setError]=useState<UiText>(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [anchor,setAnchor]=useState<{path:string;fragment?:string}>();
  const [entryError,setEntryError]=useState<UiText>(''),entryGeneration=useRef(0),entryController=useRef<AbortController|null>(null);
  const cancelEntry=useCallback(()=>{entryGeneration.current++;entryController.current?.abort();entryController.current=null;},[]);
  useEffect(()=>{cancelEntry();setEntryError('');return cancelEntry;},[id,projectId,visible,state.tab,cancelEntry]);
  const openPath=useCallback((target:string,fragment='')=>{
    if(!target)return;
    cancelEntry();setEntryError('');const generation=entryGeneration.current,controller=new AbortController();entryController.current=controller;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]);
    void api('/sessions/'+id+'/files/entry?path='+encodeURIComponent(target),undefined,signal).then(entry=>{
      if(controller.signal.aborted||generation!==entryGeneration.current)return;
      if(typeof entry.path!=='string'||!['file','directory'].includes(entry.type)||entry.type==='file'&&!entry.path)throw Object.assign(new Error('无法识别文件路径类型。'),{i18n:msg('panels.files.invalidEntry')});
      if(entry.type==='directory'){
        setAnchor(undefined);setState(current=>({...current,tab:'files',files:{...current.files,directory:entry.path,path:'',collapsed:false,listScroll:0}}));
      }else{setAnchor({path:entry.path,fragment});setState(current=>openPanelFile(current,entry.path,fragment));}
    }).catch(error=>{if(!controller.signal.aborted&&generation===entryGeneration.current)setEntryError(error);}).finally(()=>{if(entryController.current===controller)entryController.current=null;});
  },[id,cancelEntry]);
  const [fetching,setFetching]=useState(false),[fetchResult,setFetchResult]=useState<Json|null>(null),[historyRevision,setHistoryRevision]=useState(0);
  const [fetchTarget,setFetchTarget]=useState<{tab:PanelTab;repository:string}|null>(null);
  const fetchGeneration=useRef(0),fetchInFlight=useRef(false);
  useEffect(()=>{setFetching(false);setFetchResult(null);fetchInFlight.current=false;return()=>{fetchGeneration.current++;};},[id,projectId]);
  const refresh=async()=>{
    if(fetchInFlight.current)return;
    cancelEntry();setEntryError('');
    const target={tab:stateRef.current.tab,repository:stateRef.current.tab==='history'?stateRef.current.history.repository:''};
    fetchInFlight.current=true;setFetching(true);setFetchTarget(target);setFetchResult(null);setRevision(n=>n+1);
    const generation=fetchGeneration.current;
    try {const result=await api('/sessions/'+id+'/git/fetch',target.tab==='history'?{repository:target.repository}:{},AbortSignal.timeout(70_000));if(generation===fetchGeneration.current)setFetchResult(result);}
    catch {if(generation===fetchGeneration.current)setFetchResult({error:msg('panels.fetch.unconfirmed')});}
    finally {if(generation===fetchGeneration.current){fetchInFlight.current=false;setFetching(false);setHistoryRevision(n=>n+1);}}
  };
  const sectionId=useId(),recentId=useId();
  const listRef=useRef<HTMLDivElement>(null),previewRef=useRef<HTMLDivElement>(null),recentRef=useRef<HTMLDivElement>(null);
  const set=(change:Partial<PanelState>)=>setState(current=>({...current,...change}));
  const updateSection=(tab:'changes'|'files',change:Partial<PanelState[typeof tab]>)=>{cancelEntry();setEntryError('');if(change.path!==undefined)setAnchor(undefined);setState(current=>tab==='files'&&change.path?openPanelFile(current,change.path):({...current,[tab]:{...current[tab],...change}}));};
  const navigateFile=(direction:'back'|'forward')=>{const target=stateRef.current.files[direction].at(-1);if(!target)return;cancelEntry();setEntryError('');setAnchor(target.fragment?{path:target.path,fragment:target.fragment}:undefined);setState(current=>openPanelFile(current,'','',direction));};
  useEffect(()=>{recentRef.current?.hidePopover();},[id,visible,state.tab,state.files.path]);
  const section=state.tab==='changes'?state.changes:state.files;
  const listKey=state.tab==='changes'?'changes:'+state.changes.staged:'files:'+state.files.directory;
  const path=state.tab==='changes'?state.changes.path:state.files.path;
  const contentKey=state.tab==='changes'?'changes:'+state.changes.staged+':'+path:'files:'+path;
  const files=lists[listKey]??[],content=contents[contentKey],failure=failures[contentKey],previewReady=!!content||(state.tab==='files'&&imagePath(path));
  const resolvePreviewUrl=useCallback((url:string)=>fileUrl(id,path,url),[id,path]);
  const resolvePreviewImage=useCallback((url:string)=>fileImageUrl(id,path,url,location.origin,projectRoot),[id,path,projectRoot]);
  const openPreviewLink=useCallback((url:string)=>{const fragment=linkFragment(url);if(url.startsWith('#')&&!lineAnchor(fragment))return false;const next=url.startsWith('#')?path:linkedFile(id,path,url);if(!next)return false;if(url.startsWith('#')){cancelEntry();setEntryError('');setAnchor({path:next,fragment});setState(current=>openPanelFile(current,next,fragment));}else openPath(next,fragment);return true;},[id,path,openPath,cancelEntry]);

  useEffect(()=>{if(openFile)openPath(openFile.path,openFile.fragment);},[openFile]);
  useEffect(()=>savePanelState(browserStorage(),projectId,state),[projectId,state]);
  useEffect(()=>()=>{if(saveTimer.current){clearTimeout(saveTimer.current);savePanelState(browserStorage(),projectId,stateRef.current);}},[projectId]);
  useEffect(()=>{if(!visible||state.tab==='history'){setBusy(false);return;}const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]);setBusy(true);setError('');const route=state.tab==='changes'?'/git/files?staged='+state.changes.staged:'/files?directory='+encodeURIComponent(state.files.directory);void api('/sessions/'+id+route,undefined,signal).then(result=>{if(!controller.signal.aborted){const nextFiles=result.files??[];if(state.tab==='files')nextFiles.sort((a:Json,b:Json)=>Number(b.type==='directory')-Number(a.type==='directory')||fileNameOrder.compare(a.path,b.path));setLists(old=>cacheEntry(old,listKey,nextFiles));if(state.tab==='changes')setState(current=>current.changes.staged===state.changes.staged&&current.changes.path&&!nextFiles.some((file:Json)=>file.path===current.changes.path)?{...current,changes:{...current.changes,path:'',previewScroll:0,contentScroll:0}}:current);}}).catch(e=>{if(!controller.signal.aborted)setError(e);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[id,tick,visible,state.tab,state.changes.staged,state.files.directory,revision,listKey]);
  useEffect(()=>{if(!visible||state.tab==='history'||!path||(state.tab==='files'&&imagePath(path)))return;const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]);setError('');const route=state.tab==='changes'?'/git/diff?staged='+state.changes.staged+'&path='+encodeURIComponent(path):'/files/content?path='+encodeURIComponent(path);void api('/sessions/'+id+route,undefined,signal).then(result=>{if(controller.signal.aborted)return;setContents(old=>cacheEntry(old,contentKey,result));setFailures(old=>{const next={...old};delete next[contentKey];return next;});}).catch(e=>{if(!controller.signal.aborted)setFailures(old=>cacheEntry(old,contentKey,e.status===404?msg('panels.files.unavailable'):e));});return()=>controller.abort();},[id,tick,visible,state.tab,state.changes.staged,path,revision,contentKey]);
  useLayoutEffect(()=>{if(!visible||state.tab==='history')return;const latest=stateRef.current[state.tab];if(listRef.current)listRef.current.scrollTop=latest.listScroll;if(previewRef.current&&previewReady&&!(anchor?.path===path&&anchor.fragment))previewRef.current.scrollTop=latest.contentScroll;},[visible,state.tab,listKey,files,contentKey,content,state.files,section.collapsed]);

  const tab=(next:PanelTab)=>{if(next!==state.tab){cancelEntry();setEntryError('');set({tab:next});}};
  const currentFetch=fetchTarget?.tab===state.tab&&fetchTarget.repository===(state.tab==='history'?state.history.repository:'');
  const fetchLabel=fetchTarget?.repository||t('panels.repository.main');
  useEffect(()=>{
    const result=fetchResult;
    if(!currentFetch||!result||result.error||!Array.isArray(result.remotes)||result.remotes.some((remote:Json)=>remote.status!=='updated'||remote.error)||(!result.remotes.length&&!['no-remotes','not-repository'].includes(result.skipped)))return;
    const timer=setTimeout(()=>setFetchResult(current=>current===result?null:current),5000);
    return()=>clearTimeout(timer);
  },[fetchResult,currentFetch,id,projectId,state.tab,state.history.repository]);
  return <aside id="right-sidebar" aria-label={t('panels.project.panel')} className="git-panel" hidden={!visible}>
    <div className="tabs"><button aria-pressed={state.tab==='changes'} className={state.tab==='changes'?'active':''} onClick={()=>tab('changes')}>{t('panels.tab.changes')}</button><button aria-pressed={state.tab==='files'} className={state.tab==='files'?'active':''} onClick={()=>tab('files')}>{t('panels.tab.files')}</button><button aria-pressed={state.tab==='history'} className={state.tab==='history'?'active':''} onClick={()=>tab('history')}>{t('panels.tab.history')}</button><button className="panel-refresh" disabled={busy||fetching} onClick={()=>void refresh()} title={t('panels.refresh.title')}>{t('panels.refresh.button')}</button></div>
    {entryError?<p className="notice error" role="alert">{text(entryError)}</p>:null}
    {currentFetch&&fetching?<p className="muted small" role="status">{t('panels.fetch.loading',fetchLabel)}</p>:currentFetch&&fetchResult?<div className="fetch-result small" role={fetchResult.error||fetchResult.remotes?.some((remote:Json)=>remote.status!=='updated')?'alert':'status'}><p className="muted">{t('panels.fetch.target',fetchLabel)}</p>{fetchResult.error?<p className="notice error">{text(fetchResult.error)}</p>:fetchResult.skipped?<p className="muted">{fetchResult.skipped==='no-remotes'?t('panels.fetch.noRemotes'):t('panels.fetch.notRepository')}</p>:fetchResult.remotes?.map((remote:Json)=><p key={remote.name} className={remote.status==='updated'?'muted':'notice error'}>{remote.name}：{remote.status==='updated'?t('panels.fetch.updated'):remote.error}</p>)}</div>:null}
    <div className="history-panel" hidden={state.tab!=='history'}><GitHistory id={id} projectRoot={projectRoot} tick={tick+revision+historyRevision} visible={visible&&state.tab==='history'} state={state.history} onChange={history=>setState(current=>({...current,history:{...current.history,...history}}))} onScroll={rememberHistory}/></div>
    <div className="panel-sections" data-collapsed={section.collapsed} hidden={state.tab==='history'}>
      <div className="panel-list-section">
      <button className="panel-section-toggle" aria-expanded={!section.collapsed} aria-controls={sectionId} onClick={()=>updateSection(state.tab as 'changes'|'files',{collapsed:!section.collapsed})}><span aria-hidden="true">{section.collapsed?'▸':'▾'}</span><span>{state.tab==='changes'?t('panels.files.changes',state.changes.staged,files.length):t('panels.files.list')+(section.collapsed?' · '+(state.files.directory||'/'):'')}</span></button>
      <div id={sectionId} className="panel-list-body" hidden={section.collapsed}>
      {state.tab==='changes'?<div className="actions"><button aria-pressed={!state.changes.staged} onClick={()=>updateSection('changes',{staged:false})}>{t('panels.files.worktree')}</button><button aria-pressed={state.changes.staged} onClick={()=>updateSection('changes',{staged:true})}>{t('panels.files.staged')}</button></div>:<div className="directory-navigation"><span className="path directory-path" title={state.files.directory||'/'}>{state.files.directory||'/'}</span>{state.files.directory?<button onClick={()=>updateSection('files',{directory:state.files.directory.split('/').slice(0,-1).join('/'),path:''})}>{t('panels.files.parent')}</button>:null}</div>}
      {error?<p className="notice error" role="alert">{text(error)}</p>:null}
      <div className={state.tab==='files'?'file-list directory-list':'file-list'} ref={listRef} onScroll={event=>visible&&!section.collapsed&&rememberSection(state.tab as 'changes'|'files',{listScroll:event.currentTarget.scrollTop})}>{busy&&!files.length?<p>{t('panels.files.loading')}</p>:!files.length&&error?null:!files.length?<p className="muted">{state.tab==='changes'?t('panels.files.noChanges'):t('panels.files.empty')}</p>:files.map(file=><button key={file.path} className={path===file.path?'active':''} title={file.oldPath?file.oldPath+' → '+file.path:file.path} onClick={()=>{if(file.type==='directory')updateSection('files',{directory:file.path,path:''});else updateSection(state.tab as 'changes'|'files',{path:file.path});}}>{state.tab==='files'?<span className="file-name"><span className="file-kind" aria-hidden="true">{file.type==='directory'?'▸':''}</span><span className="file-name-text">{file.path.split('/').pop()}</span></span>:<span>{file.path}</span>}<small>{file.status??''}{file.binary?' '+t('panels.files.binary'):file.added!==undefined?' +'+file.added+' −'+file.deleted:''}</small></button>)}</div>
      </div>
      </div>
      {path?<PreviewShell label={path} filePath={previewFilePath(projectRoot,path)} active={visible&&state.tab!=='history'} resetKey={id+'|'+projectId+'|'+state.tab} controls={<>{state.tab==='files'&&markdownPath(path)?<div className="markdown-file-controls"><button aria-pressed={state.files.mode==='preview'} onClick={()=>updateSection('files',{mode:'preview'})}>{t('panels.files.preview')}</button><button aria-pressed={state.files.mode==='source'} onClick={()=>updateSection('files',{mode:'source'})}>{t('panels.files.source')}</button></div>:null}{state.tab==='files'?<div className="file-preview-navigation" role="group" aria-label={t('panels.files.navigation')}>
        <button aria-label={t('panels.files.back')} title={t('panels.files.back')} disabled={!state.files.back.length} onClick={()=>navigateFile('back')}>←</button>
        <button aria-label={t('panels.files.forward')} title={t('panels.files.forward')} disabled={!state.files.forward.length} onClick={()=>navigateFile('forward')}>→</button>
        <button className="file-recent-button" aria-label={t('panels.files.recent')} title={t('panels.files.recent')} popoverTarget={recentId}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/></svg></button>
        <div id={recentId} ref={recentRef} popover="auto" className="recent-files-popover" aria-label={t('panels.files.recentOpened')}><h4>{t('panels.files.recent')}</h4>{state.files.recent.map(recentPath=><button key={recentPath} title={recentPath} aria-current={recentPath===path?'page':undefined} onClick={()=>{recentRef.current?.hidePopover();updateSection('files',{path:recentPath});}}><span>{recentPath.split('/').pop()}</span><small dir="rtl">{recentPath.split('/').slice(0,-1).join('/')||'/'}</small></button>)}</div>
      </div>:<button className="split-toggle" aria-pressed={state.changes.split} onClick={()=>updateSection('changes',{split:!state.changes.split})}>{state.changes.split?t('panels.files.unified'):t('panels.files.split')}</button>}</>}><div className="preview-content" ref={previewRef} tabIndex={0} aria-label={t('panels.files.content')} onScroll={event=>{if(event.target===event.currentTarget&&previewReady)rememberSection(state.tab as 'changes'|'files',{contentScroll:event.currentTarget.scrollTop,...(state.tab==='files'?{fragment:''}:{})});}}>{state.tab==='files'&&imagePath(path)?<ImagePreview key={id+'|'+path+'|'+tick+'|'+revision} id={id} path={path} version={tick+'-'+revision}/>:<>{failure?<p className="notice error" role="alert">{text(failure)}</p>:null}{!content&&!failure?<p className="muted">{t('panels.files.reading')}</p>:content?<>{content.images?<ImageDiff id={id} images={content.images} version={tick+'-'+revision} split={state.changes.split}/>:content.binary?<p>{t('panels.files.binaryMetadata')}</p>:state.tab==='changes'?<DiffView content={content} split={state.changes.split}/>:markdownPath(path)&&state.files.mode==='preview'?<MarkdownView text={content.text??''} anchor={anchor?.path===path?anchor:undefined} linkScope={id+'|'+path} resolveUrl={resolvePreviewUrl} resolveImage={resolvePreviewImage} onLink={openPreviewLink}/>:<SourcePreview path={path} text={content.text??''} anchor={anchor?.path===path?anchor:undefined}/>}{content.truncated?<p className="notice">{t('panels.files.truncated')}</p>:null}{state.tab==='changes'?<a href={'/api/sessions/'+id+'/git/diff/patch?staged='+state.changes.staged+'&path='+encodeURIComponent(path)}>{t('panels.files.downloadPatch')}</a>:null}</>:null}</>}</div></PreviewShell>:<p className="muted small">{t('panels.files.choose')}</p>}
    </div>
  </aside>;
}

export function TestReport({threadId,turnId,itemId}:{threadId:string;turnId:string;itemId:string}){
  const {t,text}=useLocale();
  const [path,setPath]=useState(''),[report,setReport]=useState<Json|null>(null),[error,setError]=useState<UiText>(''),[busy,setBusy]=useState(false);
  return <details className="test-report"><summary>{t('panels.report.title')}</summary><p className="muted small">{t('panels.report.description')}</p><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{setReport(await api('/sessions/'+threadId+'/test-reports',{turnId,commandItemId:itemId,relativePath:path,format:'junit'}));}catch(e:any){setError(e);}finally{setBusy(false);}}}><label>{t('panels.report.path')}<input required placeholder="test-results/junit.xml" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={busy}>{busy?t('panels.files.loading'):t('panels.report.import')}</button></form>{error?<p className="notice error">{text(error)}</p>:null}{report?<><p>{t('panels.report.summary',report.summary.passed,report.summary.failed,report.summary.skipped,report.summary.errors)}</p><p className="path">{t('panels.report.source',report.source?.relativePath??path)}</p>{report.source?.stale?<p className="notice">{t('panels.report.stale')}</p>:null}{report.truncated?<p>{t('panels.report.truncated')}</p>:null}<ul>{report.cases.map((item:Json,index:number)=><li key={index}>{item.status} · {item.suite} / {item.name}{item.message?<pre>{item.message}</pre>:null}</li>)}</ul></>:null}</details>;
}
