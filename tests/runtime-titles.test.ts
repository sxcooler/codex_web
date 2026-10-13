import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {Runtime} from '../src/codex/runtime.ts';

function setup(t:any, title='原生标题',source='appServer') {
  const runtime=new Runtime({executable:process.execPath,cwd:process.cwd()}), server=new EventEmitter() as any;
  const calls:any[]=[], changes:any[]=[], threads=new Map<string,any>();
  let next=0;
  const permission={approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};
  server.close=async()=>{};
  server.request=async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==='thread/start') {
      const thread={id:`thread-${++next}`,cwd:process.cwd(),ephemeral:!!params.ephemeral,name:null,preview:'temporary preview',source,status:{type:'idle'},turns:[]};
      threads.set(thread.id,thread);
      server.emit('notification',{method:'thread/started',params:{thread}});
      return {thread,...permission,...(params.ephemeral?{sandbox:{type:'readOnly',networkAccess:false}}:{}),model:params.model??'gpt-6.1-sol',modelProvider:'selected-provider',reasoningEffort:params.ephemeral?params.config.model_reasoning_effort:'ultra',cwd:process.cwd()};
    }
    if(method==='turn/start') {
      const turn={id:`turn-${params.threadId}`,status:'completed',items:[]};
      if(threads.get(params.threadId).ephemeral) {
        if(title==='hold')return {turn:{...turn,status:'inProgress'}};
        const item={type:'agentMessage',id:'title-result',text:title==='invalid'?'invalid':JSON.stringify({title})};
        turn.items.push(item as never);
        server.emit('notification',{method:'item/completed',params:{threadId:params.threadId,turnId:turn.id,item}});
        server.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn}});
      }
      return {turn};
    }
    if(method==='thread/read')return {thread:threads.get(params.threadId)};
    if(method==='thread/name/set') {threads.get(params.threadId).name=params.name;return {};}
    if(method==='thread/unsubscribe')return {status:'unsubscribed'};
    if(method==='turn/interrupt')return {};
    throw Error(`unexpected ${method}`);
  };
  server.respondError=()=>{};
  (runtime as any).server=server;
  t.mock.method(runtime as any,'getServer',async()=>server);
  t.mock.method(runtime as any,'resolvePermissions',async()=>permission);
  t.mock.method(runtime as any,'validateTurnOptions',async()=>{});
  t.mock.method(runtime as any,'readThread',async(id:string)=>threads.get(id));
  server.on('notification',(message:any)=>(runtime as any).onNotification(message));
  runtime.on('change',change=>changes.push(change));
  t.after(()=>runtime.close());
  return {runtime,server,calls,threads,changes};
}
async function settle(runtime:Runtime,id:string){await (runtime as any).state(id).titleGeneration?.promise;}

test('create titles use dedicated luna/low while the accepted primary keeps its selected model/ultra/provider',async t=>{
  const {runtime,calls,threads,changes}=setup(t);
  const input={cwd:process.cwd(),clientRequestId:'create',prompt:'修复任务'.repeat(700),model:'gpt-6.1-sol',effort:'ultra'};
  const [first,again]=await Promise.all([runtime.create(input),runtime.create(input)]);
  assert.deepEqual(first,again);await settle(runtime,first.threadId);
  assert.equal(threads.get(first.threadId).name,'原生标题');
  const temp=calls.filter(c=>c.method==='thread/start'&&c.params.ephemeral);
  assert.equal(temp.length,1);assert.equal(temp[0].params.model,'gpt-6-luna');assert.equal(temp[0].params.modelProvider,'selected-provider');
  assert.equal(temp[0].params.config.model_reasoning_effort,'low');assert.equal(temp[0].params.sandbox,'read-only');
  for(const feature of ['hooks','multi_agent','plugins','apps'])assert.equal(temp[0].params.config[`features.${feature}`],false);
  const generated=calls.find(c=>c.method==='turn/start'&&c.params.outputSchema);
  assert.equal(generated.params.model,'gpt-6-luna');assert.equal(generated.params.effort,'low');assert.ok(generated.params.input[0].text.endsWith(input.prompt.slice(0,2000)));
  const primary=calls.find(c=>c.method==='turn/start'&&c.params.threadId===first.threadId);
  assert.equal(primary.params.model,'gpt-6.1-sol');assert.equal(primary.params.effort,'ultra');
  assert.equal((runtime as any).state(first.threadId).model,'gpt-6.1-sol');assert.equal((runtime as any).state(first.threadId).reasoningEffort,'ultra');
  assert.ok(calls.find(c=>c.method==='thread/unsubscribe'&&c.params.threadId!==first.threadId));
  assert.ok(changes.every(change=>change.threadId===first.threadId));
  assert.equal((runtime as any).states.size,1);
});

