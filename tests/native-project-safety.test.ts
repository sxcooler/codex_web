import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Runtime} from '../src/codex/runtime.ts';
import {MetadataStore} from '../src/server/metadata.ts';
import {ProjectCatalog} from '../src/server/project-catalog.ts';

const cwd=process.cwd(),other=join(cwd,'other');
const policy=(kind:string,directory=cwd)=>({mode:'custom',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:kind==='workspaceWrite'?{type:kind,writableRoots:[directory],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:kind==='readOnly'?{type:kind,networkAccess:false}:{type:kind}});
const settings=(directory:string,projectId='p',kind='workspaceWrite')=>({thread:{id:'one',cwd:directory,projectId,status:{type:'idle'},turns:[]},cwd:directory,model:'fixture',modelProvider:'openai',reasoningEffort:null,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:policy(kind,directory).sandbox});
for(const kind of ['readOnly','dangerFullAccess','workspaceWrite'])for(const changed of ['header','effective'])test(`create rejects wrong ${changed} cwd before first turn with ${kind}`,async t=>{
  const runtime=new Runtime({executable:'unused',cwd});t.after(()=>runtime.close());let turns=0;
  t.mock.method(runtime as any,'resolvePermissions',async()=>policy(kind));
  t.mock.method(runtime as any,'mutation',async()=>{const value=settings(cwd,'p',kind);if(changed==='header')value.thread.cwd=other;else value.cwd=other;return value;});
  t.mock.method(runtime as any,'startTurn',async()=>{turns++;return {threadId:'one'};});
  await assert.rejects(runtime.create({cwd,nativeProjectId:'p',clientRequestId:'wrong-cwd-'+changed,prompt:'fake only'}),(error:any)=>error.partial?.threadId==='one'&&/directory/i.test(error.message));assert.equal(turns,0);
});
for(const failure of ['project-lost','project-different','read-failed','cwd-mismatch'])test(`successful settings with ${failure} blocks sends until actual cwd and permissions reconcile`,async t=>{
  const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());let reads=0,turns=0,resumes=0,recover=false;
  const state=internal.state('one');Object.assign(state,{cwd,loaded:true,nativeStatus:{type:'idle'},permissions:policy('workspaceWrite'),selectedPermissionMode:'auto-review'});
  t.mock.method(runtime,'threadHeaderRead',async()=>{
    reads++;if(reads===1)return settings(cwd).thread;
    if(failure==='read-failed'&&!recover)throw Error('fresh header failed');
    return settings(failure==='cwd-mismatch'&&!recover?cwd:other,failure==='project-lost'&&!recover?null as any:failure==='project-different'&&!recover?'different':'p').thread;
  });
  t.mock.method(internal,'resolvePermissions',async(_mode:string,directory:string)=>policy('workspaceWrite',directory));
  t.mock.method(internal,'call',async()=>({thread:settings(other).thread}));
  t.mock.method(internal,'readThread',async()=>settings(other).thread);
  t.mock.method(internal,'mutation',async(method:string)=>{if(method==='thread/resume'){resumes++;return settings(other);}return {};});
  t.mock.method(internal,'startTurn',async()=>{turns++;state.reserved=false;return {threadId:'one'};});
  await assert.rejects(runtime.setThreadCwd('one',other,'p'));
  await assert.rejects(runtime.send('one',{text:'must block',clientRequestId:'blocked-send'}));assert.equal(turns,0);
  await runtime.snapshot('one');await assert.rejects(runtime.send('one',{text:'still block',clientRequestId:'blocked-after-snapshot'}));assert.equal(turns,0);
  recover=true;await runtime.open('one');assert.ok(resumes>0);assert.equal(state.cwd,other);assert.deepEqual(state.permissions.sandbox.writableRoots,[other]);
  await runtime.send('one',{text:'recovered',clientRequestId:'recovered-send'});assert.equal(turns,1);
});
test('native project pages cannot mix native epochs or homes',async t=>{
  const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());
  internal.server={close:async()=>{}};internal.initializeInfo={codexHome:cwd};internal.epoch='A';t.mock.method(runtime,'configurationHome',async()=>internal.initializeInfo.codexHome);
  let pages=0;t.mock.method(internal,'call',async()=>{pages++;if(pages===2){internal.epoch='B';internal.initializeInfo.codexHome=other;}return {data:[{id:'p'+pages,name:'p',roots:[{path:cwd}]}],nextCursor:pages===1?'second':null};});
  await assert.rejects(runtime.listProjects(),(error:any)=>error.code==='RUNTIME_SYNC_RESTARTED');assert.equal(pages,2);
});
for(const boundary of ['home-list','queue'])test(`catalog fences ${boundary} switch and rereads B without A suppression or keys in B`,async()=>{
  const store=new MetadataStore(':memory:'),workspaces=Array.from({length:4},(_,i)=>({id:'w'+i,name:'w'+i,path:join(cwd,'w'+i)}));let home=cwd,epoch='A',switched=false;
  const oldKeys=workspaces.map(row=>store.projectSync(cwd,row.id).idempotency_key);
  const original=store.projectSync(cwd,'w0');original.native_project_id='official-A';store.saveProjectSync(cwd,'w0',original);
  const writes:any[]=[],contexts:any[]=[];
  const runtime:any={configurationHome:async()=>home,projectContext:async()=>({home,epoch}),assertProjectContext:(context:any)=>{if(context.home!==home||context.epoch!==epoch)throw Object.assign(Error('native changed'),{code:'RUNTIME_SYNC_RESTARTED'});},
    listProjects:async()=>{const rows:any[]=[];if(boundary==='home-list'&&!switched){home=other;epoch='B';switched=true;}return rows;},
    createProject:async(input:any,context:any)=>{contexts.push(context);if(boundary==='queue'&&!switched){home=other;epoch='B';switched=true;}if(context)runtime.assertProjectContext(context);writes.push({home,key:input.idempotencyKey});return {id:'B-'+input.name,name:input.name,roots:input.roots};}};
  const projects:any={list:async()=>workspaces,resolve:async(id:string)=>workspaces.find(row=>row.id===id)};
  const catalog=new ProjectCatalog(runtime,projects,store,()=>{});
  try{await catalog.sync();assert.equal(catalog.snapshot().state,'ready');assert.equal(store.projectSync(cwd,'w0').suppressed,false);assert.equal(store.projectSync(cwd,'w0').native_project_id,'official-A');assert.ok(writes.length>0);for(const write of writes){assert.equal(write.home,other);assert.ok(!oldKeys.includes(write.key));}for(const row of workspaces)assert.equal(store.projectSync(cwd,row.id).native_project_id,row.id==='w0'?'official-A':null);assert.ok(contexts.every(Boolean));assert.ok(catalog.snapshot().workspaces.every(row=>row.nativeProjectId?.startsWith('B-')));}finally{await catalog.close();store.close();}
});

