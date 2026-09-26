import {memo,useEffect,useId,useRef,useState} from 'react';
import {chatFileUrl,fileImageUrl,linkedFile} from './fileLinks.ts';
import {ImagePreview,NativeImages} from './ImagePreview.tsx';
import {MarkdownView} from './MarkdownView.tsx';
import {api,type Json} from './api.ts';
import {AsyncQuestions,QuestionFields} from './Questions.tsx';
import {TestReport} from './GitPanel.tsx';
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const stepLabels:Record<string,string>={reasoning:'思考',commandExecution:'命令',fileChange:'文件修改',mcpToolCall:'MCP 工具',dynamicToolCall:'工具调用',webSearch:'搜索',plan:'计划',collabAgentToolCall:'协作',subAgentActivity:'子 Agent',functionCallOutput:'工具输出'};
const statusLabel=(item:Json)=>item.exitCode!==undefined&&item.exitCode!==null?`exit ${item.exitCode}`:({inProgress:'运行中',completed:'已完成',failed:'失败',declined:'已拒绝',interrupted:'已中止'} as Record<string,string>)[item.status]??item.status??'';

export const TurnMessages=memo(function TurnMessages({turn,threadId,attachments,phase,projectRoot,onOpenFile}:{turn:Json;threadId:string;attachments?:Json[];phase?:string;projectRoot?:string;onOpenFile?:(path:string)=>void}){
  const blocks:{key:string;items:Json[];process:boolean}[]=[];
  for(const [index,item] of (turn.items??[]).entries()){
    const process=Object.hasOwn(stepLabels,item.type),last=blocks.at(-1);
    if(process&&last?.process)last.items.push(item);else blocks.push({key:turn.id+':'+(item.id??index),items:[item],process});
  }
  const firstUser=turn.items?.find((item:Json)=>item.type==='userMessage'),lastAgent=turn.items?.filter((item:Json)=>item.type==='agentMessage').at(-1);
  return <>{blocks.map((block,index)=>block.process?<ExecutionGroup key={block.key} items={block.items} threadId={threadId} turnId={turn.id} status={turn.status} phase={phase} last={index===blocks.length-1}/>:<Message key={block.key} item={block.items[0]} threadId={threadId} turnId={turn.id} attachments={attachments} projectRoot={projectRoot} onOpenFile={onOpenFile} streaming={turn.status==='inProgress'} timestamp={block.items[0]===firstUser?turn.startedAt:block.items[0]===lastAgent&&turn.status!=='inProgress'?turn.completedAt:undefined} timeLabel={block.items[0]===firstUser?'本轮开始':'本轮完成'}/>)}</>;
});

