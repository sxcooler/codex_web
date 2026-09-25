import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadService, registerUploadRoutes } from '../src/server/uploads.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('default upload limits accept five 15 MiB files and reject larger files or a sixth attachment',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'uploads-defaults-'));
  const service=await createUploadService({dataDir:dir});
  try{
    const data=Buffer.alloc(15*1024*1024,65);
    const inputs=Array.from({length:5},(_,i)=>({name:`${i}.txt`,mime:'text/plain',data}));
    await assert.rejects(service.store('owner',{...inputs[0],data:Buffer.alloc(data.length+1,65)}),/15728640 bytes/);
    await assert.rejects(service.storeMany('owner',[...inputs,inputs[0]]),/5 files/);
    const uploaded=await service.storeMany('owner',inputs);
    assert.equal(uploaded.reduce((sum,item)=>sum+item.size,0),75*1024*1024);
    const claimed=await service.claim('owner',null,'default-limits',uploaded.map(item=>item.uploadId));
    assert.equal(claimed.inputs.length,5);
  }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('multipart rejects a truncated file and rolls back the entire batch', async () => {
  const dir=await mkdtemp(join(tmpdir(),'uploads-route-'));
  const service=await createUploadService({dataDir:dir,maxFileBytes:4,quotaBytes:8});
  const app=Fastify();
  try{
    await registerUploadRoutes(app,service,{authenticated:()=>true,owner:()=> 'owner'});
    const body=(values:string[])=>values.map((value,i)=>`--boundary\r\nContent-Disposition: form-data; name="file"; filename="${i}.txt"\r\nContent-Type: text/plain\r\n\r\n${value}\r\n`).join('')+'--boundary--\r\n';
    const rejected=await app.inject({method:'POST',url:'/api/uploads',headers:{'content-type':'multipart/form-data; boundary=boundary'},payload:body(['ok','abcde'])});
    assert.equal(rejected.statusCode,413,rejected.body);
    assert.deepEqual(await readdir(join(dir,'uploads')),[]);
    const accepted=await app.inject({method:'POST',url:'/api/uploads',headers:{'content-type':'multipart/form-data; boundary=boundary'},payload:body(['abcd','efgh'])});
    assert.equal(accepted.statusCode,200,accepted.body);
    assert.deepEqual(accepted.json().uploads.map((x:any)=>x.size),[4,4]);
  }finally{await app.close();service.close();await rm(dir,{recursive:true,force:true});}
});

