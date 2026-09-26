export const relativeFile=(currentPath:string,url:string,decoded=false)=>{
  if(!decoded&&(/^[a-z][a-z0-9+.-]*:/i.test(url)||url.startsWith('#')||url.startsWith('//')))return '';
  let path:string;try{path=decoded?url:decodeURIComponent(url.split(/[?#]/,1)[0]);}catch{return '';}
  const parts=[...(path.startsWith('/')?[]:currentPath.split('/').slice(0,-1)),...path.split('/')],safe:string[]=[];
  for(const part of parts){if(!part||part==='.')continue;if(part==='..'){if(!safe.length)return '';safe.pop();}else safe.push(part);}
  return safe.join('/');
};
export const linkedFile=(id:string,currentPath:string,url:string,origin=location.origin)=>{try{const parsed=new URL(url,origin),prefix='/api/sessions/'+encodeURIComponent(id)+'/files/content';if(parsed.origin===origin&&parsed.pathname===prefix)return relativeFile('',parsed.searchParams.get('path')??'',true);}catch{}return relativeFile(currentPath,url);};
export const fileUrl=(id:string,currentPath:string,url:string,origin=location.origin)=>{
  if(/^#[a-zA-Z0-9_-]+$/.test(url))return url;
  try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)?parsed.href:'';}catch{}
  const relative=relativeFile(currentPath,url);
  return relative?origin+'/api/sessions/'+encodeURIComponent(id)+'/files/content?path='+encodeURIComponent(relative):'';
};

export const fileImageUrl=(id:string,currentPath:string,url:string,origin=location.origin)=>{
  let path:string;try{path=decodeURIComponent(url.trim().split(/[?#]/,1)[0]);}catch{return '';}
  if(!path||/[\\:\x00-\x1f\x7f]/.test(path)||path.startsWith('//'))return '';
  const relative=relativeFile(currentPath,path,true);
  return relative?origin+'/api/sessions/'+encodeURIComponent(id)+'/files/image?path='+encodeURIComponent(relative):'';
};

// Local links are translated to the existing authenticated project API, never file:// navigation.
export function chatFileUrl(id:string,projectRoot:string,url:string,origin=location.origin):string{
  if(/^https?:\/\//i.test(url)||url.startsWith('#'))return fileUrl(id,'',url,origin);
  if(!projectRoot)return '';
  let path:string;try{
    if(/^file:/i.test(url)){const file=new URL(url);if(file.host)return '';url=file.pathname;}
    path=decodeURIComponent(url.split(/[?#]/,1)[0]).replace(/\\/g,'/').replace(/:\d+(?::\d+)?$/,'').replace(/^\/([a-z]:\/)/i,'$1');
  }catch{return '';}
  if(path.startsWith('//')||/[\x00-\x1f]/.test(path))return '';
  const root=projectRoot.replace(/\\/g,'/').replace(/\/$/,''),windows=/^[a-z]:\//i.test(root);
  if(path.startsWith('/')||/^[a-z]:\//i.test(path)){
    const prefix=root+'/',matches=windows?path.toLowerCase().startsWith(prefix.toLowerCase()):path.startsWith(prefix);
    if(!matches)return '';
    path=path.slice(prefix.length);
  }
  if(/^[a-z][a-z0-9+.-]*:/i.test(path))return '';
  const relative=relativeFile('',path,true);
  return relative?origin+'/api/sessions/'+encodeURIComponent(id)+'/files/content?path='+encodeURIComponent(relative):'';
}
