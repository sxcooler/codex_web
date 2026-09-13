import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import type {PanelState} from './panelState.ts';
import {layoutGitGraph} from './gitGraph.ts';

export function DiffView({content,split=false}:{content:Json;split?:boolean}){return content.binary?<p>二进制文件，仅显示元数据。</p>:<div className={'diff-view '+(split?'split':'')}>{(content.hunks??[]).map((hunk:Json,index:number)=><section key={index}><div className="hunk-header">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>{hunk.lines.map((line:Json,n:number)=><div key={n} className={'diff-line '+(line.kind==='add'?'addition':line.kind==='delete'?'deletion':'')}><span className="unified-cell"><span className="line-number">{line.oldLine??''}</span><span className="line-number">{line.newLine??''}</span><code>{line.kind==='add'?'+':line.kind==='delete'?'-':' '} {line.text}</code></span><span className="split-cell"><span className="line-number">{line.oldLine??''}</span><code>{line.kind!=='add'?line.text:''}</code></span><span className="split-cell"><span className="line-number">{line.newLine??''}</span><code>{line.kind!=='delete'?line.text:''}</code></span></div>)}</section>)}</div>;}


type SavedResult={key:string;data:Json};
type Failure={key:string;message:string};
// ponytail: retain at most 100 pages; virtualize the history before raising this ceiling.
const colors=['#82d9b4','#87b7ec','#d8a4e8','#e6c47a','#e8999a'];
const date=(value:string)=>Number.isNaN(Date.parse(value))?value:new Date(value).toLocaleString();
export function GitHistory({id,tick,visible,state,onChange}:{id:string;tick:number;visible:boolean;state:PanelState['history'];onChange:(next:PanelState['history'])=>void}){
  const [log,setLog]=useState<SavedResult|null>(null),[detail,setDetail]=useState<SavedResult|null>(null),[diff,setDiff]=useState<SavedResult|null>(null);
  const [listError,setListError]=useState<Failure|null>(null),[detailError,setDetailError]=useState<Failure|null>(null),[diffError,setDiffError]=useState<Failure|null>(null),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const listRef=useRef<HTMLDivElement>(null);
  const loaded=useRef<{signature:string;pages:number;data:Json}|null>(null);
  const listKey=id+'|'+state.ref,detailKey=id+'|'+state.commit+'|'+state.parent,diffKey=detailKey+'|'+state.path,pages=state.pages??1;
  const update=(change:Partial<PanelState['history']>)=>onChange({...state,...change});
  useEffect(()=>{
    if(!visible)return;
    const signature=listKey+'|'+tick+'|'+revision,cached=loaded.current;
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
  },[id,listKey,tick,visible,state.ref,pages,revision]);
  useEffect(()=>{
    if(!visible||!state.commit)return;let disposed=false;const controller=new AbortController();setDetailError(null);
    const query=new URLSearchParams({commit:state.commit});if(state.parent)query.set('parent',state.parent);
    void api('/sessions/'+id+'/git/commit?'+query,undefined,controller.signal).then(data=>{if(!disposed)setDetail({key:detailKey,data});}).catch(e=>{if(!disposed)setDetailError({key:detailKey,message:e.message});});
    return()=>{disposed=true;controller.abort();};
  },[id,visible,detailKey,state.commit,state.parent,revision,tick]);
  useEffect(()=>{
    if(!visible||!state.commit||!state.path)return;let disposed=false;const controller=new AbortController();setDiffError(null);
    const query=new URLSearchParams({commit:state.commit,path:state.path});if(state.parent)query.set('parent',state.parent);
    void api('/sessions/'+id+'/git/commit/diff?'+query,undefined,controller.signal).then(data=>{if(!disposed)setDiff({key:diffKey,data});}).catch(e=>{if(!disposed)setDiffError({key:diffKey,message:e.message});});
    return()=>{disposed=true;controller.abort();};
  },[id,visible,diffKey,state.commit,state.parent,state.path,revision,tick]);
  const currentLog=log?.key===listKey?log.data:null,currentDetail=detail?.key===detailKey?detail.data:null,currentDiff=diff?.key===diffKey?diff.data:null;
  const commits:Json[]=currentLog?.commits??[],graph=useMemo(()=>layoutGitGraph(commits as {id:string;parents:string[]}[]),[currentLog]);
  useLayoutEffect(()=>{if(visible&&listRef.current)listRef.current.scrollTop=state.listScroll??0;},[visible,listKey,currentLog]);
  const failure=(error:Failure|null,key:string,hasData:boolean)=>error?.key===key?<p role="alert" className="notice error">{error.message}{hasData?'（保留上次读取内容）':''}</p>:null;
  return <section className="git-history" aria-busy={busy}>
    <div className="git-history-controls"><select aria-label="Git 分支" value={state.ref} onChange={e=>update({ref:e.target.value,commit:'',parent:'',path:'',scroll:0,listScroll:0,pages:1})}><option value="HEAD">当前分支</option><option value="all">全部分支</option>{(currentLog?.branches??[]).map((branch:Json)=><option key={branch.ref} value={branch.ref}>{branch.name}</option>)}{state.ref!=='HEAD'&&state.ref!=='all'&&!currentLog?.branches?.some((b:Json)=>b.ref===state.ref)?<option value={state.ref}>{state.ref}</option>:null}</select><button disabled={busy} onClick={()=>setRevision(n=>n+1)}>刷新日志</button></div>
    {failure(listError,listKey,!!currentLog)}{busy?<p className="muted small" role="status">正在更新历史…</p>:null}
    {currentLog?.repository===false?<p className="muted">当前项目不是 Git 仓库。</p>:currentLog&&!commits.length?<p className="muted">仓库还没有提交。</p>:null}
    <div className="git-graph-list" ref={listRef} onScroll={event=>update({listScroll:event.currentTarget.scrollTop})}>{commits.length?<svg className="git-graph" width={Math.max(24,graph.columns*16+12)} height={commits.length*76} aria-hidden="true">{graph.rows.flatMap((row,index)=>[...row.lines.map((line,n)=>{const y=line.incoming?index*76:index*76+38,y2=line.incoming?index*76+38:(index+1)*76,x=line.from*16+8,x2=line.to*16+8;return <path key={index+'-'+n} d={'M '+x+' '+y+' C '+x+' '+((y+y2)/2)+', '+x2+' '+((y+y2)/2)+', '+x2+' '+y2} fill="none" stroke={colors[line.from%colors.length]}/>;}),<circle key={'node-'+index} cx={row.column*16+8} cy={index*76+38} r="4" fill={colors[row.column%colors.length]}/>])}</svg>:null}<div className="git-commit-rows">{commits.map(commit=><button className={'git-commit '+(state.commit===commit.id?'active':'')} title={commit.subject+'\n'+commit.id} key={commit.id} onClick={()=>{if(state.commit!==commit.id)update({commit:commit.id,parent:commit.parents[0]??'',path:''});}}><span className="commit-summary">{commit.subject||'(无标题)'}</span><span className="commit-refs">{(commit.refs??[]).join(' · ')}</span><small>{commit.id.slice(0,8)} · {commit.author} · {date(commit.date)}</small></button>)}</div></div>
    {graph.pending.length?<p className="muted small">{graph.pending.length} 条连线延续至尚未加载的历史。</p>:null}
    {currentLog?.nextCursor?<button disabled={busy||pages>=100} onClick={()=>update({pages:pages+1})}>{pages>=100?'已加载 10000 条，请筛选分支':'加载更早的 100 条'}</button>:null}
    {state.commit?<section className="commit-details">{failure(detailError,detailKey,!!currentDetail)}{currentDetail?<><h3>{currentDetail.commit.subject||'(无标题)'}</h3><code className="commit-hash">{currentDetail.commit.id}</code><p className="muted small">{currentDetail.commit.author} · {date(currentDetail.commit.date)}</p><p className="commit-message">{currentDetail.commit.message}</p>{currentDetail.commit.parents?.length>1?<select aria-label="比较父提交" value={currentDetail.parent??''} onChange={e=>update({parent:e.target.value,path:''})}>{currentDetail.commit.parents.map((parent:string,index:number)=><option value={parent} key={parent}>父提交 {index+1} · {parent.slice(0,8)}</option>)}</select>:<p className="muted small">{currentDetail.parent?'比较父提交 '+currentDetail.parent.slice(0,8):'根提交 · 与空树比较'}</p>}<div className="file-list">{(currentDetail.files??[]).map((file:Json)=><button className={state.path===file.path?'active':''} key={file.path} onClick={()=>update({path:file.path})}><span>{file.oldPath?file.oldPath+' → '+file.path:file.path}</span><small>{file.status??''}</small></button>)}{!currentDetail.files?.length?<p className="muted">没有可显示的文件变更。</p>:null}</div></>:detailError?.key!==detailKey?<p className="muted">读取提交…</p>:null}
      {state.path?<section className="file-preview"><h3>{state.path}</h3>{failure(diffError,diffKey,!!currentDiff)}{currentDiff?<><DiffView content={currentDiff}/>{!currentDiff.binary&&!currentDiff.hunks?.length?<p className="muted">没有文本差异（可能仅重命名或权限变更）。</p>:null}{currentDiff.truncated?<p className="notice">差异超过显示上限，已截断。</p>:null}</>:diffError?.key!==diffKey?<p className="muted">读取差异…</p>:null}</section>:null}
    </section>:commits.length?<p className="muted small">选择一条提交，查看详情和文件变更。</p>:null}
  </section>;
}
