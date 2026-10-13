import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import test from 'node:test';
import {Runtime} from '../src/codex/runtime.ts';

const cwd=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixture=fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url));
async function start(t:any){
  const runtime=new Runtime({executable:process.execPath,args:[fixture],cwd});
  t.after(()=>runtime.close());await runtime.list();return runtime;
}
function hold(t:any,runtime:Runtime,method:string){
  const server=(runtime as any).server,request=server.request.bind(server),gate=Promise.withResolvers<void>(),calls:any[]=[];
  t.mock.method(server,'request',async(name:string,input:any,timeout?:number)=>{
    if(name===method){calls.push({input,timeout});await gate.promise;}
    return request(name,input,timeout);
  });
  return {gate,calls};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('identical pending list reads share native work, distinct queries stay separate, completed results are refreshed',async t=>{
  const runtime=await start(t),{gate,calls}=hold(t,runtime,'thread/list');
  const pending=[runtime.list(),runtime.list(),runtime.list('next'),runtime.list(undefined,true),runtime.list(undefined,false,'created_at'),runtime.list(undefined,false,'updated_at','needle')];
  await tick();assert.equal(calls.length,5,'identical list requests must send one native RPC');
  assert.equal(calls[4].input.searchTerm,'needle');gate.resolve();await Promise.all(pending);
  await runtime.list();assert.equal(calls.length,6,'single-flight must not become a response cache');
});

test('default header reads share work without sharing bounded fork budget or different threads',async t=>{
  const runtime=await start(t),{gate,calls}=hold(t,runtime,'thread/read');
  const pending=[runtime.threadHeaderRead('one'),runtime.threadHeaderRead('one'),runtime.threadHeaderRead('one',5000),runtime.threadHeaderRead('two')];
  await tick();assert.equal(calls.length,3);assert.equal(calls.filter(call=>call.timeout>0&&call.timeout<=5000).length,1);gate.resolve();
  const headers=await Promise.all(pending);assert.equal(headers[0].id,'one');assert.equal(Object.hasOwn(headers[0],'turns'),false);
  await runtime.threadHeaderRead('one');assert.equal(calls.length,4);
});

test('failed shared reads clear their entry and old generation cleanup cannot remove a new read',async t=>{
  const runtime=await start(t),server=(runtime as any).server,gates=[Promise.withResolvers<any>(),Promise.withResolvers<any>()];let reads=0;
  t.mock.method(server,'request',()=>gates[reads++].promise);
  const old=[runtime.list(),runtime.list()];const rejected=Promise.all(old.map(p=>assert.rejects(p)));
  await tick();assert.equal(reads,1);(runtime as any).epoch='new-generation';
  const current=runtime.list();await tick();assert.equal(reads,2);
  gates[0].reject(new Error('fixture read failure'));await rejected;
  const same=runtime.list();await tick();assert.equal(reads,2,'old finally must not remove new generation work');
  gates[1].resolve({data:[],nextCursor:null});await Promise.all([current,same]);
});

test('header failure is retriable and validation still rejects a native subagent or wrong thread',async t=>{
  const runtime=await start(t),server=(runtime as any).server;let reads=0;
  t.mock.method(server,'request',async()=>{reads++;return {thread:{id:reads===1?'wrong':'one',source:reads===3?{subAgent:{}}:'appServer',cwd,turns:[]}};});
  await assert.rejects(runtime.threadHeaderRead('one'),{code:'RUNTIME_UNAVAILABLE'});
  assert.equal((await runtime.threadHeaderRead('one')).id,'one');
  await assert.rejects(runtime.threadHeaderRead('one'),{code:'RUNTIME_SUBAGENT_THREAD'});
});

test('project binding always reads current native cwd, sharing only concurrent reads',async t=>{
  const runtime=await start(t);await runtime.open('verified');
  const {gate,calls}=hold(t,runtime,'thread/read');
  const pending=[runtime.threadCwd('verified'),runtime.threadCwd('verified')];
  await tick();assert.equal(calls.length,1,'owned cwd must be revalidated with one concurrent native read');gate.resolve();
  assert.deepEqual(await Promise.all(pending),[cwd,cwd]);
  await runtime.threadCwd('verified');assert.equal(calls.length,2,'completed headers cannot become cwd cache');
  const state=(runtime as any).state('unverified');state.cwd=cwd;
  assert.equal(await runtime.threadCwd('unverified'),cwd);assert.equal(calls.length,3,'undefined source is not a verified user thread');
  state.subagent=false;state.cwd='relative-path';await runtime.threadCwd('unverified');assert.equal(calls.length,4);
  state.subagent=true;state.cwd=cwd;await assert.rejects(runtime.threadCwd('unverified'),{code:'RUNTIME_SUBAGENT_THREAD'});
});

for(const lifecycle of ['owned','closed','released','native-failure','resumed'])test(`file binding revalidates changed native cwd after ${lifecycle}`,async t=>{
  const runtime=await start(t);await runtime.open('one');
  const oldServer=(runtime as any).server;
  if(lifecycle==='closed'||lifecycle==='resumed')(runtime as any).onNotification({method:'thread/closed',params:{threadId:'one'}});
  if(lifecycle==='released')await runtime.release('one');
  if(lifecycle==='native-failure'){
    (runtime as any).onFailure(oldServer);await oldServer.close();
  }
  await runtime.list();const server=(runtime as any).server,request=server.request.bind(server),nativeCwd=resolve(cwd,'../native-current-project');let reads=0;
  t.mock.method(server,'request',async(method:string,input:any,timeout?:number)=>{
    const result=await request(method,input,timeout);
    if(method==='thread/read'){reads++;result.thread.cwd=nativeCwd;}
    if(method==='thread/resume')result.thread.cwd=nativeCwd;
    return result;
  });
  if(lifecycle==='resumed'){
    const accepted=await runtime.send('one',{text:'hello',clientRequestId:'resume-cwd',permissionMode:'full-access'});
    assert.equal(accepted.threadId,'one');assert.equal(typeof accepted.turnId,'string');assert.ok(accepted.turnId);
    assert.ok(['inProgress','completed'].includes(accepted.status),'send confirms acceptance; completion can arrive in a later notification');
    assert.equal((runtime as any).state('one').loaded,true);
  }
  const before=reads;
  assert.equal(await runtime.threadCwd('one'),nativeCwd,'old owned cwd must not authorize another lifecycle or current native directory');
  assert.equal(reads,before+1,'binding must revalidate after ownership changes');
});

test('missing native cwd preserves send fallback but cannot bind file reads to the configured project',async t=>{
  const runtime=await start(t),server=(runtime as any).server,request=server.request.bind(server),resumes:any[]=[];
  t.mock.method(server,'request',async(method:string,input:any,timeout?:number)=>{
    if(method==='thread/resume')resumes.push(input);
    const result=await request(method,input,timeout);
    if(method==='thread/read')delete result.thread.cwd;
    return result;
  });
  const result=await runtime.send('no-cwd',{text:'hello',clientRequestId:'fallback-cwd',permissionMode:'ask',effort:'high'});
  assert.equal(result.threadId,'no-cwd');assert.equal(typeof result.turnId,'string');assert.ok(result.turnId);
  assert.ok(['inProgress','completed'].includes(result.status),'send confirms acceptance; completion can arrive in a later notification');
  assert.equal((runtime as any).state('no-cwd').loaded,true);assert.ok(resumes[0].config.sandbox_workspace_write.writable_roots.includes(cwd));
  assert.equal(await runtime.threadCwd('no-cwd'),null,'local send fallback cannot authorize project file reads');
});

for(const nativeCwd of [undefined,resolve(cwd,'../native-other-project')])test(`created thread file binding uses native cwd ${nativeCwd===undefined?'missing':'different from requested'}`,async t=>{
  const runtime=await start(t),server=(runtime as any).server,request=server.request.bind(server);
  t.mock.method(server,'request',async(method:string,input:any,timeout?:number)=>{
    const result=await request(method,input,timeout);
    if(['thread/start','thread/read'].includes(method)){
      if(nativeCwd===undefined)delete result.thread.cwd;else result.thread.cwd=nativeCwd;
    }
    return result;
  });
  await assert.rejects(runtime.create({cwd,clientRequestId:'native-create-cwd',permissionMode:'full-access'}),(error:any)=>{assert.equal(error.code,'RUNTIME_UNAVAILABLE');assert.equal(error.partial.threadId,'thread-1');return true;});
  assert.equal(await runtime.threadCwd('thread-1'),nativeCwd??null,'requested cwd must never authorize file reads over native metadata');
  assert.equal((await (runtime as any).call('fixture/stats',{})).turnStarts,0,'unconfirmed cwd must never start a turn');
});

for(const method of ['list','threadHeaderRead'] as const)test(`${method} does not join stale reads during native failure or after close`,async t=>{
  const runtime=await start(t),server=(runtime as any).server,gate=Promise.withResolvers<any>();
  t.mock.method(server,'request',()=>gate.promise);
  const invoke=()=>method==='list'?runtime.list():runtime.threadHeaderRead('one');
  const old=invoke();await tick();(runtime as any).onFailure(server);
  const current=invoke();const result=await current;
  assert.ok(method==='list'?Array.isArray(result.data):result.id==='one','new request must reach the new fixture runtime');
  gate.reject(new Error('old fixture failed'));await assert.rejects(old);await server.close();
  await runtime.close();await assert.rejects(invoke(),{code:'RUNTIME_UNAVAILABLE'});
});

test('reads before, during and after a mutation remain separate',async t=>{
  const runtime=await start(t),server=(runtime as any).server,request=server.request.bind(server);
  const before=Promise.withResolvers<void>(),during=Promise.withResolvers<void>(),write=Promise.withResolvers<void>();let lists=0,headers=0;
  t.mock.method(server,'request',async(method:string,input:any,timeout?:number)=>{
    if(method==='thread/list'){lists++;if(lists===1)await before.promise;if(lists===2)await during.promise;}
    if(method==='thread/read'){headers++;if(headers===1)await before.promise;if(headers===2)await during.promise;}
    if(method==='thread/start')await write.promise;
    return request(method,input,timeout);
  });
  const old=[runtime.list(),runtime.threadHeaderRead('one')];await tick();
  const mutation=runtime.create({cwd,clientRequestId:'write-boundary'});await tick();
  const mid=[runtime.list(),runtime.threadHeaderRead('one')];await tick();assert.equal(lists,2);assert.equal(headers,2);
  write.resolve();await mutation;
  await Promise.all([runtime.list(),runtime.threadHeaderRead('one')]);assert.equal(lists,3);assert.equal(headers,3);
  before.resolve();during.resolve();await Promise.all([...old,...mid]);
});

for(const operation of ['open','send'] as const)for(const invalid of ['wrong-id','missing-id','missing-thread'])test(`${operation} rejects ${invalid} before remembering native source or caching cwd`,async t=>{
  const runtime=await start(t);await runtime.threadHeaderRead('one');
  const server=(runtime as any).server,request=server.request.bind(server);
  t.mock.method(server,'request',async(method:string,input:any,timeout?:number)=>{
    const result=await request(method,input,timeout);
    if(method==='thread/read'){
      result.thread.cwd=resolve(cwd,'../other-project');
      if(invalid==='wrong-id')result.thread.id='other';
      else if(invalid==='missing-id')delete result.thread.id;
      else result.thread=null;
    }
    return result;
  });
  await assert.rejects(operation==='open'?runtime.open('one'):runtime.send('one',{text:'hello',clientRequestId:'wrong-read-id'}),{code:'RUNTIME_UNAVAILABLE'});
  assert.equal((runtime as any).state('one').cwd,undefined,'invalid header must not authorize another project');
  assert.equal((runtime as any).states.has('other'),false,'invalid header must not establish another thread source');
});
