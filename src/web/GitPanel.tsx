import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {GitHistory,DiffView} from './GitHistory.tsx';
import {MarkdownView} from './MarkdownView.tsx';
import {loadPanelState,savePanelState,type PanelState,type PanelTab,type StorageLike} from './panelState.ts';

const markdownPath=(path:string)=>/\.(md|markdown)$/i.test(path);
const browserStorage=():StorageLike=>{try{return localStorage;}catch{return {getItem:()=>null,setItem:()=>{}};}};
const relativeFile=(currentPath:string,url:string,decoded=false)=>{
  if(!decoded&&(/^[a-z][a-z0-9+.-]*:/i.test(url)||url.startsWith('#')||url.startsWith('//')))return '';
  let path:string;try{path=decoded?url:decodeURIComponent(url.split(/[?#]/,1)[0]);}catch{return '';}
  const parts=[...(path.startsWith('/')?[]:currentPath.split('/').slice(0,-1)),...path.split('/')],safe:string[]=[];
  for(const part of parts){if(!part||part==='.')continue;if(part==='..'){if(!safe.length)return '';safe.pop();}else safe.push(part);}
  return safe.join('/');
};
const linkedFile=(id:string,currentPath:string,url:string)=>{try{const parsed=new URL(url,location.origin),prefix='/api/sessions/'+encodeURIComponent(id)+'/files/content';if(parsed.origin===location.origin&&parsed.pathname===prefix)return relativeFile('',parsed.searchParams.get('path')??'',true);}catch{}return relativeFile(currentPath,url);};
const fileUrl=(id:string,currentPath:string,url:string)=>{
  if(/^#[a-zA-Z0-9_-]+$/.test(url))return url;
  try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)?parsed.href:'';}catch{}
  const relative=relativeFile(currentPath,url);
  return relative?location.origin+'/api/sessions/'+encodeURIComponent(id)+'/files/content?path='+encodeURIComponent(relative):'';
};

export function GitPanel({id,projectId,tick,visible}:{id:string;projectId:string;tick:number;visible:boolean}){
  const [state,setState]=useState<PanelState>(()=>loadPanelState(browserStorage(),projectId));
  const [lists,setLists]=useState<Record<string,Json[]>>({}),[contents,setContents]=useState<Record<string,Json>>({}),[failures,setFailures]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const panelRef=useRef<HTMLElement>(null),listRef=useRef<HTMLDivElement>(null),previewRef=useRef<HTMLElement>(null),historyRef=useRef<HTMLDivElement>(null),restoreScroll=useRef<number|null>(null);
  const set=(change:Partial<PanelState>)=>setState(current=>({...current,...change}));
  const updateSection=(tab:'changes'|'files',change:Partial<PanelState[typeof tab]>)=>setState(current=>({...current,[tab]:{...current[tab],...change}}));
  const section=state.tab==='changes'?state.changes:state.files;
  const listKey=state.tab==='changes'?'changes:'+state.changes.staged:'files:'+state.files.directory;
  const path=state.tab==='changes'?state.changes.path:state.files.path;
  const contentKey=state.tab==='changes'?'changes:'+state.changes.staged+':'+path:'files:'+path;
  const files=lists[listKey]??[],content=contents[contentKey],failure=failures[contentKey];

  useEffect(()=>savePanelState(browserStorage(),projectId,state),[projectId,state]);
  useEffect(()=>{if(!visible||state.tab==='history'){setBusy(false);return;}let disposed=false;setBusy(true);setError('');const route=state.tab==='changes'?'/git/files?staged='+state.changes.staged:'/files?directory='+encodeURIComponent(state.files.directory);void api('/sessions/'+id+route).then(result=>{if(!disposed)setLists(old=>({...old,[listKey]:result.files??[]}));}).catch(e=>{if(!disposed)setError(e.message);}).finally(()=>{if(!disposed)setBusy(false);});return()=>{disposed=true;};},[id,tick,visible,state.tab,state.changes.staged,state.files.directory,revision,listKey]);
  useEffect(()=>{if(!visible||state.tab==='history'||!path)return;let disposed=false;setError('');const route=state.tab==='changes'?'/git/diff?staged='+state.changes.staged+'&path='+encodeURIComponent(path):'/files/content?path='+encodeURIComponent(path);void api('/sessions/'+id+route).then(result=>{if(disposed)return;setContents(old=>({...old,[contentKey]:result}));setFailures(old=>{const next={...old};delete next[contentKey];return next;});}).catch(e=>{if(!disposed)setFailures(old=>({...old,[contentKey]:e.status===404?'文件已不可用。':e.message}));});return()=>{disposed=true;};},[id,tick,visible,state.tab,state.changes.staged,path,revision,contentKey]);
  const restore=()=>{const panel=panelRef.current;if(!panel||restoreScroll.current===null)return;panel.scrollTop=restoreScroll.current;if(Math.abs(panel.scrollTop-restoreScroll.current)<1)restoreScroll.current=null;};
  useLayoutEffect(()=>{if(!visible)return;restoreScroll.current=state.tab==='history'?state.history.scroll:section.previewScroll;restore();if(state.tab==='history')return;listRef.current!.scrollTop=section.listScroll;const inner=previewRef.current?.querySelector<HTMLElement>('pre,.diff-view');if(inner)inner.scrollTop=section.contentScroll;},[visible,state.tab,listKey,files,contentKey,content]);
  useEffect(()=>{if(!visible)return;const target=state.tab==='history'?historyRef.current:previewRef.current;if(!target)return;const observer=new ResizeObserver(restore);observer.observe(target);return()=>observer.disconnect();},[visible,state.tab,contentKey]);

  const tab=(next:PanelTab)=>{if(next!==state.tab)set({tab:next});};
  return <aside id="right-sidebar" aria-label="项目面板" className="git-panel" hidden={!visible} ref={panelRef} onWheel={()=>{restoreScroll.current=null;}} onTouchStart={()=>{restoreScroll.current=null;}} onScroll={event=>{if(event.target!==event.currentTarget||restoreScroll.current!==null)return;const scroll=event.currentTarget.scrollTop;if(state.tab==='history')setState(current=>({...current,history:{...current.history,scroll}}));else updateSection(state.tab,{previewScroll:scroll});}}>
    <div className="git-heading"><h2>项目</h2><button disabled={busy} onClick={()=>setRevision(n=>n+1)}>↻ 刷新</button></div>
    <div className="tabs"><button aria-pressed={state.tab==='changes'} className={state.tab==='changes'?'active':''} onClick={()=>tab('changes')}>变更</button><button aria-pressed={state.tab==='files'} className={state.tab==='files'?'active':''} onClick={()=>tab('files')}>文件</button><button aria-pressed={state.tab==='history'} className={state.tab==='history'?'active':''} onClick={()=>tab('history')}>Git 日志</button></div>
    <div ref={historyRef} hidden={state.tab!=='history'}><GitHistory id={id} tick={tick+revision} visible={visible&&state.tab==='history'} state={state.history} onChange={history=>set({history})}/></div>
    <div hidden={state.tab==='history'}>
      {state.tab==='changes'?<div className="actions"><button aria-pressed={!state.changes.staged} onClick={()=>updateSection('changes',{staged:false})}>工作区</button><button aria-pressed={state.changes.staged} onClick={()=>updateSection('changes',{staged:true})}>暂存区</button><button className="split-toggle" aria-pressed={state.changes.split} onClick={()=>updateSection('changes',{split:!state.changes.split})}>{state.changes.split?'统一视图':'并排视图'}</button></div>:<div className="path">{state.files.directory||'/'}{state.files.directory?<button onClick={()=>updateSection('files',{directory:state.files.directory.split('/').slice(0,-1).join(''),path:''})}>上一级</button>:null}</div>}
      {error?<p className="notice error" role="alert">{error}</p>:null}
      <div className="file-list" ref={listRef} onScroll={event=>updateSection(state.tab as 'changes'|'files',{listScroll:event.currentTarget.scrollTop})}>{busy&&!files.length?<p>读取中…</p>:!files.length&&error?null:!files.length?<p className="muted">{state.tab==='changes'?'没有变更':'目录为空'}</p>:files.map(file=><button key={file.path} className={path===file.path?'active':''} title={file.oldPath?file.oldPath+' → '+file.path:file.path} onClick={()=>{if(file.type==='directory')updateSection('files',{directory:file.path,path:''});else updateSection(state.tab as 'changes'|'files',{path:file.path});}}><span>{file.type==='directory'?'▸ ':''}{file.path}</span><small>{file.status??''}{file.binary?' 二进制':file.added!==undefined?' +'+file.added+' −'+file.deleted:''}</small></button>)}</div>
      {path?<section className="file-preview" ref={previewRef} onScrollCapture={event=>{const target=event.target as HTMLElement;if(target.matches('pre,.diff-view'))updateSection(state.tab as 'changes'|'files',{contentScroll:target.scrollTop});}}><h3>{path}</h3>{state.tab==='files'&&markdownPath(path)?<div className="markdown-file-controls"><button aria-pressed={state.files.mode==='preview'} onClick={()=>updateSection('files',{mode:'preview'})}>预览</button><button aria-pressed={state.files.mode==='source'} onClick={()=>updateSection('files',{mode:'source'})}>源码</button></div>:null}{failure?<p className="notice error" role="alert">{failure}</p>:null}{!content&&!failure?<p className="muted">读取文件…</p>:content?<>{content.binary?<p>二进制文件，仅显示元数据。</p>:state.tab==='changes'?<DiffView content={content} split={state.changes.split}/>:markdownPath(path)&&state.files.mode==='preview'?<MarkdownView text={content.text??''} linkScope={id+'|'+path} resolveUrl={url=>fileUrl(id,path,url)} onLink={url=>{const next=linkedFile(id,path,url);if(!next)return false;updateSection('files',{path:next,directory:next.split('/').slice(0,-1).join(''),listScroll:0,previewScroll:0,contentScroll:0});return true;}}/>:<pre>{content.text}</pre>}{content.truncated?<p className="notice">内容超过显示上限，已截断。</p>:null}{state.tab==='changes'?<a href={'/api/sessions/'+id+'/git/diff/patch?staged='+state.changes.staged+'&path='+encodeURIComponent(path)}>下载 patch</a>:null}</>:null}</section>:<p className="muted small">选择文件查看内容。</p>}
    </div>
  </aside>;
}

export function TestReport({threadId,itemId}:{threadId:string;itemId:string}){
  const [path,setPath]=useState(''),[report,setReport]=useState<Json|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <details className="test-report"><summary>测试结果</summary><p className="muted small">导入本次命令生成的 JUnit 报告；不会重新运行测试。</p><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{setReport(await api('/sessions/'+threadId+'/test-reports',{commandItemId:itemId,relativePath:path,format:'junit'}));}catch(e:any){setError(e.message);}finally{setBusy(false);}}}><label>项目内报告路径<input required placeholder="test-results/junit.xml" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={busy}>{busy?'读取中…':'导入报告'}</button></form>{error?<p className="notice error">{error}</p>:null}{report?<><p>通过 {report.summary.passed} · 失败 {report.summary.failed} · 跳过 {report.summary.skipped} · 错误 {report.summary.errors}</p><p className="path">来源：{report.source?.relativePath??path}</p>{report.source?.stale?<p className="notice">可能是旧报告，请核对来源。</p>:null}{report.truncated?<p>报告已截断。</p>:null}<ul>{report.cases.map((item:Json,index:number)=><li key={index}>{item.status} · {item.suite} / {item.name}{item.message?<pre>{item.message}</pre>:null}</li>)}</ul></>:null}</details>;
}