function MessageHeader({user=false,timestamp,timeLabel}:{user?:boolean;timestamp?:number;timeLabel?:string}){
  const date=typeof timestamp==='number'&&timestamp>0?new Date(timestamp*1000):null;
  return <div className="message-heading"><strong>{user?'用户':'Codex'}</strong>{date&&Number.isFinite(date.getTime())?<time className="muted" dateTime={date.toISOString()} title={timeLabel+' · '+date.toString()}>{date.toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</time>:null}</div>;
}

function ExecutionGroup({items,threadId,turnId,status,phase,last}:{items:Json[];threadId:string;turnId:string;status:string;phase?:string;last:boolean}){
  const [open,setOpen]=useState(false),[visited,setVisited]=useState(false);
  const running=status==='inProgress'&&(last||items.some(item=>item.status==='inProgress'&&!item._syncCompleted));
  const current=items.filter(item=>item.status==='inProgress').at(-1)??items.at(-1)!;
  const label=running?phase==='WAITING_APPROVAL'?'等待审批':phase==='WAITING_INPUT'?'等待输入':current.type==='commandExecution'?'正在运行命令':current.type==='reasoning'?'正在思考':stepLabels[current.type]:last&&status==='failed'?'本轮失败':last&&status==='interrupted'?'已中止':'已完成';
  return <details className="execution-process" open={open} onToggle={event=>{if(event.target!==event.currentTarget)return;const value=event.currentTarget.open;setOpen(value);if(value)setVisited(true);}}><summary><span>{running?'执行中':'执行过程'}</span><span className="muted">{items.length} 个步骤</span><span className="execution-status">{label}</span></summary>
    {visited?<div className="execution-steps">{items.map((item,index)=><Message key={item.id??index} item={item} threadId={threadId} turnId={turnId} visible={open}/>)}</div>:null}
  </details>;
}

export const Message=memo(function Message({item,threadId,turnId,attachments=[],streaming=false,visible=true,timestamp,timeLabel,projectRoot,onOpenFile}:{item:Json;threadId:string;turnId?:string;attachments?:Json[];streaming?:boolean;visible?:boolean;timestamp?:number;timeLabel?:string;projectRoot?:string;onOpenFile?:(path:string)=>void}) {
  if(item.type==='userMessage')return <article className="message user"><div className="avatar">U</div><div className="message-body"><MessageHeader user timestamp={timestamp} timeLabel={timeLabel}/><div className="prose">{(item.content??[]).map((c:Json,i:number)=><div key={i}>{c.type==='localImage'&&attachments.some(a=>a.path===c.path)?<a href={attachments.find(a=>a.path===c.path)!.url} target="_blank" rel="noreferrer"><img className="history-image" src={attachments.find(a=>a.path===c.path)!.url} alt={attachments.find(a=>a.path===c.path)!.name}/></a>:c.type==='image'&&item.imagePreviews?.length?null:c.type==='localImage'||c.type==='image'?<span>图片附件（原生历史）</span>:c.text??`[${c.type}]`}</div>)}</div><NativeImages threadId={threadId} turnId={turnId} item={item}/></div></article>;
  if(item.type==='agentMessage')return <article className="message"><div className="avatar codex">A</div><div className="message-body"><MessageHeader timestamp={timestamp} timeLabel={timeLabel}/>{item.delivery==='async'&&item.questions?.length&&turnId?<AsyncQuestions item={item} threadId={threadId} turnId={turnId}/>:<MarkdownView text={item.text??''} streaming={streaming} linkScope={threadId+'|'+(projectRoot??'')} resolveImage={projectRoot?url=>fileImageUrl(threadId,'',url):undefined} resolveUrl={projectRoot&&onOpenFile?url=>chatFileUrl(threadId,projectRoot,url):undefined} onLink={url=>{const path=linkedFile(threadId,'',url);if(!path||!onOpenFile)return false;onOpenFile(path);return true;}}/>}<NativeImages threadId={threadId} turnId={turnId} item={item}/></div></article>;
  if(item.type==='commandExecution')return <Command item={item} threadId={threadId} turnId={turnId} visible={visible}/>;
  if(item.type==='imageView')return <ViewedImage key={threadId+'|'+item.id+'|'+item.path} item={item} threadId={threadId} projectRoot={projectRoot}/>;
  if(item.type==='imageGeneration')return <GeneratedImage item={item} threadId={threadId} turnId={turnId}/>;
  if(Object.hasOwn(stepLabels,item.type))return <Step item={item} threadId={threadId} turnId={turnId}/>;
  return <details className="tool"><summary><span>{item.type}</span><code>{item.command??item.changes?.map((change:Json)=>change.path).join(', ')??''}</code><span className="muted">{statusLabel(item)}</span></summary><pre>{pretty(item)}</pre></details>;
});

function GeneratedImage({item,threadId,turnId}:{item:Json;threadId:string;turnId?:string}){
  const remote=typeof item.result==='string'&&/^(?:https?:)?\/\//i.test(item.result),available=!!turnId&&!!item.imagePreviews?.length;
  const failed=item.status==='failed'||!!item.failure,finished=['completed','failed','interrupted','declined'].includes(item.status);
  return <section className="execution-step generated-image"><div className="step-heading"><strong>生成图片</strong><span className="muted step-status">{statusLabel(item)}</span></div>
    <NativeImages threadId={threadId} turnId={turnId} item={item}/>
    {remote?<p className="path">{item.result}</p>:!available?<p className={failed?'notice error':'muted small'} role={failed?'alert':'status'}>{item.failure?.type==='usageLimitExceeded'?'图片生成用量已达上限。':failed?'图片生成失败。':finished?'原生记录未提供可预览的图片。':'正在生成图片…'}</p>:null}
    {item.revisedPrompt?<details><summary>生成提示词</summary><pre>{item.revisedPrompt}</pre></details>:null}
  </section>;
}

function ViewedImage({item,threadId,projectRoot}:{item:Json;threadId:string;projectRoot?:string}){
  const [open,setOpen]=useState(false),path=typeof item.path==='string'?item.path:'';
  const remote=/^(?:https?:)?\/\//i.test(path);
  // Tool paths are literal filesystem names, not Markdown URLs (# and % are valid filenames).
  const url=!remote&&path&&projectRoot?chatFileUrl(threadId,projectRoot,encodeURIComponent(path)):'';
  const relative=url?linkedFile(threadId,'',url):'';
  return <details className="tool image-view" open={open} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>
    <summary><span>查看图片</span><code title={path}>{path.split(/[\\/]/).pop()}</code></summary>
    {open?<><p className="path">{path||'图片路径未提供'}</p>{remote?null:relative?<ImagePreview id={threadId} path={relative} version={item.id}/>:<p className="notice error" role="alert">无法预览：图片不在当前项目内，或缺少项目路径。仅支持项目内的本地图片。</p>}</>:null}
  </details>;
}

function Step({item,threadId,turnId}:{item:Json;threadId:string;turnId?:string}){
  const [open,setOpen]=useState(false),detailsId=useId();
  if(item.type==='subAgentActivity'){
    const path=typeof item.agentPath==='string'?item.agentPath:'',name=path.split('/').filter(Boolean).at(-1)||'未命名 Agent';
    const activity=({started:'启动',interacted:'交互',completed:'完成',interrupted:'中断'} as Record<string,string>)[item.kind]??'活动';
    return <section className="execution-step"><div className="step-heading"><span>子 Agent</span><code>{name}</code><span className="muted step-status">{activity}</span></div><button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?'收起原始数据':'原始数据'}</button><div id={detailsId} hidden={!open}>{open?<pre>{pretty(item)}</pre>:null}</div></section>;
  }
  const reasoning=item.type==='reasoning',summary=reasoning?(item.summary??[]).filter((value:unknown)=>typeof value==='string').join('\n'):item.type==='plan'?item.text??'':'';
  const content=reasoning?(item.content??[]).filter((value:unknown)=>typeof value==='string').join('\n'):'';
  const text=reasoning?[summary,content!==summary?content:''].filter(Boolean).join('\n\n'):item.type==='plan'?summary:pretty(item);
  const short=!!text&&(reasoning||item.type==='plan')&&text.length<=240&&text.split('\n').length<=4;
  const name=item.changes?.map((change:Json)=>change.path).join(', ')??item.tool??item.name??item.query??'';
  return <section className="execution-step"><div className="step-heading"><span>{stepLabels[item.type]??item.type}</span>{name?<code title={name}>{name}</code>:null}<span className="muted step-status">{reasoning&&!text?'未提供摘要':statusLabel(item)}</span></div>
    <NativeImages threadId={threadId} turnId={turnId} item={item}/>
    {short?<p className="step-excerpt">{text}</p>:<>{summary?<p className="step-excerpt">{summary.slice(0,240)}{summary.length>240?'…':''}</p>:null}{text?<><button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?'收起详情':'查看详情'}</button><div id={detailsId} hidden={!open}>{open?<pre>{text}</pre>:null}</div></>:null}</>}
  </section>;
}

