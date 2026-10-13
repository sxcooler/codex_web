import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/codex/runtime.ts';
const cwd=fileURLToPath(new URL('..',import.meta.url));
test('unloaded thread needs positive writer proof and can hand off while its sibling keeps running',async t=>{
 let free=false,checks=0,closed=0;
 const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd,
  writerLease:async()=>({released:async()=>{checks++;return free;},close:async()=>{closed++;}})} as any);
 t.after(()=>runtime.close());
 const a=await runtime.create({cwd,clientRequestId:'a'}),b=await runtime.create({cwd,clientRequestId:'b',prompt:'hold'}),internal=runtime as any;
 const pid=runtime.diagnosticState().native?.nativePid;
 const released=await runtime.release(a.threadId);assert.equal(released.handoffReady,false);assert.equal(checks,0,'unsubscribe is not unload proof');
 free=true;assert.equal(internal.state(a.threadId).handoffReady,false,'a free writer without a native unload receipt cannot hand off');
 internal.onNotification({method:'thread/closed',params:{threadId:a.threadId}});
 for(let i=0;i<50&&!internal.state(a.threadId).handoffReady;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(internal.state(a.threadId).handoffReady,true);assert.equal(closed,1);assert.equal(checks,1);
 assert.equal(runtime.diagnosticState().native?.nativePid,pid);assert.equal(internal.state(b.threadId).activeTurnId!==null,true);
});
test('unload with a held or unobservable writer remains pending and never stops busy siblings',async t=>{
 for(const mode of ['held','failure','cleanup']){
  const diagnostic:any[]=[];let closed=0;
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd,diagnostic:e=>diagnostic.push(e),
   writerLease:async()=>({released:async()=>{if(mode==='failure')throw Error('private-path-sentinel');return mode==='cleanup';},close:async()=>{closed++;if(mode==='cleanup')throw Error('helper-cleanup-sentinel');}})} as any);
  try{
   const a=await runtime.create({cwd,clientRequestId:'a'}),b=await runtime.create({cwd,clientRequestId:'b',prompt:'hold'}),internal=runtime as any,pid=runtime.diagnosticState().native?.nativePid;
   await runtime.release(a.threadId);assert.ok(diagnostic.some(event=>event.reason==='unload_timeout'),'missing unload receipt is bounded, observable and remains pending');internal.onNotification({method:'thread/closed',params:{threadId:a.threadId}});
   await new Promise(r=>setTimeout(r,80));assert.equal(internal.state(a.threadId).handoffReady,false);assert.equal(runtime.diagnosticState().native?.nativePid,pid);assert.ok(internal.state(b.threadId).activeTurnId);
   assert.equal(closed,1);assert.ok(diagnostic.some(event=>event.event==='writer_release_check'&&event.outcome==='unconfirmed'));
   if(mode==='failure')assert.ok(diagnostic.some(event=>event.errorMessage==='private-path-sentinel'),'actual check exception remains diagnosable');
   if(mode==='cleanup')assert.ok(diagnostic.some(event=>event.reason==='helper_cleanup_failed'&&event.errorMessage==='helper-cleanup-sentinel'));
  }finally{await runtime.close();}
 }
});
test('a resume during an outstanding writer check invalidates its old proof',async t=>{
 const probe=Promise.withResolvers<boolean>();let closed=0;
 const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd,
  writerLease:async()=>({released:()=>probe.promise,close:async()=>{closed++;}})} as any);t.after(()=>runtime.close());
 const a=await runtime.create({cwd,clientRequestId:'a'});await runtime.create({cwd,clientRequestId:'b',prompt:'hold'});
 await runtime.release(a.threadId);const internal=runtime as any;
 internal.onNotification({method:'thread/closed',params:{threadId:a.threadId}});await new Promise(r=>setImmediate(r));
 await runtime.cancelRelease(a.threadId);await runtime.open(a.threadId);probe.resolve(true);await new Promise(r=>setImmediate(r));
 assert.equal(internal.state(a.threadId).handoffReady,false);assert.equal(internal.state(a.threadId).released,false);assert.equal(closed,1);
});
test('native close failure still closes all retained writer checks and preserves the native error',async t=>{
 let checksClosed=0;
 const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd,
  writerLease:async()=>({released:async()=>false,close:async()=>{checksClosed++;}})} as any);
 const a=await runtime.create({cwd,clientRequestId:'a'});await runtime.create({cwd,clientRequestId:'b',prompt:'hold'});
 await runtime.release(a.threadId);const internal=runtime as any,server=internal.server,close=server.close.bind(server),error=Error('native-close-failure');
 t.mock.method(server,'close',async()=>{await close();throw error;});
 await assert.rejects(runtime.close(),value=>value===error);
 assert.equal(checksClosed,1);assert.equal(internal.state(a.threadId).writerLease,undefined);assert.equal(internal.state(a.threadId).handoffReady,false);
});