test('blank and pure attachments never generate, later sends do not backfill',async t=>{
  const {runtime,calls}=setup(t);
  for(const prompt of [undefined,'   ']) {
    const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:`blank-${prompt}`,prompt});
    await runtime.send(threadId,{clientRequestId:`send-${prompt}`,text:'later task'});
  }
  await runtime.create({cwd:process.cwd(),clientRequestId:'attachment',nativeInput:[{type:'localImage',path:'unused'}]});
  assert.equal(calls.filter(c=>c.params.ephemeral).length,0);
});

test('native name event updates state and preserves manual/native names ahead of generation',async t=>{
  const {runtime,server,calls,threads,changes}=setup(t,'hold');
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});
  await new Promise(resolve=>setImmediate(resolve));
  await runtime.rename(threadId,'手动名称');
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  server.emit('notification',{method:'turn/completed',params:{threadId:temp.id,turn:{id:`turn-${temp.id}`,status:'completed',items:[{type:'agentMessage',text:JSON.stringify({title:'自动名称'})}]}}});
  await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,'手动名称');assert.equal(calls.filter(c=>c.method==='thread/name/set').length,1);
  server.emit('notification',{method:'thread/name/updated',params:{threadId,threadName:'原生客户端名称'}});
  assert.equal(changes.at(-1).kind,'name');assert.equal(changes.at(-1).patch.thread.name,'原生客户端名称');
});

test('invalid output leaves preview and unsubscribes without inference retry',async t=>{
  const {runtime,calls,threads}=setup(t,'invalid');
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,null);assert.equal(calls.filter(c=>c.params.outputSchema).length,1);
  assert.equal(calls.filter(c=>c.method==='thread/unsubscribe').length,1);
});

test('release cancels generation, interrupts and unsubscribes before handing ownership off',async t=>{
  const {runtime,calls,threads}=setup(t,'hold');
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});
  await new Promise(resolve=>setImmediate(resolve));
  await runtime.release(threadId);
  assert.equal(threads.get(threadId).name,null);
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  assert.ok(calls.find(c=>c.method==='turn/interrupt'&&c.params.threadId===temp.id));
  assert.ok(calls.findIndex(c=>c.method==='thread/unsubscribe'&&c.params.threadId===temp.id)<calls.findIndex(c=>c.method==='thread/unsubscribe'&&c.params.threadId===threadId));
  assert.equal(serverListenerCount(runtime),0);
});
function serverListenerCount(runtime:Runtime){return (runtime as any).server?.listenerCount('failure')??0;}

test('timeout interrupts once, removes temporary listeners and leaves the accepted task untouched',async t=>{
  const {runtime,server,calls,threads}=setup(t,'hold');
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.throws(()=>runtime.assertIdle(),{code:'RUNTIME_THREAD_BUSY'});
  t.mock.timers.tick(30_001);await new Promise(resolve=>setImmediate(resolve));
  assert.ok((runtime as any).state(threadId).titleGeneration,'The product budget is 120 seconds');
  assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,0);
  t.mock.timers.tick(90_000);await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,null);
  assert.equal(calls.filter(c=>c.params.outputSchema).length,1);assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,1);
  assert.equal(server.listenerCount('notification'),1);assert.equal(server.listenerCount('failure'),0);
});

