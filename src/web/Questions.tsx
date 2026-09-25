import {createContext,useContext,useId,useRef,useState} from 'react';
import {api,type Json} from './api.ts';

export const QuestionContext=createContext<{canSend:boolean;expectedTurnId?:string;states:Json;onSent:()=>void}>({canSend:false,states:{},onSent:()=>{}});
export function QuestionFields({questions,values,onChange,disabled=false}:{questions:Json[];values:Record<string,string>;onChange:(id:string,value:string)=>void;disabled?:boolean}){
  const prefix=useId();
  return <>{questions.map((q,index)=>{const id=q.id??String(index),options=q.options??[],free=!options.length||q.isOther!==false;return <fieldset key={id} disabled={disabled} className="question-fields"><legend>{q.question??q.title}</legend>{options.length?<div className="question-options">{options.map((o:any)=>{const label=typeof o==='string'?o:o.label;return <label key={label}><input type="radio" name={prefix+id} checked={values[id]===label} onChange={()=>onChange(id,label)}/><span>{label}{o.description?<small>{o.description}</small>:null}</span></label>;})}</div>:null}{free?<label>其他回答<input type={q.isSecret?'password':'text'} value={options.some((o:any)=>(typeof o==='string'?o:o.label)===values[id])?'':values[id]??''} onChange={e=>onChange(id,e.target.value)} maxLength={12000}/></label>:null}</fieldset>;})}</>;
}
export function AsyncQuestions({item,threadId,turnId}:{item:Json;threadId:string;turnId:string}){
  const context=useContext(QuestionContext),[values,setValues]=useState<Record<string,string>>({}),[status,setStatus]=useState(''),[error,setError]=useState(''),sending=useRef(false),request=useRef<string|undefined>(undefined);
  const saved=context.states[turnId+':'+item.id]?.status,state=saved==='accepted'?'accepted':status||saved,locked=state==='accepted'||state==='unknown'||state==='sending';
  return <form className="async-questions" aria-label="回答 Codex 提问" onSubmit={async event=>{
    event.preventDefault();if(sending.current||locked||!context.canSend)return;sending.current=true;request.current??=crypto.randomUUID();setStatus('sending');setError('');
    try{await api(`/sessions/${threadId}/turns/${encodeURIComponent(turnId)}/items/${encodeURIComponent(item.id)}/answer`,{answers:item.questions.map((_:any,i:number)=>values[String(i)]),clientRequestId:request.current,...(context.expectedTurnId?{expectedTurnId:context.expectedTurnId}:{})});setStatus('accepted');context.onSent();}
    catch(e:any){setStatus(!e.status||e.status>=500?'unknown':'');setError(e.message);context.onSent();}finally{sending.current=false;}
  }}><QuestionFields questions={item.questions} values={values} onChange={(id,value)=>setValues(old=>({...old,[id]:value}))} disabled={locked}/>{state==='accepted'?<p role="status">回答已发送</p>:state==='unknown'?<p role="status">提交结果待核实，请检查历史；不会自动重发。</p>:<button className="primary" disabled={locked||!context.canSend||item.questions.some((_:any,i:number)=>!values[String(i)]?.trim())}>{state==='sending'?'发送中…':'发送回答'}</button>}{!context.canSend&&!locked?<p className="muted small">会话暂不可提交，请核对占用或等待同步完成。</p>:null}{error?<p role="alert">{error}</p>:null}</form>;
}
