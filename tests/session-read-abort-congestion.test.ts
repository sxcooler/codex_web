import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {get} from 'node:http';
import Fastify from 'fastify';
import {Runtime} from '../src/codex/runtime.ts';
import {registerApi} from '../src/server/api.ts';
import {MetadataStore} from '../src/server/metadata.ts';
import {SharedClientState} from '../src/server/shared-client-state.ts';

for(const survivor of [false,true])test(`cancelled session-list HTTP leaves one bounded backend job ${survivor?'shared with a surviving client':'to complete without a surviving client'} and caches its final result`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'session-read-abort-'));
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:dir});
  await runtime.list();const server=(runtime as any).server,request=server.request.bind(server);
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>(),joined=Promise.withResolvers<void>();let lists=0,forks=0;
  const jobs:Promise<any>[]=[],nativeCursors:any[]=[],paths:string[]=[],readSessions=SharedClientState.prototype.readSessions;
  t.mock.method(SharedClientState.prototype,'readSessions',function(this:SharedClientState,...args:Parameters<SharedClientState['readSessions']>){
    const job=readSessions.apply(this,args);jobs.push(job);if(jobs.length===2)joined.resolve();return job;
  });
  t.mock.method(server,'request',async(method:string,input:any,timeout?:number)=>{
    if(method!=='thread/list'||input.projectId===null)return request(method,input,timeout);
    lists++;nativeCursors.push(input.cursor);if(!input.cursor){entered.resolve();await gate.promise;}
    await request(method,input,timeout);
    return input.cursor?{data:[{id:'visible',source:'appServer',updatedAt:3,recencyAt:3}],nextCursor:null}:{data:[{id:'hidden',source:'appServer',updatedAt:4,recencyAt:4}],nextCursor:'next'};
  });
  t.mock.method(runtime,'forkListHeader',async(threadId:string,timeout?:number)=>{
    forks++;assert.equal(threadId,'fork');assert.ok(timeout!>0&&timeout!<=5000,'fork supplement keeps its bounded budget');
    const result=await request('thread/read',{threadId,includeTurns:false},timeout);
    return {thread:{...result.thread,preview:'',forkedFromId:'source',updatedAt:2,recencyAt:2},archived:false};
  });
  const store=new MetadataStore(join(dir,'metadata.sqlite'));store.update('hidden',{hidden:true});store.registerFork({id:'fork',cwd:dir,forkedFromId:'source'});store.close();
  const app=Fastify();app.addHook('onRequest',async(request,reply)=>{paths.push(request.method+' '+request.url);reply.raw.once('close',()=>closed.resolve());});
  registerApi(app,{dataDir:dir,runtime,projects:{root:dir,list:async()=>[]} as any,authenticated:()=>()=>true});
  await app.listen({host:'127.0.0.1',port:0});
  try{
    const address=app.server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/api/sessions`;
    const cancelled=get(url);cancelled.on('error',()=>{});await entered.promise;
    assert.equal(jobs.length,1);const owned=jobs[0];
    const active=survivor?fetch(url):null;
    if(survivor){await joined.promise;assert.strictEqual(jobs[1],owned,'both HTTP readers join the same backend job, not only the same native RPC');}
    cancelled.destroy();await closed.promise;gate.resolve();
    const completed=await owned;
    assert.deepEqual(completed.data.map((row:any)=>row.id),['visible','fork']);
    assert.equal(completed.nextCursor,null);assert.equal(completed.forksPending,false);assert.equal(completed.forkReadsFailed,false);
    if(active){const response=await active;assert.equal(response.status,200);assert.deepEqual(await response.json(),completed);}
    assert.equal(jobs.length,survivor?2:1,'owned completion is observed without adding an HTTP survivor');
    assert.equal(lists,2,'one bounded job completes the hidden page and the visible page');
    assert.deepEqual(nativeCursors,[null,'next']);assert.equal(forks,1,'the same owned job completes one fork supplement');
    const cached=await fetch(url);assert.equal(cached.status,200);assert.deepEqual(await cached.json(),completed,'a later reader receives the completed final page and fork result');
    assert.equal(lists,2,'the later GET reuses the final shared response without another native list');
    assert.equal(forks,1,'the later GET cannot repeat the fork supplement');
    assert.equal(paths.length,survivor?3:2);assert.ok(paths.every(path=>path==='GET /api/sessions'),'this shared cancellation contract only covers the list route');
  }finally{gate.resolve();await app.close();await rm(dir,{recursive:true,force:true});}
});
