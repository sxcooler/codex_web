import {useEffect,useId,useRef,useState} from 'react';
import {api} from './api.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import './preview.css';

type Props={threadId:string;itemId:string;index:number;path:string;title?:string;mode?:string;live?:boolean};
type Snapshot={path:string;source:string;digest:string;readAt:string};
const words={
 'zh-CN':{title:'HTML 预览',open:'查看源码',close:'关闭源码',retry:'重新读取',loading:'正在读取完整快照…',fallback:'当前环境未启用交互预览；仅显示安全源码，不执行片段脚本。',runtime:'固定 Lucide 运行时尚未就绪，交互能力未验收。',live:'实时预览暂不支持，可手动重新读取快照。',copy:'复制源码',copied:'已复制',copyFailed:'复制失败，请手动选择源码。',invalid:'服务器未返回有效的完整快照。',digest:'内容摘要',readAt:'读取时间'},
 en:{title:'HTML preview',open:'View source',close:'Close source',retry:'Reload snapshot',loading:'Reading the complete snapshot…',fallback:'Interactive preview is unavailable. Source is displayed safely; fragment scripts do not run.',runtime:'The fixed Lucide runtime is unavailable; interactive support is unverified.',live:'Live preview is unavailable. Reload the snapshot manually.',copy:'Copy source',copied:'Copied',copyFailed:'Copy failed. Select the source manually.',invalid:'The server did not return a valid complete snapshot.',digest:'Content digest',readAt:'Read at'},
};

function PreviewCard({threadId,path,title,live}:Props){
 const {locale,text}=useLocale(),t=words[locale==='en'?'en':'zh-CN'];
 const [open,setOpen]=useState(false),[snapshot,setSnapshot]=useState<Snapshot>(),[loading,setLoading]=useState(false),[error,setError]=useState<unknown>(),[copy,setCopy]=useState<'idle'|'pending'|'done'|'failed'>('idle');
 const request=useRef<AbortController|undefined>(undefined),version=useRef(0),trigger=useRef<HTMLButtonElement>(null),panelId=useId();
 useEffect(()=>()=>{version.current++;request.current?.abort();},[]);
 const load=async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;
  const current=++version.current;setOpen(true);setLoading(true);setError(undefined);setSnapshot(undefined);setCopy('idle');
  try{
   const value=await api('/sessions/'+encodeURIComponent(threadId)+'/rich-preview',{path},AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]));
   if(typeof value.path!=='string'||typeof value.source!=='string'||new TextEncoder().encode(value.source).length>1024*1024||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||typeof value.readAt!=='string'||!Number.isFinite(Date.parse(value.readAt)))throw new Error(t.invalid);
   if(current===version.current)setSnapshot(value);
  }catch(failure){if(current===version.current&&!controller.signal.aborted)setError(failure);}
  finally{if(current===version.current)setLoading(false);}
 };
 const close=()=>{version.current++;request.current?.abort();setOpen(false);setLoading(false);setSnapshot(undefined);setError(undefined);setCopy('idle');trigger.current?.focus();};
 const copySource=async()=>{if(!snapshot||copy==='pending')return;const current=version.current;setCopy('pending');try{await navigator.clipboard.writeText(snapshot.source);if(current===version.current)setCopy('done');}catch{if(current===version.current)setCopy('failed');}};
 return <section className="rich-card rich-preview">
  <strong>{title||t.title}</strong><p className="rich-preview-path"><code>{path}</code></p>
  <p className="muted small">{t.fallback}</p><p className="muted small">{t.runtime}</p>{live?<p className="muted small">{t.live}</p>:null}
  <div className="rich-preview-actions"><button ref={trigger} type="button" aria-expanded={open} aria-controls={panelId} onClick={()=>open?close():void load()}>{open?t.close:t.open}</button>{open?<button type="button" disabled={loading} onClick={()=>void load()}>{t.retry}</button>:null}</div>
  {open?<div id={panelId} className="rich-preview-content" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
   {loading?<p role="status">{t.loading}</p>:null}{error?<p role="alert">{text(error as any)}</p>:null}
   {snapshot?<><dl><div><dt>{t.digest}</dt><dd><code>{snapshot.digest}</code></dd></div><div><dt>{t.readAt}</dt><dd><time dateTime={snapshot.readAt}>{snapshot.readAt}</time></dd></div></dl><div className="rich-preview-actions"><button type="button" disabled={copy==='pending'} aria-busy={copy==='pending'} onClick={()=>void copySource()}>{t.copy}</button><span role="status">{copy==='done'?t.copied:copy==='failed'?t.copyFailed:''}</span></div><pre tabIndex={0}>{snapshot.source}</pre></>:null}
  </div>:null}
 </section>;
}

export function RichPreview(props:Props){return <PreviewCard key={JSON.stringify([props.threadId,props.itemId,props.index,props.path])} {...props}/>;}
