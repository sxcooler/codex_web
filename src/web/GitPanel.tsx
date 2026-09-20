import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {ImagePreview,ImageDiff,imagePath} from './ImagePreview.tsx';
import {GitHistory,DiffView} from './GitHistory.tsx';
import {fileUrl,linkedFile} from './fileLinks.ts';
import {MarkdownView} from './MarkdownView.tsx';
import {loadPanelState,savePanelState,type PanelState,type PanelTab,type StorageLike} from './panelState.ts';

const markdownPath=(path:string)=>/\.(md|markdown)$/i.test(path);
const browserStorage=():StorageLike=>{try{return localStorage;}catch{return {getItem:()=>null,setItem:()=>{}};}};

export function GitPanel({id,projectId,tick,visible,openFile}:{id:string;projectId:string;tick:number;visible:boolean;openFile?:{path:string}}){
  const [state,setState]=useState<PanelState>(()=>loadPanelState(browserStorage(),projectId));
  const [lists,setLists]=useState<Record<string,Json[]>>({}),[contents,setContents]=useState<Record<string,Json>>({}),[failures,setFailures]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [fetching,setFetching]=useState(false),[fetchResult,setFetchResult]=useState<Json|null>(null),[historyRevision,setHistoryRevision]=useState(0);
  const fetchGeneration=useRef(0),fetchInFlight=useRef(false);
  useEffect(()=>{setFetching(false);setFetchResult(null);fetchInFlight.current=false;return()=>{fetchGeneration.current++;};},[id,projectId]);
  const refresh=async()=>{
    if(fetchInFlight.current)return;
    fetchInFlight.current=true;setFetching(true);setFetchResult(null);setRevision(n=>n+1);
    const generation=fetchGeneration.current;
    try {const result=await api('/sessions/'+id+'/git/fetch',{},AbortSignal.timeout(70_000));if(generation===fetchGeneration.current)setFetchResult(result);}
    catch {if(generation===fetchGeneration.current)setFetchResult({error:'远程获取未确认，请检查网络与本机 Git 凭据后重试。本地内容仍可查看。'});}
    finally {if(generation===fetchGeneration.current){fetchInFlight.current=false;setFetching(false);setHistoryRevision(n=>n+1);}}
  };
  const sectionId=useId();
  const listRef=useRef<HTMLDivElement>(null),previewRef=useRef<HTMLDivElement>(null);
  const set=(change:Partial<PanelState>)=>setState(current=>({...current,...change}));
  const updateSection=(tab:'changes'|'files',change:Partial<PanelState[typeof tab]>)=>setState(current=>({...current,[tab]:{...current[tab],...change}}));
  const section=state.tab==='changes'?state.changes:state.files;
  const listKey=state.tab==='changes'?'changes:'+state.changes.staged:'files:'+state.files.directory;
  const path=state.tab==='changes'?state.changes.path:state.files.path;
  const contentKey=state.tab==='changes'?'changes:'+state.changes.staged+':'+path:'files:'+path;
  const files=lists[listKey]??[],content=contents[contentKey],failure=failures[contentKey];
  const resolvePreviewUrl=useCallback((url:string)=>fileUrl(id,path,url),[id,path]);
  const openPreviewLink=useCallback((url:string)=>{const next=linkedFile(id,path,url);if(!next)return false;setState(current=>({...current,files:{...current.files,path:next,directory:next.split('/').slice(0,-1).join(''),listScroll:0,previewScroll:0,contentScroll:0}}));return true;},[id,path]);

  useEffect(()=>{if(openFile)setState(current=>({...current,tab:'files',files:{...current.files,path:openFile.path,directory:openFile.path.split('/').slice(0,-1).join('/'),mode:'preview',listScroll:0,previewScroll:0,contentScroll:0}}));},[openFile]);
  useEffect(()=>savePanelState(browserStorage(),projectId,state),[projectId,state]);
  useEffect(()=>{if(!visible||state.tab==='history'){setBusy(false);return;}let disposed=false;setBusy(true);setError('');const route=state.tab==='changes'?'/git/files?staged='+state.changes.staged:'/files?directory='+encodeURIComponent(state.files.directory);void api('/sessions/'+id+route).then(result=>{if(!disposed){const nextFiles=result.files??[];setLists(old=>({...old,[listKey]:nextFiles}));if(state.tab==='changes')setState(current=>current.changes.staged===state.changes.staged&&current.changes.path&&!nextFiles.some((file:Json)=>file.path===current.changes.path)?{...current,changes:{...current.changes,path:'',previewScroll:0,contentScroll:0}}:current);}}).catch(e=>{if(!disposed)setError(e.message);}).finally(()=>{if(!disposed)setBusy(false);});return()=>{disposed=true;};},[id,tick,visible,state.tab,state.changes.staged,state.files.directory,revision,listKey]);
  useEffect(()=>{if(!visible||state.tab==='history'||!path||(state.tab==='files'&&imagePath(path)))return;let disposed=false;setError('');const route=state.tab==='changes'?'/git/diff?staged='+state.changes.staged+'&path='+encodeURIComponent(path):'/files/content?path='+encodeURIComponent(path);void api('/sessions/'+id+route).then(result=>{if(disposed)return;setContents(old=>({...old,[contentKey]:result}));setFailures(old=>{const next={...old};delete next[contentKey];return next;});}).catch(e=>{if(!disposed)setFailures(old=>({...old,[contentKey]:e.status===404?'文件已不可用。':e.message}));});return()=>{disposed=true;};},[id,tick,visible,state.tab,state.changes.staged,path,revision,contentKey]);
  useLayoutEffect(()=>{if(!visible||state.tab==='history')return;if(listRef.current)listRef.current.scrollTop=section.listScroll;if(previewRef.current)previewRef.current.scrollTop=section.contentScroll;},[visible,state.tab,listKey,files,contentKey,content,state.files.mode,section.collapsed]);

  const tab=(next:PanelTab)=>{if(next!==state.tab)set({tab:next});};
  return <aside id="right-sidebar" aria-label="项目面板" className="git-panel" hidden={!visible}>
    <div className="tabs"><button aria-pressed={state.tab==='changes'} className={state.tab==='changes'?'active':''} onClick={()=>tab('changes')}>变更</button><button aria-pressed={state.tab==='files'} className={state.tab==='files'?'active':''} onClick={()=>tab('files')}>文件</button><button aria-pressed={state.tab==='history'} className={state.tab==='history'?'active':''} onClick={()=>tab('history')}>Git 日志</button><button className="panel-refresh" disabled={busy||fetching} onClick={()=>void refresh()} title="刷新本地内容并获取远程分支更新">↻ 刷新</button></div>
    {fetching?<p className="muted small" role="status">正在获取远程更新…本地内容可继续查看。</p>:fetchResult?<div className="fetch-result small" role={fetchResult.error||fetchResult.remotes?.some((remote:Json)=>remote.status!=='updated')?'alert':'status'}>{fetchResult.error?<p className="notice error">{fetchResult.error}</p>:fetchResult.skipped?<p className="muted">{fetchResult.skipped==='no-remotes'?'未配置远程仓库，仅刷新本地内容。':'当前目录不是 Git 仓库，仅刷新本地内容。'}</p>:fetchResult.remotes?.map((remote:Json)=><p key={remote.name} className={remote.status==='updated'?'muted':'notice error'}>{remote.name}：{remote.status==='updated'?'远程记录已更新。':remote.error}</p>)}</div>:null}
    <div className="history-panel" hidden={state.tab!=='history'}><GitHistory id={id} tick={tick+revision+historyRevision} visible={visible&&state.tab==='history'} state={state.history} onChange={history=>setState(current=>({...current,history:{...current.history,...history}}))}/></div>
    <div className="panel-sections" data-collapsed={section.collapsed} hidden={state.tab==='history'}>
      <div className="panel-list-section">
      <button className="panel-section-toggle" aria-expanded={!section.collapsed} aria-controls={sectionId} onClick={()=>updateSection(state.tab as 'changes'|'files',{collapsed:!section.collapsed})}><span aria-hidden="true">{section.collapsed?'▸':'▾'}</span><span>{state.tab==='changes'?'变更文件 · '+(state.changes.staged?'暂存区':'工作区')+' · '+files.length:'文件列表 · '+(state.files.directory||'/')}</span></button>
      <div id={sectionId} className="panel-list-body" hidden={section.collapsed}>
      {state.tab==='changes'?<div className="actions"><button aria-pressed={!state.changes.staged} onClick={()=>updateSection('changes',{staged:false})}>工作区</button><button aria-pressed={state.changes.staged} onClick={()=>updateSection('changes',{staged:true})}>暂存区</button><button className="split-toggle" aria-pressed={state.changes.split} onClick={()=>updateSection('changes',{split:!state.changes.split})}>{state.changes.split?'统一视图':'并排视图'}</button></div>:<div className="path">{state.files.directory||'/'}{state.files.directory?<button onClick={()=>updateSection('files',{directory:state.files.directory.split('/').slice(0,-1).join('/'),path:''})}>上一级</button>:null}</div>}
      {error?<p className="notice error" role="alert">{error}</p>:null}
      <div className="file-list" ref={listRef} onScroll={event=>visible&&!section.collapsed&&updateSection(state.tab as 'changes'|'files',{listScroll:event.currentTarget.scrollTop})}>{busy&&!files.length?<p>读取中…</p>:!files.length&&error?null:!files.length?<p className="muted">{state.tab==='changes'?'没有变更':'目录为空'}</p>:files.map(file=><button key={file.path} className={path===file.path?'active':''} title={file.oldPath?file.oldPath+' → '+file.path:file.path} onClick={()=>{if(file.type==='directory')updateSection('files',{directory:file.path,path:''});else updateSection(state.tab as 'changes'|'files',{path:file.path});}}><span>{file.type==='directory'?'▸ ':''}{file.path}</span><small>{file.status??''}{file.binary?' 二进制':file.added!==undefined?' +'+file.added+' −'+file.deleted:''}</small></button>)}</div>
      </div>
      </div>
      {path?<section className="file-preview"><h3>{path}</h3>{state.tab==='files'&&markdownPath(path)?<div className="markdown-file-controls"><button aria-pressed={state.files.mode==='preview'} onClick={()=>updateSection('files',{mode:'preview'})}>预览</button><button aria-pressed={state.files.mode==='source'} onClick={()=>updateSection('files',{mode:'source'})}>源码</button></div>:null}<div className="preview-content" ref={previewRef} tabIndex={0} aria-label="文件内容" onScroll={event=>{if(event.target===event.currentTarget)updateSection(state.tab as 'changes'|'files',{contentScroll:event.currentTarget.scrollTop});}}>{state.tab==='files'&&imagePath(path)?<ImagePreview key={id+'|'+path+'|'+tick+'|'+revision} id={id} path={path} version={tick+'-'+revision}/>:<>{failure?<p className="notice error" role="alert">{failure}</p>:null}{!content&&!failure?<p className="muted">读取文件…</p>:content?<>{content.images?<ImageDiff id={id} images={content.images} version={tick+'-'+revision} split={state.changes.split}/>:content.binary?<p>二进制文件，仅显示元数据。</p>:state.tab==='changes'?<DiffView content={content} split={state.changes.split}/>:markdownPath(path)&&state.files.mode==='preview'?<MarkdownView text={content.text??''} linkScope={id+'|'+path} resolveUrl={resolvePreviewUrl} onLink={openPreviewLink}/>:<pre>{content.text}</pre>}{content.truncated?<p className="notice">内容超过显示上限，已截断。</p>:null}{state.tab==='changes'?<a href={'/api/sessions/'+id+'/git/diff/patch?staged='+state.changes.staged+'&path='+encodeURIComponent(path)}>下载 patch</a>:null}</>:null}</>}</div></section>:<p className="muted small">选择文件查看内容。</p>}
    </div>
  </aside>;
}

