import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Projects, validateFolder, validateRepoUrl } from '../src/projects.ts';

test('Windows names and clone transports cannot escape the project root', () => {
  for (const name of ['..','.hidden','.git','../x','C:\\x','a/b','a\\b','CON','nul.txt','COM¹','foo.','foo ','x:y','\\\\host\\share','a\0b']) assert.throws(()=>validateFolder(name, 'win32'),name);
  assert.equal(validateFolder('example-review-tool'), 'example-review-tool');
  for(const url of ['file:///tmp/x','ext::sh x','-u','https://user:pass@example.org/a','ssh://host/-x','http://host/repo']) assert.throws(()=>validateRepoUrl(url),url);
  assert.equal(validateRepoUrl('git@github.com:owner/repo.git'),'git@github.com:owner/repo.git');
  assert.equal(validateRepoUrl('https://github.com/owner/repo.git'),'https://github.com/owner/repo.git');
});

test('Linux projects preserve case and native filenames while rejecting escapes', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-linux-paths-'));
  try {
    const projects = new Projects(root);
    const upper = await projects.create({ name: 'Repo', folderName: 'Repo' });
    const lower = await projects.create({ name: 'repo', folderName: 'repo' });
    assert.notEqual(upper.id, lower.id);
    assert.equal((await projects.resolve(upper.id)).path, join(root, 'Repo'));
    assert.equal((await projects.resolve(lower.id)).path, join(root, 'repo'));
    await projects.create({ name: 'CON', folderName: 'CON' });
    for (const name of ['CON', 'time:stamp.txt', 'back\\slash.txt']) {
      await writeFile(join(upper.path, name), name);
      assert.equal((await projects.readFile(upper.id, name)).text, name);
      assert.match((await projects.gitFileDiff(upper.id, name)).hunks[0].lines[0].text, /CON|stamp|slash/);
    }
    await writeFile(join(upper.path, 'a?b.txt'), 'literal');
    await writeFile(join(upper.path, 'axb.txt'), 'neighbor');
    execFileSync('git', ['add', '.'], { cwd: upper.path });
    execFileSync('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base'], { cwd: upper.path });
    await writeFile(join(upper.path, 'a?b.txt'), 'literal changed');
    await writeFile(join(upper.path, 'axb.txt'), 'neighbor changed');
    const patch = await projects.gitPatch(upper.id, 'a?b.txt');
    assert.match(patch, /literal changed/);
    assert.doesNotMatch(patch, /neighbor changed/);
    await writeFile(join(lower.path, 'outside.txt'), 'outside');
    await symlink(lower.path, join(upper.path, 'outside'), 'dir');
    await assert.rejects(projects.readFile(upper.id, 'outside/outside.txt'), /escapes/);
    await assert.rejects(projects.readFile(upper.id, '../repo/outside.txt'));
    await assert.rejects(projects.readFile(upper.id, 'C:\\Windows\\win.ini'));
  } finally { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); }
});

test('project creation, special filenames, Git diff and stale junction rejection', async () => {
  const root=await mkdtemp(join(tmpdir(),'codex-projects-'));
  try {
    const projects=new Projects(root);
    const project=await projects.create({name:'Review Tool',folderName:'review-tool'});
    assert.equal((await projects.list()).length,1);
    await assert.rejects(projects.create({name:'same',folderName:process.platform === 'win32' ? 'REVIEW-TOOL' : 'review-tool'}));
    await writeFile(join(project.path,'中文 name.txt'),'before\n');
    execFileSync('git',['add','--','中文 name.txt'],{cwd:project.path,windowsHide:true});
    execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','test'],{cwd:project.path,windowsHide:true});
    await writeFile(join(project.path,'中文 name.txt'),'after\n');
    await writeFile(join(project.path,'untracked.txt'),'new');
    const status=await projects.gitStatus(project.id);
    assert.ok(status.entries.some(e=>e.path==='中文 name.txt'&&e.worktree==='M'));
    assert.ok(status.entries.some(e=>e.path==='untracked.txt'&&e.index==='?'));
    assert.match((await projects.gitDiff(project.id,false)).text, /\+after/);
    assert.equal((await projects.gitDiff(project.id,true)).text,'');
    await mkdir(join(root,'outside'));
    await symlink(join(root,'outside'),join(root,'junction'),'junction');
    assert.equal((await projects.refresh()).some(p=>p.name==='junction'),false);
    await assert.rejects(projects.resolve('unknown'));
  } finally {assert.equal(dirname(root),tmpdir());await rm(root,{recursive:true,force:true});}
});

