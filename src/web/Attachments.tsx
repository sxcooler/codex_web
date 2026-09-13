import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
export type Attachment={key:string;name:string;size:number;file?:File;uploadId?:string;kind?:string;status:'uploading'|'ready'|'failed';error?:string};
export function Attachments({items,onChange,disabled=false}:{items:Attachment[];onChange:(items:Attachment[])=>void;disabled?:boolean}){
  const latest=useRef(items);latest.current=items;const notify=useRef(onChange);notify.current=onChange;const input=useRef<HTMLInputElement>(null),[error,setError]=useState('');
  const pending=useRef(new Set<AbortController>()),disposed=useRef(false),root=useRef<HTMLDivElement>(null);
  const change=(next:Attachment[])=>{latest.current=next;notify.current(next);};
  useEffect(()=>()=>{disposed.current=true;for(const request of pending.current)request.abort();if(latest.current.some(item=>item.status==='uploading'))change(latest.current.map(item=>item.status==='uploading'?{...item,status:'failed',error:'上传已暂停，请重试'}:item));},[]);
  const upload=async(item:Attachment)=>{const request=new AbortController();pending.current.add(request);const form=new FormData();form.append('file',item.file!);try{const response=await api('/uploads',form,request.signal),result=response.uploads?.[0]??response;if(!disposed.current)change(latest.current.map(x=>x.key===item.key?{...x,...result,status:'ready',error:undefined}:x));}catch(e:any){if(!disposed.current)change(latest.current.map(x=>x.key===item.key?{...x,status:'failed',error:e.message}:x));}finally{pending.current.delete(request);}};
  const add=(files:File[])=>{if(disabled)return;if(latest.current.length+files.length>5||files.reduce((n,f)=>n+f.size,latest.current.reduce((n,f)=>n+f.size,0))>25*1024*1024||files.some(f=>f.size>10*1024*1024)){setError('每条消息最多 5 个附件，单个 10 MiB，合计 25 MiB。');return;}setError('');const added=files.map(file=>({key:crypto.randomUUID(),name:file.name,size:file.size,file,status:'uploading' as const}));change([...latest.current,...added]);for(const item of added)void upload(item);};
  useEffect(()=>{const form=root.current?.closest('form');if(!form)return;
    const paste=(event:ClipboardEvent)=>{const files=[...(event.clipboardData?.files??[])].filter(file=>file.type.startsWith('image/'));if(files.length){event.preventDefault();add(files);}};
    const drag=(event:DragEvent)=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();};
    const drop=(event:DragEvent)=>{if(event.dataTransfer?.files.length){event.preventDefault();add([...event.dataTransfer.files]);}};
    form.addEventListener('paste',paste);form.addEventListener('dragover',drag);form.addEventListener('drop',drop);return()=>{form.removeEventListener('paste',paste);form.removeEventListener('dragover',drag);form.removeEventListener('drop',drop);};
  },[disabled]);
  return <div ref={root} className="attachments">
    <input hidden ref={input} type="file" multiple onChange={e=>{add([...(e.target.files??[])]);e.target.value='';}}/><button type="button" disabled={disabled} onClick={()=>input.current?.click()}>＋ 附件</button><span className="muted small">拖入文件或在此粘贴图片</span>
    {items.length?<ul>{items.map(item=><li key={item.key}>{item.kind==='image'&&item.uploadId?<img src={'/api/uploads/'+encodeURIComponent(item.uploadId)} alt={item.name}/>:null}<span>{item.name} <small>{Math.ceil(item.size/1024)} KiB · {item.status==='ready'?'就绪':item.status==='uploading'?'上传中…':'上传失败'}</small>{item.error?<small role="alert">{item.error}</small>:null}</span>{item.status==='failed'?<button type="button" disabled={disabled} onClick={()=>{change(latest.current.map(x=>x.key===item.key?{...x,status:'uploading'}:x));void upload(item);}}>重试</button>:null}<button type="button" aria-label={'移除附件 '+item.name} disabled={disabled} onClick={()=>change(latest.current.filter(x=>x.key!==item.key))}>×</button></li>)}</ul>:null}{error?<p role="alert">{error}</p>:null}
  </div>;
}
