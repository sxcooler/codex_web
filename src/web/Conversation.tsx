import {createTranslator} from './i18n/messages.ts';
import type {Locale} from './i18n/types.ts';
import {formatDateTime,formatDuration,formatNumber} from './i18n/format.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {memo,useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {chatFileUrl,fileImageUrl,linkedFile,linkFragment} from './fileLinks.ts';
import {ImagePreview,NativeImages} from './ImagePreview.tsx';
import {MessageActions} from './MessageActions.tsx';
import {MarkdownView} from './MarkdownView.tsx';
import {api,type Json} from './api.ts';
import {AsyncQuestions,QuestionFields} from './Questions.tsx';
import {TestReport} from './GitPanel.tsx';
import {validItemTime} from '../codex/itemTimes.ts';
import {executionIssue,executionRows,modelOverloadNotice,stepLabel,stepLabels,turnActivity,turnElapsedMs} from './turnActivity.ts';
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const statusLabel=(item:Json,locale:Locale='zh-CN')=>{const t=createTranslator(locale);return item.exitCode!==undefined&&item.exitCode!==null?`exit ${item.exitCode}`:({inProgress:t('session.phase.running'),completed:t('session.issue.completed'),failed:t('session.issue.failed'),declined:t('session.issue.declined'),interrupted:t('session.issue.interrupted')} as Record<string,string>)[item.status]??item.status??'';};
type ItemDetails={open?:boolean;output?:string|null;outputVersion?:string};

export const TurnMessages=memo(function TurnMessages({turn,threadId,attachments,phase,projectRoot,onOpenFile,onChanged,revealItemId,revealToken}:{turn:Json;threadId:string;attachments?:Json[];phase?:string;projectRoot?:string;onOpenFile?:(path:string,fragment?:string)=>void;onChanged?:()=>Promise<void>;revealItemId?:string;revealToken?:string|number}){
  const {t,locale}=useLocale();
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
  const elapsed=turnElapsedMs(turn,now),duration=elapsed===undefined?undefined:formatDuration(elapsed,locale);
  const firstUser=turn.items?.find((item:Json)=>item.type==='userMessage'),lastAgent=turn.items?.filter((item:Json)=>item.type==='agentMessage').at(-1),lastOrdinaryAgent=turn.items?.filter((item:Json)=>item.type==='agentMessage'&&item.delivery!=='async').at(-1);
  const renderItem=(item:Json,visible=true)=><div key={itemKey(item)} className={'turn-item'+(executionIssue(item,locale)?' execution-issue':'')} data-item-id={item.id} tabIndex={-1}><Message item={item} threadId={threadId} turnId={turn.id} attachments={attachments} projectRoot={projectRoot} onOpenFile={onOpenFile} streaming={running} visible={visible} savedDetails={details.current[turn.id+'|'+itemKey(item)]??={}} revealKey={item.id===revealItemId?JSON.stringify([turn.id,revealItemId,revealToken]):undefined} canFork={turn.status==='completed'&&item===lastOrdinaryAgent} showCitation={turn.status==='completed'} onChanged={onChanged} timestamp={item===firstUser?turn.startedAt:item===lastAgent&&!running?turn.completedAt:undefined} timeLabel={item===firstUser?t('session.turn.start'):t('session.turn.end')}/></div>;
  const firstProcess=blocks.find(block=>block.process);
  return <div className="turn-messages" data-turn-id={turn.id} tabIndex={-1}>{blocks.map(block=>{if(!block.process)return renderItem(block.items[0]);const chosen=block.items.filter(item=>Object.hasOwn(opens,itemKey(item))),open=chosen.some(item=>opens[itemKey(item)])||(chosen.length?false:running);return <ExecutionGroup key={block.key} items={block.items} status={turn.status} error={turn.error} phase={phase} open={open} onOpen={value=>choose(block.items,value)} recordOpens={recordOpens} onRecordsOpen={chooseRecords} itemKey={itemKey} renderItem={renderItem} duration={block===firstProcess?duration:undefined}/>;})}</div>;
});