test('safe files and structured diffs cover untracked, staged, rename and binary files', async () => {
  const root=await mkdtemp(join(tmpdir(),'codex-project-files-'));
  try {
    const projects=new Projects(root); const project=await projects.create({name:'Files',folderName:'files'});
    await writeFile(join(project.path,'old name.txt'),'one\ntwo\n');
    execFileSync('git',['add','.'],{cwd:project.path}); execFileSync('git',['-c','user.name=T','-c','user.email=t@x','commit','-m','base'],{cwd:project.path});
    execFileSync('git',['mv','old name.txt','new name.txt'],{cwd:project.path});
    await writeFile(join(project.path,'new name.txt'),'one\nchanged\n');
    await writeFile(join(project.path,'untracked.txt'),'fresh\n');
    await mkdir(join(project.path,'new assets/nested'),{recursive:true});
    await writeFile(join(project.path,'new assets/nested/note.txt'),'nested\n');
    await writeFile(join(project.path,'binary.bin'),Buffer.from([0,1,2,3]));
    const files=await projects.gitFiles(project.id,false);
    assert.ok(files.files.some(f=>f.path==='untracked.txt'&&f.status==='untracked'&&f.added===1));
    assert.ok(files.files.some(f=>f.path==='new assets/nested/note.txt'&&f.status==='untracked'&&f.added===1));
    assert.match(await projects.gitPatch(project.id,'new assets/nested/note.txt'),/\+nested/);
    const diff=await projects.gitFileDiff(project.id,'untracked.txt',false);
    assert.equal(diff.hunks[0].lines[0].kind,'add'); assert.equal(diff.hunks[0].lines[0].newLine,1);
    assert.equal((await projects.readFile(project.id,'binary.bin')).binary,true);
    assert.deepEqual((await projects.listFiles(project.id,'')).files.map(f=>f.path),['binary.bin','new assets','new name.txt','untracked.txt']);
    await assert.rejects(projects.readFile(project.id,'../outside'));
    await assert.rejects(projects.readFile(project.id,'C:\\Windows\\win.ini'));
    await assert.rejects(projects.readFile(project.id,'new name.txt:stream'));
    await writeFile(join(project.path,'.gitignore'),'ignored.txt\n'); await writeFile(join(project.path,'ignored.txt'),'secret');
    assert.equal((await projects.readFile(project.id,'ignored.txt')).text,'secret');
    assert.ok((await projects.listFiles(project.id)).files.some(file=>file.path==='ignored.txt'));
    await assert.rejects(projects.readFile(project.id,'.git/config'));
    const patch=await projects.gitPatch(project.id,'untracked.txt',false); assert.match(patch,/\+fresh/);
    assert.match(patch,/@@ -0,0 \+1,1 @@/); assert.doesNotMatch(patch,/\n\+\n?$/);
    assert.equal((await projects.gitFiles(project.id,true)).files.some(f=>f.path==='untracked.txt'),false);
    execFileSync('git',['add','new name.txt'],{cwd:project.path});
    assert.equal((await projects.gitFiles(project.id,false)).files.some(f=>f.status==='renamed'),false);
    await writeFile(join(project.path,'huge.txt'),'x'.repeat(2*1024*1024));
    const huge=await projects.readFile(project.id,'huge.txt'); assert.equal(huge.truncated,true); assert.ok(Buffer.byteLength(huge.text)<=1024*1024);
    const hugeDiff=await projects.gitFileDiff(project.id,'huge.txt'); assert.equal(hugeDiff.truncated,true); assert.ok(Buffer.byteLength(JSON.stringify(hugeDiff))<1100*1024);
    await writeFile(join(project.path,'too-big.txt'),'x'.repeat(5*1024*1024+1)); await assert.rejects(projects.gitPatch(project.id,'too-big.txt'),/5 MiB/);
    await rm(join(project.path,'new name.txt')); assert.ok((await projects.gitFileDiff(project.id,'new name.txt',false)).hunks.length>0);
  } finally { assert.equal(dirname(root),tmpdir()); await rm(root,{recursive:true,force:true}); }
});