test('native name observed during generation prevents automatic replacement',async t=>{
  const {runtime,server,threads,calls}=setup(t,'hold');
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await new Promise(resolve=>setImmediate(resolve));
  threads.get(threadId).name='VSCode名称';
  server.emit('notification',{method:'thread/name/updated',params:{threadId,threadName:'VSCode名称'}});
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  server.emit('notification',{method:'turn/completed',params:{threadId:temp.id,turn:{id:`turn-${temp.id}`,status:'completed',items:[{type:'agentMessage',text:'{"title":"自动名称"}'}]}}});
  await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,'VSCode名称');assert.equal(calls.filter(c=>c.method==='thread/name/set').length,0);
});

test('unknown name-write outcome is read back once and never replayed',async t=>{
  const {runtime,server,calls,threads}=setup(t);
  const request=server.request;
  server.request=async(method:string,params:any)=>{
    const result=await request(method,params);
    if(method==='thread/name/set')throw Object.assign(Error('unknown'),{statusCode:504,code:'RUNTIME_RESULT_UNKNOWN'});
    return result;
  };
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,'原生标题');assert.equal(calls.filter(c=>c.method==='thread/name/set').length,1);
  assert.equal(calls.filter(c=>c.method==='thread/read').length,2);
});

test('manual rename waits for an already-sent automatic write and remains the final name',async t=>{
  const {runtime,server,calls,threads}=setup(t),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
  const request=server.request;
  server.request=async(method:string,params:any)=>{
    if(method==='thread/name/set'&&params.name==='原生标题'){entered.resolve();await gate.promise;}
    return request(method,params);
  };
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await entered.promise;
  const rename=runtime.rename(threadId,'最终手动名称');gate.resolve();await rename;await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,'最终手动名称');assert.deepEqual(calls.filter(c=>c.method==='thread/name/set').map(c=>c.params.name),['原生标题','最终手动名称']);
});

test('temporary effective model, effort, provider and permissions must exactly match before inference',async t=>{
  for(const mismatch of [{model:'gpt-5.6-luna'},{reasoningEffort:'high'},{modelProvider:'fallback'},{sandbox:{type:'dangerFullAccess'}}]) {
    const {runtime,server,calls,threads}=setup(t),request=server.request;
    server.request=async(method:string,params:any)=>{const result=await request(method,params);return method==='thread/start'&&params.ephemeral?{...result,...mismatch}:result;};
    const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
    assert.equal(threads.get(threadId).name,null);assert.equal(calls.filter(c=>c.params.outputSchema).length,0);
    assert.equal(calls.filter(c=>c.method==='thread/unsubscribe').length,1);
  }
});

test('a primary native default effort stays null while title inference explicitly uses luna/low',async t=>{
  const {runtime,server,calls,threads}=setup(t),request=server.request;
  server.request=async(method:string,params:any)=>{const result=await request(method,params);return method==='thread/start'&&!params.ephemeral?{...result,reasoningEffort:null}:result;};
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  assert.equal(threads.get(threadId).name,'原生标题');
  assert.equal((runtime as any).state(threadId).reasoningEffort,null);
  assert.equal(calls.find(c=>c.method==='turn/start'&&c.params.threadId===threadId).params.effort,undefined);
  assert.equal(calls.find(c=>c.params.ephemeral).params.model,'gpt-6-luna');
  assert.equal(calls.find(c=>c.params.ephemeral).params.config.model_reasoning_effort,'low');
  assert.equal(calls.find(c=>c.params.outputSchema).params.effort,'low');
});

test('close cancels pending title work and does not leave temporary listeners or writes',async t=>{
  const {runtime,server,calls}=setup(t,'hold');
  await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await new Promise(resolve=>setImmediate(resolve));
  await runtime.close();assert.equal(server.listenerCount('notification'),1);assert.equal(server.listenerCount('failure'),0);
  assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,1);assert.equal(calls.filter(c=>c.method==='thread/name/set').length,0);
});

test('recent list filters temporary threads even when a native fixture returns them',async t=>{
  const {runtime,server,threads}=setup(t),request=server.request;
  server.request=(method:string,params:any)=>method==='thread/list'?Promise.resolve({data:[...threads.values()]}):request(method,params);
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  assert.deepEqual((await runtime.list()).data.map(thread=>thread.id),[threadId]);
});