function MessageHeader({item,user=false,timestamp,timeLabel}:{item:Json;user?:boolean;timestamp?:number;timeLabel?:string}){
  const {t,locale}=useLocale();
  const field=(user?['startedAtMs','completedAtMs']:['completedAtMs','startedAtMs']).find(field=>validItemTime(item[field]));
  const milliseconds=field?item[field]:typeof timestamp==='number'&&timestamp>0?timestamp*1000:undefined;
  const date=validItemTime(milliseconds)?new Date(milliseconds):null;
  const label=field?(field==='startedAtMs'?t('session.message.start'):t('session.message.end')):timeLabel;
  return <div className="message-heading"><strong>{user?t('session.message.user'):'Codex'}</strong>{date?<time className="muted" dateTime={date.toISOString()} title={label+' · '+formatDateTime(date.getTime(),locale,{dateStyle:'full',timeStyle:'long'})}>{formatDateTime(date.getTime(),locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>:null}</div>;
}

function activityLabel(item:Json,locale:Locale){
  const t=createTranslator(locale);
  if(item.type==='subAgentActivity')return ({started:t('session.activity.started'),interacted:t('session.activity.interacted'),completed:t('session.activity.completed'),interrupted:t('session.activity.interrupted')} as Record<string,string>)[item.kind]??t('session.activity.generic');
  return item.status==='inProgress'?item.type==='commandExecution'?t('session.activity.command'):item.type==='reasoning'?t('session.activity.reasoning'):t('session.activity.running',stepLabel(item.type,locale)??t('session.activity.tool')):statusLabel(item,locale);
}

function ExecutionRecords({items,open,visible,onOpen,renderItem}:{items:Json[];open:boolean;visible:boolean;onOpen:(open:boolean)=>void;renderItem:(item:Json,visible:boolean)=>ReactNode}){
  const {t,locale}=useLocale();
  const [visited,setVisited]=useState(open),detailsId=useId();
  useEffect(()=>{if(open)setVisited(true);},[open]);
  const current=items.filter(item=>item.status==='inProgress').at(-1)??items.filter(item=>item.type==='subAgentActivity').at(-1);
  return <details className="execution-records" open={open}><summary aria-expanded={open} aria-controls={detailsId} onClick={event=>{event.preventDefault();onOpen(!open);}}><span>{t('session.process.records',items.length)}</span>{current?<span className="muted execution-status">{current.type==='subAgentActivity'?t('session.step.subagent')+' · ':''}{activityLabel(current,locale)}</span>:null}</summary><div className="execution-record-items" id={detailsId}>{visited||open?items.map(item=>renderItem(item,visible&&open)):null}</div></details>;
}

function ExecutionGroup({items,status,error,phase,open,onOpen,recordOpens,onRecordsOpen,itemKey,renderItem,duration}:{items:Json[];status:string;error?:Json;phase?:string;open:boolean;onOpen:(open:boolean)=>void;recordOpens:Record<string,boolean>;onRecordsOpen:(items:Json[],open:boolean)=>void;itemKey:(item:Json)=>string;renderItem:(item:Json,visible:boolean)=>ReactNode;duration?:string}){
  const {t,locale}=useLocale();
  const [visited,setVisited]=useState(open),stepsId=useId(),running=status==='inProgress';
  useEffect(()=>{if(open)setVisited(true);},[open]);
  const current=items.filter(item=>item.status==='inProgress').at(-1)??items.at(-1)!;
  const label=running?phase==='WAITING_APPROVAL'?t('session.phase.approval'):phase==='WAITING_INPUT'?t('session.phase.input'):current.type==='reasoning'&&!current.status?t('session.activity.reasoning'):activityLabel(current,locale)||(stepLabel(current.type,locale)??t('session.activity.description')):status==='failed'?modelOverloadNotice(error,locale)??t('session.turn.failure'):status==='interrupted'?t('session.issue.interrupted'):t('session.issue.completed');
  return <details className="execution-process" open={open}><summary aria-expanded={open} aria-controls={stepsId} onClick={event=>{event.preventDefault();onOpen(!open);}}><span>{running?t('session.process.running'):t('session.process.label')}</span>{duration?<span className="execution-duration">{running?t('session.process.elapsed'):t('session.process.duration')} {duration}</span>:null}<span className="muted">{t('session.process.count',items.length)}</span><span className="execution-status">{label}</span></summary>
    <div className="execution-steps" id={stepsId}>{visited||open?executionRows(items).map(row=>row.records?<ExecutionRecords key={itemKey(row.items[0])} items={row.items} open={row.items.some(item=>recordOpens[itemKey(item)])} visible={open} onOpen={value=>onRecordsOpen(row.items,value)} renderItem={renderItem}/>:renderItem(row.items[0],open)):null}</div>
  </details>;
}

export const Message=memo(function Message({item,threadId,turnId,attachments=[],streaming=false,visible=true,revealKey,savedDetails,timestamp,timeLabel,projectRoot,onOpenFile,canFork=false,showCitation=false,onChanged}:{item:Json;threadId:string;turnId?:string;attachments?:Json[];streaming?:boolean;visible?:boolean;revealKey?:string;savedDetails?:ItemDetails;timestamp?:number;timeLabel?:string;projectRoot?:string;onOpenFile?:(path:string,fragment?:string)=>void;canFork?:boolean;showCitation?:boolean;onChanged?:()=>Promise<void>}) {
  const {t,locale}=useLocale();
  if(item.type==='userMessage')return <article className="message user"><div className="avatar">U</div><div className="message-body"><MessageHeader item={item} user timestamp={timestamp} timeLabel={timeLabel}/><div className="prose">{(item.content??[]).map((c:Json,i:number)=><div key={i}>{c.type==='localImage'&&attachments.some(a=>a.path===c.path)?<a href={attachments.find(a=>a.path===c.path)!.url} target="_blank" rel="noreferrer"><img className="history-image" src={attachments.find(a=>a.path===c.path)!.url} alt={attachments.find(a=>a.path===c.path)!.name}/></a>:c.type==='image'&&item.imagePreviews?.length?null:c.type==='localImage'||c.type==='image'?<span>{t('session.image.nativeAttachment')}</span>:c.text??`[${c.type}]`}</div>)}</div><NativeImages threadId={threadId} turnId={turnId} item={item}/></div></article>;
  if(item.type==='agentMessage')return <article className="message"><div className="avatar codex">A</div><div className="message-body"><MessageHeader item={item} timestamp={timestamp} timeLabel={timeLabel}/>{item.delivery==='async'&&item.questions?.length&&turnId?<AsyncQuestions item={item} threadId={threadId} turnId={turnId}/>:<MarkdownView text={item.text??''} actions={item.delivery!=='async'?<MessageActions threadId={threadId} turnId={turnId} canFork={canFork} memoryCitation={showCitation?item.memoryCitation:undefined} onChanged={onChanged}/>:undefined} streaming={streaming} linkScope={threadId+'|'+(projectRoot??'')} resolveImage={projectRoot?url=>fileImageUrl(threadId,'',url,location.origin,projectRoot):undefined} resolveUrl={projectRoot&&onOpenFile?url=>chatFileUrl(threadId,projectRoot,url):undefined} onLink={url=>{const path=linkedFile(threadId,'',url);if(!path||!onOpenFile)return false;onOpenFile(path,linkFragment(url));return true;}}/>}<NativeImages threadId={threadId} turnId={turnId} item={item}/></div></article>;
  if(item.type==='commandExecution')return <Command item={item} threadId={threadId} turnId={turnId} visible={visible} savedDetails={savedDetails}/>;
  if(item.type==='imageView')return <ViewedImage key={threadId+'|'+item.id} item={item} threadId={threadId} projectRoot={projectRoot} visible={visible} revealKey={revealKey} savedDetails={savedDetails}/>;
  if(item.type==='imageGeneration')return <GeneratedImage item={item} threadId={threadId} turnId={turnId}/>;
  if(Object.hasOwn(stepLabels,item.type))return <Step item={item} threadId={threadId} turnId={turnId} savedDetails={savedDetails}/>;
  return <details className="tool"><summary><span>{item.type}</span><code>{item.command??item.changes?.map((change:Json)=>change.path).join(', ')??''}</code><span className="muted">{statusLabel(item,locale)}</span></summary><pre>{pretty(item)}</pre></details>;
});

function GeneratedImage({item,threadId,turnId}:{item:Json;threadId:string;turnId?:string}){
  const {t,locale}=useLocale();
  const remote=typeof item.result==='string'&&/^(?:https?:)?\/\//i.test(item.result),available=!!turnId&&!!item.imagePreviews?.length;
  const failed=item.status==='failed'||!!item.failure,finished=['completed','failed','interrupted','declined'].includes(item.status);
  return <section className="execution-step generated-image"><div className="step-heading"><strong>{t('session.image.generate')}</strong><span className="muted step-status">{statusLabel(item,locale)}</span></div>
    <NativeImages threadId={threadId} turnId={turnId} item={item}/>
    {remote?<p className="path">{item.result}</p>:!available?<p className={failed?'notice error':'muted small'} role={failed?'alert':'status'}>{item.failure?.type==='usageLimitExceeded'?t('session.image.limit'):failed?t('session.image.failed'):finished?t('session.image.missingPreview'):t('session.image.generating')}</p>:null}
    {item.revisedPrompt?<details><summary>{t('session.image.prompt')}</summary><pre>{item.revisedPrompt}</pre></details>:null}
  </section>;
}

function ViewedImage({item,threadId,projectRoot,visible,revealKey,savedDetails}:{item:Json;threadId:string;projectRoot?:string;visible:boolean;revealKey?:string;savedDetails?:ItemDetails}){
  const {t}=useLocale();
  const [open,setOpen]=useState(savedDetails?.open??false),path=typeof item.path==='string'?item.path:'';
  useLayoutEffect(()=>{if(savedDetails)savedDetails.open=open;},[savedDetails,open]);
  useLayoutEffect(()=>{if(revealKey)setOpen(true);},[revealKey]);
  const remote=/^(?:https?:)?\/\//i.test(path);
  // Tool paths are literal filesystem names, not Markdown URLs (# and % are valid filenames).
  const url=!remote&&path&&projectRoot?chatFileUrl(threadId,projectRoot,encodeURIComponent(path)):'';
  const relative=url?linkedFile(threadId,'',url):'';
  return <details className="tool image-view" open={open} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>
    <summary><span>{t('session.image.view')}</span><code title={path}>{path.split(/[\\/]/).pop()||t('session.image.noPath')}</code></summary>
    {open&&visible?<><p className="path">{path||t('session.image.noPath')}</p>{remote?null:relative?<ImagePreview key={relative} id={threadId} path={relative} version={item.id}/>:path?<p className="muted small" role="status">{t('session.image.localOnly')}</p>:null}</>:null}
  </details>;
}

function Step({item,threadId,turnId,savedDetails}:{item:Json;threadId:string;turnId?:string;savedDetails?:ItemDetails}){
  const {t,locale}=useLocale();
  const [open,setOpen]=useState(savedDetails?.open??false),detailsId=useId();
  useLayoutEffect(()=>{if(savedDetails)savedDetails.open=open;},[savedDetails,open]);
  if(item.type==='subAgentActivity'){
    const path=typeof item.agentPath==='string'?item.agentPath:'',name=path.split('/').filter(Boolean).at(-1)||t('session.agent.unnamed');
    const activity=executionIssue(item,locale)||activityLabel(item,locale);
    return <section className="execution-step"><div className="step-heading"><span>{t('session.step.subagent')}</span><code>{name}</code><span className="muted step-status">{activity}</span></div><button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?t('session.data.hide'):t('session.data.show')}</button><div id={detailsId} hidden={!open}>{open?<pre>{pretty(item)}</pre>:null}</div></section>;
  }
  const reasoning=item.type==='reasoning',summary=reasoning?(item.summary??[]).filter((value:unknown)=>typeof value==='string').join('\n'):item.type==='plan'?item.text??'':'';
  const content=reasoning?(item.content??[]).filter((value:unknown)=>typeof value==='string').join('\n'):'';
  const text=reasoning?[summary,content!==summary?content:''].filter(Boolean).join('\n\n'):item.type==='plan'?summary:pretty(item);
  const short=!!text&&(reasoning||item.type==='plan')&&text.length<=240&&text.split('\n').length<=4;
  const name=item.changes?.map((change:Json)=>change.path).join(', ')??item.tool??item.name??item.query??'';
  return <section className="execution-step"><div className="step-heading"><span>{stepLabel(item.type,locale)??item.type}</span>{name?<code title={name}>{name}</code>:null}<span className="muted step-status">{executionIssue(item,locale)||(reasoning&&!text?t('session.reasoning.noSummary'):statusLabel(item,locale))}</span></div>
    <NativeImages threadId={threadId} turnId={turnId} item={item}/>
    {short?<p className="step-excerpt">{text}</p>:<>{summary?<p className="step-excerpt">{summary.slice(0,240)}{summary.length>240?'…':''}</p>:null}{text||reasoning?<><button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?t('session.details.hide'):t('session.details.show')}</button><div id={detailsId} hidden={!open}>{open?<pre>{text||pretty(item)}</pre>:null}</div></>:null}</>}
  </section>;
}

