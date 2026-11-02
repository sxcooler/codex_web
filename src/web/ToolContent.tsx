import {useState} from 'react';
import {toolContentParts} from './richContent.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {zh,en} from './i18n/catalogs/richContent.ts';
import './richContent.css';
function ToolAudio({src,mime,label,error}:{src:string;mime:string;label:string;error:string}){const [failed,setFailed]=useState(false);return failed?<p role="status">{error}</p>:<audio controls preload="none" aria-label={label} onError={()=>setFailed(true)}><source src={src} type={mime}/>{error}</audio>;}
export function ToolContent({item,threadId,turnId}:{item:any;threadId:string;turnId?:string}){
 const {locale}=useLocale(),t=locale==='en'?en:zh,parts=toolContentParts(item);
 if(!parts.length)return null;
 return <div className="tool-content" data-thread-id={threadId} data-turn-id={turnId}>{parts.map((part,index)=>part.type==='image'&&turnId&&item.imagePreviews?.length?null:<section className="tool-content-part" key={index}>
  {part.type==='text'?<pre className="tool-text">{part.text}</pre>:part.type==='structured'?<details><summary>{t['rich.toolStructured']}</summary><pre>{part.text}</pre></details>:part.type==='audio'&&part.src?<ToolAudio key={part.src} src={part.src} mime={part.mime!} label={t['rich.toolAudio']} error={t['rich.toolAudioFailed']}/>:part.type==='resource'||part.type==='widget'?<><strong>{t[part.type==='widget'?'rich.toolWidget':'rich.toolResource']}</strong><p className="rich-path"><code>{part.name}</code>{part.mime?' · '+part.mime:null}</p>{part.text?<pre className="tool-text">{part.text}</pre>:null}<p className="muted small">{t[part.type==='widget'?'rich.toolWidgetUnavailable':'rich.toolResourceUnavailable']}</p></>:<p className="muted small">{t[part.type==='image'?'rich.toolImageUnavailable':'rich.toolUnsupported']}{part.name?' ('+part.name+')':''}</p>}
  {part.truncated?<p className="muted small" role="status">{t['rich.toolTruncated']}</p>:null}
 </section>)}</div>;
}
