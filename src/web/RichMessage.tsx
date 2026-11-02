import {memo,useEffect,useRef,useState,type ComponentProps} from 'react';
import {MarkdownView} from './MarkdownView.tsx';
import {RichPreview} from './RichPreview.tsx';
import {parseRichContent,type RichPart} from './richContent.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {zh,en} from './i18n/catalogs/richContent.ts';
import './richContent.css';
type Props=ComponentProps<typeof MarkdownView>&{threadId:string;itemId:string;onDraft?:(text:string)=>void};
type MarkdownProps=Omit<ComponentProps<typeof MarkdownView>,'text'|'actions'>;
function Original({text}:{text:string}){const {locale}=useLocale(),t=locale==='en'?en:zh;return <details className="rich-original"><summary>{t['rich.original']}</summary><pre>{text}</pre></details>;}
function FileReference({part,markdown}:{part:Extract<RichPart,{type:'file'|'comment'}>;markdown:MarkdownProps}){
 const {locale}=useLocale(),t=locale==='en'?en:zh;
 const fragment=part.start?'#L'+part.start+(part.end?'-L'+part.end:''):'';
 let url='';try{const candidate=markdown.resolveUrl?.(encodeURIComponent(part.path)+fragment)??'';if(candidate){const target=new URL(candidate,location.origin);if(target.origin===location.origin&&target.pathname.startsWith('/api/sessions/')&&target.pathname.endsWith('/files/content'))url=target.href;}}catch{}
 return <><p className="rich-path">{url?<a href={url} onClick={event=>{if(markdown.onLink?.(url))event.preventDefault();}}>{part.path}{part.start?':'+part.start+(part.end?'–'+part.end:''):''}</a>:<code>{part.path}{part.start?':'+part.start+(part.end?'–'+part.end:''):''}</code>}</p>{!url?<p className="muted small">{t['rich.fileUnavailable']}</p>:null}</>;
}
function Part({part,index,props}:{part:RichPart;index:number;props:Props}){
 const {locale}=useLocale(),t=locale==='en'?en:zh;
 const {text:_text,threadId,itemId,onDraft,actions:_actions,...markdown}=props;
 if(part.type==='markdown')return <MarkdownView {...markdown} text={part.raw}/>;
 if(part.type==='preview')return <RichPreview threadId={threadId} itemId={itemId} index={index} path={part.path} title={part.title} mode={part.mode} live={part.live}/>;
 if(part.type==='fallback')return <aside className="rich-card rich-fallback"><strong>{part.label||part.name}</strong><p role={part.reason==='pending'?'status':undefined}>{t[('rich.'+part.reason) as 'rich.invalid'|'rich.pending'|'rich.unsupported'|'rich.unresolved']}</p><Original text={part.raw}/></aside>;
 if(part.type==='receipt')return <details className="rich-card rich-receipt"><summary>{part.name==='memory'?t['rich.memoryReceipt']:t['rich.receipt']+' · '+part.name}</summary><pre>{part.raw}</pre></details>;
 if(part.type==='details')return <details className="rich-card" open={part.open}><summary>{part.title||t['rich.details']}</summary><MarkdownView {...markdown} text={part.body}/><Original text={part.raw}/></details>;
 if(part.type==='file')return <aside className="rich-card"><strong>{part.title||t[part.purpose==='output'?'rich.output':'rich.source']}</strong><FileReference part={part} markdown={markdown}/>{part.fields?<dl className="rich-fields">{Object.entries(part.fields).filter(([key])=>['sheet','range','object_id','page_number','page_id'].includes(key)).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>:null}</aside>;
 if(part.type==='comment')return <aside className="rich-card"><strong>{t['rich.review']} · {part.title}</strong><FileReference part={part} markdown={markdown}/><MarkdownView {...markdown} text={part.body}/>{part.priority!==undefined?<p>{t['rich.priority']}: {part.priority}</p>:null}{part.confidence!==undefined?<p className="muted small">{t['rich.confidence']}: {part.confidence}</p>:null}<Original text={part.raw}/></aside>;
 if(part.type==='writing'||part.type==='task')return <section className="rich-card"><strong>{part.title||t[part.type==='task'?'rich.task':'rich.writing']}</strong>{part.type==='writing'?<dl className="rich-fields">{Object.entries(part.fields).filter(([key])=>['variant','recipient','subject','cc','bcc'].includes(key)).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>:null}<MarkdownView {...markdown} text={part.body}/>{part.type==='task'?<><button type="button" disabled={!onDraft} onClick={()=>onDraft?.([part.title,part.body.trim()].filter(Boolean).join('\n\n'))}>{t['rich.draft']}</button>{!onDraft?<p className="muted small" role="status">{t['rich.draftUnavailable']}</p>:null}</>:null}<Original text={part.raw}/></section>;
 return <aside className="rich-card"><strong>{part.type==='template'?String(part.fields.display_name):t['rich.page']}</strong><p className="muted small">{t[part.type==='template'?'rich.templateUnavailable':'rich.pageUnavailable']}</p><dl className="rich-fields">{Object.entries(part.fields).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl><Original text={part.raw}/></aside>;
}
export const RichMessage=memo(function RichMessage(props:Props){
 const {locale}=useLocale(),t=locale==='en'?en:zh,[copy,setCopy]=useState<'idle'|'pending'|'done'|'failed'>('idle'),version=useRef(0);
 useEffect(()=>{version.current++;setCopy('idle');return()=>{version.current++;};},[props.text,props.threadId,props.itemId]);
 const parts=parseRichContent(props.text,props.streaming);
 if(parts.every(part=>part.type==='markdown')){const {threadId:_threadId,itemId:_itemId,onDraft:_onDraft,...markdown}=props;return <MarkdownView {...markdown}/>;}
 const copyOriginal=async()=>{if(copy==='pending')return;const request=version.current;setCopy('pending');try{await navigator.clipboard.writeText(props.text);if(version.current===request)setCopy('done');}catch{if(version.current===request)setCopy('failed');}};
 return <div className="rich-message"><div className="rich-parts">{parts.map((part,index)=><Part key={index+':'+part.type} part={part} index={index} props={props}/>)}</div><Original text={props.text}/><div className="message-actions"><button type="button" className="quiet" disabled={copy==='pending'} aria-busy={copy==='pending'} onClick={()=>void copyOriginal()}>{t['rich.copy']}</button><span role="status">{copy==='idle'?'':t[copy==='pending'?'rich.copyPending':copy==='done'?'rich.copyDone':'rich.copyFailed']}</span>{props.actions}</div></div>;
});
