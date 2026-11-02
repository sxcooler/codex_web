import {open} from 'node:fs/promises';
import {join,posix} from 'node:path';

type Skill={id?:string;name:string;path?:string;interface?:{displayName?:string|null}};
const keys=(values:unknown[])=>values.flatMap(value=>{if(typeof value!=='string')return [];const key=value.trim().toLowerCase();return key?[key,...(key.replace(/[^a-z0-9]/g,'')?[key.replace(/[^a-z0-9]/g,'')]:[])]:[];});
export async function readRecommendedSkills(home:string):Promise<{known:boolean;matches:(skill:Skill)=>boolean}>{
 let file:Awaited<ReturnType<typeof open>>|undefined;
 try{
  file=await open(join(home,'vendor_imports/skills-curated-cache.json'),'r');const before=await file.stat();
  if(!before.isFile()||before.size>2*1024*1024)throw Error('Invalid recommendation cache');
  const buffer=Buffer.alloc(before.size+1),read=await file.read(buffer,0,buffer.length,0),after=await file.stat();
  if(read.bytesRead!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('Changed recommendation cache');
  const cache=JSON.parse(buffer.subarray(0,read.bytesRead).toString('utf8'));
  if(!Number.isFinite(cache?.fetchedAt)||!Array.isArray(cache?.skills)||cache.skills.length>5000)throw Error('Invalid recommendation cache');
  const recommended=new Set<string>();
  for(const skill of cache.skills){if(typeof skill?.id!=='string'||typeof skill?.name!=='string'||!skill.id.trim()||!skill.name.trim()||skill.id.length>512||skill.name.length>512)throw Error('Invalid recommended skill');for(const key of keys([skill.id,skill.name]))recommended.add(key);}
  return {known:true,matches:skill=>keys([skill.id,skill.name,skill.interface?.displayName,skill.path?posix.basename(posix.dirname(skill.path.replaceAll('\\','/'))):null]).some(key=>recommended.has(key))};
 }catch{return {known:false,matches:()=>false};}finally{await file?.close().catch(()=>{});}
}
