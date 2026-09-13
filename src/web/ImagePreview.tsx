import {useState} from 'react';
import type {Json} from './api.ts';

export const imagePath=(path:string)=>/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path);

export function ImagePreview({id,path,version,revision}:{id:string;path:string;version:string;revision?:string}){
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const src='/api/sessions/'+encodeURIComponent(id)+'/files/image?path='+encodeURIComponent(path)+'&v='+encodeURIComponent(version)+(revision?'&revision='+encodeURIComponent(revision):'');
  return <div className="image-preview">
    {status==='loading'?<p className="muted" role="status">读取图片…</p>:null}
    {status==='error'?<p className="notice error" role="alert">图片预览不可用，请检查文件是否已变更、损坏或超过限制。</p>:null}
    <img src={src} alt={path} hidden={status==='error'} onLoad={()=>setStatus('ready')} onError={()=>setStatus('error')}/>
    {status==='ready'?<a href={src} target="_blank" rel="noopener noreferrer">在新标签页查看预览</a>:null}
    <p className="muted small">预览最长边 2048 像素；动图显示首帧。支持 10 MiB / 4000 万像素以内的图片。</p>
  </div>;
}
export function ImageDiff({id,images,version,split=false}:{id:string;images:Json;version:string;split?:boolean}){
  return <div className={'image-diff'+(split?' split':'')}>{(['before','after'] as const).map(side=>{
    const source=images[side];
    return <section key={side}><h4>{side==='before'?'变更前':'变更后'}</h4>{source?<ImagePreview key={id+'|'+source.path+'|'+source.revision+'|'+version} id={id} path={source.path} revision={source.revision} version={version}/>:<p className="muted">此版本中不存在（{side==='before'?'新增':'已删除'}）。</p>}</section>;
  })}</div>;
}
