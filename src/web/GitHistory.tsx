import {memo,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ImageDiff} from './ImagePreview.tsx';
import {api,type Json} from './api.ts';
import type {PanelState} from './panelState.ts';
import {layoutGitGraph} from './gitGraph.ts';

export const DiffView=memo(function DiffView({content,split=false}:{content:Json;split?:boolean}){return content.binary?<p>二进制文件，仅显示元数据。</p>:<div className={'diff-view '+(split?'split':'')}>{(content.hunks??[]).map((hunk:Json,index:number)=><section key={index}><div className="hunk-header">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>{hunk.lines.map((line:Json,n:number)=><div key={n} className={'diff-line '+(line.kind==='add'?'addition':line.kind==='delete'?'deletion':'')}><span className="unified-cell"><span className="line-number">{line.oldLine??''}</span><span className="line-number">{line.newLine??''}</span><code>{line.kind==='add'?'+':line.kind==='delete'?'-':' '} {line.text}</code></span><span className="split-cell"><span className="line-number">{line.oldLine??''}</span><code>{line.kind!=='add'?line.text:''}</code></span><span className="split-cell"><span className="line-number">{line.newLine??''}</span><code>{line.kind!=='delete'?line.text:''}</code></span></div>)}</section>)}</div>;});


type SavedResult={key:string;data:Json};
type Failure={key:string;message:string};
// ponytail: retain at most 100 pages; virtualize the history before raising this ceiling.
const rowHeight=48;
const colors=['#82d9b4','#87b7ec','#d8a4e8','#e6c47a','#e8999a'];
const date=(value:string)=>Number.isNaN(Date.parse(value))?value:new Date(value).toLocaleString();
export function GitHistory({id,tick,visible,state,onChange}:{id:string;tick:number;visible:boolean;state:PanelState['history'];onChange:(next:Partial<PanelState['history']>)=>void}){
  const [log,setLog]=useState<SavedResult|null>(null),[detail,setDetail]=useState<SavedResult|null>(null),[diff,setDiff]=useState<SavedResult|null>(null);
  const [listError,setListError]=useState<Failure|null>(null),[detailError,setDetailError]=useState<Failure|null>(null),[diffError,setDiffError]=useState<Failure|null>(null),[busy,setBusy]=useState(false);
  const listRef=useRef<HTMLDivElement>(null),previewRef=useRef<HTMLDivElement>(null),filesRef=useRef<HTMLDivElement>(null),infoRef=useRef<HTMLDivElement>(null);
  const sectionId=useId(),infoId=useId();
  useEffect(()=>{infoRef.current?.hidePopover();},[id,visible,state.commit,state.filesCollapsed]);
  const loaded=useRef<{signature:string;pages:number;data:Json}|null>(null);
  const listKey=id+'|'+state.ref,detailKey=id+'|'+state.commit+'|'+state.parent,diffKey=detailKey+'|'+state.path,pages=state.pages??1;
  const update=onChange;
  useEffect(()=>{
    if(!visible)return;
    const signature=listKey+'|'+tick,cached=loaded.current;
    if(cached?.signature===signature&&cached.pages>=pages)return;
    let disposed=false;const controller=new AbortController();setBusy(true);setListError(null);
    void (async()=>{
      const reuse=cached?.signature===signature;let count=reuse?cached.pages:0,result:Json=reuse?cached.data:{commits:[],nextCursor:null},commits:Json[]=reuse?[...result.commits]:[];
      while(count<pages){
        if(count&&!result.nextCursor)break;
        const query=new URLSearchParams({ref:state.ref});if(count)query.set('cursor',result.nextCursor);
        result=await api('/sessions/'+id+'/git/log?'+query,undefined,controller.signal);if(disposed)return;
        commits.push(...result.commits);++count;
      }
      result={...result,commits};loaded.current={signature,pages:count,data:result};setLog({key:listKey,data:result});
    })().catch(e=>{if(!disposed)setListError({key:listKey,message:e.message});}).finally(()=>{if(!disposed)setBusy(false);});
    return()=>{disposed=true;controller.abort();};
  },[id,listKey,tick,visible,state.ref,pages]);
  useEffect(()=>{
    if(!visible||!state.commit)return;let disposed=false;const controller=new AbortController();setDetailError(null);
    const query=new URLSearchParams({commit:state.commit});if(state.parent)query.set('parent',state.parent);
    void api('/sessions/'+id+'/git/commit?'+query,undefined,controller.signal).then(data=>{if(!disposed)setDetail({key:detailKey,data});}).catch(e=>{if(!disposed)setDetailError({key:detailKey,message:e.message});});
    return()=>{disposed=true;controller.abort();};
  },[id,visible,detailKey,state.commit,state.parent,tick]);
  useEffect(()=>{
    if(!visible||!state.commit||!state.path)return;let disposed=false;const controller=new AbortController();setDiffError(null);
    const query=new URLSearchParams({commit:state.commit,path:state.path});if(state.parent)query.set('parent',state.parent);
    void api('/sessions/'+id+'/git/commit/diff?'+query,undefined,controller.signal).then(data=>{if(!disposed)setDiff({key:diffKey,data});}).catch(e=>{if(!disposed)setDiffError({key:diffKey,message:e.message});});
    return()=>{disposed=true;controller.abort();};
  },[id,visible,diffKey,state.commit,state.parent,state.path,tick]);
  const currentLog=log?.key===listKey?log.data:null,currentDetail=detail?.key===detailKey?detail.data:null,currentDiff=diff?.key===diffKey?diff.data:null;
  const commits:Json[]=currentLog?.commits??[],graph=useMemo(()=>layoutGitGraph(commits as {id:string;parents:string[]}[]),[currentLog]);
  useLayoutEffect(()=>{if(visible&&listRef.current)listRef.current.scrollTop=state.listScroll??0;},[visible,listKey,currentLog,state.listCollapsed]);
  useLayoutEffect(()=>{if(visible&&previewRef.current)previewRef.current.scrollTop=state.scroll;},[visible,diffKey,currentDiff]);
  useLayoutEffect(()=>{if(visible&&!state.filesCollapsed&&filesRef.current)filesRef.current.scrollTop=state.filesScroll;},[visible,detailKey,currentDetail,state.filesCollapsed]);
  const failure=(error:Failure|null,key:string,hasData:boolean)=>error?.key===key?<p role="alert" className="notice error">{error.message}{hasData?'（保留上次读取内容）':''}</p>:null;
  return <section className="git-history" aria-busy={busy} data-selected={!!state.commit} data-list-collapsed={state.listCollapsed} data-files-collapsed={state.filesCollapsed}>
    <div className="panel-list-section">
    <button className="panel-section-toggle" aria-expanded={!state.listCollapsed} aria-controls={sectionId+'-log'} onClick={()=>update({listCollapsed:!state.listCollapsed})}><span aria-hidden="true">{state.listCollapsed?'▸':'▾'}</span><span>提交记录 · {state.ref==='HEAD'?'当前分支':state.ref==='all'?'全部分支':state.ref.replace(/^refs\/(heads|remotes|tags)\//,'')}</span></button>
    <div id={sectionId+'-log'} className="panel-list-body" hidden={state.listCollapsed}>
    <div className="git-history-controls"><select aria-label="Git 分支" value={state.ref} onChange={e=>update({ref:e.target.value,commit:'',parent:'',path:'',scroll:0,listScroll:0,pages:1,filesScroll:0})}><option value="HEAD">当前分支</option><option value="all">全部分支</option>{(currentLog?.branches??[]).map((branch:Json)=><option key={branch.ref} value={branch.ref}>{branch.name}</option>)}{state.ref!=='HEAD'&&state.ref!=='all'&&!currentLog?.branches?.some((b:Json)=>b.ref===state.ref)?<option value={state.ref}>{state.ref.replace(/^refs\/(heads|remotes|tags)\//,'')}</option>:null}</select></div>
    {failure(listError,listKey,!!currentLog)}{busy?<p className="muted small" role="status">正在更新历史…</p>:null}
    {currentLog?.repository===false?<p className="muted">当前项目不是 Git 仓库。</p>:currentLog&&!commits.length?<p className="muted">仓库还没有提交。</p>:null}
    <div className="git-graph-list" ref={listRef} onScroll={event=>visible&&!state.listCollapsed&&update({listScroll:event.currentTarget.scrollTop})}>{commits.length?<svg className="git-graph" width={Math.max(24,graph.columns*16+12)} height={commits.length*rowHeight} aria-hidden="true">{graph.rows.flatMap((row,index)=>[...row.lines.map((line,n)=>{const y=line.incoming?index*rowHeight:index*rowHeight+rowHeight/2,y2=line.incoming?index*rowHeight+rowHeight/2:(index+1)*rowHeight,x=line.from*16+8,x2=line.to*16+8;return <path key={index+'-'+n} d={'M '+x+' '+y+' C '+x+' '+((y+y2)/2)+', '+x2+' '+((y+y2)/2)+', '+x2+' '+y2} fill="none" stroke={colors[line.from%colors.length]}/>;}),<circle key={'node-'+index} cx={row.column*16+8} cy={index*rowHeight+rowHeight/2} r="4" fill={colors[row.column%colors.length]}/>])}</svg>:null}<div className="git-commit-rows">{commits.map(commit=><button className={'git-commit '+(state.commit===commit.id?'active':'')} title={commit.subject+'\n'+commit.id} key={commit.id} onClick={()=>{if(state.commit!==commit.id)update({commit:commit.id,parent:commit.parents[0]??'',path:'',scroll:0,filesScroll:0,filesCollapsed:false});}}><span className="commit-summary"><span className="commit-refs" title={(commit.refs??[]).join('\n')}>{(commit.refs??[]).map((ref:string)=><span key={ref} className={'git-ref '+(ref.startsWith('refs/remotes/')?'remote':ref.startsWith('refs/tags/')?'tag':'local')} title={ref}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">{ref.startsWith('refs/tags/')?<><path d="M2 2h6l6 6-6 6-6-6Z"/><circle cx="5" cy="5" r="1"/></>:ref.startsWith('refs/remotes/')?<><circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/></>:<><circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><path d="M4 4.5v7M12 4.5C12 8 4 7 4 10"/></>}</svg>{ref.replace(/^refs\/(heads|remotes|tags)\//,'')}</span>)}</span>{commit.subject||'(无标题)'}</span><small>{commit.id.slice(0,8)} · {commit.author} · {date(commit.date)}</small></button>)}</div></div>
    <div className="git-history-footer">{graph.pending.length?<p className="muted small">{graph.pending.length} 条连线延续至尚未加载的历史。</p>:null}
    {currentLog?.nextCursor?<button disabled={busy||pages>=100} onClick={()=>update({pages:pages+1})}>{pages>=100?'已加载 10000 条，请筛选分支':'加载更早的 100 条'}</button>:null}
    </div></div></div>
    {state.commit?<section className="commit-details">
      <div className="commit-files-section panel-list-section">
      <button className="panel-section-toggle" aria-expanded={!state.filesCollapsed} aria-controls={sectionId+'-files'} onClick={()=>update({filesCollapsed:!state.filesCollapsed})}><span aria-hidden="true">{state.filesCollapsed?'▸':'▾'}</span><span>提交文件 · {state.commit.slice(0,8)}{currentDetail?' · '+currentDetail.files.length:''}</span></button>
      <div id={sectionId+'-files'} className="panel-list-body" hidden={state.filesCollapsed}>
      {failure(detailError,detailKey,!!currentDetail)}
      {currentDetail?<div className="commit-metadata"><h3 title={currentDetail.commit.subject}>{currentDetail.commit.subject||'(无标题)'}</h3><button popoverTarget={infoId}>查看提交信息</button></div>:detailError?.key!==detailKey?<p className="muted">读取提交…</p>:null}
      <div className="file-list" ref={filesRef} onScroll={event=>visible&&!state.filesCollapsed&&update({filesScroll:event.currentTarget.scrollTop})}>{(currentDetail?.files??[]).map((file:Json)=><button className={state.path===file.path?'active':''} key={file.path} onClick={()=>update({path:file.path,scroll:0})}><span>{file.oldPath?file.oldPath+' → '+file.path:file.path}</span><small className="file-change-counts" title={file.status??''}>{file.binary?'二进制':file.added!==undefined&&file.deleted!==undefined?<><span className="added">+{file.added}</span>{' '}<span className="deleted">−{file.deleted}</span></>:file.status??''}</small></button>)}{currentDetail&&!currentDetail.files?.length?<p className="muted">没有可显示的文件变更。</p>:null}</div>
      </div>
      <div id={infoId} ref={infoRef} popover="auto" className="commit-info-popover" role="dialog" aria-label="提交信息">
      <button className="commit-info-close" popoverTarget={infoId} popoverTargetAction="hide" aria-label="关闭提交信息">×</button>
      {currentDetail?<><h3>{currentDetail.commit.subject||'(无标题)'}</h3><code className="commit-hash">{currentDetail.commit.id}</code><p className="small muted">{currentDetail.commit.author} · {date(currentDetail.commit.date)}</p><p className="commit-message">{currentDetail.commit.message}</p>{currentDetail.commit.parents?.length>1?<label>比较父提交<select aria-label="比较父提交" value={currentDetail.parent??''} onChange={e=>update({parent:e.target.value,path:'',filesScroll:0})}>{currentDetail.commit.parents.map((parent:string,index:number)=><option value={parent} key={parent}>父提交 {index+1} · {parent.slice(0,8)}</option>)}</select></label>:<p className="muted small">{currentDetail.parent?'比较父提交 '+currentDetail.parent.slice(0,8):'根提交 · 与空树比较'}</p>}</>:null}
      </div></div>
      {state.path?<section className="file-preview"><h3>{state.path}</h3><div className="preview-content" ref={previewRef} tabIndex={0} aria-label="提交差异" onScroll={event=>{if(event.target===event.currentTarget)update({scroll:event.currentTarget.scrollTop});}}>{failure(diffError,diffKey,!!currentDiff)}{currentDiff?<>{currentDiff.images?<ImageDiff id={id} images={currentDiff.images} version={String(tick)}/>:<DiffView content={currentDiff}/>}{!currentDiff.images&&!currentDiff.binary&&!currentDiff.hunks?.length?<p className="muted">没有文本差异（可能仅重命名或权限变更）。</p>:null}{currentDiff.truncated?<p className="notice">差异超过显示上限，已截断。</p>:null}</>:diffError?.key!==diffKey?<p className="muted">读取差异…</p>:null}</div></section>:<p className="muted small">选择文件查看差异。</p>}
    </section>:commits.length?<p className="muted small">选择一条提交，查看详情和文件变更。</p>:null}
  </section>;
}
