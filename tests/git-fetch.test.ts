import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Projects} from '../src/projects.ts';

test('fetch timeout cleans up its helper process tree and releases the project after cooldown',async t=>{
  const root=await mkdtemp(join(tmpdir(),'codex-fetch-timeout-'));let pids:number[]=[];
  try {
    const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
    const projects=new Projects(root),p=await projects.create({name:'slow',folderName:'slow'}),pidFile=join(root,'pids.json'),helper=join(root,'wait.mjs');
    await writeFile(helper,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
    git(p.path,'remote','add','slow',p.path);
    git(p.path,'config','remote.slow.uploadpack','"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"');
    const timer=globalThis.setTimeout;
    t.mock.method(globalThis,'setTimeout',(callback:any,delay?:number,...args:any[])=>timer(callback,delay===30_000?1500:delay===10_000?10:delay,...args));
    const result=await projects.fetchRemotes(p.id);
    assert.equal(result.remotes[0].status,'timeout',JSON.stringify(result));
    pids=JSON.parse(await readFile(pidFile,'utf8'));
    for(const pid of pids)await assert.doesNotReject(async()=>{for(let i=0;i<20;i++){try{process.kill(pid,0);}catch{return;}await new Promise(r=>timer(r,50));}assert.fail('fetch helper survived timeout: '+pid);});
    git(p.path,'remote','remove','slow');await new Promise(r=>timer(r,30));
    assert.equal((await projects.fetchRemotes(p.id)).skipped,'no-remotes');
  } finally {for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});}
});

test('manual fetch shares work, prunes only remote branches and preserves local state despite custom refspecs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex-fetch-'));
  try {
    const remote=join(root,'upstream'),work=join(root,'work');await mkdir(remote);await mkdir(work);
    const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
    git(remote,'init','-b','main');git(remote,'config','user.name','Test');git(remote,'config','user.email','test@example.invalid');
    await writeFile(join(remote,'file.txt'),'initial');git(remote,'add','.');git(remote,'commit','-m','initial');
    git(remote,'branch','gone');git(remote,'tag','upstream-tag');
    const projects=new Projects(work),p=await projects.create({name:'project',folderName:'project'});
    assert.equal((await projects.fetchRemotes(p.id)).skipped,'no-remotes');
    git(p.path,'remote','add','origin',remote);git(p.path,'fetch','origin');git(p.path,'checkout','-b','main','origin/main');
    const before=git(p.path,'rev-parse','HEAD');
    git(p.path,'tag','local-only');await writeFile(join(p.path,'file.txt'),'staged');git(p.path,'add','.');await writeFile(join(p.path,'file.txt'),'unstaged');
    const index=git(p.path,'rev-parse',':file.txt');const fetchHead=await readFile(join(p.path,'.git','FETCH_HEAD'),'utf8');
    await writeFile(join(remote,'file.txt'),'remote next');git(remote,'add','.');git(remote,'commit','-m','next');const next=git(remote,'rev-parse','HEAD');
    git(remote,'branch','-D','gone');git(remote,'tag','new-tag');
    // These repository settings must not redirect updates or pruning into local refs.
    git(p.path,'config','remote.origin.fetch','+refs/heads/*:refs/heads/*');
    git(p.path,'config','--add','remote.origin.fetch','+refs/tags/*:refs/tags/*');
    git(p.path,'config','fetch.pruneTags','true');git(p.path,'config','remote.origin.pruneTags','true');git(p.path,'config','remote.origin.tagOpt','--tags');
    git(p.path,'remote','add','broken',join(root,'missing-private-path'));
    const fresh=new Projects(work);await fresh.list();
    const [a,b]=await Promise.all([fresh.fetchRemotes(p.id),fresh.fetchRemotes(p.id)]);
    assert.strictEqual(a,b);assert.strictEqual(await fresh.fetchRemotes(p.id),a,'cooldown should reuse result');
    assert.equal(a.remotes.find(r=>r.name==='origin')?.status,'updated',JSON.stringify(a));
    assert.equal(a.remotes.find(r=>r.name==='broken')?.status,'failed');assert.ok(!JSON.stringify(a).includes(root));
    assert.equal(git(p.path,'rev-parse','refs/remotes/origin/main'),next);
    assert.throws(()=>git(p.path,'rev-parse','--verify','refs/remotes/origin/gone'));
    assert.equal(git(p.path,'rev-parse','HEAD'),before);assert.equal(git(p.path,'rev-parse',':file.txt'),index);
    assert.equal(await readFile(join(p.path,'file.txt'),'utf8'),'unstaged');assert.equal(await readFile(join(p.path,'.git','FETCH_HEAD'),'utf8'),fetchHead);
    assert.equal(git(p.path,'rev-parse','refs/tags/local-only'),before);assert.throws(()=>git(p.path,'rev-parse','--verify','refs/tags/new-tag'));
    git(p.path,'branch','protected-local');
    git(p.path,'symbolic-ref','refs/remotes/origin/main','refs/heads/protected-local');
    const protectedFetch=await new Projects(work).fetchRemotes(p.id);
    assert.equal(protectedFetch.remotes.find(r=>r.name==='origin')?.status,'failed');
    assert.equal(git(p.path,'rev-parse','refs/heads/protected-local'),before);
    git(p.path,'config','remote.origin/nested.url',remote);
    const overlapping=await new Projects(work).fetchRemotes(p.id);
    assert.ok(overlapping.remotes.filter(r=>r.name.startsWith('origin')).every(r=>r.status==='failed'));
    await mkdir(join(work,'plain'));const plain=(await fresh.list()).find(item=>item.name==='plain')!;
    assert.equal((await fresh.fetchRemotes(plain.id)).skipped,'not-repository');
  } finally {await rm(root,{recursive:true,force:true});}
});
