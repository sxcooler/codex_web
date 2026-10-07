import {createHash,randomUUID} from 'node:crypto';
import fs,{type FileHandle} from 'node:fs/promises';
import {constants,type Stats} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {pathKey,type Projects} from '../projects.ts';

export type InstructionTarget={scope:'user'|'project';projectId?:string};
export type InstructionDocument={path:string;content:string;version:string;exists:boolean;writable:boolean;reason?:string;overriddenBy:string|null};
const MAX_BYTES=262144;
const BOM=Buffer.from([239,187,191]);
const missingVersion='missing';
const problem=(statusCode:number,code:string,message:string)=>Object.assign(new Error(message),{statusCode,code});
const unsafe=()=>problem(409,'INSTRUCTIONS_UNSAFE_TARGET','指令文件或父目录已变化，或包含不安全的链接，请重新读取。');
const identity=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino;
const stat=(path:string)=>fs.lstat(path).catch((error:any)=>{if(error.code==='ENOENT')return null;throw error;});
type Location={parent:string;path:string;info:Stats};
type Snapshot={document:InstructionDocument;bom:boolean;newline:string;info:Stats|null};

export class Instructions {
 private options:{codexHome:()=>Promise<string|null>;projects:Projects};
 private writes=new Map<string,Promise<InstructionDocument>>();
 constructor(options:{codexHome:()=>Promise<string|null>;projects:Projects}){this.options=options;}

 private async location(target:InstructionTarget):Promise<Location>{
  if(!target||!['user','project'].includes(target.scope)||Object.keys(target).some(key=>!['scope','projectId'].includes(key))||
   (target.scope==='user'?target.projectId!==undefined:typeof target.projectId!=='string'||!/^[a-f0-9]{24}$/.test(target.projectId)))
   throw problem(400,'INSTRUCTIONS_INVALID_INPUT','请选择个人指令或有效项目。');
  const parent=target.scope==='user'?await this.options.codexHome():(await this.options.projects.resolve(target.projectId!)).path;
  if(typeof parent!=='string'||!isAbsolute(parent))throw problem(503,'INSTRUCTIONS_HOME_UNAVAILABLE','当前原生进程未提供可靠的 Codex 主机目录，无法编辑个人指令。');
  const normalized=resolve(parent),info=await fs.lstat(normalized);
  if(!info.isDirectory()||info.isSymbolicLink()||pathKey(await fs.realpath(normalized))!==pathKey(normalized))throw unsafe();
  return {parent:normalized,path:join(normalized,'AGENTS.md'),info};
 }