test('abort cancels title generation even when primary turn has already completed',async t=>{
  const {runtime,calls,threads}=setup(t,'hold');
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await new Promise(resolve=>setImmediate(resolve));
  await runtime.abort(threadId);
  assert.equal((runtime as any).state(threadId).titleGeneration,undefined);
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  assert.ok(calls.find(c=>c.method==='turn/interrupt'&&c.params.threadId===temp.id));
  assert.equal(calls.filter(c=>c.method==='thread/name/set').length,0);
});

test('close waits for an already-sent name write before stopping native server',async t=>{
  const {runtime,server}=setup(t),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create'});
  const request=server.request;let stopped=false;
  server.request=async(method:string,params:any)=>{if(method==='thread/name/set'){entered.resolve();await gate.promise;}return request(method,params);};
  server.close=async()=>{stopped=true;};
  const rename=runtime.rename(threadId,'手动名称');await entered.promise;
  const closing=runtime.close();await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  gate.resolve();await rename;await closing;assert.equal(stopped,true);
});

test('name read before automatic write is retained and propagated even without a native event',async t=>{
  const {runtime,server,threads,changes,calls}=setup(t,'hold');
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await new Promise(resolve=>setImmediate(resolve));
  threads.get(threadId).name='其他客户端名称';
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  server.emit('notification',{method:'turn/completed',params:{threadId:temp.id,turn:{id:`turn-${temp.id}`,status:'completed',items:[{type:'agentMessage',text:'{"title":"自动名称"}'}]}}});
  await settle(runtime,threadId);
  assert.equal(calls.filter(c=>c.method==='thread/name/set').length,0);
  assert.equal(changes.findLast(change=>change.kind==='name')?.patch.thread.name,'其他客户端名称');
});

test('a known temporary thread is unsubscribed when its start reply is lost',async t=>{
  const {runtime,server,calls}=setup(t),request=server.request;
  server.request=async(method:string,params:any)=>{const result=await request(method,params);if(method==='thread/start'&&params.ephemeral)throw Error('RPC thread/start timed out; outcome is uncertain');return result;};
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  assert.equal(calls.filter(c=>c.method==='thread/unsubscribe').length,1);
  assert.equal(calls.filter(c=>c.params.outputSchema).length,0);
});

