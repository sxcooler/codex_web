import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {readExtensions,changeExtension} from '../src/codex/extensions.ts';
test('skill actions bind native metadata, use file hashes and verify native reload',async t=>{
 await fs.mkdir(join(process.cwd(),'.local'),{recursive:true});
 const dir=await fs.mkdtemp(join(process.cwd(),'.local/extensions-skill-actions-')),home=join(dir,'home'),cwd=join(dir,'project');await fs.mkdir(home);await fs.mkdir(cwd);t.after(()=>fs.rm(dir,{recursive:true,force:true}));const path=join(cwd,'.agents/skills/guide/SKILL.md');let managed=false,failReload=false;
 const peer={home,cli:async(args:string[])=>args.includes('--available')?{installed:[],available:[]}:{marketplaces:[]},request:async(method:string):Promise<any>=>{
  if(method==='config/read')return {config:{},origins:managed?{skills:{name:{type:'enterpriseManaged'}}}:{},layers:[{name:{type:'user',file:join(home,'config.toml'),profile:null},config:{},version:'v1'}]};
  if(method==='configRequirements/read')return {requirements:null};if(method==='plugin/installed')return {marketplaces:[],marketplaceLoadErrors:[]};if(['app/list','mcpServerStatus/list'].includes(method))return {data:[],nextCursor:null};
  if(method==='skills/list'){if(failReload)throw Error('failed');const exists=await fs.stat(path).then(()=>true).catch(()=>false);return {data:[{cwd,skills:exists?[{path,name:'guide',scope:'repo',pluginId:null,enabled:true}]:[],errors:[]}]};}throw Error('Unexpected native method');
 }};
 const created=await changeExtension(peer,cwd,{action:'skill.create',scope:'repo',name:'guide',content:'---\nname: guide\ndescription: A guide\n---\nFirst',expectedContentVersion:'missing'} as any);assert.equal(created.status,'written');
 const key=(await readExtensions(peer,cwd)).items.find(x=>x.kind==='skill')!.key;
 const read=await changeExtension(peer,cwd,{action:'skill.read',key} as any);assert.match(read.document.version,/^sha256:/);assert.equal(read.document.files[0].name,'SKILL.md');
 managed=true;await assert.rejects(()=>changeExtension(peer,cwd,{action:'skill.save',key,expectedContentVersion:read.document.version,content:'changed'} as any),{code:'EXTENSION_READ_ONLY'});managed=false;
 await assert.rejects(()=>changeExtension(peer,cwd,{action:'skill.save',key,expectedContentVersion:'stale',content:read.document.content+'changed'} as any),{code:'EXTENSION_SKILL_CONFLICT'});
 const saved=await changeExtension(peer,cwd,{action:'skill.save',key,expectedContentVersion:read.document.version,content:'---\nname: guide\ndescription: A guide\n---\nChanged'} as any);assert.equal(saved.status,'written');
 const changed=await changeExtension(peer,cwd,{action:'skill.read',key} as any);await changeExtension(peer,cwd,{action:'skill.remove',key,expectedContentVersion:changed.document.version} as any);assert.equal((await readExtensions(peer,cwd)).items.length,0);
 failReload=true;await assert.rejects(()=>changeExtension(peer,cwd,{action:'skill.import',scope:'repo',name:'guide',content:'---\nname: guide\ndescription: Imported\n---\nImported',expectedContentVersion:'missing'} as any),{code:'EXTENSION_WRITE_UNKNOWN'});assert.match(await fs.readFile(path,'utf8'),/Imported/);
});