for(const boundary of ['before-dispatch','after-response','failed-response'])test(`native registration fences ${boundary} process changes at the RPC boundary`,async t=>{
  const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());let requests=0;
  const switchHome=()=>{internal.epoch='B';internal.initializeInfo.codexHome=other;};
  const server={close:async()=>{},request:async()=>{requests++;switchHome();if(boundary==='failed-response')throw Error('old native request failed');return {project:{id:'p',name:'p',roots:[{path:cwd}]}};}};
  internal.server=server;internal.initializeInfo={codexHome:cwd};internal.epoch='A';
  t.mock.method(internal,'getServer',async()=>{if(boundary==='before-dispatch')switchHome();return server;});
  await assert.rejects(runtime.createProject({idempotencyKey:'A-key',name:'p',roots:[{path:cwd}]},{home:cwd,epoch:'A'}),(error:any)=>error.code==='RUNTIME_SYNC_RESTARTED');
  assert.equal(requests,boundary==='before-dispatch'?0:1);
});
test('verified cwd switch also reloads permissions for the actual directory before sending',async t=>{
  const runtime=new Runtime({executable:'unused',cwd}),internal=runtime as any;t.after(()=>runtime.close());let reads=0,resumes=0;
  const state=internal.state('one');Object.assign(state,{cwd,loaded:true,nativeStatus:{type:'idle'},permissions:policy('workspaceWrite')});
  t.mock.method(runtime,'threadHeaderRead',async()=>settings(++reads===1?cwd:other).thread);
  t.mock.method(internal,'resolvePermissions',async(_mode:string,directory:string,previous:any)=>{assert.equal(directory,other);if(previous)assert.deepEqual(previous.sandbox.writableRoots,[other]);return policy('workspaceWrite',other);});
  t.mock.method(internal,'mutation',async(method:string)=>{if(method==='thread/resume'){resumes++;return settings(other);}return {};});
  t.mock.method(internal,'startTurn',async(_id:string,_text:string,_input:any,_state:any,permissions:any)=>{assert.deepEqual(permissions.sandbox.writableRoots,[other]);state.reserved=false;return {threadId:'one'};});
  t.mock.method(internal,'call',async()=>({thread:settings(other).thread}));
  await runtime.setThreadCwd('one',other,'p');assert.equal(state.loaded,false);assert.equal(state.permissions,undefined);
  await runtime.open('one');
  await runtime.send('one',{text:'fake',clientRequestId:'verified-cwd-send'});assert.equal(resumes,1);
});