test('concurrent creates retain cleanup ownership while an earlier temporary start loses its reply',async t=>{
  const {runtime,server,calls,threads}=setup(t),request=server.request,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
  let starts=0;
  server.request=async(method:string,params:any)=>{
    if(method==='thread/start'&&params.ephemeral) {
      const number=++starts;
      server.emit('notification',{method:'thread/started',params:{thread:{id:'unrelated-primary',ephemeral:false,source:'appServer'}}});
      server.emit('notification',{method:'thread/started',params:{thread:{id:'unrelated-subagent',ephemeral:true,source:{subAgent:{spawn:{}}}}}});
      const result=await request(method,params);
      if(number===1){entered.resolve();await gate.promise;throw Error('RPC thread/start timed out; outcome is uncertain');}
      return result;
    }
    return request(method,params);
  };
  const [first,second]=await Promise.all([runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'}),runtime.create({cwd:process.cwd(),clientRequestId:'second',prompt:'second task'})]);
  await entered.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(starts,1);
  gate.resolve();await Promise.all([settle(runtime,first.threadId),settle(runtime,second.threadId)]);
  assert.equal(starts,2);assert.equal(threads.get(first.threadId).name,null);assert.equal(threads.get(second.threadId).name,'原生标题');
  assert.deepEqual(calls.filter(call=>call.method==='thread/unsubscribe').map(call=>call.params.threadId).sort(),[...threads.values()].filter(thread=>thread.ephemeral).map(thread=>thread.id).sort());
  assert.equal(server.listenerCount('notification'),1);
});

test('waiting for another temporary start consumes the same title deadline',async t=>{
  const {runtime,server,calls}=setup(t),request=server.request,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
  t.mock.timers.enable({apis:['setTimeout','Date']});
  server.request=async(method:string,params:any)=>{const result=await request(method,params);if(method==='thread/start'&&params.ephemeral){entered.resolve();await gate.promise;}return result;};
  const first=await runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await entered.promise;
  const second=await runtime.create({cwd:process.cwd(),clientRequestId:'second',prompt:'second task'});await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(120_001);await settle(runtime,second.threadId);
  assert.equal(calls.filter(call=>call.method==='thread/start'&&call.params.ephemeral).length,1);
  gate.resolve();await settle(runtime,first.threadId);
  assert.equal(calls.filter(call=>call.params.outputSchema).length,0);assert.equal(calls.filter(call=>call.method==='thread/unsubscribe').length,1);
});

test('a mismatched start reply cannot redirect cleanup to another native thread',async t=>{
  const {runtime,server,calls,threads}=setup(t),request=server.request;
  server.request=async(method:string,params:any)=>{const result=await request(method,params);return method==='thread/start'&&params.ephemeral?{...result,thread:{...result.thread,id:'another-thread'}}:result;};
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  assert.deepEqual(calls.filter(call=>call.method==='thread/unsubscribe').map(call=>call.params.threadId),[temp.id]);
  assert.equal(calls.filter(call=>call.params.outputSchema).length,0);
});

test('pre-response cleanup uses the primary native source rather than assuming appServer origin',async t=>{
  const {runtime,server,calls,threads}=setup(t,'原生标题','vscode'),request=server.request;
  server.request=async(method:string,params:any)=>{const result=await request(method,params);if(method==='thread/start'&&params.ephemeral)throw Error('RPC thread/start timed out; outcome is uncertain');return result;};
  const {threadId}=await runtime.create({cwd:process.cwd(),clientRequestId:'create',prompt:'task'});await settle(runtime,threadId);
  const temp=[...threads.values()].find(thread=>thread.ephemeral);
  assert.deepEqual(calls.filter(call=>call.method==='thread/unsubscribe').map(call=>call.params.threadId),[temp.id]);
});

test('a late started event from an earlier replied start cannot be claimed by the next title job',async t=>{
  const {runtime,server,calls,threads}=setup(t),request=server.request,emit=server.emit.bind(server);
  let late:any,starts=0;
  server.emit=(event:string,message:any)=>{if(event==='notification'&&message?.method==='thread/started'&&message.params.thread.ephemeral&&starts===1){late=message;return true;}return emit(event,message);};
  server.request=(method:string,params:any)=>{
    if(method==='thread/start'&&params.ephemeral){starts++;if(starts===2&&late)emit('notification',late);}
    return request(method,params);
  };
  const [first,second]=await Promise.all([runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'}),runtime.create({cwd:process.cwd(),clientRequestId:'second',prompt:'second task'})]);
  await Promise.all([settle(runtime,first.threadId),settle(runtime,second.threadId)]);
  assert.equal(threads.get(first.threadId).name,'原生标题');assert.equal(threads.get(second.threadId).name,'原生标题');
  assert.deepEqual(calls.filter(call=>call.method==='thread/unsubscribe').map(call=>call.params.threadId).sort(),[...threads.values()].filter(thread=>thread.ephemeral).map(thread=>thread.id).sort());
});

function delayedUnknownStart(t:any) {
  const env=setup(t,'原生标题','vscode'),request=env.server.request;
  let starts=0,late:(outcome:any)=>void=()=>{};
  const thread={id:'unknown-temporary',cwd:process.cwd(),ephemeral:true,name:null,source:'vscode',status:{type:'idle'},turns:[]};
  const result={thread,model:'gpt-6-luna',modelProvider:'selected-provider',reasoningEffort:'low',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}};
  env.server.request=async(method:string,params:any,_timeout?:number,onLateOutcome?:(outcome:any)=>void)=>{
    if(method==='thread/start'&&params.ephemeral&&++starts===1){env.calls.push({method,params});env.threads.set(thread.id,thread);late=onLateOutcome??(()=>{});throw Object.assign(Error('RPC thread/start timed out; outcome is uncertain'),{outcomeUnknown:true});}
    return request(method,params);
  };
  env.server.close=async()=>late({error:Error('App-server closed')});
  return {...env,thread,result,starts:()=>starts,reply:(outcome:any={result})=>late(outcome),started:()=>env.server.emit('notification',{method:'thread/started',params:{thread}})};
}

test('an unknown timed-out start keeps later title starts owned until its exact late reply',async t=>{
  const env=delayedUnknownStart(t);
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await settle(env.runtime,first.threadId);
  assert.equal((env.runtime as any).state(first.threadId).titleGeneration,undefined);
  const second=await env.runtime.create({cwd:process.cwd(),clientRequestId:'second',prompt:'second task'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.starts(),1,'The unresolved start must keep the next temporary start queued');
  assert.throws(()=>env.runtime.assertIdle(),{code:'RUNTIME_THREAD_BUSY'});
  env.started();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(env.calls.filter(c=>c.method==='thread/unsubscribe').map(c=>c.params.threadId),[env.thread.id]);
  assert.equal(env.starts(),1,'Metadata cleanup alone does not settle the original RPC ownership');
  env.reply();await settle(env.runtime,second.threadId);
  assert.equal(env.starts(),2);assert.equal(env.threads.get(first.threadId).name,null);assert.equal(env.threads.get(second.threadId).name,'原生标题');
  assert.equal(env.calls.filter(c=>c.method==='thread/unsubscribe'&&c.params.threadId===env.thread.id).length,1);
  assert.equal(env.calls.filter(c=>c.method==='turn/start'&&c.params.threadId===env.thread.id).length,0);
  assert.equal(env.server.listenerCount('notification'),1);
});

test('an exact late start reply without metadata only cleans its temporary thread',async t=>{
  const env=delayedUnknownStart(t);
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await settle(env.runtime,first.threadId);
  env.reply();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(env.calls.filter(c=>c.method==='thread/unsubscribe').map(c=>c.params.threadId),[env.thread.id]);
  assert.equal(env.calls.filter(c=>c.method==='turn/start'&&c.params.threadId===env.thread.id).length,0);
  assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);
  assert.equal(env.server.listenerCount('notification'),1);env.runtime.assertIdle();
});

test('late metadata without a reply keeps ownership but queued generation expires and close settles it',async t=>{
  const env=delayedUnknownStart(t);t.mock.timers.enable({apis:['setTimeout','Date']});
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await settle(env.runtime,first.threadId);
  env.started();await new Promise(resolve=>setImmediate(resolve));
  const second=await env.runtime.create({cwd:process.cwd(),clientRequestId:'second',prompt:'second task'});await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(120_001);await settle(env.runtime,second.threadId);
  assert.equal(env.starts(),1);assert.equal((env.runtime as any).state(second.threadId).titleGeneration,undefined);
  assert.equal(env.server.listenerCount('notification'),2,'Only the unresolved start keeps a cleanup listener');
  await env.runtime.close();assert.equal(env.server.listenerCount('notification'),1);
  assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);
});

test('failure ends an unknown start cleanup owner and does not write a title',async t=>{
  const env=delayedUnknownStart(t);
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await settle(env.runtime,first.threadId);
  env.reply({error:Error('App-server exited')});env.server.emit('failure',Error('App-server exited'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.server.listenerCount('notification'),1);env.runtime.assertIdle();
  assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);
});

test('release closes an otherwise idle owned server to settle unknown temporary cleanup',async t=>{
  const env=delayedUnknownStart(t);
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await settle(env.runtime,first.threadId);
  const released=await env.runtime.release(first.threadId);
  assert.equal(released.handoffReady,true);assert.equal(env.server.listenerCount('notification'),1);
  assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);
});

for(const stage of ['thread/start','turn/start'])test(`release does not wait for a pending temporary ${stage} reply`,async t=>{
  const env=setup(t,'hold'),request=env.server.request,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<any>();
  let result:any;
  env.server.request=async(method:string,params:any)=>{
    const value=await request(method,params);
    if(method===stage&&(params.ephemeral||params.outputSchema)){result=value;entered.resolve();return gate.promise;}
    return value;
  };
  env.server.close=async()=>gate.reject(Error('App-server closed'));
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await entered.promise;
  let released=false;const operation=env.runtime.release(first.threadId).then(value=>{released=true;return value;});
  try {
    await new Promise(resolve=>setImmediate(resolve));assert.equal(released,true,'Release must not wait for the 120-second RPC budget');
    assert.equal((await operation).handoffReady,true);
    assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);
    assert.equal(env.server.listenerCount('notification'),1);
  } finally {gate.resolve(result);await operation;}
});

