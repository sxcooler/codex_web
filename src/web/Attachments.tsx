import {formatNumber} from './i18n/format.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from './api.ts';
import {pastedMarkdown} from './pastedText.ts';
import {PastedTextPreview} from './PastedTextPreview.tsx';
export type Attachment={key:string;name:string;size:number;file?:File;uploadId?:string;kind?:string;pasted?:boolean;status:'uploading'|'ready'|'failed';error?:UiText};
export function Attachments({items,onChange,disabled=false,compact=false,children,onError}:{items:Attachment[];onChange:(items:Attachment[])=>void;disabled?:boolean;compact?:boolean;children?:ReactNode;onError?:(error:UiText)=>void}){
  const {t,text,locale}=useLocale();
  const latest=useRef(items);latest.current=items;const notify=useRef(onChange);notify.current=onChange;const input=useRef<HTMLInputElement>(null),[error,setError]=useState<UiText>('');
  const pending=useRef(new Set<AbortController>()),disposed=useRef(false),root=useRef<HTMLDivElement>(null);
  const reportedError=error||items.find(item=>item.status==='failed'&&item.error)?.error||'';
  useEffect(()=>{onError?.(reportedError);},[reportedError,onError]);
  const change=(next:Attachment[])=>{latest.current=next;notify.current(next);};
  useEffect(()=>()=>{disposed.current=true;for(const request of pending.current)request.abort();if(latest.current.some(item=>item.status==='uploading'))change(latest.current.map(item=>item.status==='uploading'?{...item,status:'failed',error:msg('session.attachment.paused')}:item));},[]);
  const upload=async(item:Attachment)=>{const request=new AbortController();pending.current.add(request);const form=new FormData();form.append('file',item.file!);try{const response=await api('/uploads',form,request.signal),result=response.uploads?.[0]??response;if(!disposed.current)change(latest.current.map(x=>x.key===item.key?{...x,...result,status:'ready',error:undefined}:x));}catch(e:any){if(!disposed.current)change(latest.current.map(x=>x.key===item.key?{...x,status:'failed',error:e?.status===400?msg('session.attachment.rejected',item.name):e}:x));}finally{pending.current.delete(request);}};
  const validate=(files:File[],existing=latest.current):UiText=>{
    if(existing.length+files.length>5)return msg('session.attachment.countLimit');
    const oversized=files.find(file=>file.size>15*1024*1024);
    if(oversized)return msg('session.attachment.oversized',oversized.name);
    if(files.reduce((n,f)=>n+f.size,existing.reduce((n,f)=>n+f.size,0))>75*1024*1024)return msg('session.attachment.totalLimit');
    return '';
  };
  const add=(files:File[],pasted=false)=>{
    if(disabled)return;
    const error=validate(files);setError(error);
    if(error&&!pasted)return;
    // Preserve rejected long pastes as recoverable files instead of a truncated textarea fallback.
    const added=files.map(file=>({key:crypto.randomUUID(),name:file.name,size:file.size,file,...(pasted?{pasted:true}:{}),status:error?'failed' as const:'uploading' as const,...(error?{error}:{})}));
    change([...latest.current,...added]);if(!error)for(const item of added)void upload(item);
  };
  const retry=(item:Attachment)=>{
    if(disabled||!item.file)return;
    const error=validate([item.file],latest.current.filter(x=>x.key!==item.key));setError(error);
    change(latest.current.map(x=>x.key===item.key?{...x,status:error?'failed':'uploading',error:error||undefined}:x));
    if(!error)void upload(item);
  };
  useEffect(()=>{const form=root.current?.closest('form');if(!form)return;
    const paste=(event:ClipboardEvent)=>{
      if(disabled||event.defaultPrevented)return;
      const files=[...(event.clipboardData?.files??[])];
      if(files.length){event.preventDefault();add(files);return;}
      if(event.target!==form.querySelector('textarea'))return;
      const file=pastedMarkdown(event.clipboardData?.getData('text/plain')??'');
      if(file){event.preventDefault();add([file],true);}
    };
    const drag=(event:DragEvent)=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();};
    const drop=(event:DragEvent)=>{if(event.dataTransfer?.files.length){event.preventDefault();add([...event.dataTransfer.files]);}};
    form.addEventListener('paste',paste);form.addEventListener('dragover',drag);form.addEventListener('drop',drop);return()=>{form.removeEventListener('paste',paste);form.removeEventListener('dragover',drag);form.removeEventListener('drop',drop);};
  },[disabled]);
  return <div ref={root} className="attachments">
    <input hidden ref={input} type="file" multiple onChange={e=>{add([...(e.target.files??[])]);e.target.value='';}}/><button className="attachment-picker" type="button" aria-label={t('session.attachment.add')} aria-description={compact&&items.length?t('session.attachment.count',items.length):undefined} title={t('session.attachment.add')} disabled={disabled} onClick={()=>input.current?.click()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>{!compact?t('session.attachment.label'):items.length?<span className="attachment-count" aria-hidden="true">{formatNumber(items.length,locale)}</span>:null}</button><span hidden={compact} className="muted small attachment-hint">{t('session.attachment.hint')}</span>{!compact?children:null}
    {!compact&&items.length?<ul>{items.map(item=><li key={item.key}>{item.kind==='image'&&item.uploadId?<img src={'/api/uploads/'+encodeURIComponent(item.uploadId)} alt={item.name}/>:null}<span>{item.name} <small>{formatNumber(Math.ceil(item.size/1024),locale)} KiB · {item.status==='ready'?t('session.attachment.ready'):item.status==='uploading'?t('session.attachment.uploading'):t('session.attachment.failed')}</small>{item.error?<small role="alert">{text(item.error)}</small>:null}</span>{item.pasted&&item.file?<PastedTextPreview file={item.file}/>:null}{item.status==='failed'?<button type="button" disabled={disabled} onClick={()=>retry(item)}>{t('session.retry')}</button>:null}<button type="button" aria-label={t('session.attachment.remove',item.name)} disabled={disabled} onClick={()=>change(latest.current.filter(x=>x.key!==item.key))}>×</button></li>)}</ul>:null}{!compact&&error?<p role="alert">{text(error)}</p>:null}
  </div>;
}