 private async snapshot(location:Location):Promise<Snapshot>{
  const {path,parent}=location,info=await stat(path);
  let content='',version=missingVersion,bom=false,newline='\n',reason:string|undefined;
  if(info){
   if(!info.isFile()||info.isSymbolicLink()||pathKey(await fs.realpath(path))!==pathKey(path))throw unsafe();
   const handle=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   try{
    const opened=await handle.stat();if(!opened.isFile()||!identity(info,opened))throw unsafe();
    const hash=createHash('sha256'),chunks:Buffer[]=[],buffer=Buffer.alloc(64*1024);let total=0;
    for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;hash.update(buffer.subarray(0,bytesRead));if(total<=MAX_BYTES)chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));}
    const after=await handle.stat(),current=await stat(path);
    if(!current||!identity(info,current)||opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs||current.size!==after.size||current.mtimeMs!==after.mtimeMs||current.ctimeMs!==after.ctimeMs)throw unsafe();
    version='sha256:'+hash.digest('hex');
    if(total>MAX_BYTES)reason='文件超过 256 KiB 上限，只能在本机编辑。';
    else{
     const bytes=Buffer.concat(chunks);bom=bytes.subarray(0,3).equals(BOM);
     try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bom?bytes.subarray(3):bytes);newline=content.match(/\r\n|\r|\n/)?.[0]??'\n';}
     catch{reason='文件不是有效 UTF-8，只能在本机编辑。';}
    }
   }finally{await handle.close();}
  }
  if(!reason)try{await fs.access(parent,constants.W_OK);if(info)await fs.access(path,constants.W_OK);}catch{reason='指令文件或父目录不可写。';}
  const override=join(parent,'AGENTS.override.md'),overrideInfo=await stat(override);
  const document:InstructionDocument={path,content,version,exists:!!info,writable:!reason,...(reason?{reason}:{}),overriddenBy:overrideInfo?override:null};
  return {document,bom,newline,info};
 }

 async read(target:InstructionTarget):Promise<InstructionDocument>{
  try{return (await this.snapshot(await this.location(target))).document;}
  catch(error:any){if(error.statusCode)throw error;throw problem(503,'INSTRUCTIONS_READ_FAILED','无法读取主机指令文件，请检查目录和访问权限。');}
 }

 async write(target:InstructionTarget,input:{expectedVersion:string;content:string}):Promise<InstructionDocument>{
  if(!input||Object.keys(input).some(key=>!['expectedVersion','content'].includes(key))||typeof input.expectedVersion!=='string'||!input.expectedVersion||input.expectedVersion.length>512||typeof input.content!=='string')
   throw problem(400,'INSTRUCTIONS_INVALID_INPUT','保存需要文件版本和原始文本。');
  if(Buffer.byteLength(input.content)>MAX_BYTES||new TextDecoder('utf-8',{ignoreBOM:true}).decode(Buffer.from(input.content))!==input.content)
   throw problem(400,'INSTRUCTIONS_INVALID_INPUT','指令必须是有效 UTF-8，且不超过 256 KiB。');
  let location:Location;
  try{location=await this.location(target);}catch(error:any){if(error.statusCode)throw error;throw problem(503,'INSTRUCTIONS_WRITE_FAILED','无法访问指令目录。');}
  const key=pathKey(location.path),prior=this.writes.get(key);
  const pending=(prior??Promise.resolve()).catch(()=>{}).then(()=>this.save(target,location,input));this.writes.set(key,pending);
  try{return await pending;}finally{if(this.writes.get(key)===pending)this.writes.delete(key);}
 }

 private async recheck(target:InstructionTarget,location:Location){
  const current=await this.location(target);
  if(pathKey(current.path)!==pathKey(location.path)||!identity(current.info,location.info))throw unsafe();
  return current;
 }

 private async save(target:InstructionTarget,location:Location,input:{expectedVersion:string;content:string}):Promise<InstructionDocument>{
  let temporary:string|undefined,tempInfo:Stats|undefined,handle:FileHandle|undefined,replaced=false;
  try{
   await this.recheck(target,location);const before=await this.snapshot(location);
   if(before.document.version!==input.expectedVersion)throw problem(409,'INSTRUCTIONS_CONFLICT','指令已被其他编辑者修改，请重新读取并比较。');
   if(!before.document.writable)throw problem(409,'INSTRUCTIONS_READ_ONLY',before.document.reason!);
   const content=input.content.replace(/\r\n|\r|\n/g,before.newline),bytes=Buffer.concat([before.bom?BOM:Buffer.alloc(0),Buffer.from(content)]);
   if(bytes.length>MAX_BYTES)throw problem(400,'INSTRUCTIONS_INVALID_INPUT','保留编码和换行后的文件超过 256 KiB。');
   temporary=join(location.parent,'.AGENTS.'+randomUUID()+'.tmp');
   handle=await fs.open(temporary,'wx',before.info?(before.info.mode&0o777):0o600);
   // Keep the original inode open until rename/cleanup so an external replacement cannot reuse it.
   tempInfo=await handle.stat();await handle.writeFile(bytes);await handle.sync();
   await this.recheck(target,location);const current=await this.snapshot(location);
   if(current.document.version!==input.expectedVersion)throw problem(409,'INSTRUCTIONS_CONFLICT','指令已被其他编辑者修改，请重新读取并比较。');
   if(!current.document.writable)throw problem(409,'INSTRUCTIONS_READ_ONLY',current.document.reason!);
   if(!!current.info!==!!before.info||(current.info&&before.info&&!identity(current.info,before.info)))throw unsafe();
   const currentTemp=await stat(temporary);if(!currentTemp||!currentTemp.isFile()||currentTemp.isSymbolicLink()||!identity(currentTemp,tempInfo!))throw unsafe();
   // Version recheck + rename is not a transaction lock against external editors/processes.
   await fs.rename(temporary,location.path);replaced=true;temporary=undefined;
   await handle.close();handle=undefined;
   await this.recheck(target,location);return (await this.snapshot(location)).document;
  }catch(error:any){if(replaced)throw problem(504,'SETTINGS_WRITE_UNKNOWN','保存结果待核实，请先重新读取核对，不要重复保存。');if(error.statusCode)throw error;throw problem(503,'INSTRUCTIONS_WRITE_FAILED','保存指令失败，请重新读取后核对；原文件不会被预先删除。');}
  finally{
   if(temporary&&tempInfo)try{
    await this.recheck(target,location);const current=await stat(temporary);
    if(current?.isFile()&&!current.isSymbolicLink()&&identity(current,tempInfo))await fs.unlink(temporary);
   }catch{/* Leave uncertain paths untouched. */}
   await handle?.close().catch(()=>{});
  }
 }
}
