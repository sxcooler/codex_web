import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import Fastify from 'fastify';
import { Projects } from '../src/projects.ts';
import { registerApi } from '../src/server/api.ts';
import { Runtime } from '../src/codex/runtime.ts';

const git = (cwd:string,...args:string[]) => execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
async function init(path:string, subject:string) {
  await mkdir(path,{recursive:true});git(path,'init','-b','main');
  git(path,'config','user.name','Test');git(path,'config','user.email','test@example.invalid');
  await writeFile(join(path,'file.txt'),subject+'\n');git(path,'add','.');git(path,'commit','-m',subject);
  return git(path,'rev-parse','HEAD');
}

test('repository discovery includes nested roots, initialized and unavailable declared modules, without scanning excluded trees',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repositories-'));
  try{
    const repo=join(root,'project'),source=join(root,'source');await init(repo,'main');await init(source,'module');
    git(repo,'-c','protocol.file.allow=always','submodule','add',source,'sdk');
    await init(join(repo,'tools','sdk'),'nested');await init(join(repo,'node_modules','ignored'),'ignored');
    await writeFile(join(repo,'.gitmodules'),'[submodule "sdk"]\n\tpath = sdk\n\turl = '+source.replaceAll('\\','/')+'\n[submodule "missing"]\n\tpath = missing\n\turl = https://example.invalid/missing\n');
    git(repo,'update-index','--add','--cacheinfo','160000,'+git(source,'rev-parse','HEAD')+',index-only');
    const projects=new Projects(root),project=(await projects.list()).find(p=>p.name==='project')!;
    const result=await projects.gitRepositories(project.id);
    assert.equal(result.complete,true);
    assert.deepEqual(result.repositories.map(r=>[r.path,r.kind,r.available]),[['','main',true],['index-only','submodule',false],['missing','submodule',false],['sdk','submodule',true],['tools/sdk','nested',true]]);
    assert.ok(result.repositories.filter(r=>!r.available).every(r=>r.reason));
    assert.equal((await projects.gitLog(project.id,'HEAD',undefined,'sdk')).commits[0].subject,'module');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('selected repository controls branches, commit parents, text/image history and fetch while normal files remain project scoped',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-history-'));
  try{
    const repo=join(root,'project');await init(repo,'main root');const nested=join(repo,'tools','nested'),first=await init(nested,'nested root');
    git(nested,'branch','nested-only');
    await writeFile(join(nested,'file.txt'),'nested next\n');await writeFile(join(nested,'picture.png'),await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer());
    git(nested,'add','.');git(nested,'commit','-m','nested next');const head=git(nested,'rev-parse','HEAD');
    await writeFile(join(repo,'picture.png'),await sharp({create:{width:8,height:8,channels:3,background:'blue'}}).png().toBuffer());
    const upstream=join(root,'upstream');await init(upstream,'remote nested');git(nested,'remote','add','origin',upstream);
    const projects=new Projects(root),project=(await projects.list()).find(p=>p.name==='project')!;
    const history=await projects.gitLog(project.id,'HEAD',undefined,'tools/nested');
    assert.deepEqual(new Set(history.commits.map(c=>c.subject)),new Set(['nested root','nested next']));
    assert.ok(history.branches.some(b=>b.name==='nested-only'));
    const detail=await projects.gitCommit(project.id,head,undefined,'tools/nested');assert.equal(detail.parent,first);
    const diff:any=await projects.gitCommitDiff(project.id,head,first,'file.txt','tools/nested');assert.ok(diff.hunks.some((h:any)=>h.lines.some((l:any)=>l.text==='nested next')));
    const imageDiff:any=await projects.gitCommitDiff(project.id,head,first,'picture.png','tools/nested');
    assert.equal(imageDiff.images.after.repository,'tools/nested');
    const historical=await sharp(await projects.readImage(project.id,'picture.png',head,'tools/nested')).raw().toBuffer();assert.ok(historical[0]>historical[2]);
    const normal=await sharp(await projects.readImage(project.id,'picture.png',undefined,'tools/nested')).raw().toBuffer();assert.ok(normal[2]>normal[0]);
    assert.equal((await projects.readFile(project.id,'file.txt')).text,'main root\n');
    const [a,b,main]=await Promise.all([projects.fetchRemotes(project.id,'tools/nested'),projects.fetchRemotes(project.id,'tools/nested'),projects.fetchRemotes(project.id)]);
    assert.strictEqual(a,b);assert.equal(a.remotes[0].status,'updated');assert.equal(main.skipped,'no-remotes');
    assert.equal(git(nested,'rev-parse','refs/remotes/origin/main'),git(upstream,'rev-parse','HEAD'));
    await assert.rejects(projects.gitCommit(project.id,head),{statusCode:404});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('repository validation rejects ancestor inheritance, traversal, links and foreign Git metadata on every lookup',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-safety-'));
  try{
    const repo=join(root,'project'),outside=join(root,'outside');await init(repo,'main');await init(outside,'foreign');await mkdir(join(repo,'ordinary'));
    const projects=new Projects(root,true),project=(await projects.list()).find(p=>p.name==='project')!;
    for(const value of ['ordinary','../outside','/tmp/repo','C:/foreign','C:foreign','a\\b','./ordinary','.git','ordinary/..'])await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,value),value);
    await symlink(outside,join(repo,'linked'),'junction');
    await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,'linked'));
    const forged=join(repo,'forged');await mkdir(forged);await writeFile(join(forged,'.git'),'gitdir: '+join(outside,'.git').replaceAll('\\','/')+'\n');
    await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,'forged'));
    const nested=join(repo,'nested');await init(nested,'nested');await projects.gitRepositories(project.id);await rm(join(nested,'.git'),{recursive:true});
    await writeFile(join(nested,'.git'),'gitdir: '+join(outside,'.git').replaceAll('\\','/')+'\n');
    await assert.rejects(projects.fetchRemotes(project.id,'nested'));await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,'nested'));
    assert.ok(!(await projects.gitRepositories(project.id)).repositories.some(r=>r.path==='linked'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('legitimate linked main and nested worktrees accept Git files but reject forged main targets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-worktrees-'));
  try{
    const source=join(root,'source'),work=join(root,'work');await init(source,'source');await mkdir(work);git(source,'worktree','add','-b','linked',join(work,'project'));
    const projects=new Projects(work),project=(await projects.list())[0];assert.equal((await projects.gitLog(project.id)).commits[0].subject,'source');
    git(source,'worktree','add','-b','nested',join(project.path,'nested'));assert.equal((await projects.gitLog(project.id,'HEAD',undefined,'nested')).commits[0].subject,'source');
    await rm(join(project.path,'.git'));await writeFile(join(project.path,'.git'),'gitdir: '+join(source,'.git').replaceAll('\\','/')+'\n');
    await assert.rejects(projects.gitLog(project.id));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('history cursor cannot be replayed in another project or repository and scan depth limit is explicit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-cursor-'));
  try{
    const repo=join(root,'project'),other=join(root,'other');const head=await init(repo,'main');await init(other,'other');await init(join(repo,'nested'),'nested');
    const projects=new Projects(root),all=await projects.list(),project=all.find(p=>p.name==='project')!,second=all.find(p=>p.name==='other')!;
    const records=Array.from({length:101},(_,i)=>{const subject='page '+i;return 'commit refs/heads/main\nmark :'+(i+1)+'\ncommitter Test <test@example.invalid> '+(1800000000+i)+' +0000\ndata '+Buffer.byteLength(subject)+'\n'+subject+'\nfrom '+(i?':'+i:head)+'\n\n';}).join('');
    execFileSync('git',['fast-import','--quiet'],{cwd:repo,input:records,windowsHide:true,stdio:['pipe','pipe','pipe']});
    git(repo,'clone','--quiet',repo,join(repo,'copy'));
    const page=await projects.gitLog(project.id),cursor=page.nextCursor!;assert.ok(cursor);
    assert.equal((await projects.gitLog(project.id,'HEAD',cursor)).commits.length,2);
    await assert.rejects(projects.gitLog(project.id,'HEAD',cursor,'copy'),{statusCode:400});
    await assert.rejects(projects.gitLog(second.id,'HEAD',cursor),{statusCode:400});
    const deep=Array.from({length:13},(_,i)=>'d'+i).join('/');await init(join(repo,deep),'deep');
    const result=await projects.gitRepositories(project.id);assert.equal(result.complete,false);
    assert.equal((await projects.gitLog(project.id,'HEAD',undefined,deep)).commits[0].subject,'deep','selection must revalidate directly rather than require inclusion in a bounded scan');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Git repository API uses bound project and propagates repository through history, images and fetch',async t=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-api-'));const runtime=new Runtime({executable:process.execPath,cwd:root});const app=Fastify();
  t.mock.method(runtime,'close',async()=>{});let cwd='';t.mock.method(runtime,'threadCwd',async()=>cwd);
  t.mock.method(runtime,'configurationHome',async()=>null);
  try{
    const work=join(root,'work'),repo=join(work,'project');await init(repo,'main');const head=await init(join(repo,'nested'),'nested');cwd=repo;
    await writeFile(join(repo,'nested','picture.png'),await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer());git(join(repo,'nested'),'add','.');git(join(repo,'nested'),'commit','-m','image');const imageHead=git(join(repo,'nested'),'rev-parse','HEAD');
    registerApi(app,{dataDir:root,runtime,projects:new Projects(work),authenticated:()=>()=>true});
    const base='/api/sessions/thread-1',repositories=await app.inject(base+'/git/repositories');assert.equal(repositories.statusCode,200,repositories.body);assert.equal(repositories.json().repositories.length,2);
    const history=await app.inject(base+'/git/log?repository=nested');assert.equal(history.statusCode,200,history.body);assert.equal(history.json().commits[0].subject,'image');
    assert.equal((await app.inject(base+'/git/commit?repository=nested&commit='+head)).json().commit.subject,'nested');
    assert.equal((await app.inject(base+'/git/commit/diff?repository=nested&commit='+head+'&path=file.txt')).statusCode,200);
    const image=await app.inject(base+'/files/image?repository=nested&revision='+imageHead+'&path=picture.png');assert.equal(image.statusCode,200,image.body);assert.equal(image.headers['content-type'],'image/webp');
    assert.equal((await app.inject({method:'POST',url:base+'/git/fetch',payload:{repository:'nested'}})).json().skipped,'no-remotes');
    await mkdir(join(repo,'broken'));await writeFile(join(repo,'broken','.git'),'gitdir: ../missing-metadata\n');
    const broken=await app.inject(base+'/git/log?repository=broken');assert.equal(broken.statusCode,409,broken.body);assert.ok(!broken.body.includes(root));
    for(const value of ['../outside','/outside','ordinary'])assert.ok((await app.inject(base+'/git/log?repository='+encodeURIComponent(value))).statusCode>=400);
    assert.equal((await app.inject(base+'/git/files?repository=nested')).statusCode,400,'changes cannot accept history selection');
    cwd=root;assert.equal((await app.inject(base+'/git/repositories')).statusCode,404);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});




