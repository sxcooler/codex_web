import assert from 'node:assert/strict';
import test from 'node:test';
import {Runtime} from '../src/codex/runtime.ts';
import {resolve} from 'node:path';

test('runtime delegates extension sections and search to its service and retains read accounting',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());
 const gate=Promise.withResolvers<any>(),calls:any[]=[];
 (runtime as any).extensionCatalog={read:async(...args:any[])=>{calls.push(['read',...args]);return gate.promise;},search:async(...args:any[])=>{calls.push(['search',...args]);return {items:[]};},invalidate:()=>{}};
 const reading=runtime.extensions(process.cwd(),{section:'apps',refresh:true});
 assert.equal((runtime as any).reads,1);gate.resolve({section:'apps'});assert.deepEqual(await reading,{section:'apps'});assert.equal((runtime as any).reads,0);
 await runtime.searchExtensions(process.cwd(),{query:'keyword',cursor:'opaque',refresh:false});
 assert.deepEqual(calls,[['read',process.cwd(),{section:'apps',refresh:true}],['search',process.cwd(),{query:'keyword',cursor:'opaque',refresh:false}]]);
 assert.equal((runtime as any).reads,0);assert.equal((runtime as any).writes,0);
});

test('runtime extension mutations preserve single-writer exclusion and clean up counters on failure',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());
 const gate=Promise.withResolvers<any>();
 (runtime as any).extensionCatalog={change:()=>gate.promise,invalidate:()=>{}};
 const changing=runtime.changeExtension(process.cwd(),{action:'mcp.reload'});
 assert.equal((runtime as any).reads,1);assert.equal((runtime as any).writes,1);
 await assert.rejects(runtime.changeExtension(process.cwd(),{action:'mcp.reload'}),{code:'EXTENSION_BUSY'});
 gate.reject(Object.assign(Error('unknown'),{code:'EXTENSION_WRITE_UNKNOWN'}));await assert.rejects(changing,{code:'EXTENSION_WRITE_UNKNOWN'});
 assert.equal((runtime as any).reads,0);assert.equal((runtime as any).writes,0);assert.equal((runtime as any).extensionWriting,false);
});

test('runtime invalidates extension service for account changes and Apps updates, without quota invalidation',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),invalidations:any[]=[];
 (runtime as any).extensionCatalog={invalidate:(method?:string)=>{if(method!=='account/rateLimits/updated')invalidations.push(method);}};
 for(const method of ['account/rateLimits/updated','app/list/updated','account/updated'])(runtime as any).onNotification({method,params:{}});
 assert.deepEqual(invalidations,['app/list/updated','account/updated']);
 runtime.emit('accountChanged');assert.deepEqual(invalidations,['app/list/updated','account/updated',undefined]);
 await runtime.close();assert.deepEqual(invalidations,['app/list/updated','account/updated',undefined,undefined]);
});

test('extension peers pin RPC and CLI to the epoch and home that created them',async t=>{
 for(const change of ['epoch','home']){
  const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());
  const home=resolve('fixture-home');let requests=0;
  const server={request:async()=>{requests++;return {ok:true};}};
  (runtime as any).server=server;(runtime as any).initializeInfo={codexHome:home};
  t.mock.method(runtime as any,'configurationHome',async()=>home);
  t.mock.method(runtime as any,'getServer',async()=>server);
  const peer=await (runtime as any).extensionPeer(process.cwd());
  assert.deepEqual(await peer.request('config/read',{}),{ok:true});assert.equal(requests,1);
  if(change==='epoch')(runtime as any).epoch='replacement';else (runtime as any).initializeInfo.codexHome=resolve('replacement-home');
  await assert.rejects(peer.request('config/batchWrite',{}),{code:'RUNTIME_SYNC_RESTARTED'});
  await assert.rejects(peer.cli(['plugin','install','fixture@market']),{code:'RUNTIME_SYNC_RESTARTED'});
  assert.equal(requests,1,'stale peers cannot send any RPC to the replacement process');
  (runtime as any).server=undefined;
 }
});
