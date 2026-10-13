import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {retainWriterLease} from '../src/codex/writer-lease.ts';
test('writer check refuses unsupported path and identifier without starting a helper',async()=>{
 await assert.rejects(retainWriterLease('relative','bad'),/WRITER_CHECK_UNSUPPORTED/);
});
test('Windows readonly helper preserves actual missing-file exception and refuses an initially free lock',{skip:process.platform!=='win32'},async t=>{
 const home=await mkdtemp(join(tmpdir(),'writer-lease-')),id='00000000-0000-4000-8000-000000000001',dir=join(home,'thread-writer-locks');t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(dir);await writeFile(join(dir,'.coordination.lock'),'coordination-sentinel');
 await assert.rejects(retainWriterLease(home,id),error=>{
  const exception=error as any;assert.match(exception.name,/FileNotFoundException/);assert.match(exception.message,/00000000-0000-4000-8000-000000000001.lock/);assert.equal(exception.win32Error,2);return true;
 });
 await writeFile(join(dir,id+'.lock'),'writer-sentinel');
 await assert.rejects(retainWriterLease(home,id),error=>(error as any).code==='WRITER_CHECK_NOT_HELD');
 assert.equal(await readFile(join(dir,'.coordination.lock'),'utf8'),'coordination-sentinel');assert.equal(await readFile(join(dir,id+'.lock'),'utf8'),'writer-sentinel');
});
