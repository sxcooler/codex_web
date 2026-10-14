import {useLocale} from './i18n/LocaleProvider.tsx';
import {type UiText} from './i18n/text.ts';
import {createContext,useContext,useId,useRef,useState} from 'react';
import {api,type Json} from './api.ts';
import {writeSession} from './handoff.ts';
import {MarkdownView} from './MarkdownView.tsx';
import {chatFileUrl,fileImageUrl,linkedFile,linkFragment} from './fileLinks.ts';

export const QuestionContext=createContext<{canSend:boolean;expectedTurnId?:string;states:Json;onSent:()=>void;threadId?:string;projectRoot?:string;onOpenFile?:(path:string,fragment?:string)=>void}>({canSend:false,states:{},onSent:()=>{}});
export function QuestionFields({questions,values,onChange,disabled=false}:{questions:Json[];values:Record<string,string>;onChange:(id:string,value:string)=>void;disabled?:boolean}){
  const {t}=useLocale();
  const prefix=useId(),{threadId,projectRoot,onOpenFile}=useContext(QuestionContext);
  return <>{questions.map((q,index)=>{const id=q.id??String(index),options=q.options??[],free=!options.length||q.isOther!==false,promptId=prefix+id+'-prompt';return <fieldset key={id} disabled={disabled} className="question-fields" aria-labelledby={promptId}>
    <div id={promptId} className="question-prompt"><MarkdownView text={q.question??q.title??''} linkScope={'questions|'+(threadId??'')+'|'+(projectRoot??'')}
      resolveImage={threadId&&projectRoot?url=>fileImageUrl(threadId,'',url,location.origin,projectRoot):undefined}
      resolveUrl={threadId&&projectRoot?url=>chatFileUrl(threadId,projectRoot,url):undefined}
      onLink={url=>{const path=threadId?linkedFile(threadId,'',url):'';if(!path||!onOpenFile)return false;onOpenFile(path,linkFragment(url));return true;}}/></div>
    {options.length?<div className="question-options">{options.map((o:any)=>{const label=typeof o==='string'?o:o.label;return <label key={label}><input type="radio" name={prefix+id} checked={values[id]===label} onChange={()=>onChange(id,label)}/><span>{label}{o.description?<small>{o.description}</small>:null}</span></label>;})}</div>:null}{free?<label>{t('session.question.other')}<input type={q.isSecret?'password':'text'} value={options.some((o:any)=>(typeof o==='string'?o:o.label)===values[id])?'':values[id]??''} onChange={e=>onChange(id,e.target.value)} maxLength={12000}/></label>:null}</fieldset>;})}</>;
}
export function AsyncQuestions({item,threadId,turnId}:{item:Json;threadId:string;turnId:string}){
  const {t,text}=useLocale();
  const context=useContext(QuestionContext),[values,setValues]=useState<Record<string,string>>({}),[status,setStatus]=useState(''),[error,setError]=useState<UiText>(''),sending=useRef(false),request=useRef<string|undefined>(undefined);
  const saved=context.states[turnId+':'+item.id]?.status,state=saved==='accepted'?'accepted':status||saved,locked=state==='accepted'||state==='unknown'||state==='sending';
  return <form className="async-questions" aria-label={t('session.question.form')} onSubmit={async event=>{
    event.preventDefault();if(sending.current||locked||!context.canSend)return;sending.current=true;request.current??=crypto.randomUUID();setStatus('sending');setError('');
    try{await writeSession(threadId,()=>api(`/sessions/${threadId}/turns/${encodeURIComponent(turnId)}/items/${encodeURIComponent(item.id)}/answer`,{answers:item.questions.map((_:any,i:number)=>values[String(i)]),clientRequestId:request.current,...(context.expectedTurnId?{expectedTurnId:context.expectedTurnId}:{})},AbortSignal.timeout(30_000)));setStatus('accepted');context.onSent();}
    catch(e:any){setStatus(!e.status||e.status>=500?'unknown':'');setError(e);context.onSent();}finally{sending.current=false;}
  }}><QuestionFields questions={item.questions} values={values} onChange={(id,value)=>setValues(old=>({...old,[id]:value}))} disabled={locked}/>{state==='accepted'?<p role="status">{t('session.question.accepted')}</p>:state==='unknown'?<p role="status">{t('session.question.unknown')}</p>:<button className="primary" disabled={locked||!context.canSend||item.questions.some((_:any,i:number)=>!values[String(i)]?.trim())}>{state==='sending'?t('session.outgoing.sending'):t('session.question.send')}</button>}{!context.canSend&&!locked?<p className="muted small">{t('session.question.blocked')}</p>:null}{error?<p role="alert">{text(error)}</p>:null}</form>;
}