test('upload streams chunks into private temp storage and hashes the original bytes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'uploads-stream-'));
  const service=await createUploadService({dataDir:dir});
  try{
    async function* chunks(){
      yield Buffer.from('first');
      const paths=await readdir(join(dir,'uploads'));
      assert.equal(paths.length,1);
      assert.ok(paths[0].endsWith('.tmp'));
      assert.equal(await readFile(join(dir,'uploads',paths[0]),'utf8'),'first');
      yield Buffer.from('second');
    }
    const [item]=await service.storeStreams('owner',[{name:'a.txt',mime:'text/plain',data:chunks()}]);
    const stored=await service.read('owner',item.uploadId);
    assert.equal(stored.data.toString(),'firstsecond');
    assert.equal(stored.sha256,createHash('sha256').update('firstsecond').digest('hex'));
  }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('upload validates content, persists privately, and claim is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uploads-'));
  let service: Awaited<ReturnType<typeof createUploadService>> | undefined;
  try {
    service = await createUploadService({ dataDir: dir, quotaBytes: 1024 });
    await assert.rejects(service.store('owner', { name: 'x.png', mime: 'image/png', data: Buffer.from('<html>') }), /content/i);
    await assert.rejects(service.store('owner', { name: 'notes.txt', mime: 'text/plain', data: Buffer.from('MZfake executable') }), /content/i);
    await assert.rejects(service.store('owner', { name: 'notes.json', mime: 'text/plain', data: Buffer.from('plain') }), /extension/i);
    const pdf=await service.store('owner',{name:'binary.pdf',mime:'application/pdf',data:Buffer.from([37,80,68,70,45,49,46,55,10,0,1])});
    assert.equal(pdf.kind,'file');
    const uploaded = await service.store('owner', { name: '../../photo.png', mime: 'image/png', data: png });
    assert.equal(uploaded.kind, 'image');
    assert.equal(uploaded.name, 'photo.png');
    await assert.rejects(service.store('owner', { name: 'cut.png', mime: 'image/png', data: png.subarray(0, 33) }), /image content/i);
    const first = await service.claim('owner', null, 'request-1', [uploaded.uploadId]);
    assert.equal(await service.bindClaim('owner', 'request-1', 'thread-1'), 1);
    const again = await service.claim('owner', null, 'request-1', [uploaded.uploadId]);
    assert.deepEqual(again, first);
    assert.equal(first.inputs[0].type, 'localImage');
    assert.deepEqual(await readFile((first.inputs[0] as {path:string}).path), png);
    await assert.rejects(service.bindClaim('owner', 'request-1', 'thread-2'), /another thread/i);
    assert.equal(await service.rollbackClaim('owner', 'request-1'), 0);
    assert.equal(service.listForThread('owner', 'thread-1').length, 1);
    await assert.rejects(service.claim('other', 'thread-1', 'request-1', [uploaded.uploadId]), /not found/i);
  } finally { service?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('upload enforces per-file, batch, count, and durable quota limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uploads-'));
  try {
    const service = await createUploadService({ dataDir: dir, maxFileBytes: 10, maxBatchBytes: 15, quotaBytes: 20 });
    await assert.rejects(service.store('owner', { name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(11) }), /10 bytes/);
    await assert.rejects(service.storeMany('owner', Array.from({length: 6}, (_, i) => ({ name: `${i}.txt`, mime: 'text/plain', data: Buffer.from('a') }))), /5 files/);
    await assert.rejects(service.storeMany('owner', [{name:'a.txt',mime:'text/plain',data:Buffer.alloc(8)},{name:'b.txt',mime:'text/plain',data:Buffer.alloc(8)}]), /15 bytes/);
    await service.store('owner', { name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(10, 65) });
    await service.store('owner', { name: 'b.txt', mime: 'text/plain', data: Buffer.alloc(10, 66) });
    await assert.rejects(service.store('owner', { name: 'c.txt', mime: 'text/plain', data: Buffer.from('x') }), /quota/i);
    await service.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent stores reserve quota and failed batches leave no durable rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uploads-'));
  const service = await createUploadService({ dataDir: dir, maxFileBytes: 20, maxBatchBytes: 30, quotaBytes: 20 });
  try {
    const settled=await Promise.allSettled([
      service.store('owner',{name:'a.txt',mime:'text/plain',data:Buffer.alloc(12,65)}),
      service.store('owner',{name:'b.txt',mime:'text/plain',data:Buffer.alloc(12,66)})
    ]);
    assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
    await assert.rejects(service.storeMany('owner',[{name:'ok.txt',mime:'text/plain',data:Buffer.from('ok')},{name:'bad.svg',mime:'image/svg+xml',data:Buffer.from('<svg/>')}]),/allowed/);
    const winner=(settled.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<any>).value;
    assert.deepEqual((await service.read('owner',winner.uploadId)).data,Buffer.alloc(12,winner.name==='a.txt'?65:66));
  } finally { service.close(); await rm(dir,{recursive:true,force:true}); }
});

test('claim enforces aggregate bytes and only rolls back unaccepted requests', async () => {
  const dir=await mkdtemp(join(tmpdir(),'uploads-'));
  const service=await createUploadService({dataDir:dir,maxFileBytes:20,maxBatchBytes:15,quotaBytes:100});
  try{
    const a=await service.store('owner',{name:'a.txt',mime:'text/plain',data:Buffer.alloc(8,65)});
    const b=await service.store('owner',{name:'b.txt',mime:'text/plain',data:Buffer.alloc(8,66)});
    await assert.rejects(service.claim('owner',null,'too-large',[a.uploadId,b.uploadId]),/15 bytes/);
    await service.claim('owner',null,'retryable',[a.uploadId]);
    assert.equal(await service.rollbackClaim('owner','retryable'),1);
    await service.claim('owner','thread-1','accepted',[a.uploadId]);
    await service.bindClaim('owner','accepted','thread-1');
    assert.equal(await service.rollbackClaim('owner','accepted'),0);
  }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('cleanup and claim cannot produce a claimed missing attachment', async () => {
  const dir=await mkdtemp(join(tmpdir(),'uploads-'));
  const service=await createUploadService({dataDir:dir,draftTtlMs:1});
  try{
    const item=await service.store('owner',{name:'a.txt',mime:'text/plain',data:Buffer.from('a')});
    const [cleaned,claimed]=await Promise.allSettled([service.cleanup(Date.now()+10),service.claim('owner',null,'request',[item.uploadId])]);
    assert.ok(cleaned.status==='fulfilled');
    if(claimed.status==='fulfilled')assert.deepEqual((await service.read('owner',item.uploadId)).data,Buffer.from('a'));
    else await assert.rejects(service.read('owner',item.uploadId),/not found/);
  }finally{service.close();await rm(dir,{recursive:true,force:true});}
});