export function TestReport({threadId,itemId}:{threadId:string;itemId:string}){
  const [path,setPath]=useState(''),[report,setReport]=useState<Json|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <details className="test-report"><summary>测试结果</summary><p className="muted small">导入本次命令生成的 JUnit 报告；不会重新运行测试。</p><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{setReport(await api('/sessions/'+threadId+'/test-reports',{commandItemId:itemId,relativePath:path,format:'junit'}));}catch(e:any){setError(e.message);}finally{setBusy(false);}}}><label>项目内报告路径<input required placeholder="test-results/junit.xml" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={busy}>{busy?'读取中…':'导入报告'}</button></form>{error?<p className="notice error">{error}</p>:null}{report?<><p>通过 {report.summary.passed} · 失败 {report.summary.failed} · 跳过 {report.summary.skipped} · 错误 {report.summary.errors}</p><p className="path">来源：{report.source?.relativePath??path}</p>{report.source?.stale?<p className="notice">可能是旧报告，请核对来源。</p>:null}{report.truncated?<p>报告已截断。</p>:null}<ul>{report.cases.map((item:Json,index:number)=><li key={index}>{item.status} · {item.suite} / {item.name}{item.message?<pre>{item.message}</pre>:null}</li>)}</ul></>:null}</details>;
}
