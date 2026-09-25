import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export type Entry={path:string;size:number;sha256:string};
export type Manifest={platform:string;sourceCommit:string;nodeVersion:string;files:Entry[];schemaVersion?:number;runtimeFingerprint?:string};
export const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export const environmentFile=(path:string)=>path.startsWith('runtime/')||path.startsWith('node_modules/');
export function safePath(path:string){
  if(typeof path!=='string'||path.length>512||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f<>:"|?*]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)||['.local','.git','.codex'].includes(p.toLowerCase())))throw Error('Unsafe update path');
  return path;
}
export function appFile(path:string){
  safePath(path);
  return /^(src\/(server|codex)\/|src\/projects\.ts$|dist\/|docs\/|scripts\/)/.test(path)||/^(package(?:-lock)?\.json|README(?:_EN)?\.md|THIRD-PARTY-NOTICES\.txt|(?:Start|Stop|Status|Update)\.(?:cmd|sh))$/.test(path);
}
export function validateManifest(value:any):Manifest{
  if(!value||!['win32-x64','linux-x64'].includes(value.platform)||!/^\d+\.\d+\.\d+$/.test(value.nodeVersion)||!(/^[a-f0-9]{40}$/.test(value.sourceCommit))||!Array.isArray(value.files)||value.files.length>50000||value.schemaVersion!==undefined&&value.schemaVersion!==2)throw Error('Invalid portable manifest');
  const names=new Set<string>();
  for(const e of value.files){safePath(e.path);if((!environmentFile(e.path)&&!appFile(e.path))||names.has(e.path.toLowerCase())||!Number.isSafeInteger(e.size)||e.size<0||e.size>256*1024*1024||!(/^[a-f0-9]{64}$/.test(e.sha256)))throw Error('Invalid manifest file');names.add(e.path.toLowerCase());}
  if(!value.files.some((e:Entry)=>e.path==='package.json')||!value.files.some((e:Entry)=>e.path.startsWith('runtime/'))||!value.files.some((e:Entry)=>e.path.startsWith('node_modules/')))throw Error('Incomplete portable manifest');
  if(value.runtimeFingerprint&&value.runtimeFingerprint!==runtimeFingerprint(value))throw Error('Invalid runtime fingerprint');
  return value;
}
export function runtimeFingerprint(manifest:Manifest){return digest(Buffer.from(JSON.stringify([manifest.platform,manifest.nodeVersion,manifest.files.filter(e=>environmentFile(e.path)&&!/(^|\/)\.bin\/|\/\.package-lock\.json$/.test(e.path)).map(e=>[e.path,e.size,e.sha256]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'en'))])));}
export async function checkedPath(root:string,path:string){
  safePath(path);let current=root;
  for(const part of ['',...path.split('/')]){if(part)current=join(current,part);const stat=await lstat(current).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});if(stat?.isSymbolicLink())throw Error('Symbolic link in update path');}
  return join(root,path);
}
export async function verifyFiles(root:string,files:Entry[]){for(const e of files){const bytes=await readFile(await checkedPath(root,e.path));if(bytes.length!==e.size||digest(bytes)!==e.sha256)throw Error('File checksum mismatch: '+e.path);}}
