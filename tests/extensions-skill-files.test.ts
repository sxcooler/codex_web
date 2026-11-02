import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {SkillFiles} from '../src/codex/skill-files.ts';

async function fixture(t:any){await fs.mkdir(join(process.cwd(),'.local'),{recursive:true});const base=await fs.mkdtemp(join(process.cwd(),'.local/extensions-skills-')),home=join(base,'home'),cwd=join(base,'project');await fs.mkdir(home);await fs.mkdir(cwd);t.after(()=>fs.rm(base,{recursive:true,force:true}));return {base,home,cwd,files:new SkillFiles(home,cwd)};}
test('bounded skill files create and save with hash CAS and preserve other files',async t=>{
 const {files,cwd}=await fixture(t),target={scope:'repo' as const,name:'guide'},content='---\nname: guide\ndescription: Test\n---\nOriginal';
 const empty=await files.read(target);assert.equal(empty.version,'missing');
 const created=await files.save(target,{expectedVersion:'missing',content});assert.match(created.version,/^sha256:/);assert.equal(await fs.readFile(join(cwd,'.agents/skills/guide/SKILL.md'),'utf8'),content);
 await assert.rejects(()=>files.save(target,{expectedVersion:'missing',content:content+'clobber'}),{code:'EXTENSION_SKILL_CONFLICT'});
 const saved=await files.save(target,{expectedVersion:created.version,content:content+'\nUpdated'});assert.equal(saved.content,content+'\nUpdated');
 await fs.writeFile(join(cwd,'.agents/skills/guide/support.txt'),'keep');const before=await files.read(target);assert.equal(before.files.some(f=>f.name==='support.txt'),true);
 await assert.rejects(()=>files.remove(target,before.version),{code:'EXTENSION_SKILL_NOT_EMPTY'});assert.equal(await fs.readFile(join(cwd,'.agents/skills/guide/support.txt'),'utf8'),'keep');
 await fs.unlink(join(cwd,'.agents/skills/guide/support.txt'));await files.remove(target,saved.version);assert.equal((await files.read(target)).exists,false);
});
test('native selectors reject plugin/system/outside paths and legacy requires native metadata',async t=>{
 const {files,home,cwd}=await fixture(t);assert.deepEqual(files.fromNative({scope:'user',pluginId:null,path:join(home,'skills/guide/SKILL.md')}),{scope:'user',name:'guide'});
 assert.deepEqual(files.fromNative({scope:'repo',pluginId:null,path:join(cwd,'.codex/skills/legacy/SKILL.md')}),{scope:'repo',name:'legacy',legacy:true});
 for(const skill of [{scope:'system',path:join(home,'skills/guide/SKILL.md')},{scope:'user',pluginId:'plugin',path:join(home,'skills/guide/SKILL.md')},{scope:'repo',path:join(home,'skills/guide/SKILL.md')},{scope:'repo',path:join(cwd,'other/guide/SKILL.md')}])assert.throws(()=>files.fromNative(skill),{code:'EXTENSION_SKILL_READ_ONLY'});
 await assert.rejects(()=>files.save({scope:'repo',name:'../escape'},{expectedVersion:'missing',content:'x'}),{statusCode:400});
 await assert.rejects(()=>files.save({scope:'repo',name:'guide'},{expectedVersion:'missing',content:'x'.repeat(262145)}),{statusCode:400});
});
test('skill file creation is exclusive and links are rejected without modifying their target',async t=>{
 const {files,cwd,base}=await fixture(t),target={scope:'repo' as const,name:'guide'};
 const content='---\nname: guide\ndescription: Guide\n---\n';const results=await Promise.allSettled([files.save(target,{expectedVersion:'missing',content:content+'one'}),files.save(target,{expectedVersion:'missing',content:content+'two'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const outside=join(base,'outside');await fs.mkdir(outside);await fs.writeFile(join(outside,'SKILL.md'),'outside');await fs.symlink(outside,join(cwd,'.agents/skills/link'),'junction');
 await assert.rejects(()=>files.read({scope:'repo',name:'link'}),{code:'EXTENSION_SKILL_UNSAFE'});assert.equal(await fs.readFile(join(outside,'SKILL.md'),'utf8'),'outside');
});
test('first skill creation cannot replace an external file appearing at the final publish step',async t=>{
 const {files,cwd}=await fixture(t),path=join(cwd,'.agents/skills/guide/SKILL.md'),external='---\nname: guide\ndescription: External\n---\nDo not replace',open=fs.open,rename=fs.rename;
 t.mock.method(fs,'open',async(file:any,flags:any,...args:any[])=>{if(file===path&&flags==='wx')await fs.writeFile(path,external,{flag:'wx'});return (open as any)(file,flags,...args);});
 t.mock.method(fs,'rename',async(from:any,to:any)=>{if(to===path)await fs.writeFile(path,external,{flag:'wx'});return rename(from,to);});
 await assert.rejects(()=>files.save({scope:'repo',name:'guide'},{expectedVersion:'missing',content:'---\nname: guide\ndescription: Mine\n---\nMine'}),{code:'EXTENSION_SKILL_CONFLICT'});assert.equal(await fs.readFile(path,'utf8'),external);
});
test('skill saves reject missing metadata and invalid new slugs without altering the original',async t=>{
 const {files}=await fixture(t),target={scope:'repo' as const,name:'guide'},content='---\nname: guide\ndescription: Guide\n---\nOriginal';
 const saved=await files.save(target,{expectedVersion:'missing',content});
 for(const value of ['arbitrary text','---\nname: Guide\ndescription: Test\n---\n','---\nname: guide\n---\n'])await assert.rejects(()=>files.save(target,{expectedVersion:saved.version,content:value}),{code:'EXTENSION_SKILL_INVALID'});
 assert.equal((await files.read(target)).content,content);await assert.rejects(()=>files.save({scope:'user',name:'New_Guide'},{expectedVersion:'missing',content}),{code:'EXTENSION_SKILL_INVALID'});
});
test('user-root CRUD preserves stale remove hashes and rejects NUL and invalid UTF-8',async t=>{
 const {files,home}=await fixture(t),target={scope:'user' as const,name:'guide'},content='---\nname: guide\ndescription: User guide\n---\nOriginal';
 const before=await files.save(target,{expectedVersion:'missing',content});assert.equal(await fs.readFile(join(home,'skills/guide/SKILL.md'),'utf8'),content);const after=await files.save(target,{expectedVersion:before.version,content:content+'\nChanged'});
 await assert.rejects(()=>files.remove(target,before.version),{code:'EXTENSION_SKILL_CONFLICT'});await assert.rejects(()=>files.save(target,{expectedVersion:after.version,content:content+'\0'}),{statusCode:400});
 await files.remove(target,after.version);await fs.mkdir(join(home,'skills/guide'));await fs.writeFile(join(home,'skills/guide/SKILL.md'),Buffer.from([0xff]));await assert.rejects(()=>files.read(target),{statusCode:400});
});
test('skill roots and hard-linked files cannot escape the fixed directory contract',async t=>{
 const {files,home,cwd,base}=await fixture(t),content='---\nname: guide\ndescription: Guide\n---\nOriginal';await files.save({scope:'repo',name:'guide'},{expectedVersion:'missing',content});
 const alias=join(base,'home-link');await fs.symlink(home,alias,'junction');await assert.rejects(()=>new SkillFiles(alias,cwd).read({scope:'user',name:'guide'}),{code:'EXTENSION_SKILL_UNSAFE'});
 await fs.mkdir(join(home,'skills'));await fs.mkdir(join(home,'skills/guide'));await fs.link(join(cwd,'.agents/skills/guide/SKILL.md'),join(home,'skills/guide/SKILL.md'));await assert.rejects(()=>files.read({scope:'user',name:'guide'}),{code:'EXTENSION_SKILL_UNSAFE'});
});