test('a late temporary turn reply after release only cleans the temporary resource while another primary runs',async t=>{
  const env=setup(t,'hold'),request=env.server.request,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<any>();
  let result:any,tempId:string|undefined;
  env.server.request=async(method:string,params:any)=>{
    const value=await request(method,params);
    if(method==='turn/start'&&params.outputSchema){result=value;tempId=params.threadId;entered.resolve();return gate.promise;}
    return value;
  };
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await entered.promise;
  const second=await env.runtime.create({cwd:process.cwd(),clientRequestId:'second'});
  (env.runtime as any).state(second.threadId).activeTurnId='other-active-turn';
  let released=false;const operation=env.runtime.release(first.threadId).then(value=>{released=true;return value;});
  try {
    await new Promise(resolve=>setImmediate(resolve));assert.equal(released,true);
    assert.equal((await operation).handoffReady,false);assert.throws(()=>env.runtime.assertIdle(),{code:'RUNTIME_THREAD_BUSY'});
    const marker=env.calls.length;gate.resolve(result);await new Promise(resolve=>setImmediate(resolve));
    assert.ok(env.calls.slice(marker).some(c=>c.method==='turn/interrupt'&&c.params.threadId===tempId));
    assert.ok(env.calls.slice(marker).every(c=>c.params.threadId===tempId),'Late cleanup must not touch either primary');
    assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);assert.equal(env.server.listenerCount('notification'),1);
  } finally {gate.resolve(result);await operation;}
});

