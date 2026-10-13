import {memo,useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {chatFileUrl,fileImageUrl,linkedFile,linkFragment} from './fileLinks.ts';
import {ImagePreview,NativeImages} from './ImagePreview.tsx';
import {MessageActions} from './MessageActions.tsx';
import {MarkdownView} from './MarkdownView.tsx';
import {api,type Json} from './api.ts';
import {AsyncQuestions,QuestionFields} from './Questions.tsx';
import {TestReport} from './GitPanel.tsx';
import {validItemTime} from '../codex/itemTimes.ts';
import {executionIssue,executionRows,modelOverloadNotice,stepLabels,turnActivity,turnElapsedMs} from './turnActivity.ts';
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const statusLabel=(item:Json)=>item.exitCode!==undefined&&item.exitCode!==null?`exit ${item.exitCode}`:({inProgress:'运行中',completed:'已完成',failed:'失败',declined:'已拒绝',interrupted:'已中止'} as Record<string,string>)[item.status]??item.status??'';
type ItemDetails={open?:boolean;output?:string|null;outputVersion?:string};

export const TurnMessages=memo(function TurnMessages({turn,threadId,attachments,phase,projectRoot,onOpenFile,onChanged,revealItemId,revealToken}:{turn:Json;threadId:string;attachments?:Json[];phase?:string;projectRoot?:string;onOpenFile?:(path:string,fragment?:string)=>void;onChanged?:()=>Promise<void>;revealItemId?:string;revealToken?:string|number}){
  const blocks=turnActivity(turn),running=turn.status==='inProgress',previous=useRef({id:turn.id,status:turn.status}),revealed=useRef<string|undefined>(undefined),[opens,setOpens]=useState<Record<string,boolean>>({}),[recordOpens,setRecordOpens]=useState<Record<string,boolean>>({}),[now,setNow]=useState(Date.now);
  const details=useRef<Record<string,ItemDetails>>({});
  const itemKey=(item:Json)=>String(item.id??(turn.items??[]).indexOf(item));
  const choose=(items:Json[],open:boolean)=>setOpens(old=>({...old,...Object.fromEntries(items.map(item=>[itemKey(item),open]))}));
  const chooseRecords=(items:Json[],open:boolean)=>setRecordOpens(old=>({...old,...Object.fromEntries(items.map(item=>[itemKey(item),open]))}));
  useLayoutEffect(()=>{if(previous.current.id!==turn.id){setOpens({});setRecordOpens({});}previous.current={id:turn.id,status:turn.status};},[turn.id,turn.status]);
  useLayoutEffect(()=>{
    const token=JSON.stringify([turn.id,revealItemId,revealToken]);if(!revealItemId||revealed.current===token)return;
    const block=blocks.find(block=>block.items.some(item=>item.id===revealItemId));if(!block)return;revealed.current=token;if(block.process){choose(block.items,true);const row=executionRows(block.items).find(row=>row.items.some(item=>item.id===revealItemId));if(row?.records)chooseRecords(row.items,true);}
  });
  useEffect(()=>{if(!running||turnElapsedMs(turn)===undefined)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running,turn.startedAt]);
  const elapsed=turnElapsedMs(turn,now),seconds=elapsed===undefined?undefined:Math.floor(elapsed/1000),duration=seconds===undefined?undefined:(seconds>=3600?Math.floor(seconds/3600)+'小时 ':'')+(seconds>=60?Math.floor(seconds%3600/60)+'分 ':'')+(seconds%60)+'秒';
  const firstUser=turn.items?.find((item:Json)=>item.type==='userMessage'),lastAgent=turn.items?.filter((item:Json)=>item.type==='agentMessage').at(-1),lastOrdinaryAgent=turn.items?.filter((item:Json)=>item.type==='agentMessage'&&item.delivery!=='async').at(-1);
  const renderItem=(item:Json,visible=true)=><div key={itemKey(item)} className={'turn-item'+(executionIssue(item)?' execution-issue':'')} data-item-id={item.id} tabIndex={-1}><Message item={item} threadId={threadId} turnId={turn.id} attachments={attachments} projectRoot={projectRoot} onOpenFile={onOpenFile} streaming={running} visible={visible} savedDetails={details.current[turn.id+'|'+itemKey(item)]??={}} revealKey={item.id===revealItemId?JSON.stringify([turn.id,revealItemId,revealToken]):undefined} canFork={turn.status==='completed'&&item===lastOrdinaryAgent} showCitation={turn.status==='completed'} onChanged={onChanged} timestamp={item===firstUser?turn.startedAt:item===lastAgent&&!running?turn.completedAt:undefined} timeLabel={item===firstUser?'本轮开始':'本轮完成'}/></div>;
  const firstProcess=blocks.find(block=>block.process);
  return <div className="turn-messages" data-turn-id={turn.id} tabIndex={-1}>{blocks.map(block=>{if(!block.process)return renderItem(block.items[0]);const chosen=block.items.filter(item=>Object.hasOwn(opens,itemKey(item))),open=chosen.some(item=>opens[itemKey(item)])||(chosen.length?false:running);return <ExecutionGroup key={block.key} items={block.items} status={turn.status} error={turn.error} phase={phase} open={open} onOpen={value=>choose(block.items,value)} recordOpens={recordOpens} onRecordsOpen={chooseRecords} itemKey={itemKey} renderItem={renderItem} duration={block===firstProcess?duration:undefined}/>;})}</div>;
});

function MessageHeader({item,user=false,timestamp,timeLabel}:{item:Json;user?:boolean;timestamp?:number;timeLabel?:string}){
  const field=(user?['startedAtMs','completedAtMs']:['completedAtMs','startedAtMs']).find(field=>validItemTime(item[field]));
  const milliseconds=field?item[field]:typeof timestamp==='number'&&timestamp>0?timestamp*1000:undefined;
  const date=validItemTime(milliseconds)?new Date(milliseconds):null;
  const label=field?(field==='startedAtMs'?'消息开始':'消息完成'):timeLabel;
  return <div className="message-heading"><strong>{user?'用户':'Codex'}</strong>{date?<time className="muted" dateTime={date.toISOString()} title={label+' · '+date.toString()}>{date.toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>:null}</div>;
}

function activityLabel(item:Json){
  if(item.type==='subAgentActivity')return ({started:'启动',interacted:'交互',completed:'完成',interrupted:'中断'} as Record<string,string>)[item.kind]??'活动';
  return item.status==='inProgress'?item.type==='commandExecution'?'正在运行命令':item.type==='reasoning'?'正在思考':(stepLabels[item.type]??'工具')+'运行中':statusLabel(item);
}

function ExecutionRecords({items,open,visible,onOpen,renderItem}:{items:Json[];open:boolean;visible:boolean;onOpen:(open:boolean)=>void;renderItem:(item:Json,visible:boolean)=>ReactNode}){
  const [visited,setVisited]=useState(open),detailsId=useId();
  useEffect(()=>{if(open)setVisited(true);},[open]);
  const current=items.filter(item=>item.status==='inProgress').at(-1)??items.filter(item=>item.type==='subAgentActivity').at(-1);
  return <details className="execution-records" open={open}><summary aria-expanded={open} aria-controls={detailsId} onClick={event=>{event.preventDefault();onOpen(!open);}}><span>执行记录 · {items.length} 项</span>{current?<span className="muted execution-status">{current.type==='subAgentActivity'?'子 Agent · ':''}{activityLabel(current)}</span>:null}</summary><div className="execution-record-items" id={detailsId}>{visited||open?items.map(item=>renderItem(item,visible&&open)):null}</div></details>;
}

function ExecutionGroup({items,status,error,phase,open,onOpen,recordOpens,onRecordsOpen,itemKey,renderItem,duration}:{items:Json[];status:string;error?:Json;phase?:string;open:boolean;onOpen:(open:boolean)=>void;recordOpens:Record<string,boolean>;onRecordsOpen:(items:Json[],open:boolean)=>void;itemKey:(item:Json)=>string;renderItem:(item:Json,visible:boolean)=>ReactNode;duration?:string}){
  const [visited,setVisited]=useState(open),stepsId=useId(),running=status==='inProgress';
  useEffect(()=>{if(open)setVisited(true);},[open]);
  const current=items.filter(item=>item.status==='inProgress').at(-1)??items.at(-1)!;
  const label=running?phase==='WAITING_APPROVAL'?'等待审批':phase==='WAITING_INPUT'?'等待输入':current.type==='reasoning'&&!current.status?'正在思考':activityLabel(current)||(stepLabels[current.type]??'说明'):status==='failed'?modelOverloadNotice(error)??'本轮失败':status==='interrupted'?'已中止':'已完成';
  return <details className="execution-process" open={open}><summary aria-expanded={open} aria-controls={stepsId} onClick={event=>{event.preventDefault();onOpen(!open);}}><span>{running?'执行中':'执行过程'}</span>{duration?<span className="execution-duration">{running?'已用':'用时'} {duration}</span>:null}<span className="muted">{items.length} 项过程</span><span className="execution-status">{label}</span></summary>
    <div className="execution-steps" id={stepsId}>{visited||open?executionRows(items).map(row=>row.records?<ExecutionRecords key={itemKey(row.items[0])} items={row.items} open={row.items.some(item=>recordOpens[itemKey(item)])} visible={open} onOpen={value=>onRecordsOpen(row.items,value)} renderItem={renderItem}/>:renderItem(row.items[0],open)):null}</div>
  </details>;
}

export const Message=memo(function Message({item,threadId,turnId,attachments=[],streaming=false,visible=true,revealKey,savedDetails,timestamp,timeLabel,projectRoot,onOpenFile,canFork=false,showCitation=false,onChanged}:{item:Json;threadId:string;turnId?:string;attachments?:Json[];streaming?:boolean;visible?:boolean;revealKey?:string;savedDetails?:ItemDetails;timestamp?:number;timeLabel?:string;projectRoot?:string;onOpenFile?:(path:string,fragment?:string)=>void;canFork?:boolean;showCitation?:boolean;onChanged?:()=>Promise<void>}) {
  if(item.type==='userMessage')return <article className="message user"><div className="avatar">U</div><div className="message-body"><MessageHeader item={item} user timestamp={timestamp} timeLabel={timeLabel}/><div className="prose">{(item.content??[]).map((c:Json,i:number)=><div key={i}>{c.type==='localImage'&&attachments.some(a=>a.path===c.path)?<a href={attachments.find(a=>a.path===c.path)!.url} target="_blank" rel="noreferrer"><img className="history-image" src={attachments.find(a=>a.path===c.path)!.url} alt={attachments.find(a=>a.path===c.path)!.name}/></a>:c.type==='image'&&item.imagePreviews?.length?null:c.type==='localImage'||c.type==='image'?<span>图片附件（原生历史）</span>:c.text??`[${c.type}]`}</div>)}</div><NativeImages threadId={threadId} turnId={turnId} item={item}/></div></article>;
  if(item.type==='agentMessage')return <article className="message"><div className="avatar codex">A</div><div className="message-body"><MessageHeader item={item} timestamp={timestamp} timeLabel={timeLabel}/>{item.delivery==='async'&&item.questions?.length&&turnId?<AsyncQuestions item={item} threadId={threadId} turnId={turnId}/>:<MarkdownView text={item.text??''} actions={item.delivery!=='async'?<MessageActions threadId={threadId} turnId={turnId} canFork={canFork} memoryCitation={showCitation?item.memoryCitation:undefined} onChanged={onChanged}/>:undefined} streaming={streaming} linkScope={threadId+'|'+(projectRoot??'')} resolveImage={projectRoot?url=>fileImageUrl(threadId,'',url,location.origin,projectRoot):undefined} resolveUrl={projectRoot&&onOpenFile?url=>chatFileUrl(threadId,projectRoot,url):undefined} onLink={url=>{const path=linkedFile(threadId,'',url);if(!path||!onOpenFile)return false;onOpenFile(path,linkFragment(url));return true;}}/>}<NativeImages threadId={threadId} turnId={turnId} item={item}/></div></article>;
  if(item.type==='commandExecution')return <Command item={item} threadId={threadId} turnId={turnId} visible={visible} savedDetails={savedDetails}/>;
  if(item.type==='imageView')return <ViewedImage key={threadId+'|'+item.id} item={item} threadId={threadId} projectRoot={projectRoot} visible={visible} revealKey={revealKey} savedDetails={savedDetails}/>;
  if(item.type==='imageGeneration')return <GeneratedImage item={item} threadId={threadId} turnId={turnId}/>;
  if(Object.hasOwn(stepLabels,item.type))return <Step item={item} threadId={threadId} turnId={turnId} savedDetails={savedDetails}/>;
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

function ViewedImage({item,threadId,projectRoot,visible,revealKey,savedDetails}:{item:Json;threadId:string;projectRoot?:string;visible:boolean;revealKey?:string;savedDetails?:ItemDetails}){
  const [open,setOpen]=useState(savedDetails?.open??false),path=typeof item.path==='string'?item.path:'';
  useLayoutEffect(()=>{if(savedDetails)savedDetails.open=open;},[savedDetails,open]);
  useLayoutEffect(()=>{if(revealKey)setOpen(true);},[revealKey]);
  const remote=/^(?:https?:)?\/\//i.test(path);
  // Tool paths are literal filesystem names, not Markdown URLs (# and % are valid filenames).
  const url=!remote&&path&&projectRoot?chatFileUrl(threadId,projectRoot,encodeURIComponent(path)):'';
  const relative=url?linkedFile(threadId,'',url):'';
  return <details className="tool image-view" open={open} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>
    <summary><span>查看图片</span><code title={path}>{path.split(/[\\/]/).pop()||'图片路径未提供'}</code></summary>
    {open&&visible?<><p className="path">{path||'图片路径未提供'}</p>{remote?null:relative?<ImagePreview key={relative} id={threadId} path={relative} version={item.id}/>:path?<p className="muted small" role="status">仅支持当前项目内的本地图片预览。</p>:null}</>:null}
  </details>;
}

function Step({item,threadId,turnId,savedDetails}:{item:Json;threadId:string;turnId?:string;savedDetails?:ItemDetails}){
  const [open,setOpen]=useState(savedDetails?.open??false),detailsId=useId();
  useLayoutEffect(()=>{if(savedDetails)savedDetails.open=open;},[savedDetails,open]);
  if(item.type==='subAgentActivity'){
    const path=typeof item.agentPath==='string'?item.agentPath:'',name=path.split('/').filter(Boolean).at(-1)||'未命名 Agent';
    const activity=executionIssue(item)||activityLabel(item);
    return <section className="execution-step"><div className="step-heading"><span>子 Agent</span><code>{name}</code><span className="muted step-status">{activity}</span></div><button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?'收起原始数据':'原始数据'}</button><div id={detailsId} hidden={!open}>{open?<pre>{pretty(item)}</pre>:null}</div></section>;
  }
  const reasoning=item.type==='reasoning',summary=reasoning?(item.summary??[]).filter((value:unknown)=>typeof value==='string').join('\n'):item.type==='plan'?item.text??'':'';
  const content=reasoning?(item.content??[]).filter((value:unknown)=>typeof value==='string').join('\n'):'';
  const text=reasoning?[summary,content!==summary?content:''].filter(Boolean).join('\n\n'):item.type==='plan'?summary:pretty(item);
  const short=!!text&&(reasoning||item.type==='plan')&&text.length<=240&&text.split('\n').length<=4;
  const name=item.changes?.map((change:Json)=>change.path).join(', ')??item.tool??item.name??item.query??'';
  return <section className="execution-step"><div className="step-heading"><span>{stepLabels[item.type]??item.type}</span>{name?<code title={name}>{name}</code>:null}<span className="muted step-status">{executionIssue(item)||(reasoning&&!text?'未提供摘要':statusLabel(item))}</span></div>
    <NativeImages threadId={threadId} turnId={turnId} item={item}/>
    {short?<p className="step-excerpt">{text}</p>:<>{summary?<p className="step-excerpt">{summary.slice(0,240)}{summary.length>240?'…':''}</p>:null}{text||reasoning?<><button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?'收起详情':'查看详情'}</button><div id={detailsId} hidden={!open}>{open?<pre>{text||pretty(item)}</pre>:null}</div></>:null}</>}
  </section>;
}

function Command({item,threadId,turnId,visible,savedDetails}:{item:Json;threadId:string;turnId?:string;visible:boolean;savedDetails?:ItemDetails}){
  const version=JSON.stringify([threadId,turnId,item.id,item.outputChars,item.outputBytes]);
  const [open,setOpen]=useState(savedDetails?.open??false),[output,setOutput]=useState<string|null>(savedDetails?.outputVersion===version?savedDetails.output??null:null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[attempt,setAttempt]=useState(0);
  const outputVersion=useRef(version);
  const request=useRef<AbortController|null>(null),detailsId=useId();
  // Group boundaries can move this item; retain its choices and invalidate output on metadata changes.
  useLayoutEffect(()=>{if(savedDetails)Object.assign(savedDetails,{open,output,outputVersion:outputVersion.current});},[savedDetails,open,output]);
  useEffect(()=>{if(outputVersion.current!==version){outputVersion.current=version;setOutput(null);setError('');}},[version]);
  useEffect(()=>{
    if(!visible||!open||!item.outputDeferred||output!==null||!turnId)return;
    const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    void api('/sessions/'+encodeURIComponent(threadId)+'/turns/'+encodeURIComponent(turnId)+'/items/'+encodeURIComponent(item.id)+'/output',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]))
      .then(result=>{if(!controller.signal.aborted){if(typeof result.output!=='string')throw new Error('命令输出无效');setOutput(result.output);}})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(request.current===controller){request.current=null;if(!controller.signal.aborted)setLoading(false);}});
    return()=>{controller.abort();if(request.current===controller)request.current=null;};
  },[visible,open,threadId,turnId,item.id,item.outputDeferred,item.outputChars,item.outputBytes,attempt,output]);
  return <section className="execution-step command-step"><div className="step-heading"><span>命令</span><code title={item.command??''}>{item.command??''}</code><span className="muted step-status">{executionIssue(item)||statusLabel(item)}</span></div>
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
