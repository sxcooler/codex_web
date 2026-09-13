import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { Projects } from '../src/projects.ts';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}
async function commit(repo: string, subject: string, file: string, value = subject) {
  await writeFile(join(repo, file), value);
  await git(repo, 'add', '--', file);
  await git(repo, 'commit', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

test('git history covers roots, merges, branches, rename/delete, and frozen 100-item pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
  const repo = join(root, 'repo');
  try {
    await mkdir(repo); await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'History Tester');
    await git(repo, 'config', 'user.email', 'history@example.test');
    const rootId = await commit(repo, 'root commit', 'old.txt', 'one\n');
    await git(repo, 'checkout', '-b', 'topic');
    const topicId = await commit(repo, 'topic commit', 'topic.txt');
    await git(repo, 'checkout', 'main');
    await commit(repo, 'main commit', 'main.txt');
    await git(repo, 'merge', '--no-ff', 'topic', '-m', 'merge topic');
    const mergeId = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'mv', 'old.txt', 'new.txt'); await git(repo, 'commit', '-m', 'rename file');
    const renameId = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'rm', 'new.txt'); await git(repo, 'commit', '-m', 'delete file');
    const deleteId = await git(repo, 'rev-parse', 'HEAD');
    for (let i = 0; i < 98; i++) await commit(repo, `page ${i}`, 'page.txt', `${i}\n`);

    const projects = new Projects(root); const project = (await projects.list())[0];
    const first = await projects.gitLog(project.id, 'HEAD');
    assert.equal(first.repository, true); assert.equal(first.commits.length, 100); assert.ok(first.nextCursor);
    assert.ok(first.branches.some(branch => branch.name === 'main' && branch.ref === 'refs/heads/main' && branch.current));
    assert.ok(first.branches.some(branch => branch.name === 'topic' && !branch.current));
    const newId = await commit(repo, 'arrived after page one', 'later.txt');
    const second = await projects.gitLog(project.id, 'HEAD', first.nextCursor!);
    assert.equal(second.nextCursor, null); assert.ok(second.commits.length > 0);
    assert.ok(!second.commits.some(item => item.id === newId));
    assert.equal(new Set([...first.commits, ...second.commits].map(item => item.id)).size, first.commits.length + second.commits.length);
    for(let i=0;i<71;i++)await git(repo,'branch','fan/'+i,'HEAD~'+i);
    const wide=await projects.gitLog(project.id,'all'); assert.ok(wide.nextCursor && wide.nextCursor.length<4096);
    assert.ok((await projects.gitLog(project.id,'all',wide.nextCursor!)).commits.length>0);
    const sameHead=await git(repo,'rev-parse','HEAD');
    execFileSync('git',['update-ref','--stdin'],{cwd:repo,input:Array.from({length:520},(_,i)=>'update refs/heads/same/'+i+' '+sameHead).join('\n')+'\n'});
    const sameHeads=await projects.gitLog(project.id,'all');
    assert.ok(sameHeads.nextCursor && (await projects.gitLog(project.id,'all',sameHeads.nextCursor)).commits.length>0);
    await git(repo,'branch','功能/中文','HEAD~2');
    assert.ok((await projects.gitLog(project.id,'refs/heads/功能/中文')).commits.length>0);
    const tree=await git(repo,'rev-parse','HEAD^{tree}');
    for(let i=0;i<200;i++){const tip=await git(repo,'commit-tree',tree,'-m','independent '+i);await git(repo,'update-ref','refs/heads/wide/'+i,tip);}
    await assert.rejects(()=>projects.gitLog(project.id,'all'),(error:any)=>error.statusCode===409&&/分支过多/.test(error.message));
    const bomb=deflateRawSync('x'.repeat(100_000)).toString('base64url');
    await assert.rejects(()=>projects.gitLog(project.id,'HEAD',bomb),(error:any)=>error.statusCode===400);
    assert.ok((await projects.gitLog(project.id, 'refs/heads/topic')).commits.some(item => item.id === topicId));
    const merge = await projects.gitCommit(project.id, mergeId);
    assert.equal(merge.parent, merge.commit.parents[0]); assert.equal(merge.commit.parents.length, 2);
    assert.equal((await projects.gitCommit(project.id, mergeId, merge.commit.parents[1])).parent, merge.commit.parents[1]);
    await assert.rejects(() => projects.gitCommit(project.id, mergeId, rootId), (error: any) => error.statusCode === 400);
    const rootDetail = await projects.gitCommit(project.id, rootId);
    assert.equal(rootDetail.parent, null); assert.deepEqual(rootDetail.files.map(file => [file.path, file.status]), [['old.txt', 'added']]);
    await writeFile(join(repo,'old.txt'),'uncommitted worktree value\n');
    const rootDiff=await projects.gitCommitDiff(project.id,rootId,undefined,'old.txt');
    assert.deepEqual(rootDiff.hunks.flatMap(hunk=>hunk.lines.filter((line:any)=>line.kind==='add').map((line:any)=>line.text)),['one']);
    await unlink(join(repo,'old.txt'));
    const renamed=(await projects.gitCommit(project.id, renameId)).files;
    assert.deepEqual(renamed.map(file => [file.path, file.oldPath, file.status, file.added, file.deleted]), [['new.txt', 'old.txt', 'renamed', 0, 0]]);
    assert.deepEqual((await projects.gitCommit(project.id, deleteId)).files.map(file => [file.path, file.status]), [['new.txt', 'deleted']]);
    const diff = await projects.gitCommitDiff(project.id, deleteId, undefined, 'new.txt');
    assert.equal(diff.path, 'new.txt'); assert.ok(diff.hunks.some(hunk => hunk.lines.some((line: any) => line.kind === 'delete')));
    await writeFile(join(repo,'.env.example'),'DUMMY_SECRET'); await writeFile(join(repo,'public.txt'),'visible');
    await git(repo,'add','--','.env.example','public.txt'); await git(repo,'commit','-m','mixed visibility'); const mixedId=await git(repo,'rev-parse','HEAD');
    assert.deepEqual((await projects.gitCommit(project.id,mixedId)).files.map(file=>file.path),['public.txt']);
    await assert.rejects(()=>projects.gitCommitDiff(project.id,mixedId,undefined,'.'),(error:any)=>error.statusCode===400);
    await assert.rejects(()=>projects.gitCommitDiff(project.id,mixedId,undefined,'.env.example'),(error:any)=>error.statusCode===403);
    await writeFile(join(repo,'config'),'public file'); await git(repo,'add','--','config'); await git(repo,'commit','-m','config file');
    await rm(join(repo,'config')); await mkdir(join(repo,'config')); await writeFile(join(repo,'config','.env'),'DUMMY_SECRET'); await git(repo,'add','-A'); await git(repo,'commit','-m','file to directory'); const toDirectory=await git(repo,'rev-parse','HEAD');
    assert.ok(!(await projects.gitCommit(project.id,toDirectory)).files.some(file=>file.path==='config'));
    await assert.rejects(()=>projects.gitCommitDiff(project.id,toDirectory,undefined,'config'),(error:any)=>error.statusCode===400);
    await rm(join(repo,'config'),{recursive:true}); await writeFile(join(repo,'config'),'replacement file'); await git(repo,'add','-A'); await git(repo,'commit','-m','directory to file'); const toFile=await git(repo,'rev-parse','HEAD');
    assert.ok(!(await projects.gitCommit(project.id,toFile)).files.some(file=>file.path==='config'));
    await assert.rejects(()=>projects.gitCommitDiff(project.id,toFile,undefined,'config'),(error:any)=>error.statusCode===400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('git history rejects forged refs, commits, parents, paths, and distinguishes an empty repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-edge-'));
  const repo = join(root, 'empty');
  try {
    await mkdir(repo); await git(repo, 'init', '-b', 'main');
    const plain=join(root,'plain'); await mkdir(plain); await writeFile(join(plain,'readme.md'),'plain');
    const projects = new Projects(root); const listed=await projects.list(); const project=listed.find(item=>item.name==='empty')!;
    const nonRepository=listed.find(item=>item.name==='plain')!;
    assert.deepEqual(await projects.gitLog(nonRepository.id,'HEAD'),{repository:false,commits:[],branches:[],nextCursor:null});
    assert.deepEqual((await projects.listFiles(nonRepository.id)).files.map(file=>file.path),['readme.md']);
    assert.deepEqual(await projects.gitLog(project.id, 'HEAD'), { repository: true, commits: [], branches: [{ name: 'main', ref: 'refs/heads/main', current: true }], nextCursor: null });
    for (const action of [
      () => projects.gitLog(project.id, '--all'),
      () => projects.gitLog(project.id, 'refs/heads/main;touch owned'),
      () => projects.gitCommit(project.id, '--help'),
      () => projects.gitCommitDiff(project.id, 'a'.repeat(40), undefined, '../secret'),
    ]) await assert.rejects(action, (error: any) => error.code === 'PROJECT_ERROR' && error.statusCode === 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a non-Git child never discovers a parent repository', async () => {
  const root=await mkdtemp(join(tmpdir(),'codex-parent-repo-'));
  try {
    await git(root,'init','-b','main'); await git(root,'config','user.name','Parent'); await git(root,'config','user.email','parent@example.test');
    const plain=join(root,'plain'),other=join(root,'other'),secrets=join(root,'secrets'),credentials=join(root,'credentials'); await mkdir(plain); await mkdir(other); await mkdir(secrets); await mkdir(credentials);
    await writeFile(join(secrets,'private.json'),'secret'); await writeFile(join(credentials,'private.json'),'credential');
    await writeFile(join(plain,'readme.md'),'child'); await writeFile(join(other,'private.txt'),'private'); await writeFile(join(root,'.gitignore'),'plain/readme.md\n');
    await git(root,'add','--','.gitignore','other/private.txt'); await git(root,'commit','-m','parent repository');
    const projects=new Projects(root),listed=await projects.list();
    assert.ok(!listed.some(project=>['.git','secrets','credentials'].includes(project.name))); const project=listed.find(project=>project.name==='plain')!;
    for(const path of [secrets,credentials]){const id=createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0,24);await assert.rejects(()=>projects.resolve(id),(error:any)=>error.statusCode===404);}
    assert.deepEqual((await projects.listFiles(project.id)).files.map(file=>file.path),['readme.md']);
    assert.equal((await projects.gitLog(project.id)).repository,false);
    for(const action of [()=>projects.gitStatus(project.id),()=>projects.gitDiff(project.id),()=>projects.gitFiles(project.id),()=>projects.gitPatch(project.id,'readme.md')])await assert.rejects(action,(error:any)=>error.statusCode===409);
  } finally { await rm(root,{recursive:true,force:true}); }
});