function Command({item,threadId,turnId,visible}:{item:Json;threadId:string;turnId?:string;visible:boolean}){
  const [open,setOpen]=useState(false),[output,setOutput]=useState<string|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[attempt,setAttempt]=useState(0);
  const request=useRef<AbortController|null>(null),detailsId=useId();
  useEffect(()=>{setOutput(null);setError('');},[threadId,turnId,item.id,item.outputChars,item.outputBytes]);
  useEffect(()=>{
    if(!visible||!open||!item.outputDeferred||output!==null||!turnId)return;
    const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    void api('/sessions/'+encodeURIComponent(threadId)+'/turns/'+encodeURIComponent(turnId)+'/items/'+encodeURIComponent(item.id)+'/output',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]))
      .then(result=>{if(!controller.signal.aborted){if(typeof result.output!=='string')throw new Error('命令输出无效');setOutput(result.output);}})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(request.current===controller){request.current=null;if(!controller.signal.aborted)setLoading(false);}});
    return()=>{controller.abort();if(request.current===controller)request.current=null;};
  },[visible,open,threadId,turnId,item.id,item.outputDeferred,item.outputChars,item.outputBytes,attempt,output]);
  return <section className="execution-step command-step"><div className="step-heading"><span>命令</span><code title={item.command??''}>{item.command??''}</code><span className="muted step-status">{statusLabel(item)}</span></div>
    <button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?'收起输出':'查看输出'}</button>
    <div id={detailsId} hidden={!open}>{open?<><pre className="command-source">{item.command}</pre>
      {item.outputDeferred&&output===null?<div className="output-status small" role="status">{loading?'正在加载完整输出…':error?<>{error} <button type="button" onClick={()=>setAttempt(n=>n+1)}>重试加载输出</button></>:`输出 ${(Number(item.outputBytes)/1024).toFixed(1)} KiB，展开后加载全文`}</div>:null}
      <pre>{output??item.aggregatedOutput??'等待命令输出…'}</pre>{turnId&&item.status!=='inProgress'?<TestReport threadId={threadId} turnId={turnId} itemId={item.id}/>:null}
    </>:null}</div>
  </section>;
}

