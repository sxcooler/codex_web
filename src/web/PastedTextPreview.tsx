import {useEffect,useRef,useState} from 'react';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {PreviewShell} from './PreviewShell.tsx';
import {pastedTextPreview} from './pastedText.ts';

const previewBytes=256*1024;
export function PastedTextPreview({file}:{file:File}){
  const {t}=useLocale(),button=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false);
  const [preview,setPreview]=useState<{url:string;source?:string;failed?:boolean}|null>(null);
  useEffect(()=>{
    if(!open)return;
    let current=true;
    const url=URL.createObjectURL(file);setPreview({url});
    void (async()=>{
      try{const source=await pastedTextPreview(file);if(current)setPreview({url,source});}
      catch{if(current)setPreview({url,failed:true});}
    })();
    return()=>{current=false;URL.revokeObjectURL(url);};
  },[open,file]);
  const close=()=>{setOpen(false);setPreview(null);button.current?.focus({preventScroll:true});};
  return <><button ref={button} type="button" aria-label={t('session.attachment.previewPasted',file.name)} onClick={()=>setOpen(true)}>{t('session.attachment.preview')}</button>
    {open?<PreviewShell label={file.name} active resetKey={file.name} modal={{open,onClose:close}} controls={preview?<a href={preview.url} download={file.name}>{t('session.attachment.downloadFull')}</a>:null}>
      {file.size>previewBytes?<p role="status">{t('session.attachment.previewTruncated')}</p>:null}
      <div className="preview-content">{preview?.failed?<p role="alert">{t('session.attachment.previewFailed')}</p>:preview?.source!==undefined?<pre>{preview.source}</pre>:<p role="status">{t('session.attachment.previewLoading')}</p>}</div>
    </PreviewShell>:null}
  </>;
}
