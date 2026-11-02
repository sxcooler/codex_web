import fs from 'node:fs/promises';
import {constants,type Stats} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';

export type SkillTarget={scope:'user'|'repo';name:string;legacy?:true};
export type SkillDocument={content:string;version:string;exists:boolean;files:Array<{name:string;kind:'file'|'directory'|'link'|'other'}>;filesTruncated:boolean};
const MAX=262144,locks=new Map<string,Promise<unknown>>();
const error=(statusCode:number,code:string,message:string)=>Object.assign(new Error(message),{statusCode,code});
const invalid=()=>error(400,'EXTENSION_SKILL_INVALID','技能名称、内容或文件版本无效；只允许不超过 256 KiB 的 UTF-8 SKILL.md。');
const unsafe=()=>error(409,'EXTENSION_SKILL_UNSAFE','技能文件或父目录包含链接、越界或已发生变化，请重新核对。');
const conflict=()=>error(409,'EXTENSION_SKILL_CONFLICT','技能文件已变化，请重新读取并比较，不能覆盖旧版本。');
const unknown=()=>error(504,'EXTENSION_WRITE_UNKNOWN','技能文件操作结果待核实，请先刷新核对，勿重复执行。');
const pathKey=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino;
const optionalStat=(path:string)=>fs.lstat(path).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});
function metadata(content:string){
 const header=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.replace(/^\uFEFF/,''))?.[1];if(!header)throw invalid();
 const scalar=(field:string)=>{const value=new RegExp('^'+field+':[ \\t]*(.+)$','m').exec(header)?.[1]?.trim();if(!value)return '';return value[0]==='"'&&value.at(-1)==='"'||value[0]==="'"&&value.at(-1)==="'"?value.slice(1,-1):value;};
 const name=scalar('name'),description=scalar('description');if(name.length>64||!/[a-z0-9]/.test(name)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||!description||['|','>'].includes(description)&&!/^description:[^\n]*\n[ \t]+\S/m.test(header))throw invalid();
 // This checks required header fields; native forceReload validates the full skill format.
}
type Location={path:string;directory:string;directories:Array<{path:string;info:Stats}>;missing:boolean};