export function Pending({pending,items,respond,busy}:{pending:Json;items:Json[];respond:(answer:Json)=>Promise<void>;busy:boolean}) {
  const p=pending.params,[answers,setAnswers]=useState<Record<string,string>>({}),[content,setContent]=useState<Json>({});
  const method=pending.method as string;
  const command=method.includes('commandExecution'),file=method.includes('fileChange'),permission=method.includes('permissions'),questions=method.includes('requestUserInput'),mcp=method.toLowerCase().includes('elicitation');
  const properties=p.requestedSchema?.properties??{},required=p.requestedSchema?.required??[];
  const unsupported=mcp&&p.mode!=='url'&&Object.values(properties).some((s:any)=>!['string','number','integer','boolean'].includes(s.type));
  return <section className="approval"><h3>{questions?'需要你的输入':mcp?'工具请求确认':'等待你的审批'}</h3><p>{p.reason??p.message??''}</p>
    {(command||file||permission)?<><span className="muted">{command?'命令':file?'文件修改':'请求的权限'}</span><pre>{p.command??pretty(permission?p.permissions:items.find(i=>i.id===p.itemId)?.changes??p)}</pre>{p.cwd?<p className="path">工作目录：{p.cwd}</p>:null}</>:null}
    {(command||file)?<div className="actions"><button className="primary" disabled={busy} onClick={()=>void respond({decision:'accept'})}>允许一次</button><button disabled={busy} onClick={()=>void respond({decision:'decline'})}>拒绝</button><button className="quiet" disabled={busy} onClick={()=>void respond({decision:'cancel'})}>取消</button></div>:null}
    {permission?<div className="actions"><button className="primary" disabled={busy} onClick={()=>void respond({permissions:p.permissions,scope:'turn'})}>允许本轮</button><button disabled={busy} onClick={()=>void respond({permissions:{},scope:'turn'})}>拒绝</button></div>:null}
    {questions?<form onSubmit={e=>{e.preventDefault();void respond({answers:Object.fromEntries((p.questions??[]).map((q:Json)=>[q.id,{answers:[answers[q.id]??'']}]))});}}><QuestionFields questions={p.questions??[]} values={answers} onChange={(id,value)=>setAnswers(old=>({...old,[id]:value}))} disabled={busy}/><button className="primary" disabled={busy||(p.questions??[]).some((q:Json)=>!answers[q.id]?.trim())}>提交回答</button></form>:null}
    {mcp?<form onSubmit={e=>{e.preventDefault();void respond({action:'accept',content:p.mode==='url'?null:content,_meta:null});}}>
      {p._meta?.tool_params?<details open><summary>工具参数</summary><pre>{pretty(p._meta.tool_params)}</pre></details>:null}
      {p.mode==='url'?<p>{/^https?:\/\//i.test(p.url)?<a href={p.url} target="_blank" rel="noreferrer">打开 {p.serverName} 的请求页面 ↗</a>:<span>不支持的链接协议</span>}</p>:Object.entries(properties).map(([key,schema]:[string,any])=><label key={key}>{schema.title??key}<span className="muted small">{schema.description}</span>{schema.enum?<select required={required.includes(key)} value={content[key]??''} onChange={e=>setContent({...content,[key]:e.target.value})}><option value="" disabled>请选择</option>{schema.enum.map((value:any)=><option key={String(value)} value={value}>{String(value)}</option>)}</select>:schema.type==='boolean'?<select required={required.includes(key)} value={content[key]===undefined?'':String(content[key])} onChange={e=>setContent({...content,[key]:e.target.value==='true'})}><option value="" disabled>请选择</option><option value="true">是</option><option value="false">否</option></select>:<input required={required.includes(key)} type={['number','integer'].includes(schema.type)?'number':schema.format==='email'?'email':'text'} step={schema.type==='integer'?1:'any'} min={schema.minimum} max={schema.maximum} minLength={schema.minLength} maxLength={schema.maxLength} onChange={e=>setContent({...content,[key]:['number','integer'].includes(schema.type)?Number(e.target.value):e.target.value})}/>}</label>)}
      {unsupported?<p className="notice">此工具表单包含当前页面不支持的字段，可以拒绝或取消请求。</p>:null}<div className="actions"><button className="primary" disabled={busy||unsupported}>确认</button><button type="button" disabled={busy} onClick={()=>void respond({action:'decline',content:null,_meta:null})}>拒绝</button><button type="button" disabled={busy} onClick={()=>void respond({action:'cancel',content:null,_meta:null})}>取消</button></div>
    </form>:null}
    {!command&&!file&&!permission&&!questions&&!mcp?<p className="notice">当前请求不受支持，请中止本轮并检查运行时诊断。</p>:null}
  </section>;
}
