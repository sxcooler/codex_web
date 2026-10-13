import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/codex/runtime.ts';
import {SharedClientState} from '../src/server/shared-client-state.ts';

test('a released session sharing an active AppServer does not invalidate list reads and receives handoff after the other session finishes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'release-list-feedback-'));
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:dir});
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  const a=await runtime.create({cwd:dir,clientRequestId:'idle-a'}),b=await runtime.create({cwd:dir,clientRequestId:'busy-b',prompt:'hold'});
  assert.equal((await runtime.requestRelease(a.threadId)).handoffReady,false);
  assert.equal((runtime as any).state(a.threadId).released,true);
  const server=(runtime as any).server,nativePid=runtime.diagnosticState().native?.nativePid,request=server.request.bind(server),changes:any[]=[];
  let lists=0,headers=0;
  await mkdir(join(dir,'sessions'));const path=join(dir,'sessions','fork.jsonl');await writeFile(path,'');(runtime as any).initializeInfo.codexHome=dir;
  t.mock.method(server,'request',async(method:string,params:any,timeout?:number)=>{
    const result=await request(method,params,timeout);
    if(method==='thread/list')lists++;
    if(method==='thread/read'&&params.threadId==='fork'){headers++;return {thread:{...result.thread,path,source:'appServer',forkedFromId:a.threadId,preview:''}};}
    return result;
  });
  runtime.on('change',event=>{if(event.threadId===a.threadId&&event.kind==='release')changes.push(event.patch.state);});
  const usage=Object.assign(new EventEmitter(),{snapshot:()=>({}),read:async()=>({}),refreshBackground:async()=>({})});
  const shared=new SharedClientState(runtime,usage as any,async(query,signal)=>{
    const result=await runtime.list(query.cursor,query.archived,query.sortKey,query.searchTerm),fork=await runtime.forkListHeader('fork',5000);signal.throwIfAborted();
    assert.ok(fork,'the fixture fork must qualify for the filesystem supplement');
    return {...result,data:[...result.data,fork.thread]};
  });
  t.after(()=>shared.close());
  const result=await shared.readSessions({sortKey:'updated_at',archived:false,includeHidden:false,searchTerm:''});
  assert.ok(result.data.some((thread:any)=>thread.id==='fork'));assert.equal(lists,1);assert.equal(headers,1);
  assert.deepEqual(changes,[],'an already released thread cannot repeatedly reserve itself or emit release changes after reads');
  assert.equal(runtime.diagnosticState().native?.nativePid,nativePid,'the busy sibling keeps the shared native process alive');
  shared.close();
  const ready=Promise.withResolvers<void>();
  const changed=(event:any)=>{if(event.threadId===a.threadId&&(runtime as any).state(a.threadId).handoffReady)ready.resolve();};runtime.on('change',changed);
  const timer=setTimeout(()=>ready.reject(Error('pending released session never received handoff')),3000);
  try{await runtime.abort(b.threadId);await ready.promise;}finally{clearTimeout(timer);runtime.off('change',changed);}
  assert.equal((runtime as any).state(a.threadId).handoffReady,true);assert.equal(runtime.diagnosticState().native,undefined);
  assert.equal(changes.length,1);assert.equal(changes[0].phase,'RELEASED');assert.equal(changes[0].release.handoffReady,true);
});

test('diagnostics retain unloaded release ownership until handoff without waking native or exposing private fields',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd:process.cwd()});t.after(()=>runtime.close());
  const id='00000000-0000-4000-8000-000000000001',state=(runtime as any).state(id);
  Object.assign(state,{releaseRequested:true,released:true,handoffReady:false,cwd:'/private-cwd-sentinel',nativeName:'private-prompt-sentinel'});
  const sample=runtime.diagnosticState();assert.equal(sample.native,undefined);assert.equal(sample.threads.length,1);
  assert.equal(sample.threads[0].threadId,id);assert.equal(sample.threads[0].phase,'RELEASED');
  assert.deepEqual(sample.threads[0].release,{requested:true,released:true,handoffReady:false});
  assert.doesNotMatch(JSON.stringify(sample),/private-cwd-sentinel|private-prompt-sentinel/);
  state.releaseRequested=false;assert.equal(runtime.diagnosticState().threads.length,1,'a confirmed manual pending release remains visible even without an older requested flag');
  state.handoffReady=true;assert.deepEqual(runtime.diagnosticState().threads,[]);
});

test('confirmed manual release completes handoff after a sibling naturally finishes without navigation or another release request',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'manual-release-handoff-'));
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:dir,idleMs:60_000});
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  const a=await runtime.create({cwd:dir,clientRequestId:'manual-a'}),b=await runtime.create({cwd:dir,clientRequestId:'manual-b',prompt:'approval'});
  const [pending]=(await runtime.snapshot(b.threadId)).pending;
  const result=await runtime.release(a.threadId);
  assert.equal(result.nativeStatus,'unsubscribed');assert.equal(result.handoffReady,false);
  const state=(runtime as any).state(a.threadId),changes:any[]=[],ready=Promise.withResolvers<void>();
  runtime.on('change',event=>{if(event.threadId===a.threadId&&event.kind==='release'){changes.push(event.patch.state);if(state.handoffReady)ready.resolve();}});
  const timer=setTimeout(()=>ready.reject(Error('manual pending release was not completed by the sibling completion')),1000);
  try{await runtime.respond(b.threadId,pending.requestId,{decision:'accept'});await ready.promise;}finally{clearTimeout(timer);}
  assert.equal(state.releaseRequested,true);assert.equal(state.handoffReady,true);assert.equal(runtime.diagnosticState().native,undefined);
  assert.equal(changes.length,1);assert.equal(changes[0].release.handoffReady,true);
});

test('failed manual release does not create a deferred release intention',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'manual-release-rejected-'));
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:dir,idleMs:60_000});
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  const busy=await runtime.create({cwd:dir,clientRequestId:'rejected-busy',prompt:'approval'}),idle=await runtime.create({cwd:dir,clientRequestId:'rejected-idle'});
  const server=(runtime as any).server,request=server.request.bind(server);let unsubscribes=0;
  t.mock.method(server,'request',async(method:string,params:any,timeout?:number)=>{
    if(method==='thread/unsubscribe'){unsubscribes++;return {status:'not-confirmed'};}
    return request(method,params,timeout);
  });
  await assert.rejects(runtime.release(busy.threadId),{code:'RUNTIME_THREAD_BUSY'});assert.equal(unsubscribes,0);
  await assert.rejects(runtime.release(idle.threadId),{code:'RUNTIME_UNAVAILABLE'});assert.equal(unsubscribes,1);
  for(const id of [busy.threadId,idle.threadId])assert.equal(!!(runtime as any).state(id).releaseRequested,false);
  const [pending]=(await runtime.snapshot(busy.threadId)).pending;
  await runtime.respond(busy.threadId,pending.requestId,{decision:'accept'});
  await runtime.list();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(unsubscribes,1);assert.ok(runtime.diagnosticState().native);
  for(const id of [busy.threadId,idle.threadId])assert.equal((runtime as any).state(id).released,false);
});
