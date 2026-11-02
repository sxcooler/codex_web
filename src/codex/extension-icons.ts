import {open,realpath,lstat,opendir} from 'node:fs/promises';
import {isAbsolute,resolve,relative,sep,extname,parse} from 'node:path';
import sharp from 'sharp';
import {XMLParser,XMLValidator} from 'fast-xml-parser';

const pngMagic=Buffer.from([137,80,78,71,13,10,26,10]);
const inside=(root:string,path:string)=>{const scope=relative(root,path);return !!scope&&scope!=='..'&&!scope.startsWith('..'+sep)&&!isAbsolute(scope);};
const same=(a:string,b:string)=>relative(a,b)==='';
type CacheIdentity={marketplace:string;name:string;version?:string|null};
const component=(v:unknown):v is string=>typeof v==='string'&&/^[\w][\w.+-]{0,199}$/.test(v);
export function readAppIconUrl(dark:unknown,light:unknown):string|null{
 for(const value of [dark,light])try{
  if(typeof value!=='string'||value.length>4096||/[\x00-\x20\x7f\\]/.test(value)||!/^https:\/\/(?:files\.openai\.com|chatgpt\.com)(?=\/|[?#]|$)/i.test(value))continue;
  const url=new URL(value);
  if(url.hostname==='chatgpt.com'&&!/^\/images\/ecosystem\/apps\/(?:[\w-]+\/)+icon(?:_dark)?\.png$/.test(url.pathname))continue;
  return value;
 }catch{/* Invalid branding falls back to the next native image or the generic icon. */}
 return null;
}
const svgTags=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','mask','title','desc','use']);
function safeSvg(bytes:Buffer){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\s*<\?xml\s[^?]*\?>/,'');
 if(/\0|<!DOCTYPE|<!ENTITY|<\?/i.test(text)||XMLValidator.validate(text)!==true)return false;
 const parsed=new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false}).parse(text);
 // Only self-contained vector graphics reach librsvg; no CSS, scripts, entities or external resources.
 const visit=(value:any,depth:number):boolean=>{
  if(depth>32)return false;if(Array.isArray(value))return value.every(v=>visit(v,depth+1));if(!value||typeof value!=='object')return true;
  return Object.entries(value).every(([key,v])=>{
   if(key.startsWith('@_')){const name=key.slice(2),s=String(v);if(name==='xmlns')return s==='http://www.w3.org/2000/svg';if(name==='xmlns:xlink')return s==='http://www.w3.org/1999/xlink';
    if(/^on/i.test(name)||name==='style'||name==='xml:base'||/[\\@]/.test(s))return false;
    if(name==='href'||name==='xlink:href')return /^#[\w.:-]+$/.test(s);
    return !/url\s*\(/i.test(s)||/^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(s);
   }
   return key==='#text'||svgTags.has(key)&&visit(v,depth+1);
  });
 };
 return Object.keys(parsed).length===1&&Object.hasOwn(parsed,'svg')&&visit(parsed,0);
}

export function createPluginIconReader(home:string){
 const roots=realpath(home).then(async base=>({base,cache:await realpath(resolve(base,'plugins/cache')).then(cache=>same(resolve(base,'plugins/cache'),cache)?cache:null).catch(()=>null)})).catch(()=>null);let attempts=0,inputBytes=0,outputBytes=0;
 const readBytes=async(canonical:string,limit:number)=>{
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
   const before=await lstat(canonical,{bigint:true});if(!before.isFile()||before.size<8n||before.size>BigInt(limit)||inputBytes+Number(before.size)>4194304)return null;
   inputBytes+=Number(before.size);file=await open(canonical,'r');const opened=await file.stat({bigint:true});
   // Windows has no O_NOFOLLOW: verify the opened identity before reading a bounded buffer.
   if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||!same(await realpath(canonical),canonical))return null;
   const buffer=Buffer.alloc(Number(opened.size)+1),result=await file.read(buffer,0,buffer.length,0),after=await file.stat({bigint:true});
   if(result.bytesRead!==Number(opened.size)||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||!same(await realpath(canonical),canonical))return null;
   return buffer.subarray(0,result.bytesRead);
  }catch{return null;}finally{await file?.close().catch(()=>{});}
 };
 const readLocal=async(path:string,verifiedPackageRoot?:unknown):Promise<string|null>=>{
  try{
   const extension=extname(path).toLowerCase();if(!['.png','.jpg','.jpeg','.webp','.gif','.svg'].includes(extension))return null;
   const trusted=await roots;if(!trusted)return null;const canonical=await realpath(path);let packageRoot:string|null=null;
   if(verifiedPackageRoot!==undefined||!(trusted.cache&&inside(trusted.cache,canonical))){
    if(typeof verifiedPackageRoot!=='string'||!isAbsolute(verifiedPackageRoot))return null;
    packageRoot=await realpath(verifiedPackageRoot);
    if(!same(resolve(verifiedPackageRoot),packageRoot)||same(packageRoot,parse(packageRoot).root)||same(packageRoot,trusted.base)||inside(packageRoot,trusted.base)||!inside(packageRoot,canonical))return null;
    const manifest=resolve(packageRoot,'.codex-plugin/plugin.json');if(!same(await realpath(manifest),manifest)||!(await lstat(manifest)).isFile())return null;
   }
   const bytes=await readBytes(canonical,1048576);if(!bytes||!same(await realpath(path),canonical)||packageRoot&&!same(await realpath(verifiedPackageRoot as string),packageRoot))return null;
   const format=extension==='.svg'?'svg':bytes.subarray(0,8).equals(pngMagic)?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))?'gif':bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP'?'webp':null;
   if(!format||format==='svg'&&!safeSvg(bytes))return null;
   const image=sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}),metadata=await image.metadata();
   if(metadata.format!==format||!metadata.width||!metadata.height||metadata.width*metadata.height>40_000_000)return null;
   const rendered=await image.rotate().resize({width:96,height:96,fit:'inside',withoutEnlargement:true}).png().toBuffer(),embedded='data:image/png;base64,'+rendered.toString('base64');
   if(outputBytes+Buffer.byteLength(embedded)>1048576)return null;outputBytes+=Buffer.byteLength(embedded);return embedded;
  }catch{return null;}
 };
 const cachedIcon=async(identity:CacheIdentity,requestedPath?:string):Promise<string|null>=>{
  try{
   if(!identity||!component(identity.marketplace)||!component(identity.name)||identity.version!=null&&!component(identity.version))return null;
   const trusted=await roots;if(!trusted?.cache)return null;const parent=resolve(trusted.cache,identity.marketplace,identity.name);let version=identity.version;
   if(version==null){const directory=await opendir(parent);let entries=0;try{for await(const entry of directory){if(++entries>32||entry.isSymbolicLink())return null;if(entry.isDirectory()){if(version!=null)return null;version=entry.name;}}}finally{await directory.close().catch(()=>{});}}
   if(!component(version))return null;const pkg=resolve(parent,version),canonical=await realpath(pkg);if(!same(pkg,canonical)||!inside(trusted.cache,canonical))return null;
   const manifestPath=resolve(pkg,'.codex-plugin/plugin.json');if(!same(await realpath(manifestPath),manifestPath))return null;
   const bytes=await readBytes(manifestPath,65536);if(!bytes)return null;const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(manifest.name!==identity.name||manifest.version!==version)return null;
   if(requestedPath!==undefined)return inside(pkg,resolve(requestedPath))&&inside(pkg,await realpath(requestedPath))?await readLocal(requestedPath,pkg):null;
   const logo=manifest.interface?.logoDark??manifest.interface?.logo;if(typeof logo!=='string'||logo.length>4096||isAbsolute(logo)||/[\x00-\x1f]/.test(logo))return null;
   const path=resolve(pkg,logo);if(!inside(pkg,path)||!inside(pkg,await realpath(path)))return null;return await readLocal(path,pkg);
  }catch{return null;}
 };
 return async(path:unknown,verifiedPackageRoot?:unknown,cacheIdentity?:CacheIdentity):Promise<string|null>=>{
  if(typeof path!=='string'||/^[/\\]{2}/.test(path)||attempts>=32)return null;attempts++;
  // Native remote identity always narrows the boundary; legacy calls without it retain cache-only reads.
  if(isAbsolute(path))return cacheIdentity!==undefined?cachedIcon(cacheIdentity,path):readLocal(path,verifiedPackageRoot);
  try{
   if(/[\x00-\x20\\]/.test(path)||/^https:\/\/[^/?#]*@/i.test(path))return null;const url=new URL(path);
   if(url.protocol!=='https:'||url.hostname!=='files.openai.com'||url.port||url.username||url.password)return null;
   if(cacheIdentity){const cached=await cachedIcon(cacheIdentity);if(cached)return cached;}
   if(outputBytes+Buffer.byteLength(path)>1048576)return null;outputBytes+=Buffer.byteLength(path);return path;
  }catch{return null;}
 };
}
