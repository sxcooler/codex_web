import {useLocale} from './i18n/LocaleProvider.tsx';
import {memo,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Streamdown,type DiagramPlugin,type MermaidErrorComponentProps} from 'streamdown';

const controls={mermaid:{panZoom:true,fullscreen:false,copy:false,download:false}};
function DiagramError({chart}:MermaidErrorComponentProps){const {t}=useLocale();return <div className="mermaid-error" role="status"><p>{t('panels.mermaid.error')}</p><pre>{chart}</pre></div>;}
const options={config:{theme:'dark',securityLevel:'strict',startOnLoad:false,htmlLabels:false,flowchart:{htmlLabels:false},maxTextSize:20_000,maxEdges:300,
  secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','htmlLabels','flowchart','theme','themeCSS','themeVariables','fontFamily']},errorComponent:DiagramError};

export const MermaidBlock=memo(function MermaidBlock({text,incomplete,children}:{text:string;incomplete:boolean;children:ReactNode}){
  const {t}=useLocale();
  const translations={zoomIn:t('panels.mermaid.zoomIn'),zoomOut:t('panels.mermaid.zoomOut'),resetView:t('panels.mermaid.reset'),viewFullscreen:t('panels.preview.fullscreen'),exitFullscreen:t('panels.preview.exitFullscreen')};
  const ref=useRef<HTMLElement>(null);
  const dialogRef=useRef<HTMLDialogElement>(null),buttonRef=useRef<HTMLButtonElement>(null),normalSize=useRef<{width:string;height:string}|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [visible,setVisible]=useState(false),[source,setSource]=useState(false);
  const [plugins,setPlugins]=useState<{mermaid:DiagramPlugin}>(),[failed,setFailed]=useState(false);
  const oversized=text.length>20_000;
  const change=(next:boolean,restoreFocus=true,hideFocus=false)=>{
    const dialog=dialogRef.current,section=ref.current;if(!dialog||!section)return;
    const area=section.closest<HTMLElement>('.preview-content'),top=area?.scrollTop??0,left=area?.scrollLeft??0;
    // Keep the diagram's footprint while its modal leaves the document flow.
    if(next){const rect=section.getBoundingClientRect();normalSize.current={width:section.style.width,height:section.style.height};section.style.width=rect.width+'px';section.style.height=rect.height+'px';}
    if(dialog.open)dialog.close();
    // Inline open must not acquire focus or register another Esc close watcher.
    if(next)dialog.showModal();else dialog.open=true;
    if(!next&&normalSize.current){section.style.width=normalSize.current.width;section.style.height=normalSize.current.height;normalSize.current=null;}
    setExpanded(next);
    if(restoreFocus){buttonRef.current?.focus({preventScroll:true});buttonRef.current?.toggleAttribute('data-hide-focus',hideFocus);}
    if(area){area.scrollTop=top;area.scrollLeft=left;}
  };
  useLayoutEffect(()=>{const dialog=dialogRef.current;return()=>dialog?.close();},[]);
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
  return <section ref={ref} className="mermaid-preview" aria-label={t('panels.mermaid.diagram')}
    onWheelCapture={event=>{if(!expanded&&!event.altKey&&!event.ctrlKey)event.stopPropagation();}}
    onPointerDownCapture={event=>{if(!expanded&&event.pointerType==='touch')event.stopPropagation();}}>
    <dialog open ref={dialogRef} className="mermaid-dialog" role={expanded?'dialog':'region'} aria-label={expanded?t('panels.preview.fullscreen'):t('panels.mermaid.preview')} aria-modal={expanded?true:undefined} data-streamdown={expanded?'mermaid-fullscreen':undefined}
      onClose={()=>{if(dialogRef.current&&!dialogRef.current.open)change(false,false);}}
      onCancel={event=>{event.preventDefault();event.stopPropagation();change(false,true,true);}}
      onKeyDown={event=>{
        if(event.key!=='Escape')buttonRef.current?.removeAttribute('data-hide-focus');
        const dialog=dialogRef.current;if(!dialog?.matches(':modal'))return;event.stopPropagation();
        if(event.key==='Escape'){event.preventDefault();change(false,true,true);return;}
        if(event.key==='Tab'){
          const nodes=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(node=>node.getClientRects().length);
          if(event.shiftKey&&document.activeElement===nodes[0]||!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();(event.shiftKey?nodes.at(-1):nodes[0])?.focus({preventScroll:true});}
        }
      }}>
    <div className="mermaid-toolbar"><div><button type="button" aria-pressed={!showSource} disabled={incomplete||oversized||failed} onClick={()=>setSource(false)}>{t('panels.mermaid.graph')}</button><button type="button" aria-pressed={showSource} onClick={()=>setSource(true)}>{t('panels.files.source')}</button></div><div>{children}<button ref={buttonRef} type="button" className="mermaid-expand" disabled={!expanded&&(showSource||!plugins)} aria-label={expanded?t('panels.preview.exitFullscreen'):t('panels.preview.fullscreen')} title={expanded?t('panels.preview.exitFullscreen'):t('panels.preview.fullscreen')} aria-expanded={expanded} onBlur={event=>event.currentTarget.removeAttribute('data-hide-focus')} onClick={event=>change(!expanded,true,event.detail>0)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={expanded?'M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6':'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6'}/></svg></button></div></div>
    {incomplete?<p className="muted small">{t('panels.mermaid.generating')}</p>:oversized?<p className="muted small">{t('panels.mermaid.oversized')}</p>:failed?<p className="notice error" role="status">{t('panels.mermaid.failed')}</p>:null}
    {showSource?<pre className="mermaid-source">{text}</pre>:null}
    {!incomplete&&!oversized&&!failed?<div hidden={source} className="mermaid-rendered">
      {plugins?<Streamdown key={text} mode="static" plugins={plugins} mermaid={options} controls={controls} translations={translations} skipHtml>{fence+'mermaid\n'+text.trimEnd()+'\n'+fence}</Streamdown>:<p className="muted mermaid-placeholder">{visible?t('panels.mermaid.loading'):t('panels.mermaid.deferred')}</p>}
    </div>:null}
    </dialog>
  </section>;
});
