import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Projects } from '../src/projects.ts';

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
    await assert.rejects(projects.readImage(project.id,'ignored.png'),{statusCode:403});
    await mkdir(join(root,'outside')); await writeFile(join(root,'outside','hidden.png'),png);
    await symlink(join(root,'outside'),join(project.path,'escape'),'junction');
    await assert.rejects(projects.readImage(project.id,'escape/hidden.png'),{statusCode:403});
    await assert.rejects(projects.readImage(project.id,'../outside/hidden.png'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
