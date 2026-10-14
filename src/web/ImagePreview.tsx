import {useLocale} from './i18n/LocaleProvider.tsx';
import {useState} from 'react';
import type {Json} from './api.ts';

export const imagePath=(path:string)=>/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path);

export function NativeImages({threadId,turnId,item}:{threadId:string;turnId?:string;item:Json}){
  const {t}=useLocale();
  if(!turnId||!item.id)return null;
  const prefix='/api/sessions/'+encodeURIComponent(threadId)+'/turns/'+encodeURIComponent(turnId)+'/items/'+encodeURIComponent(item.id)+'/images/';
  return item.imagePreviews?.length?<div className="native-images">{item.imagePreviews.map((image:Json,index:number)=><NativeImage key={image.id} src={prefix+encodeURIComponent(image.id)} label={t('panels.image.history',index+1)}/>)}</div>:null;
}
function NativeImage({src,label}:{src:string;label:string}){
  const {t}=useLocale();
  const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  return <figure className="native-image">
    <a href={src+'?size=original'} target="_blank" rel="noopener noreferrer" aria-label={t('panels.image.viewOriginal',label)}><img key={attempt} className="history-image" src={src} alt={label} width="384" height="256" loading="lazy" decoding="async" hidden={failed} onError={()=>setFailed(true)}/></a>
    {failed?<figcaption role="status">{t('panels.image.failed')}<button type="button" className="quiet" onClick={()=>{setFailed(false);setAttempt(value=>value+1);}}>{t('panels.image.retry')}</button></figcaption>:<figcaption className="muted small">{t('panels.image.original')}</figcaption>}
  </figure>;
}

export function ImagePreview({id,path,version,revision,repository}:{id:string;path:string;version:string;revision?:string;repository?:string}){
  const {t}=useLocale();
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const src='/api/sessions/'+encodeURIComponent(id)+'/files/image?path='+encodeURIComponent(path)+'&v='+encodeURIComponent(version)+(revision?'&revision='+encodeURIComponent(revision)+(repository!==undefined?'&repository='+encodeURIComponent(repository):''):'');
  return <div className="image-preview">
    {status==='loading'?<p className="muted" role="status">{t('panels.image.loading')}</p>:null}
    {status==='error'?<p className="notice error" role="alert">{t('panels.image.unavailable')}</p>:null}
    <img src={src} alt={path} hidden={status==='error'} onLoad={()=>setStatus('ready')} onError={()=>setStatus('error')}/>
    {status==='ready'?<a href={src} target="_blank" rel="noopener noreferrer">{t('panels.image.open')}</a>:null}
    <p className="muted small">{t('panels.image.limits')}</p>
  </div>;
}
export function ImageDiff({id,images,version,split=false,repository}:{id:string;images:Json;version:string;split?:boolean;repository?:string}){
  const {t}=useLocale();
  return <div className={'image-diff'+(split?' split':'')}>{(['before','after'] as const).map(side=>{
    const source=images[side];
    return <section key={side}><h4>{side==='before'?t('panels.image.before'):t('panels.image.after')}</h4>{source?<ImagePreview key={JSON.stringify([id,repository,source.path,source.revision,version])} id={id} path={source.path} revision={source.revision} repository={repository} version={version}/>:<p className="muted">{t('panels.image.absent',side==='before')}</p>}</section>;
  })}</div>;
}
