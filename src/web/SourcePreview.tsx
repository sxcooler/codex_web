import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import type {CodeHighlighterPlugin} from '@streamdown/code';
import {checkedTokens,type HighlightResult} from './codeHighlight.ts';

type Language=Parameters<CodeHighlighterPlugin['highlight']>[0]['language'];
const extensions:Record<string,Language>={xml:'xml',xsd:'xml',xsl:'xml',xslt:'xml',svg:'xml',json:'json',jsonc:'jsonc',yaml:'yaml',yml:'yaml',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',ts:'typescript',mts:'typescript',cts:'typescript',tsx:'tsx',py:'python',ps1:'powershell',psm1:'powershell',psd1:'powershell',c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',hxx:'cpp',cs:'csharp',java:'java',go:'go',rs:'rust',rb:'ruby',php:'php',sh:'shellscript',bash:'shellscript',zsh:'shellscript',bat:'batch',cmd:'batch',sql:'sql',html:'html',htm:'html',css:'css',scss:'scss',less:'less',toml:'toml',ini:'ini',md:'markdown',markdown:'markdown',lua:'lua',r:'r',vue:'vue',svelte:'svelte',cmake:'cmake'};
const filenames:Record<string,Language>={dockerfile:'dockerfile',containerfile:'dockerfile',makefile:'makefile',gnumakefile:'makefile','cmakelists.txt':'cmake'};
const languageFor=(path:string)=>{const name=path.split(/[\\/]/).at(-1)?.toLowerCase()??'',extension=/\.([^.]+)$/.exec(name)?.[1]??'';return Object.hasOwn(filenames,name)?filenames[name]:Object.hasOwn(extensions,extension)?extensions[extension]:undefined;};

export function SourcePreview({path,text,anchor}:{path:string;text:string;anchor?:{fragment?:string}}){
 const target=useRef<HTMLElement>(null),language=languageFor(path);
 const lines=useMemo(()=>text.split('\n'),[text]),large=useMemo(()=>lines.length>5000||new TextEncoder().encode(text).byteLength>262144,[text,lines]);
 const [highlight,setHighlight]=useState<{path:string;text:string;result:HighlightResult}>();
 const result=highlight?.path===path&&highlight.text===text&&!large&&language?highlight.result:undefined;
 useEffect(()=>{
  let current=true,worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const finish=()=>{current=false;if(timer)clearTimeout(timer);worker?.terminate();};
  if(language&&!large){
   // Shiki normalizes CRLF; reinsert original CR characters when rendering each verified line.
   const codeText=text.replace(/\r\n/g,'\n');
   const deadline=performance.now()+2000;
   try{
    worker=new Worker(new URL('./sourceHighlight.worker.ts',import.meta.url),{type:'module'});
    timer=setTimeout(finish,Math.max(0,deadline-performance.now()));
    worker.onmessage=event=>{
     if(!current)return;
     try{if(performance.now()<deadline&&event.data)setHighlight({path,text,result:checkedTokens(codeText,event.data)});}catch{/* Invalid worker results keep the original plain text. */}
     finally{finish();}
    };
    worker.onerror=event=>{event.preventDefault();finish();};
    worker.onmessageerror=finish;
    worker.postMessage({code:codeText,language});
   }catch{finish();}
  }
  return finish;
 },[path,text,language,large]);
 useEffect(()=>{target.current?.scrollIntoView({block:'start'});},[path,text,anchor]);
 const rendered=result?lines.map((line,index)=><Fragment key={index}>{result.tokens[index]?.map((token,tokenIndex)=><span key={tokenIndex} style={{color:token.htmlStyle?.color??token.color}}>{token.content}</span>)}{line.endsWith('\r')&&index<lines.length-1?'\r':''}{index<lines.length-1?'\n':''}</Fragment>):null;
 const match=/^L([1-9]\d*)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/.exec(anchor?.fragment??''),start=match?Number(match[1])-1:-1,end=match?Math.max(start+1,Number(match[2]??match[1])):0;
 return <>{large?<p className="muted small source-preview-notice">文件较大，使用纯文本预览。</p>:null}<pre className="source-preview">{start>=0&&start<lines.length?<>{rendered?rendered.slice(0,start):lines.slice(0,start).map(line=>line+'\n').join('')}<mark ref={target}>{rendered?rendered.slice(start,end):lines.slice(start,end).map((line,index)=>line+(start+index<lines.length-1?'\n':'')).join('')}</mark>{rendered?rendered.slice(end):lines.slice(end).join('\n')}</>:rendered??text}</pre></>;
}
