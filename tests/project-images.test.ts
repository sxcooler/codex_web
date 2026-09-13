import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {execFileSync} from 'node:child_process';
import { Projects } from '../src/projects.ts';

test('image diffs use worktree, index and commit versions, including renamed and deleted paths', async () => {
  const root=await mkdtemp(join(tmpdir(),'codex-image-git-'));
  try {
    const projects=new Projects(root),p=await projects.create({name:'Images',folderName:'images'});
    const git=(...args:string[])=>execFileSync('git',args,{cwd:p.path,encoding:'utf8',windowsHide:true}).trim();
    git('config','user.name','Test');git('config','user.email','test@example.invalid');
    const picture='folder/图 #1.png';await mkdir(join(p.path,'folder'));
    const write=async(color:string)=>writeFile(join(p.path,picture),await sharp({create:{width:32,height:32,channels:3,background:color}}).png().toBuffer());
    const color=async(source:any)=>{
      assert.ok(source);
      const {data}=await sharp(await projects.readImage(p.id,source.path,source.revision)).raw().toBuffer({resolveWithObject:true});
      return [...data.subarray(0,3)].indexOf(Math.max(...data.subarray(0,3)));
    };
    await write('red');git('add','.');git('commit','-m','red');const first=git('rev-parse','HEAD');
    const rootDiff:any=await projects.gitCommitDiff(p.id,first,undefined,picture);
    assert.equal(rootDiff.images.before,null);assert.equal(await color(rootDiff.images.after),0);
    await write('lime');git('add','.');await write('blue');
    const work:any=await projects.gitFileDiff(p.id,picture),staged:any=await projects.gitFileDiff(p.id,picture,true);
    assert.equal(await color(work.images.before),1);assert.equal(await color(work.images.after),2);
    assert.equal(await color(staged.images.before),0);assert.equal(await color(staged.images.after),1);
    git('commit','-m','green');const second=git('rev-parse','HEAD');
    const history:any=await projects.gitCommitDiff(p.id,second,first,picture);
    assert.equal(await color(history.images.before),0);assert.equal(await color(history.images.after),1);
    git('restore',picture);git('mv',picture,'renamed.png');
    const rename:any=await projects.gitFileDiff(p.id,'renamed.png',true);
    assert.equal(rename.images.before.path,picture);assert.equal(await color(rename.images.after),1);
    git('commit','-m','rename');const third=git('rev-parse','HEAD');
    const renamed:any=await projects.gitCommitDiff(p.id,third,second,'renamed.png');
    assert.equal(renamed.images.before.path,picture);assert.equal(await color(renamed.images.before),1);
    await rm(join(p.path,'folder'),{recursive:true,force:true});
    assert.equal(await color(history.images.before),0,'history must not require a live parent directory');
    await rm(join(p.path,'renamed.png'));
    const deleted:any=await projects.gitFileDiff(p.id,'renamed.png');
    assert.equal(deleted.images.after,null);assert.equal(await color(deleted.images.before),1);
    git('add','-u');git('commit','-m','delete');
    const deletion:any=await projects.gitCommitDiff(p.id,git('rev-parse','HEAD'),third,'renamed.png');
    assert.equal(deletion.images.after,null);assert.equal(await color(deletion.images.before),1);
    await assert.rejects(projects.gitFileDiff(p.id,'renamed.png'));
    await assert.rejects(projects.readImage(p.id,picture,'HEAD'),{statusCode:400});
    await assert.rejects(projects.readImage(p.id,'../outside.png',first));
    await assert.rejects(projects.readImage(p.id,'.env.png',first),{statusCode:403});
    await writeFile(join(p.path,'huge.png'),Buffer.alloc(10*1024*1024+1));git('add','huge.png');
    await assert.rejects(projects.readImage(p.id,'huge.png','index'),{statusCode:413});
    const blob=git('rev-parse',first+':'+picture);
    git('update-index','--add','--cacheinfo','120000,'+blob+',link.png');
    await assert.rejects(projects.readImage(p.id,'link.png','index'),{statusCode:400});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('project image previews decode safely, bound size and retain file access restrictions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-image-'));
  try {
    const projects = new Projects(root), project = await projects.create({ name:'Images', folderName:'images' });
    const png = await sharp({ create:{ width:2400, height:1200, channels:4, background:'#82d9b4' } }).png().toBuffer();
    await writeFile(join(project.path,'图 #1.png'),png);
    const preview = await projects.readImage(project.id,'图 #1.png');
    const metadata = await sharp(preview).metadata();
    assert.equal(metadata.format,'webp'); assert.equal(metadata.width,2048); assert.equal(metadata.height,1024);
    await writeFile(join(project.path,'icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><script>alert(1)</script><rect width="24" height="24" fill="red"/></svg>');
    assert.equal((await sharp(await projects.readImage(project.id,'icon.svg')).metadata()).format,'webp');
    await writeFile(join(project.path,'bad.png'),'<html>not an image</html>');
    await assert.rejects(projects.readImage(project.id,'bad.png'),{statusCode:415});
    await writeFile(join(project.path,'large.png'),Buffer.alloc(10*1024*1024+1));
    await assert.rejects(projects.readImage(project.id,'large.png'),{statusCode:413});
    await writeFile(join(project.path,'pixels.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>');
    await assert.rejects(projects.readImage(project.id,'pixels.svg'));
    await writeFile(join(project.path,'.env.png'),png);
    await assert.rejects(projects.readImage(project.id,'.env.png'),{statusCode:403});
    await writeFile(join(project.path,'.gitignore'),'ignored.png\n');
    await writeFile(join(project.path,'ignored.png'),png);
    assert.equal((await sharp(await projects.readImage(project.id,'ignored.png')).metadata()).format,'webp');
    assert.ok((await projects.listFiles(project.id)).files.some(file=>file.path==='ignored.png'));
    await mkdir(join(project.path,'ignored-dir'));
    await writeFile(join(project.path,'.gitignore'),'ignored.png\nignored-dir/\n');
    await writeFile(join(project.path,'ignored-dir','note.txt'),'visible');
    assert.equal((await projects.readFile(project.id,'ignored-dir/note.txt')).text,'visible');
    assert.equal((await projects.listFiles(project.id,'ignored-dir')).files[0].path,'ignored-dir/note.txt');
    await assert.rejects(projects.listFiles(project.id,'.git'),{statusCode:403});
    await mkdir(join(root,'outside')); await writeFile(join(root,'outside','hidden.png'),png);
    await symlink(join(root,'outside'),join(project.path,'escape'),'junction');
    await assert.rejects(projects.readImage(project.id,'escape/hidden.png'),{statusCode:403});
    await assert.rejects(projects.readImage(project.id,'../outside/hidden.png'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
