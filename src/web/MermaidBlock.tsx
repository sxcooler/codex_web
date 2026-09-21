import {memo,useEffect,useRef,useState,type ReactNode} from 'react';
import {Streamdown,type DiagramPlugin,type MermaidErrorComponentProps} from 'streamdown';

const translations={zoomIn:'放大',zoomOut:'缩小',resetView:'重置视图',viewFullscreen:'全屏查看',exitFullscreen:'退出全屏'};
const controls={mermaid:{panZoom:true,fullscreen:true,copy:false,download:false}};
function DiagramError({chart}:MermaidErrorComponentProps){return <div className="mermaid-error" role="status"><p>无法绘制此流程图，请检查 Mermaid 语法。源码仍可复制。</p><pre>{chart}</pre></div>;}
const options={config:{theme:'dark',securityLevel:'strict',startOnLoad:false,htmlLabels:false,flowchart:{htmlLabels:false},maxTextSize:20_000,maxEdges:300,
  secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','htmlLabels','flowchart','theme','themeCSS','themeVariables','fontFamily']},errorComponent:DiagramError};

export const MermaidBlock=memo(function MermaidBlock({text,incomplete,children}:{text:string;incomplete:boolean;children:ReactNode}){
  const ref=useRef<HTMLElement>(null);
  const [visible,setVisible]=useState(false),[source,setSource]=useState(false);
  const [plugins,setPlugins]=useState<{mermaid:DiagramPlugin}>(),[failed,setFailed]=useState(false);
  const oversized=text.length>20_000;
  useEffect(()=>{
    if(visible)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}});
    if(ref.current)observer.observe(ref.current);
    return ()=>observer.disconnect();
  },[visible]);
  useEffect(()=>{
    if(!visible||incomplete||oversized||plugins)return;
    let cancelled=false;
    void import('@streamdown/mermaid').then(module=>{if(!cancelled)setPlugins({mermaid:module.mermaid});}).catch(()=>{if(!cancelled)setFailed(true);});
    return ()=>{cancelled=true;};
  },[visible,incomplete,oversized,plugins]);
  const showSource=source||incomplete||oversized||failed;
  const fence=oversized?'```':'`'.repeat(Math.max(3,...(text.match(/`+/g)??[]).map(run=>run.length+1)));
  // Remount on source changes: upstream otherwise retains the last SVG after a parse error.
  return <section ref={ref} className="mermaid-preview" aria-label="Mermaid 流程图"
    onWheelCapture={event=>{if(!event.altKey&&!event.ctrlKey)event.stopPropagation();}}
    onPointerDownCapture={event=>{if(event.pointerType==='touch')event.stopPropagation();}}>
    <div className="mermaid-toolbar"><div><button type="button" aria-pressed={!showSource} disabled={incomplete||oversized||failed} onClick={()=>setSource(false)}>图形</button><button type="button" aria-pressed={showSource} onClick={()=>setSource(true)}>源码</button></div>{children}</div>
    {incomplete?<p className="muted small">流程图生成中…</p>:oversized?<p className="muted small">流程图超过预览上限，显示源码。</p>:failed?<p className="notice error" role="status">绘图模块加载失败，显示源码。请刷新后重试。</p>:null}
    {showSource?<pre className="mermaid-source">{text}</pre>:null}
    {!incomplete&&!oversized&&!failed?<div hidden={source} className="mermaid-rendered">
      {plugins?<Streamdown key={text} mode="static" plugins={plugins} mermaid={options} controls={controls} translations={translations} skipHtml>{fence+'mermaid\n'+text.trimEnd()+'\n'+fence}</Streamdown>:<p className="muted mermaid-placeholder">{visible?'正在加载流程图…':'流程图将在滚动到此处时加载。'}</p>}
    </div>:null}
  </section>;
});
