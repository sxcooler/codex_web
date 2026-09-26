import {useEffect,useMemo,useState,type ComponentProps} from 'react';
import {Streamdown,CodeBlock,defaultRehypePlugins,useIsCodeFenceIncomplete,type CodeHighlighterPlugin,type Components} from 'streamdown';
import {code} from '@streamdown/code';
import {MermaidBlock} from './MermaidBlock.tsx';
type HighlightResult=NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;
const plainTokens=(text:string):HighlightResult=>({tokens:text.split('\n').map(content=>[{content}])});
const nativeCode:CodeHighlighterPlugin=code;
// ponytail: upstream caches only code edges/length; keep exact source until its cache key is fixed.
const checkedCode:CodeHighlighterPlugin={...code,highlight(options,callback){const check=(result:HighlightResult)=>result.tokens.map(line=>line.map(token=>token.content).join('')).join('\n')===options.code?result:plainTokens(options.code);const result=nativeCode.highlight(options,callback?value=>callback(check(value)):undefined);return result?check(result):null;}};
type MarkdownNode={type?:string;value?:string;tagName?:string;properties?:Record<string,unknown>;children?:MarkdownNode[]};
type LinkOptions={resolve:(url:string)=>string;image?:(url:string)=>string;scope:string};
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
const linkPlugin=({resolve,image}:LinkOptions)=>function visit(node:MarkdownNode){
  if(node.tagName==='a'&&typeof node.properties?.href==='string')node.properties.href=resolve(node.properties.href);
  if(node.tagName==='img'){
    const props=node.properties??{},src=typeof props.src==='string'?image?.(props.src):'';
    if(!src){node.tagName='span';node.properties={};node.children=[{type:'text',value:'[仅支持项目内图片'+(props.alt?'：'+String(props.alt):'')+']'}];}
    else{
      node.properties={src};
      for(const key of ['alt','title'])if(typeof props[key]==='string')node.properties[key]=props[key];
      for(const key of ['width','height'])if(/^[1-9]\d{0,3}$/.test(String(props[key]))&&Number(props[key])<=2048)node.properties[key]=Number(props[key]);
    }
  }
  node.children?.forEach(visit);
};
const theme:['github-dark','github-dark']=['github-dark','github-dark'];
const safeRemote=(url:string)=>{if(/^#[a-zA-Z0-9_-]+$/.test(url))return url;try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)?parsed.href:'';}catch{return '';}};
function Copy({text,label}:{text:string;label:string}){const [feedback,setFeedback]=useState('');useEffect(()=>setFeedback(''),[text]);return <span className="markdown-copy"><button type="button" className="quiet" onClick={async()=>{try{await navigator.clipboard.writeText(text);setFeedback('已复制');}catch{setFeedback('复制失败，请选择文本复制');}}}>{label}</button><span role="status">{feedback}</span></span>;}
function MarkdownImage({src,alt,title,width,height}:ComponentProps<'img'>){const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return failed?<span className="muted" role="status">[图片无法加载：{alt||'文件可能不存在、不可读或超过预览限制'}]</span>:<img className="markdown-image" src={src} alt={alt??''} title={title} width={width} height={height} style={height?{height}:undefined} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>;}
function MarkdownCode(props:ComponentProps<'code'>&{node?:unknown;'data-block'?:string}){const incomplete=useIsCodeFenceIncomplete();if(!('data-block' in props))return <code>{props.children}</code>;const text=String(props.children??''),language=/language-([^\s]+)/.exec(props.className??'')?.[1]??'text';if(language==='mermaid')return <MermaidBlock text={text} incomplete={incomplete}><Copy text={text} label="复制源码"/></MermaidBlock>;return <CodeBlock key={text} code={text} language={language} isIncomplete={incomplete} lineNumbers={false}><Copy text={text} label="复制代码"/></CodeBlock>;}
export function Markdown({text,streaming=false,resolveUrl=safeRemote,resolveImage,onLink,linkScope='chat'}:{text:string;streaming?:boolean;resolveUrl?:(url:string)=>string;resolveImage?:(url:string)=>string;onLink?:(url:string)=>boolean;linkScope?:string}){const rehypePlugins=useMemo(()=>[imageHtmlPlugin,defaultRehypePlugins.raw,[linkPlugin,{resolve:resolveUrl,image:resolveImage,scope:linkScope}] as [typeof linkPlugin,LinkOptions],defaultRehypePlugins.sanitize,defaultRehypePlugins.harden],[resolveUrl,resolveImage,linkScope]);const components:Components={code:MarkdownCode,strong:({children})=><strong>{children}</strong>,a:({href,children})=>{const url=safeRemote(href??'');return url?<a href={url} onClick={event=>{if(onLink?.(href??''))event.preventDefault();}} {...(url.startsWith('#')?{}:{target:'_blank',rel:'noopener noreferrer'})}>{children}</a>:<span>{children}</span>;},img:({src,alt,title,width,height})=><MarkdownImage src={src} alt={alt} title={title} width={width} height={height}/>,input:({checked})=><input type="checkbox" checked={!!checked} disabled aria-label={checked?'已完成':'未完成'}/>};return <div className="markdown-message" data-streaming={streaming}><Streamdown key={linkScope} mode={streaming?'streaming':'static'} isAnimating={streaming} parseIncompleteMarkdown={streaming} plugins={streaming?{}:{code:checkedCode}} shikiTheme={theme} components={components} rehypePlugins={rehypePlugins} skipHtml urlTransform={safeRemote} controls={{code:false,table:false,image:false,mermaid:false}} lineNumbers={false} tableMaxHeight={0} codeBlockMaxHeight={0}>{text}</Streamdown><Copy text={text} label="复制 Markdown"/></div>;}
