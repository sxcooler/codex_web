import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Runtime} from '../src/codex/runtime.ts';

const cwd=process.cwd(),target=join(cwd,'target');
const policy=(kind:string,directory:string)=>({mode:'custom',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:kind==='workspaceWrite'?{type:kind,writableRoots:[directory],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:kind==='readOnly'?{type:kind,networkAccess:false}:{type:kind}});
const native=(kind:string,directory=target)=>({thread:{id:'one',cwd:directory,projectId:'p',status:{type:'idle'},turns:[]},cwd:directory,model:'fixture',modelProvider:'openai',reasoningEffort:null,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:policy(kind,directory).sandbox});
async function fixture(t:any,kind:string){
  const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any; t.after(()=>runtime.close());let reads=0,turns=0,resumes=0;
  const state=internal.state('one');Object.assign(state,{cwd,loaded:true,nativeStatus:{type:'idle'},permissions:policy(kind,cwd)});
  let response=native(kind),header=native(kind).thread;
  t.mock.method(runtime,'threadHeaderRead',async()=>++reads===1?native(kind,cwd).thread:native(kind).thread);
  t.mock.method(internal,'call',async()=>({thread:header}));
  t.mock.method(internal,'resolvePermissions',async(_mode:any,directory:string,previous:any)=>{assert.equal(directory,target);if(previous)assert.deepEqual(previous.sandbox,policy(kind,target).sandbox);return policy(kind,directory);});
  t.mock.method(internal,'mutation',async(method:string)=>{if(method==='thread/resume'){resumes++;return response;}return {};});
  t.mock.method(internal,'startTurn',async(_id:any,_text:any,_input:any,_state:any,permissions:any)=>{turns++;assert.deepEqual(permissions.sandbox,policy(kind,target).sandbox);state.reserved=false;return {threadId:'one'};});
  await runtime.setThreadCwd('one',target,'p');
  return {runtime,state,counts:()=>({turns,resumes}),response,header};
}
for(const kind of ['readOnly','dangerFullAccess'])for(const changed of ['header','effective','project'])for(const entry of ['open','send'])test(`verified settings then wrong resume ${changed} blocks ${entry} with ${kind}`,async t=>{
  const f=await fixture(t,kind);
  if(changed==='header')f.response.thread.cwd=cwd;
  if(changed==='effective')f.response.cwd=cwd;
  if(changed==='project')f.response.thread.projectId='different';
  if(entry==='open')await assert.rejects(f.runtime.open('one'),{code:'RUNTIME_UNAVAILABLE',message:'Native working directory reconciliation was not confirmed'});
  await assert.rejects(f.runtime.send('one',{text:'must not send',clientRequestId:'blocked'}));
  if(entry==='send')await assert.rejects(f.runtime.open('one'),{code:'RUNTIME_UNAVAILABLE',message:'Native working directory reconciliation was not confirmed'});
  assert.equal(f.counts().turns,0);
  f.response.thread.cwd=target;f.response.cwd=target;f.response.thread.projectId='p';
  await f.runtime.open('one');assert.equal(f.state.cwd,target);assert.deepEqual(f.state.permissions.sandbox,policy(kind,target).sandbox);
  await f.runtime.send('one',{text:'correct recovery',clientRequestId:'recovered'});assert.equal(f.counts().turns,1);
});
for(const kind of ['readOnly','dangerFullAccess','workspaceWrite'])test(`verified settings requires explicit open and resumes new cwd permissions with ${kind}`,async t=>{
  const f=await fixture(t,kind);await assert.rejects(f.runtime.send('one',{text:'open first',clientRequestId:'blocked-direct'}));assert.equal(f.counts().turns,0);
  assert.equal((await f.runtime.open('one')).phase,'IDLE');assert.equal(f.counts().resumes,1);assert.equal(f.state.cwd,target);assert.deepEqual(f.state.permissions.sandbox,policy(kind,target).sandbox);
  await f.runtime.send('one',{text:'safe',clientRequestId:'safe-send'});assert.equal(f.counts().turns,1);
});
for(const changed of ['cwd','project'])test(`verified settings identity remains bound when fresh open header changes ${changed}`,async t=>{
  const f=await fixture(t,'readOnly');if(changed==='cwd')f.header.cwd=cwd;else f.header.projectId='different';
  await assert.rejects(f.runtime.open('one'),{code:'RUNTIME_UNAVAILABLE',message:'Native working directory identity changed before resume'});await assert.rejects(f.runtime.send('one',{text:'must block',clientRequestId:'changed-header'}));assert.deepEqual(f.counts(),{turns:0,resumes:0});
});
test('external cwd notifications revoke old grants until authoritative open verifies new identity and permissions',async t=>{
 const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());const state=internal.state('one');let turns=0,resumes=0;
 Object.assign(state,{cwd,loaded:true,nativeStatus:{type:'idle'},permissions:policy('dangerFullAccess',cwd)});
 t.mock.method(internal,'validateTurnOptions',async()=>{});t.mock.method(internal,'getServer',async()=>({}));t.mock.method(internal,'loadThread',async()=>native('readOnly').thread);
 t.mock.method(internal,'call',async(method:string)=>method==='thread/read'?{thread:native('readOnly').thread}:{data:[],nextCursor:null});
 t.mock.method(internal,'resolvePermissions',async(_mode:any,directory:string,previous:any)=>{assert.equal(directory,target);if(previous)assert.deepEqual(previous,policy('readOnly',target),'only newly verified grants may be reused');return policy('readOnly',target);});
 t.mock.method(internal,'mutation',async()=>{resumes++;return native('readOnly');});
 t.mock.method(internal,'startTurn',async(_id:any,_text:any,_input:any,_state:any,grants:any)=>{turns++;assert.deepEqual(grants,policy('readOnly',target));state.reserved=false;return {threadId:'one'};});
 internal.onNotification({method:'thread/settings/updated',params:{threadId:'one',threadSettings:{cwd:target}}});
 assert.equal(state.contextUnknown,true);assert.equal(state.loaded,false);assert.equal(state.permissions,undefined);
 const snapshot=await runtime.snapshot('one',{window:true});assert.equal(snapshot.phase,'UNKNOWN');await runtime.status('one',snapshot.epoch);assert.equal(state.contextUnknown,true);
 await assert.rejects(runtime.send('one',{text:'blocked',clientRequestId:'external-cwd-blocked'}),{code:'RUNTIME_THREAD_BUSY'});assert.equal(turns,0);
 await runtime.open('one');assert.equal(resumes,1);assert.equal(state.contextUnknown,false);await runtime.send('one',{text:'verified',clientRequestId:'external-cwd-verified'});assert.equal(turns,1);
});

test('canonical cwd aliases retain verified grants and external changes preserve pending Web identity',async t=>{
 const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());const state=internal.state('one');const grants=policy('readOnly',cwd);Object.assign(state,{cwd,loaded:true,permissions:grants});
 const alias=process.platform==='win32'?'\\\\?\\'+cwd.toUpperCase():cwd;internal.onNotification({method:'thread/settings/updated',params:{threadId:'one',threadSettings:{cwd:alias}}});assert.notEqual(state.contextUnknown,true);assert.equal(state.loaded,true);assert.equal(state.permissions,grants);
 const identity={cwd:target,projectId:'p'};state.pendingCwdIdentity=identity;internal.onNotification({method:'thread/settings/updated',params:{threadId:'one',threadSettings:{cwd:target}}});assert.equal(state.contextUnknown,true);assert.equal(state.pendingCwdIdentity,identity);
});