function Command({item,threadId,turnId,visible,savedDetails}:{item:Json;threadId:string;turnId?:string;visible:boolean;savedDetails?:ItemDetails}){
  const {t,text,locale}=useLocale();
  const version=JSON.stringify([threadId,turnId,item.id,item.outputChars,item.outputBytes]);
  const [open,setOpen]=useState(savedDetails?.open??false),[output,setOutput]=useState<string|null>(savedDetails?.outputVersion===version?savedDetails.output??null:null),[error,setError]=useState<UiText>(''),[loading,setLoading]=useState(false),[attempt,setAttempt]=useState(0);
  const outputVersion=useRef(version);
  const request=useRef<AbortController|null>(null),detailsId=useId();
  // Group boundaries can move this item; retain its choices and invalidate output on metadata changes.
  useLayoutEffect(()=>{if(savedDetails)Object.assign(savedDetails,{open,output,outputVersion:outputVersion.current});},[savedDetails,open,output]);
  useEffect(()=>{if(outputVersion.current!==version){outputVersion.current=version;setOutput(null);setError('');}},[version]);
  useEffect(()=>{
    if(!visible||!open||!item.outputDeferred||output!==null||!turnId)return;
    const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    void api('/sessions/'+encodeURIComponent(threadId)+'/turns/'+encodeURIComponent(turnId)+'/items/'+encodeURIComponent(item.id)+'/output',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]))
      .then(result=>{if(!controller.signal.aborted){if(typeof result.output!=='string')throw Object.assign(new Error('命令输出无效'),{i18n:msg('session.command.invalidOutput')});setOutput(result.output);}})
      .catch(e=>{if(!controller.signal.aborted)setError(e);})
      .finally(()=>{if(request.current===controller){request.current=null;if(!controller.signal.aborted)setLoading(false);}});
    return()=>{controller.abort();if(request.current===controller)request.current=null;};
  },[visible,open,threadId,turnId,item.id,item.outputDeferred,item.outputChars,item.outputBytes,attempt,output]);
  return <section className="execution-step command-step"><div className="step-heading"><span>{t('session.step.command')}</span><code title={item.command??''}>{item.command??''}</code><span className="muted step-status">{executionIssue(item,locale)||statusLabel(item,locale)}</span></div>
    <button type="button" className="step-toggle quiet" aria-expanded={open} aria-controls={detailsId} onClick={()=>setOpen(value=>!value)}>{open?t('session.command.hide'):t('session.command.show')}</button>
    <div id={detailsId} hidden={!open}>{open?<><pre className="command-source">{item.command}</pre>
      {item.outputDeferred&&output===null?<div className="output-status small" role="status">{loading?t('session.command.loading'):error?<>{text(error)} <button type="button" onClick={()=>setAttempt(n=>n+1)}>{t('session.command.retry')}</button></>:t('session.command.size',formatNumber(Number(item.outputBytes)/1024,locale,{minimumFractionDigits:1,maximumFractionDigits:1}))}</div>:null}
      <pre>{output??item.aggregatedOutput??t('session.command.waiting')}</pre>{turnId&&item.status!=='inProgress'?<TestReport threadId={threadId} turnId={turnId} itemId={item.id}/>:null}
    </>:null}</div>
  </section>;
}

