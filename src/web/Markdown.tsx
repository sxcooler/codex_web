import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {useEffect,useId,useMemo,useRef,useState,type ReactNode,type ComponentProps} from 'react';
import {Streamdown,CodeBlock,defaultRehypePlugins,useIsCodeFenceIncomplete,type Components} from 'streamdown';
import {code} from '@streamdown/code';
import {linkFragment} from './fileLinks.ts';
import {MermaidBlock} from './MermaidBlock.tsx';
import {createTranslator} from './i18n/messages.ts';
import type {Locale} from './i18n/types.ts';
import {checkedHighlighter} from './codeHighlight.ts';
const checkedCode=checkedHighlighter(code);
type MarkdownNode={type?:string;value?:string;tagName?:string;properties?:Record<string,unknown>;children?:MarkdownNode[];position?:{start:{line:number};end:{line:number}}};
type LinkOptions={resolve:(url:string)=>string;image?:(url:string)=>string;scope:string;locale:Locale};
// Parse only standalone image HTML; other raw HTML keeps the existing rendering policy.
const imageHtmlPlugin=()=>{
  const parse=(defaultRehypePlugins.raw as ()=> (tree:MarkdownNode)=>MarkdownNode)();
  return function visit(node:MarkdownNode){
    if(!node.children)return;
    node.children=node.children.flatMap(child=>{
      if(child.type==='raw'){
        const parsed=parse({type:'root',children:[child]});
        if(parsed.children?.every(item=>item.tagName==='img'||(item.type==='text'&&!item.value?.trim())))return parsed.children;
        return [{type:'text',value:child.value}];
      }
      visit(child);return [child];
    });
  };
};
// ponytail: Streamdown keys processors by plugin names and JSON options; scope isolates file resolvers.
const linkPlugin=({resolve,image,locale}:LinkOptions)=>{const t=createTranslator(locale);return function visit(node:MarkdownNode){
  if(node.tagName==='a'&&typeof node.properties?.href==='string'){
    const original=node.properties.href,url=resolve(original);
    if(url)node.properties.href=url;
    else{node.tagName='span';node.properties={};node.children=[...(node.children??[]),{type:'text',value:' ('+original+')'}];}
  }
  if(node.tagName==='img'){
    const props=node.properties??{},src=typeof props.src==='string'?image?.(props.src):'';
    if(!src){node.tagName='span';node.properties={};node.children=[{type:'text',value:t('panels.markdown.projectImages',props.alt?String(props.alt):'')+(typeof props.src==='string'?' ('+props.src+')':'')}];}
    else{
      node.properties={src};
      for(const key of ['alt','title'])if(typeof props[key]==='string')node.properties[key]=props[key];
      for(const key of ['width','height'])if(/^[1-9]\d{0,3}$/.test(String(props[key]))&&Number(props[key])<=2048)node.properties[key]=Number(props[key]);
    }
  }
  node.children?.forEach(visit);
};};
const theme:['github-dark','github-dark']=['github-dark','github-dark'];
// Positions come from the Markdown parser, after raw HTML has been sanitized.
const sourcePositionPlugin=()=>function visit(node:MarkdownNode){
 if(node.position&&/^(h[1-6]|p|li|blockquote|pre|table|tr)$/.test(node.tagName??''))node.properties={...node.properties,'data-source-start':node.position.start.line,'data-source-end':node.position.end.line};
 node.children?.forEach(visit);
};
const safeRemote=(url:string)=>{if(url.startsWith('#')&&linkFragment(url))return '#'+encodeURIComponent(linkFragment(url));try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)?parsed.href:'';}catch{return '';}};
function Copy({text,label}:{text:string;label:string}){const {text:displayText}=useLocale();const [feedback,setFeedback]=useState<UiText>('');useEffect(()=>setFeedback(''),[text]);return <span className="markdown-copy"><button type="button" className="quiet" onClick={async()=>{try{await navigator.clipboard.writeText(text);setFeedback(msg('panels.copy.success'));}catch{setFeedback(msg('panels.copy.select'));}}}>{label}</button><span role="status">{displayText(feedback)}</span></span>;}
function MarkdownImage({src,alt,title,width,height}:ComponentProps<'img'>){const {t}=useLocale();const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return failed?<span className="muted" role="status">{t('panels.markdown.imageFailed',alt||t('panels.markdown.imageReason'))}</span>:<img className="markdown-image" src={src} alt={alt??''} title={title} width={width} height={height} style={height?{height}:undefined} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>;}
function MarkdownImageNode(props:ComponentProps<'img'>|Record<string,unknown>){return <MarkdownImage {...props as ComponentProps<'img'>}/>;}
function MarkdownCode(props:ComponentProps<'code'>&{node?:MarkdownNode;'data-block'?:string}){const {t}=useLocale();const incomplete=useIsCodeFenceIncomplete();if(!('data-block' in props))return <code>{props.children}</code>;const text=String(props.children??''),language=/language-([^\s]+)/.exec(props.className??'')?.[1]??'text';return <div data-source-start={props.node?.position?.start.line} data-source-end={props.node?.position?.end.line}>{language==='mermaid'?<MermaidBlock text={text} incomplete={incomplete}><Copy text={text} label={t('panels.markdown.copySource')}/></MermaidBlock>:<CodeBlock key={text} code={text} language={language} isIncomplete={incomplete} lineNumbers={false}><Copy text={text} label={t('panels.markdown.copyCode')}/></CodeBlock>}</div>;}
export function Markdown({text,streaming=false,resolveUrl=safeRemote,resolveImage,onLink,anchor,linkScope='chat',actions}:{text:string;streaming?:boolean;resolveUrl?:(url:string)=>string;resolveImage?:(url:string)=>string;onLink?:(url:string)=>boolean;anchor?:{fragment?:string};linkScope?:string;actions?:ReactNode}){
 const {locale,t}=useLocale();
 const root=useRef<HTMLDivElement>(null),scope=useId();
 const jump=(fragment:string)=>{
  const line=/^L([1-9]\d*)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.exec(fragment);
  let target:HTMLElement|undefined;
  if(line){
   const number=Number(line[1]),blocks=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-source-start]')??[]);
   target=blocks.filter(node=>Number(node.dataset.sourceStart)<=number&&Number(node.dataset.sourceEnd)>=number).at(-1)
    ??blocks.find(node=>Number(node.dataset.sourceStart)>=number)??blocks.at(-1);
  }else target=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-anchor]')??[]).find(node=>node.dataset.anchor===fragment);
  target?.scrollIntoView({block:'start'});
 };
 useEffect(()=>{
  const used=new Set<string>();
  for(const heading of root.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')??[]){
   const base=(heading.textContent??'').toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu,'').trim().replace(/\s/g,'-');
   let slug=base,index=0;while(used.has(slug))slug=base+'-'+(++index);used.add(slug);
   heading.dataset.anchor=slug;heading.id='markdown-'+scope+'-'+slug;
  }
  if(root.current?.closest('.preview-shell'))for(const scroll of root.current.querySelectorAll<HTMLElement>('[data-streamdown="table-wrapper"]>div:last-child'))scroll.tabIndex=0;
  if(anchor?.fragment)jump(anchor.fragment);
 },[text,linkScope,anchor,scope]);
 const rehypePlugins=useMemo(()=>[imageHtmlPlugin,defaultRehypePlugins.raw,[linkPlugin,{resolve:resolveUrl,image:resolveImage,scope:linkScope,locale}] as [typeof linkPlugin,LinkOptions],defaultRehypePlugins.sanitize,sourcePositionPlugin,defaultRehypePlugins.harden],[resolveUrl,resolveImage,linkScope,locale]);const components:Components={code:MarkdownCode,strong:({children})=><strong>{children}</strong>,a:({href,children})=>{const url=safeRemote(href??'');return url?<a href={url} onClick={event=>{if(onLink?.(href??''))event.preventDefault();else if(url.startsWith('#')){event.preventDefault();jump(linkFragment(url));}}} {...(url.startsWith('#')?{}:{target:'_blank',rel:'noopener noreferrer'})}>{children}</a>:<span>{children}</span>;},img:MarkdownImageNode,input:({checked})=><input type="checkbox" checked={!!checked} disabled aria-label={checked?t('panels.markdown.completed'):t('panels.markdown.incomplete')}/>};return <div ref={root} className="markdown-message" data-streaming={streaming}><Streamdown key={linkScope} mode={streaming?'streaming':'static'} isAnimating={streaming} parseIncompleteMarkdown={streaming} plugins={streaming?{}:{code:checkedCode}} shikiTheme={theme} components={components} rehypePlugins={rehypePlugins} skipHtml urlTransform={safeRemote} controls={{code:false,table:false,image:false,mermaid:false}} lineNumbers={false} tableMaxHeight={0} codeBlockMaxHeight={0}>{text}</Streamdown><div className="message-actions"><Copy text={text} label={t('panels.markdown.copy')}/>{actions}</div></div>;}
