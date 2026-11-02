import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {readRecommendedSkills} from '../src/codex/recommended-skills.ts';

async function fixture(run:(home:string,file:string)=>Promise<void>){await mkdir('.local',{recursive:true});const home=await mkdtemp(join(process.cwd(),'.local/recommended-'));await mkdir(join(home,'vendor_imports'));try{await run(home,join(home,'vendor_imports/skills-curated-cache.json'));}finally{await rm(home,{recursive:true,force:true});}}
test('recommended matching uses id, name, display name and folder identity without hardcoded skill names',async()=>fixture(async(home,file)=>{
 await writeFile(file,JSON.stringify({fetchedAt:1,skills:[{id:'official-browser',name:'Browser Tool'},{id:'other',name:'Other'}]}));
 const policy=await readRecommendedSkills(home);assert.equal(policy.known,true);
 assert.equal(policy.matches({name:'unrelated',path:'C:\\skills\\official-browser\\SKILL.md'}),true);
 assert.equal(policy.matches({name:'browser_tool'}),true);assert.equal(policy.matches({name:'x',interface:{displayName:'Browser Tool'}}),true);
 assert.equal(policy.matches({name:'my-browser-tool'}),false);assert.equal(policy.matches({name:'user-created'}),false);
}));
test('an empty known catalog differs from missing, malformed and oversized recommendation data',async()=>fixture(async(home,file)=>{
 assert.equal((await readRecommendedSkills(home)).known,false);
 await writeFile(file,'{');assert.equal((await readRecommendedSkills(home)).known,false);
 await writeFile(file,JSON.stringify({fetchedAt:1,skills:[]}));const empty=await readRecommendedSkills(home);assert.equal(empty.known,true);assert.equal(empty.matches({name:'anything'}),false);
 await writeFile(file,' '.repeat(2*1024*1024+1));assert.equal((await readRecommendedSkills(home)).known,false);
 await writeFile(file,JSON.stringify({fetchedAt:1,skills:[{id:'broken',name:42}]}));assert.equal((await readRecommendedSkills(home)).known,false);
}));
test('non-Latin names do not collapse to a shared empty match key',async()=>fixture(async(home,file)=>{
 await writeFile(file,JSON.stringify({fetchedAt:1,skills:[{id:'one',name:'技能甲'}]}));const policy=await readRecommendedSkills(home);
 assert.equal(policy.matches({name:'技能甲'}),true);assert.equal(policy.matches({name:'技能乙'}),false);assert.equal(policy.matches({name:''}),false);
}));