test('late turn metadata interrupts after the initial unsubscribe but keeps unknown RPC ownership until stop',async t=>{
  const env=setup(t,'hold'),request=env.server.request,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<any>();
  let tempId:string|undefined;
  env.server.request=async(method:string,params:any)=>{
    const value=await request(method,params);
    if(method==='turn/start'&&params.outputSchema){tempId=params.threadId;entered.resolve();return gate.promise;}
    return value;
  };
  env.server.close=async()=>gate.reject(Error('App-server closed'));
  const first=await env.runtime.create({cwd:process.cwd(),clientRequestId:'first',prompt:'first task'});await entered.promise;
  const second=await env.runtime.create({cwd:process.cwd(),clientRequestId:'second'}),other=(env.runtime as any).state(second.threadId);
  other.activeTurnId='other-active-turn';await env.runtime.release(first.threadId);
  assert.ok(env.calls.some(c=>c.method==='thread/unsubscribe'&&c.params.threadId===tempId));
  const marker=env.calls.length;
  env.server.emit('notification',{method:'turn/started',params:{threadId:tempId,turn:{id:'late-active-turn',status:'inProgress'}}});
  env.server.emit('notification',{method:'turn/started',params:{threadId:tempId,turn:{id:'late-active-turn',status:'inProgress'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(env.calls.slice(marker).some(c=>c.method==='turn/interrupt'&&c.params.threadId===tempId&&c.params.turnId==='late-active-turn'));
  assert.equal(env.calls.filter(c=>c.method==='turn/interrupt'&&c.params.turnId==='late-active-turn').length,1);
  assert.ok(env.calls.slice(marker).every(c=>c.params.threadId===tempId));
  other.activeTurnId=null;assert.throws(()=>env.runtime.assertIdle(),{code:'RUNTIME_THREAD_BUSY'});
  assert.equal(env.calls.filter(c=>c.method==='thread/name/set').length,0);
  await env.runtime.close();assert.equal(env.server.listenerCount('notification'),1);
});
