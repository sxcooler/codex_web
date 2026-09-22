import {createContext,useCallback,useContext,useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {defaultLayout,fitLayout,layoutKey,parseLayout,resizeLayout,type Layout} from './layout.ts';
import {AccountUsageButton,AccountUsageProvider} from './AccountUsage.tsx';
type Side='left'|'right';
type PaneState={layout:Layout;total:number;mobile:boolean;drawer:Side|null;leftVisible:boolean;rightVisible:boolean;rightAvailable:boolean;setRightAvailable:(value:boolean)=>void;toggle:(side:Side)=>void;adjust:(side:Side,delta:number,base?:Layout)=>void;save:()=>void;reset:()=>void;composerCollapsed:boolean;setComposerCollapsed:(value:boolean)=>void};
const Context=createContext<PaneState>(null!);
const visibilityKey='codex-web:panels:v1';
export const usePanes=()=>useContext(Context);
export function PaneLayout({children,className}:{children:ReactNode;className:string}) {
  const [composerCollapsed,setComposerCollapsed]=useState(false);
  const [layout,setLayout]=useState(()=>{try{return parseLayout(localStorage.getItem(layoutKey))??defaultLayout;}catch{return defaultLayout;}});
  const [shown,setShown]=useState(()=>{try{const v=JSON.parse(localStorage.getItem(visibilityKey)??'null');if(v?.version===1&&typeof v.left==='boolean'&&typeof v.right==='boolean')return {left:v.left as boolean,right:v.right as boolean};}catch{}return {left:true,right:true};});
  const [mobile,setMobile]=useState(()=>matchMedia('(max-width:1000px)').matches),[drawer,setDrawer]=useState<Side|null>(null);
  const current=useRef(layout);current.current=layout;
  const [width,setWidth]=useState(window.innerWidth),[rightAvailable,setRightAvailable]=useState(false),root=useRef<HTMLDivElement>(null),lastDrawer=useRef<Side|null>(null);
  const leftVisible=mobile?drawer==='left':shown.left,rightVisible=rightAvailable&&(mobile?drawer==='right':shown.right);
  useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));if(root.current)observer.observe(root.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{const media=matchMedia('(max-width:1000px)'),change=()=>{setMobile(media.matches);setDrawer(null);};media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  useEffect(()=>{try{localStorage.setItem(visibilityKey,JSON.stringify({version:1,...shown}));}catch{}},[shown]);
  useEffect(()=>{if(!rightAvailable)setDrawer(value=>value==='right'?null:value);},[rightAvailable]);
  useEffect(()=>{const close=()=>setDrawer(null);window.addEventListener('popstate',close);return()=>window.removeEventListener('popstate',close);},[]);
  useEffect(()=>{
    const previous=lastDrawer.current;lastDrawer.current=drawer;
    const frame=requestAnimationFrame(()=>{if(drawer)root.current?.querySelector<HTMLElement>(drawer==='left'?'.sidebar button':'.git-panel button')?.focus();else if(previous)root.current?.querySelector<HTMLElement>('[data-panel-toggle="'+previous+'"]')?.focus();});
    if(!drawer)return()=>cancelAnimationFrame(frame);
    const keyboard=(event:KeyboardEvent)=>{if(event.defaultPrevented||document.querySelector('dialog[open]'))return;if(event.key==='Escape'){event.preventDefault();setDrawer(null);}else if(event.key==='Tab'){
      const panel=root.current?.querySelector(drawer==='left'?'.sidebar':'.git-panel');
      const nodes=[...root.current?.querySelectorAll<HTMLElement>('.pane-toolbar button:not(:disabled)')??[],...panel?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')??[]].filter(el=>el.getClientRects().length>0);
      const index=nodes.indexOf(document.activeElement as HTMLElement),next=nodes[(index+(event.shiftKey?-1:1)+nodes.length)%nodes.length];if(next){event.preventDefault();next.focus();}
    }};window.addEventListener('keydown',keyboard);return()=>{cancelAnimationFrame(frame);window.removeEventListener('keydown',keyboard);};
  },[drawer]);
  const total=Math.max(0,width-22),[left,,right]=fitLayout(layout,total);
  const save=()=>{try{localStorage.setItem(layoutKey,JSON.stringify({version:1,...current.current}));}catch{}};
  const toggle=useCallback((side:Side)=>{if(mobile)setDrawer(value=>value===side?null:side);else setShown(value=>({...value,[side]:!value[side]}));},[mobile]);
  const adjust=(side:Side,delta:number,base=current.current)=>{const next=resizeLayout(base,total,side,delta,rightVisible,leftVisible);current.current=next;setLayout(next);};
  const reset=()=>{current.current=defaultLayout;setLayout(defaultLayout);setShown({left:true,right:true});setDrawer(null);try{localStorage.removeItem(layoutKey);}catch{}};
  return <Context.Provider value={{layout,total,mobile,drawer,leftVisible,rightVisible,rightAvailable,setRightAvailable,toggle,adjust,save,reset,composerCollapsed,setComposerCollapsed}}><AccountUsageProvider><div ref={root} className={className} data-left-open={leftVisible} data-right-open={rightVisible} data-drawer={drawer??''} style={{'--left-width':`${left}px`,'--right-width':`${right}px`} as CSSProperties}>{children}{mobile&&drawer?<button className="drawer-backdrop" aria-label="关闭侧栏" onClick={()=>setDrawer(null)}/>:null}</div></AccountUsageProvider></Context.Provider>;
}
export function PaneToolbar({children}:{children?:ReactNode}){
  const panes=usePanes();
  const button=(side:Side)=>{const shown=side==='left'?panes.leftVisible:panes.rightVisible,label=(shown?'收起':'展开')+(side==='left'?'左侧栏':'右侧栏');return <button type="button" className="quiet pane-toggle" data-panel-toggle={side} title={label} aria-label={label} aria-expanded={shown} aria-controls={side==='left'?'left-sidebar':'right-sidebar'} disabled={side==='right'&&!panes.rightAvailable} onClick={()=>panes.toggle(side)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d={side==='left'?'M9 4v16':'M15 4v16'}/><rect x={side==='left'?4:16} y="5" width="4" height="14" fill="currentColor" opacity={shown?'.35':'0'}/></svg></button>;};
  return <div className={'pane-toolbar'+(children?' session-toolbar':'')}>{button('left')}{children??<span className="muted small pane-brand">Codex Web</span>}<AccountUsageButton/>{button('right')}</div>;
}
export function PaneSeparator({side}:{side:Side}) {
  const panes=usePanes(),drag=useRef<{x:number;base:Layout}|null>(null),value=side==='left'?panes.layout.left:1-panes.layout.right;
  if(panes.mobile||!(side==='left'?panes.leftVisible:panes.rightVisible))return null;
  return <div className={`pane-separator pane-${side}`} role="separator" aria-label={side==='left'?'调整左侧栏宽度':'调整右侧栏宽度'} aria-orientation="vertical" tabIndex={0} aria-valuenow={Math.round(value*100)} aria-valuemin={Math.round((side==='left'?180:420+(panes.leftVisible?180:0))/panes.total*100)} aria-valuemax={Math.round((panes.total-(side==='left'?420+(panes.rightVisible?240:0):240))/panes.total*100)}
    onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,base:panes.layout};}}
    onPointerMove={event=>{if(drag.current)panes.adjust(side,event.clientX-drag.current.x,drag.current.base);}}
    onPointerUp={event=>{if(!drag.current)return;panes.save();drag.current=null;event.currentTarget.releasePointerCapture(event.pointerId);}}
    onPointerCancel={()=>{if(drag.current)panes.adjust(side,0,drag.current.base);drag.current=null;}}
    onKeyDown={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();panes.adjust(side,(event.key==='ArrowLeft'?-1:1)*panes.total*.01);panes.save();}}}/>;
}