test('malformed module configuration preserves index gitlinks and reports incomplete discovery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-invalid-modules-'));
  try{
    const repo=join(root,'project'),head=await init(repo,'main');await init(join(repo,'sdk'),'initialized module');
    for(const path of ['index-only','sdk'])git(repo,'update-index','--add','--cacheinfo','160000,'+head+','+path);
    await writeFile(join(repo,'.gitmodules'),'[submodule "broken"\npath = missing\n');
    const projects=new Projects(root),project=(await projects.list())[0];const result=await projects.gitRepositories(project.id);
    assert.equal(result.complete,false);assert.equal(result.repositories[0].available,true);
    assert.deepEqual(result.repositories.map(r=>[r.path,r.kind,r.available]),[['','main',true],['index-only','submodule',false],['sdk','submodule',true]]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('damaged Git index preserves module configuration paths and reports incomplete discovery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-invalid-index-'));
  try{
    const repo=join(root,'project');await init(repo,'main');
    await writeFile(join(repo,'.gitmodules'),'[submodule "missing"]\npath = config-only\n');
    await rm(join(repo,'.git','index'));await writeFile(join(repo,'.git','index'),'damaged index');
    const projects=new Projects(root),project=(await projects.list())[0],result=await projects.gitRepositories(project.id);
    assert.equal(result.complete,false);
    assert.deepEqual(result.repositories.map(r=>[r.path,r.kind,r.available]),[['','main',true],['config-only','submodule',false]]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('repository lookup rejects outside common metadata, symlink metadata and a configured outside worktree',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-metadata-'));
  try{
    const repo=join(root,'project'),outside=join(root,'outside');await init(repo,'main');await init(outside,'outside');
    const projects=new Projects(root),project=(await projects.list()).find(p=>p.name==='project')!;
    const nested=join(repo,'nested');await init(nested,'nested');
    await writeFile(join(nested,'.git','commondir'),join(outside,'.git').replaceAll('\\','/')+'\n');
    await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,'nested'));
    await rm(join(nested,'.git','commondir'));
    git(nested,'config','core.worktree',outside);await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,'nested'));
    git(nested,'config','--unset','core.worktree');await rm(join(nested,'.git'),{recursive:true});
    await symlink(join(outside,'.git'),join(nested,'.git'),'junction');
    await assert.rejects(projects.gitLog(project.id,'HEAD',undefined,'nested'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('discovery returns an explicit incomplete flag when the deadline or repository cap is reached',async t=>{
  const root=await mkdtemp(join(tmpdir(),'git-repository-bounds-'));
  try{
    const repo=join(root,'project');await init(repo,'main');
    await writeFile(join(repo,'.gitmodules'),Array.from({length:205},(_,i)=>'[submodule "m'+i+'"]\npath = m'+i+'\n').join(''));
    const projects=new Projects(root),project=(await projects.list())[0];
    const bounded=await projects.gitRepositories(project.id);assert.equal(bounded.complete,false);assert.equal(bounded.repositories.length,200);
    const original=Date.now,start=original();let calls=0;const clock=t.mock.method(Date,'now',()=>start+(++calls>3?6000:0));
    const timed=await projects.gitRepositories(project.id);clock.mock.restore();assert.equal(timed.complete,false);assert.ok(timed.repositories.length<200);
  }finally{await rm(root,{recursive:true,force:true});}
});