export function Pending({pending,items,respond,busy}:{pending:Json;items:Json[];respond:(answer:Json)=>Promise<void>;busy:boolean}) {
  const {t}=useLocale();
  const p=pending.params,[answers,setAnswers]=useState<Record<string,string>>({}),[content,setContent]=useState<Json>({});
  const method=pending.method as string;
  const command=method.includes('commandExecution'),file=method.includes('fileChange'),permission=method.includes('permissions'),questions=method.includes('requestUserInput'),mcp=method.toLowerCase().includes('elicitation');
  const properties=p.requestedSchema?.properties??{},required=p.requestedSchema?.required??[];
  const unsupported=mcp&&p.mode!=='url'&&Object.values(properties).some((s:any)=>!['string','number','integer','boolean'].includes(s.type));
  return <section className="approval"><h3>{questions?t('session.approval.input'):mcp?t('session.approval.tool'):t('session.approval.waiting')}</h3><p>{p.reason??p.message??''}</p>
    {(command||file||permission)?<><span className="muted">{command?t('session.step.command'):file?t('session.step.fileChange'):t('session.approval.permissions')}</span><pre>{p.command??pretty(permission?p.permissions:items.find(i=>i.id===p.itemId)?.changes??p)}</pre>{p.cwd?<p className="path">{t('session.approval.cwd',p.cwd)}</p>:null}</>:null}
    {(command||file)?<div className="actions"><button className="primary" disabled={busy} onClick={()=>void respond({decision:'accept'})}>{t('session.approval.once')}</button><button disabled={busy} onClick={()=>void respond({decision:'decline'})}>{t('session.approval.decline')}</button><button className="quiet" disabled={busy} onClick={()=>void respond({decision:'cancel'})}>{t('session.approval.cancel')}</button></div>:null}
    {permission?<div className="actions"><button className="primary" disabled={busy} onClick={()=>void respond({permissions:p.permissions,scope:'turn'})}>{t('session.approval.turn')}</button><button disabled={busy} onClick={()=>void respond({permissions:{},scope:'turn'})}>{t('session.approval.decline')}</button></div>:null}
    {questions?<form onSubmit={e=>{e.preventDefault();void respond({answers:Object.fromEntries((p.questions??[]).map((q:Json)=>[q.id,{answers:[answers[q.id]??'']}]))});}}><QuestionFields questions={p.questions??[]} values={answers} onChange={(id,value)=>setAnswers(old=>({...old,[id]:value}))} disabled={busy}/><button className="primary" disabled={busy||(p.questions??[]).some((q:Json)=>!answers[q.id]?.trim())}>{t('session.approval.answer')}</button></form>:null}
    {mcp?<form onSubmit={e=>{e.preventDefault();void respond({action:'accept',content:p.mode==='url'?null:content,_meta:null});}}>
      {p._meta?.tool_params?<details open><summary>{t('session.approval.params')}</summary><pre>{pretty(p._meta.tool_params)}</pre></details>:null}
      {p.mode==='url'?<p>{/^https?:\/\//i.test(p.url)?<a href={p.url} target="_blank" rel="noreferrer">{t('session.approval.openUrl',p.serverName)}</a>:<span>{t('session.approval.protocol')}</span>}</p>:Object.entries(properties).map(([key,schema]:[string,any])=><label key={key}>{schema.title??key}<span className="muted small">{schema.description}</span>{schema.enum?<select required={required.includes(key)} value={content[key]??''} onChange={e=>setContent({...content,[key]:e.target.value})}><option value="" disabled>{t('session.approval.select')}</option>{schema.enum.map((value:any)=><option key={String(value)} value={value}>{String(value)}</option>)}</select>:schema.type==='boolean'?<select required={required.includes(key)} value={content[key]===undefined?'':String(content[key])} onChange={e=>setContent({...content,[key]:e.target.value==='true'})}><option value="" disabled>{t('session.approval.select')}</option><option value="true">{t('session.approval.yes')}</option><option value="false">{t('session.approval.no')}</option></select>:<input required={required.includes(key)} type={['number','integer'].includes(schema.type)?'number':schema.format==='email'?'email':'text'} step={schema.type==='integer'?1:'any'} min={schema.minimum} max={schema.maximum} minLength={schema.minLength} maxLength={schema.maxLength} onChange={e=>setContent({...content,[key]:['number','integer'].includes(schema.type)?Number(e.target.value):e.target.value})}/>}</label>)}
      {unsupported?<p className="notice">{t('session.approval.unsupportedFields')}</p>:null}<div className="actions"><button className="primary" disabled={busy||unsupported}>{t('session.approval.confirm')}</button><button type="button" disabled={busy} onClick={()=>void respond({action:'decline',content:null,_meta:null})}>{t('session.approval.decline')}</button><button type="button" disabled={busy} onClick={()=>void respond({action:'cancel',content:null,_meta:null})}>{t('session.approval.cancel')}</button></div>
    </form>:null}
    {!command&&!file&&!permission&&!questions&&!mcp?<p className="notice">{t('session.approval.unsupported')}</p>:null}
  </section>;
}