export class SkillFiles {
 private home:string;private cwd:string;
 constructor(home:string,cwd:string){this.home=home;this.cwd=cwd;}
 fromNative(skill:any):SkillTarget{
  if(!skill||!['user','repo'].includes(skill.scope)||skill.pluginId||typeof skill.path!=='string'||!isAbsolute(skill.path))throw error(409,'EXTENSION_SKILL_READ_ONLY','系统、受管、插件拥有或来源未核实的技能不能修改。');
  const name=basename(dirname(skill.path)),scope=skill.scope as SkillTarget['scope'];
  const modern=scope==='user'?join(this.home,'skills',name,'SKILL.md'):join(this.cwd,'.agents','skills',name,'SKILL.md');
  if(pathKey(skill.path)===pathKey(modern))return {scope,name};
  if(scope==='repo'&&pathKey(skill.path)===pathKey(join(this.cwd,'.codex','skills',name,'SKILL.md')))return {scope,name,legacy:true};
  throw error(409,'EXTENSION_SKILL_READ_ONLY','原生技能路径不在已核实的用户或当前项目技能目录中。');
 }
 private validate(target:SkillTarget){
  if(!target||!['user','repo'].includes(target.scope)||typeof target.name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(target.name)||target.name.endsWith('.')||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(target.name)||target.legacy!==undefined&&target.legacy!==true||target.legacy&&target.scope!=='repo')throw invalid();
 }
 path(target:SkillTarget){this.validate(target);return target.scope==='user'?join(this.home,'skills',target.name,'SKILL.md'):join(this.cwd,target.legacy?'.codex':'.agents','skills',target.name,'SKILL.md');}
 private async location(target:SkillTarget,create=false):Promise<Location>{
  this.validate(target);const base=resolve(target.scope==='user'?this.home:this.cwd),parts=target.scope==='user'?['skills',target.name]:[target.legacy?'.codex':'.agents','skills',target.name],directories:Location['directories']=[];
  if(!isAbsolute(target.scope==='user'?this.home:this.cwd))throw unsafe();
  let current=base,missing=false;
  for(const part of ['',...parts]){
   if(part)current=join(current,part);let info=await optionalStat(current);
   if(!info&&create){if(current===base||target.legacy)throw unsafe();try{await fs.mkdir(current);}catch(e:any){if(e.code!=='EEXIST')throw e;}info=await fs.lstat(current);}
   if(!info){missing=true;continue;}
   if(missing||!info.isDirectory()||info.isSymbolicLink()||pathKey(await fs.realpath(current))!==pathKey(current))throw unsafe();
   directories.push({path:current,info});
  }
  return {path:join(current,'SKILL.md'),directory:current,directories,missing};
 }
 private async check(location:Location){for(const {path,info}of location.directories){const current=await fs.lstat(path);if(!current.isDirectory()||current.isSymbolicLink()||!same(current,info)||pathKey(await fs.realpath(path))!==pathKey(path))throw unsafe();}}
 private async files(location:Location){
  if(location.missing)return {files:[],filesTruncated:false};const files:SkillDocument['files']=[];let filesTruncated=false;
  const dir=await fs.opendir(location.directory);for await(const entry of dir){if(files.length===100){filesTruncated=true;break;}files.push({name:entry.name,kind:entry.isSymbolicLink()?'link':entry.isFile()?'file':entry.isDirectory()?'directory':'other'});}return {files:files.sort((a,b)=>a.name.localeCompare(b.name)),filesTruncated};
 }
 private async snapshot(location:Location):Promise<SkillDocument>{
  await this.check(location);const info=location.missing?null:await optionalStat(location.path),impact=await this.files(location);
  if(!info)return {content:'',version:'missing',exists:false,...impact};
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>MAX||pathKey(await fs.realpath(location.path))!==pathKey(location.path))throw unsafe();
  const handle=await fs.open(location.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=await handle.stat();if(!same(before,info)||!before.isFile())throw unsafe();const buffer=Buffer.alloc(MAX+1);let length=0;
   for(;;){const read=await handle.read(buffer,length,buffer.length-length,null);length+=read.bytesRead;if(length>MAX)throw unsafe();if(!read.bytesRead)break;}
   const after=await handle.stat(),current=await fs.lstat(location.path);if(!same(before,current)||current.isSymbolicLink()||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||current.size!==after.size||current.mtimeMs!==after.mtimeMs||current.ctimeMs!==after.ctimeMs)throw unsafe();
   const bytes=buffer.subarray(0,length);let content:string;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw invalid();}if(content.includes('\0'))throw invalid();await this.check(location);
   return {content,version:'sha256:'+createHash('sha256').update(bytes).digest('hex'),exists:true,...impact};
  }finally{await handle.close();}
 }
 async read(target:SkillTarget){try{return await this.snapshot(await this.location(target));}catch(e:any){if(e.statusCode)throw e;throw error(503,'EXTENSION_SKILL_READ_FAILED','无法读取技能文件，请核对目录权限。');}}
 private async lock<T>(target:SkillTarget,operation:()=>Promise<T>){const key=pathKey(this.path(target)),prior=locks.get(key);const pending=(prior??Promise.resolve()).catch(()=>{}).then(operation);locks.set(key,pending);try{return await pending;}finally{if(locks.get(key)===pending)locks.delete(key);}}
 async save(target:SkillTarget,input:{expectedVersion:string;content:string}){
  if(!input||typeof input.expectedVersion!=='string'||!input.expectedVersion||input.expectedVersion.length>512||typeof input.content!=='string'||Buffer.byteLength(input.content)>MAX||input.content.includes('\0')||new TextDecoder('utf-8',{ignoreBOM:true}).decode(Buffer.from(input.content))!==input.content)throw invalid();
  metadata(input.content);
  return this.lock(target,async()=>{
   const before=await this.read(target);if(before.version!==input.expectedVersion)throw conflict();if(target.legacy&&!before.exists)throw unsafe();
   if(!before.exists&&(target.name.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.name)))throw invalid();
   const location=await this.location(target,true),temporary=join(location.directory,'.SKILL.'+randomUUID()+'.tmp');let replaced=false,tempInfo:Stats|undefined;
   if(!before.exists){
    await this.check(location);let created;
    try{created=await fs.open(location.path,'wx',0o600);}catch(e:any){if(e.code==='EEXIST')throw conflict();throw error(503,'EXTENSION_SKILL_WRITE_FAILED','无法独占创建技能文件，请刷新核对。');}
    try{await created.writeFile(input.content);await created.sync();await created.close();const after=await this.snapshot(location);if(after.content!==input.content)throw unknown();return after;}
    catch{throw unknown();}finally{await created.close().catch(()=>{});}
   }
   const handle=await fs.open(temporary,'wx',(await optionalStat(location.path))?.mode!&0o777||0o600);
   try{tempInfo=await handle.stat();await handle.writeFile(input.content);await handle.sync();const current=await this.snapshot(location);if(current.version!==input.expectedVersion)throw conflict();await this.check(location);
    const currentTemp=await fs.lstat(temporary);if(!currentTemp.isFile()||currentTemp.isSymbolicLink()||!same(currentTemp,tempInfo))throw unsafe();
    // Hash recheck + rename cannot lock out an external editor between those operations.
    await fs.rename(temporary,location.path);replaced=true;await handle.close();const after=await this.snapshot(location);if(after.content!==input.content)throw unknown();return after;
   }catch(e:any){if(replaced)throw unknown();if(e.statusCode)throw e;throw error(503,'EXTENSION_SKILL_WRITE_FAILED','技能文件未能保存，请重新读取核对；原文件未被预先删除。');}
   finally{await handle.close().catch(()=>{});if(!replaced&&tempInfo)try{await this.check(location);const current=await fs.lstat(temporary);if(current.isFile()&&!current.isSymbolicLink()&&same(current,tempInfo))await fs.unlink(temporary);}catch{/* Leave uncertain paths untouched. */}}
  });
 }
 async remove(target:SkillTarget,expectedVersion:string){
  if(typeof expectedVersion!=='string'||!expectedVersion||expectedVersion.length>512)throw invalid();
  return this.lock(target,async()=>{
   const location=await this.location(target),before=await this.snapshot(location);if(!before.exists||before.version!==expectedVersion)throw conflict();
   if(before.filesTruncated||before.files.length!==1||before.files[0].name!=='SKILL.md'||before.files[0].kind!=='file')throw error(409,'EXTENSION_SKILL_NOT_EMPTY','技能目录包含其他文件，不能从 Web 递归删除；请先在原生宿主审阅。');
   await this.check(location);const current=await this.snapshot(location);if(current.version!==expectedVersion)throw conflict();if(current.filesTruncated||current.files.length!==1)throw error(409,'EXTENSION_SKILL_NOT_EMPTY','技能目录影响已变化，请重新读取。');
   let removed=false;try{await fs.unlink(location.path);removed=true;await fs.rmdir(location.directory);if((await this.read(target)).exists)throw unknown();}
   catch(e:any){if(removed)throw unknown();if(e.statusCode)throw e;throw error(503,'EXTENSION_SKILL_WRITE_FAILED','技能未能移除，请重新读取后核对。');}
  });
 }
}
