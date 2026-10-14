import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/codex/runtime.ts';

const fixture=fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url));
function runtimeFixture(t:any){
 const runtime=new Runtime({executable:process.execPath,args:[fixture,'normal'],cwd:fileURLToPath(new URL('..',import.meta.url)),idleMs:60_000,sandbox:'danger-full-access'});
 t.after(()=>runtime.close().catch(()=>{}));return runtime;
}
function holdRequest(t:any,runtime:Runtime,method:string){
 const server=(runtime as any).server,original=server.request.bind(server),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
 t.mock.method(server,'request',async(name:string,...args:any[])=>{if(name===method&&!held){held=true;started.resolve();await release.promise;}return original(name,...args);});
 return {started:started.promise,release:()=>release.resolve()};
}

for(const method of ['thread/list','thread/read'])test(`explicit Web restart permits a pending read: ${method}`,async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const gate=holdRequest(t,runtime,method);
 const read=(method==='thread/list'?runtime.list():runtime.threadHeaderRead('existing')).catch(error=>error);
 await gate.started;
 try{
  assert.throws(()=>runtime.assertIdle(),{code:'RUNTIME_THREAD_BUSY'},'updater and automatic idle checks retain their strict read guard');
  await runtime.assertNativeIdle();await runtime.prepareRestart();
  await assert.rejects(runtime.models(),{code:'RUNTIME_UPDATING'},'Web restart closes admission after its final task check');
 }finally{gate.release();await read;}
});

test('explicit native restart can close an idle child while a background list request is pending',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const previous=(runtime as any).server,gate=holdRequest(t,runtime,'thread/list');
 const read=runtime.list().catch(error=>error);await gate.started;
 try{assert.ok((await runtime.reloadModels()).data.length);assert.notStrictEqual((runtime as any).server,previous);}
 finally{gate.release();await read;}
});

test('restart continues to protect a native write even when only reads may be interrupted',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const gate=holdRequest(t,runtime,'thread/name/set');
 const write=(runtime as any).mutation('thread/name/set',{threadId:'existing',name:'Fixture name'}).catch((error:any)=>error);await gate.started;
 try{await assert.rejects(runtime.assertNativeIdle(),{code:'RUNTIME_THREAD_BUSY'});await assert.rejects(runtime.prepareRestart(),{code:'RUNTIME_THREAD_BUSY'});}
 finally{gate.release();await write;}
 await runtime.assertNativeIdle();
});

test('restart protects an account reset submission through confirmation',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const server=(runtime as any).server,original=server.request.bind(server),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 t.mock.method(server,'request',async(method:string,...args:any[])=>{
  if(method==='account/rateLimits/read')return {accountId:'fixture-account'};
  if(method==='account/rateLimitResetCredit/consume'){started.resolve();await release.promise;return {accepted:true};}
  return original(method,...args);
 });
 const write=runtime.consumeAccountReset({creditId:'fixture-credit',idempotencyKey:'fixture-reset'},createHash('sha256').update('fixture-account').digest('hex')).catch(error=>error);await started.promise;
 try{await assert.rejects(runtime.prepareRestart(),{code:'RUNTIME_THREAD_BUSY'});await assert.rejects(runtime.reloadModels(),{code:'RUNTIME_THREAD_BUSY'});}
 finally{release.resolve();await write;}
 await runtime.assertNativeIdle();
});

for(const operation of ['create','saveModelDefaults'])test(`restart protects ${operation} before its validation reads complete`,async t=>{
 const runtime=runtimeFixture(t),models=await runtime.models(),original=runtime.models.bind(runtime),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false;
 t.mock.method(runtime,'models',async(...args:any[])=>{if(!held){held=true;started.resolve();await release.promise;}return (original as any)(...args);});
 const model=models.data[0].model,write=(operation==='create'?runtime.create({cwd:fileURLToPath(new URL('..',import.meta.url)),clientRequestId:'fixture-create',model}):runtime.saveModelDefaults(fileURLToPath(new URL('..',import.meta.url)),model,undefined,'fixture-version')).catch(error=>error);
 await started.promise;
 try{await assert.rejects(runtime.prepareRestart(),{code:'RUNTIME_THREAD_BUSY'});await assert.rejects(runtime.reloadModels(),{code:'RUNTIME_THREAD_BUSY'});}
 finally{release.resolve();await write;}
 await runtime.assertNativeIdle();
});

test('a task appearing during the native idle query still prevents restart',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const gate=holdRequest(t,runtime,'thread/loaded/list');
 const check=runtime.prepareRestart();const rejected=assert.rejects(check,{code:'RUNTIME_THREAD_BUSY'});await gate.started;
 (runtime as any).state('racing-task').activeTurnId='running-turn';gate.release();await rejected;
 assert.ok((await runtime.models()).data.length,'rejected check does not close admission');
});

for(const flags of [['waitingOnApproval'],['waitingOnUserInput']])test(`pending reads do not hide a native active task: ${flags[0]}`,async t=>{
 const runtime=runtimeFixture(t);await runtime.models();await (runtime as any).call('fixture/native-thread',{threadId:'background',status:{type:'active',activeFlags:flags}});
 const gate=holdRequest(t,runtime,'thread/list'),read=runtime.list().catch(error=>error);await gate.started;
 try{await assert.rejects(runtime.prepareRestart(),{code:'RUNTIME_THREAD_BUSY'});}finally{gate.release();await read;}
});

test('pending reads cannot authorize restart when native activity is unknown',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();await (runtime as any).call('fixture/native-thread',{threadId:'background',status:{type:'unknown'}});
 const gate=holdRequest(t,runtime,'thread/list'),read=runtime.list().catch(error=>error);await gate.started;
 try{await assert.rejects(runtime.prepareRestart(),{code:'RUNTIME_UNAVAILABLE'});}finally{gate.release();await read;}
});
