import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';

export function PreviewShell({children,label,filePath,controls,active,resetKey}:{children:ReactNode;label:string;filePath?:string;controls?:ReactNode;active:boolean;resetKey:string}){
  const {t,text}=useLocale();
  const dialogRef=useRef<HTMLDialogElement>(null),buttonRef=useRef<HTMLButtonElement>(null),switching=useRef(false),frame=useRef(0),[expanded,setExpanded]=useState(false);
  const [copied,setCopied]=useState<{path:string;message:UiText;success:boolean}|null>(null),slash=label.lastIndexOf('/');
  const feedback=copied?.path===filePath?copied:null;
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(null),1800);return()=>clearTimeout(timer);},[copied]);
  const change=(next:boolean,restoreFocus=true,hideFocus=false)=>{
    const dialog=dialogRef.current;if(!dialog)return;
    const area=dialog.querySelector<HTMLElement>('.preview-content'),top=area?.scrollTop??0,left=area?.scrollLeft??0,rect=area?.getBoundingClientRect();
    // Only inspect the viewport's first reading block, regardless of document length.
    let anchor:HTMLElement|null=null;
    const markdown=area?.querySelector<HTMLElement>('.markdown-message');
    if(rect&&markdown&&area){
      const readingRect=markdown.getBoundingClientRect();
      for(const dy of [8,24,48,72,96,128]){
        const point=document.elementFromPoint((Math.max(rect.left,readingRect.left)+Math.min(rect.right,readingRect.right))/2,rect.top+Math.min(dy,rect.height/2));
        const block=point?.closest<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,table,pre,blockquote');
        if(block&&area.contains(block)){anchor=block;break;}
      }
    }
    const offset=anchor&&rect?anchor.getBoundingClientRect().top-rect.top:0;
    switching.current=true;cancelAnimationFrame(frame.current);
    if(dialog.open)dialog.close();
    if(next)dialog.showModal();else dialog.show();
    setExpanded(next);
    // Keep restored focus after pointer/Esc dismissal without leaving a keyboard ring.
    if(restoreFocus){const button=buttonRef.current;button?.focus({preventScroll:true});button?.toggleAttribute('data-hide-focus',hideFocus);}
    const correct=()=>{if(area){area.scrollTop=top;area.scrollLeft=left;if(anchor&&rect)area.scrollTop+=anchor.getBoundingClientRect().top-area.getBoundingClientRect().top-offset;}};
    correct();
    frame.current=requestAnimationFrame(()=>{correct();frame.current=requestAnimationFrame(()=>{switching.current=false;area?.dispatchEvent(new Event('scroll'));});});
  };
  useLayoutEffect(()=>{const dialog=dialogRef.current;if(dialog&&!dialog.open)dialog.show();return()=>{cancelAnimationFrame(frame.current);dialog?.close();};},[]);
  useLayoutEffect(()=>{const dialog=dialogRef.current;for(const nested of dialog?.querySelectorAll<HTMLDialogElement>('dialog:modal')??[])nested.close();if(dialog?.matches(':modal'))change(false,false);},[active,resetKey]);
  return <dialog ref={dialogRef} className="file-preview preview-shell" role={expanded?'dialog':'region'} aria-label={label} aria-modal={expanded?true:undefined}
    onScrollCapture={event=>{if(switching.current)event.stopPropagation();}}
    onClose={()=>{if(dialogRef.current&&!dialogRef.current.open)change(false);}}
    onCancel={event=>{event.preventDefault();change(false,true,true);}}
    onKeyDown={event=>{
      if(event.key!=='Escape')buttonRef.current?.removeAttribute('data-hide-focus');
      const dialog=dialogRef.current;if(!dialog)return;
      if(event.key==='Escape'&&dialog.querySelector(':popover-open')){event.preventDefault();event.stopPropagation();dialog.querySelector<HTMLElement>(':popover-open')?.hidePopover();}
      if(!dialog.matches(':modal'))return;
      if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();change(false,true,true);return;}
      if(event.key==='Tab'){
        const nodes=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(node=>node.getClientRects().length&&!node.closest('[popover]:not(:popover-open)'));
        if(event.shiftKey&&document.activeElement===nodes[0]||!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();(event.shiftKey?nodes.at(-1):nodes[0])?.focus({preventScroll:true});}
      }
    }}>
    <div className="file-preview-toolbar"><div className="file-preview-header"><h3 title={label}>{slash>=0?<><span className="preview-directory">{label.slice(0,slash)}</span><span className="preview-path-separator">/</span></>:null}<span className="preview-filename">{label.slice(slash+1)}</span></h3>
    <button type="button" className="preview-copy" disabled={!filePath} aria-label={t('panels.preview.copyPath')} title={!filePath?t('panels.preview.noRoot'):feedback?text(feedback.message):t('panels.preview.copyPath')} data-copy-status={feedback?.success?'success':feedback?'error':undefined} onClick={async()=>{if(!filePath)return;try{await navigator.clipboard.writeText(filePath);setCopied({path:filePath,message:msg('panels.copy.success'),success:true});}catch{setCopied({path:filePath,message:msg('panels.copy.failure'),success:false});}}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{feedback?.success?<path d="m5 12 4 4L19 6"/>:feedback?<path d="m6 6 12 12M18 6 6 18"/>:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>}</svg></button>
    <button ref={buttonRef} type="button" className="preview-expand" aria-label={expanded?t('panels.preview.collapse'):t('panels.preview.fullscreen')} aria-expanded={expanded} title={expanded?t('panels.preview.inline'):t('panels.preview.fullscreen')} onBlur={event=>event.currentTarget.removeAttribute('data-hide-focus')} onClick={event=>change(!expanded,true,event.detail>0)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={expanded?'M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6':'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6'}/></svg></button>
    </div>
    {controls?<div className="file-preview-controls">{controls}</div>:null}
    <span role="status" className={'preview-copy-feedback'+(feedback?.success?' sr-only':'')} hidden={!feedback} data-error={feedback&&!feedback.success?true:undefined}>{feedback?text(feedback.message):''}</span></div>
    {children}
  </dialog>;
}
