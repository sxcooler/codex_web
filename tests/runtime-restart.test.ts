import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/codex/runtime.ts';
import {AppServer} from '../src/codex/app-server.ts';

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
 const runtime=runtimeFixture(t);await runtime.models();await runtime.open('existing');const gate=holdRequest(t,runtime,'thread/name/set');
 const write=(runtime as any).mutation('thread/name/set',{threadId:'existing',name:'Fixture name'}).catch((error:any)=>error);await gate.started;
 try{await assert.rejects(runtime.assertNativeIdle(),{code:'RUNTIME_THREAD_BUSY'});await assert.rejects(runtime.prepareRestart(),{code:'RUNTIME_THREAD_BUSY'});}
 finally{gate.release();assert.equal((await write) instanceof Error,false);}
 await runtime.assertNativeIdle();
});

test('unconfirmed native shutdown retains ownership, blocks new work and permits final close retries',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const server=(runtime as any).server,shutdown=server.shutdown.bind(server);let failures=0;
 t.after(()=>shutdown(true));
 t.mock.method(server,'shutdown',async(force:boolean)=>{if(failures++<2){const error=Error('close not confirmed');server.emit('failure',error);throw error;}return shutdown(force);});
 await assert.rejects(runtime.reloadModels(),/close not confirmed/);
 assert.ok((runtime as any).server===server,'Native ownership must survive a failed reload');
 assert.ok((await server.request('fixture/stats',{})).modelLists,'failed close must retain a process that can still answer');
 await assert.rejects(runtime.models(),{code:'RUNTIME_UPDATING'});
 await assert.rejects(runtime.close(),/close not confirmed/);
 assert.ok((runtime as any).server===server,'Native ownership must survive a failed final close');
 await runtime.close();assert.equal((runtime as any).server,undefined);
});

test('the whole model catalog load remains busy after its native reads finish',async t=>{
 const runtime=runtimeFixture(t);await runtime.models();const load=(runtime as any).loadModels.bind(runtime),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 t.mock.method(runtime as any,'loadModels',async()=>{const result=await load();started.resolve();await release.promise;return result;});
 const pending=runtime.models(true);await started.promise;
 try{assert.throws(()=>runtime.assertIdle(),{code:'RUNTIME_THREAD_BUSY'});}
 finally{release.resolve();await pending;}
 runtime.assertIdle();
});

test('failed initialization retains ownership when startup cleanup cannot confirm shutdown',async t=>{
 const runtime=runtimeFixture(t),shutdown=(AppServer.prototype as any).shutdown;let server:any,attempts=0;
 t.mock.method(AppServer.prototype,'initialize',async function(this:AppServer){server=this;await Promise.resolve();const error=Error('initialize failed');this.emit('failure',error);throw error;});
 t.mock.method(AppServer.prototype as any,'shutdown',async function(this:AppServer,force:boolean){if(this===server&&attempts++===0)throw Error('startup close not confirmed');return shutdown.call(this,force);});
 t.after(()=>shutdown.call(server,true));
 await assert.rejects(runtime.models(),{code:'RUNTIME_UNAVAILABLE'});
 assert.ok((runtime as any).server===server,'Failed startup cleanup must retain its owned process');
 await assert.rejects(runtime.models(),{code:'RUNTIME_UPDATING'});
 await runtime.close();assert.equal((runtime as any).server,undefined);
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
