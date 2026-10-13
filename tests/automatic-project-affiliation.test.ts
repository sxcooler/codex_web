import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataStore} from '../src/server/metadata.ts';
import {ProjectCatalog} from '../src/server/project-catalog.ts';
import {Runtime} from '../src/codex/runtime.ts';

function fixture(){
 const root=process.platform==='win32'?'C:/work':'/work',metadata=new MetadataStore(':memory:');
 const workspaces=['one','two'].map(id=>({id,name:id,path:root+'/'+id}));
 let home='/native/one',native=workspaces.map(p=>({id:'native-'+p.id,name:p.name,roots:[{path:p.path}]}));
 const threads:any[]=[];const reads:any[]=[],writes:any[]=[],events:string[]=[];let active=0,max=0;
 const runtime:any={projectContext:async()=>({home,epoch:home}),assertProjectContext:(context:any)=>{if(context.home!==home)throw Object.assign(Error('changed'),{code:'RUNTIME_SYNC_RESTARTED'});},listProjects:async()=>structuredClone(native),createProject:async()=>{throw Error('unexpected registration');},
  list:async(cursor:any,archived:boolean,_sort:any,_search:any,projectId:any)=>{assert.equal(projectId,null);reads.push({cursor,archived});events.push('list');return {data:threads.filter(t=>!!t.archived===archived&&t.projectId===null),nextCursor:null};},
  setThreadProject:async(id:string,projectId:string,expected:any)=>{runtime.assertProjectContext(expected.context);const thread=threads.find(t=>t.id===id);assert.equal(thread.cwd,expected.cwd);assert.equal(thread.projectId,null);writes.push({id,projectId,expected});events.push('write');active++;max=Math.max(max,active);await Promise.resolve();active--;thread.projectId=projectId;return {threadId:id,nativeProjectId:projectId,cwd:thread.cwd};}
 };
 const projects:any={list:async()=>workspaces,resolve:async(id:string)=>{const p=workspaces.find(p=>p.id===id);if(!p)throw Error('unsafe');return p;}};
 const catalog=new ProjectCatalog(runtime,projects,metadata,()=>{});
 return {catalog,metadata,projects,runtime,threads,workspaces,reads,writes,events,root,max:()=>max,setHome:(value:string)=>home=value,setNative:(value:any)=>native=value,close:async()=>{await catalog.close();metadata.close();}};
}

test('automatic maintenance fills saved Web, directory-only and archived affiliations without changing cwd or Web preferences',async()=>{
 const f=fixture();
 f.threads.push({id:'web',projectId:null,cwd:f.root+'/tasks/502'},{id:'vscode',projectId:null,cwd:f.workspaces[1].path},{id:'archived',projectId:null,cwd:f.workspaces[0].path,archived:true},{id:'none',projectId:null,cwd:f.root},{id:'assigned',projectId:'other',cwd:f.workspaces[0].path});
 f.metadata.save('web',f.workspaces[0].path,'Title');f.metadata.update('web',{favorite:true,hidden:true});const saved=f.metadata.get('web'),cwd=f.threads.map(t=>t.cwd);
 try{await (f.catalog as any).maintain();assert.deepEqual(f.writes.map(w=>[w.id,w.projectId]),[['web','native-one'],['vscode','native-two'],['archived','native-one']]);assert.deepEqual(f.threads.map(t=>t.cwd),cwd);assert.deepEqual(f.metadata.get('web'),saved);assert.equal(f.threads.at(-1).projectId,'other');assert.ok(f.events.lastIndexOf('list')<f.events.indexOf('write'),'Read all pages before mutating the filtered list');assert.ok(f.max()<=2);}finally{await f.close();}
});

test('overlapping callers share one paginated sweep and at most two assignment workers',async()=>{
 const f=fixture(),gate=Promise.withResolvers<void>();let started=0,max=0,active=0;
 f.threads.push(...Array.from({length:6},(_,i)=>({id:'t'+i,cwd:f.workspaces[0].path,projectId:null})));
 f.runtime.list=async(cursor:any,archived:boolean,_sort:any,_search:any,projectId:any)=>{assert.equal(projectId,null);f.reads.push({cursor,archived});if(archived)return {data:[],nextCursor:null};return {data:cursor?f.threads.slice(3):f.threads.slice(0,3),nextCursor:cursor?null:'next'};};
 f.runtime.setThreadProject=async(id:string,projectId:string)=>{started++;max=Math.max(max,++active);await gate.promise;active--;f.threads.find(t=>t.id===id).projectId=projectId;};
 try{const first=(f.catalog as any).maintain();while(started<2)await new Promise(r=>setImmediate(r));const second=(f.catalog as any).maintain();assert.equal(started,2);gate.resolve();await Promise.all([first,second]);assert.equal(started,6);assert.equal(max,2);assert.equal(f.reads.length,3);}finally{gate.resolve();await f.close();}
});

test('busy and failed affiliations retry on the next cycle while successful rows are not rewritten',async()=>{
 const f=fixture();f.threads.push({id:'busy',cwd:f.workspaces[0].path,projectId:null},{id:'failed',cwd:f.workspaces[1].path,projectId:null});
 const assign=f.runtime.setThreadProject;let first=true;
 f.runtime.setThreadProject=async(id:string,...args:any[])=>{if(first)throw Object.assign(Error(id),{statusCode:id==='busy'?409:503});return assign(id,...args);};
 try{await (f.catalog as any).maintain();assert.deepEqual((f.catalog.snapshot() as any).sessionSync,{pending:2,failed:1});first=false;await (f.catalog as any).maintain();assert.equal(f.writes.length,2);await (f.catalog as any).maintain();assert.equal(f.writes.length,2);assert.deepEqual((f.catalog.snapshot() as any).sessionSync,{pending:0,failed:0});}finally{await f.close();}
});

test('ambiguous, deleted and unsafe directory affiliations are never guessed or recreated',async()=>{
 const f=fixture();f.threads.push({id:'one',projectId:null,cwd:f.workspaces[0].path},{id:'outside',projectId:null,cwd:f.root+'/outside'});
 try{await f.catalog.sync();f.setNative([{id:'native-one',name:'One',roots:[{path:f.workspaces[0].path}]},{id:'duplicate',name:'Duplicate',roots:[{path:f.workspaces[0].path}]}]);await (f.catalog as any).maintain();assert.equal(f.writes.length,0);assert.equal(f.catalog.snapshot().workspaces[0].status,'ambiguous');assert.equal(f.catalog.snapshot().workspaces[1].status,'removed');}finally{await f.close();}
});

test('failed or repeated pagination makes no partial assignments and retries without advancing past candidates',async()=>{
 const f=fixture();f.threads.push({id:'one',projectId:null,cwd:f.workspaces[0].path});let fail=true;
 f.runtime.list=async(cursor:any,archived:boolean)=>{if(archived)return {data:[],nextCursor:null};if(cursor&&fail)throw Error('page unavailable');return {data:cursor?[]:f.threads,nextCursor:cursor?null:'next'};};
 try{await (f.catalog as any).maintain();assert.equal(f.writes.length,0);assert.equal((f.catalog.snapshot() as any).sessionSync.failed,1);fail=false;await (f.catalog as any).maintain();assert.equal(f.writes.length,1);}finally{await f.close();}
});

test('native home switching during the sweep prevents assignment using the old mapping',async()=>{
 const f=fixture();f.threads.push({id:'one',projectId:null,cwd:f.workspaces[0].path});const read=f.runtime.list;
 f.runtime.list=async(...args:any[])=>{const page=await read(...args);f.setHome('/native/two');return page;};
 try{await (f.catalog as any).maintain();assert.equal(f.writes.length,0);}finally{await f.close();}
});

test('Web affiliation changing during directory validation is not overwritten with the stale mapping',async()=>{
 const f=fixture();f.threads.push({id:'one',projectId:null,cwd:f.workspaces[0].path});f.metadata.save('one',f.workspaces[0].path,null);
 const resolve=f.projects.resolve;f.projects.resolve=async(id:string)=>{const p=await resolve(id);f.metadata.save('one',f.workspaces[1].path,null);return p;};
 try{await (f.catalog as any).maintain();assert.equal(f.writes.length,0);assert.equal(f.threads[0].projectId,null);}finally{await f.close();}
});

test('repeated cursors never trigger partial writes or an infinite pagination loop',async()=>{
 const f=fixture();let reads=0;f.runtime.list=async()=>{reads++;return {data:[{id:'one',projectId:null,cwd:f.workspaces[0].path}],nextCursor:'same'};};
 try{await (f.catalog as any).maintain();assert.equal(reads,2);assert.equal(f.writes.length,0);assert.equal((f.catalog.snapshot() as any).sessionSync.failed,1);}finally{await f.close();}
});

test('service startup and a shared minute timer maintain affiliations without any browser client',async t=>{
 const f=fixture();t.mock.timers.enable({apis:['setInterval']});
 try{(f.catalog as any).start();await (f.catalog as any).maintain();const before=f.reads.length;(f.catalog as any).start();t.mock.timers.tick(60_000);await (f.catalog as any).maintain();assert.equal(f.reads.length,before+2);await f.catalog.close();t.mock.timers.tick(60_000);assert.equal(f.reads.length,before+2);}finally{await f.close();}
});

for(const change of ['project','cwd','epoch','ignored'])test('automatic runtime assignment rejects '+change+' drift without overwriting another identity',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),context={home:'/home',epoch:'one'},cwd=process.cwd();let writes=0,reads=0;
 t.after(()=>runtime.close());t.mock.method(runtime,'assertProjectContext',()=>{if(change==='epoch'&&reads)throw Object.assign(Error('changed'),{code:'RUNTIME_SYNC_RESTARTED'});});
 t.mock.method(runtime,'threadHeaderRead',async()=>{reads++;return {id:'one',cwd:change==='cwd'?cwd+'/other':cwd,projectId:change==='project'?'other':reads>1&&change!=='ignored'?'target':null,status:{type:'idle'}};});
 t.mock.method(runtime as any,'mutation',async(_method:string,params:any,bound:any)=>{writes++;assert.deepEqual(params,{threadId:'one',projectId:'target'});assert.equal(bound,context);});
 await assert.rejects(runtime.setThreadProject('one','target',{cwd,context}),(error:any)=>error.code===({project:'RUNTIME_THREAD_CONFLICT',cwd:'RUNTIME_THREAD_CONFLICT',epoch:'RUNTIME_SYNC_RESTARTED',ignored:'RUNTIME_UNAVAILABLE'}[change]));assert.equal(writes,change==='ignored'?1:0);
});

test('an observed project update between fresh header and RPC dispatch is never overwritten',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),context={home:'/home',epoch:'one'},cwd=process.cwd();let writes=0,projectId:any=null;
 t.after(()=>runtime.close());t.mock.method(runtime,'assertProjectContext',()=>{});
 t.mock.method(runtime,'threadHeaderRead',async()=>({id:'one',cwd,projectId,status:{type:'idle'}}));
 t.mock.method(runtime as any,'getServer',async()=>{projectId='other';(runtime as any).onNotification({method:'thread/project/updated',params:{threadId:'one',projectId}});return {request:async()=>{writes++;projectId='target';return {};}};});
 await assert.rejects(runtime.setThreadProject('one','target',{cwd,context}),/changed/);assert.equal(writes,0);assert.equal(projectId,'other');
});

for(const stage of ['header','dispatch'])test('an unsupported native interaction during '+stage+' defers automatic assignment without clearing the unknown state',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),context={home:'/home',epoch:'one'},cwd=process.cwd();let writes=0,projectId:any=null;
 const unknown=()=>{(runtime as any).onRequest({id:1,method:'future/request',params:{threadId:'one'}});};
 t.after(()=>runtime.close());t.mock.method(runtime,'assertProjectContext',()=>{});
 t.mock.method(runtime,'threadHeaderRead',async()=>{if(stage==='header')unknown();return {id:'one',cwd,projectId,status:{type:'idle'}};});
 t.mock.method(runtime as any,'getServer',async()=>{if(stage==='dispatch')unknown();return {request:async()=>{writes++;projectId='target';return {};}};});
 await assert.rejects(runtime.setThreadProject('one','target',{cwd,context}),(error:any)=>error.code==='RUNTIME_THREAD_CONFLICT');
 assert.equal(writes,0);assert.equal(projectId,null);assert.equal((runtime as any).state('one').error,'Codex requested an unsupported interaction');
});

test('a source change while the fresh header is read prevents any native write',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),context={home:'/home',epoch:'one'},cwd=process.cwd();let changed=false,writes=0;
 t.after(()=>runtime.close());t.mock.method(runtime,'assertProjectContext',()=>{});
 t.mock.method(runtime,'threadHeaderRead',async()=>{changed=true;return {id:'one',cwd,projectId:null,status:{type:'idle'}};});
 t.mock.method(runtime as any,'mutation',async()=>{writes++;});
 await assert.rejects(runtime.setThreadProject('one','target',{cwd,context,assertCurrent:()=>{if(changed)throw Object.assign(Error('source changed'),{statusCode:409});}}),/source changed/);assert.equal(writes,0);
});

test('a native process failure during metadata-only maintenance can retry without opening or resuming the thread',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),context={home:'/home',epoch:'one'},cwd=process.cwd();let writes=0,projectId:any=null;
 t.after(()=>runtime.close());t.mock.method(runtime,'assertProjectContext',()=>{});
 t.mock.method(runtime,'threadHeaderRead',async()=>({id:'one',cwd,projectId,status:{type:'notLoaded'}}));
 t.mock.method(runtime as any,'mutation',async()=>{if(++writes===1){(runtime as any).onFailure(undefined,Error('stopped'));throw Object.assign(Error('stopped'),{statusCode:503});}projectId='target';});
 await assert.rejects(runtime.setThreadProject('one','target',{cwd,context}));
 assert.equal((runtime as any).state('one').error,undefined);assert.notEqual((runtime as any).state('one').recoverOnIdle,true);
 await runtime.setThreadProject('one','target',{cwd,context});assert.equal(writes,2);assert.equal(projectId,'target');assert.equal((runtime as any).state('one').loaded,false);
});

for(const patch of [{loaded:true},{cwd:'/owned'},{error:'existing'},{contextUnknown:true},{activeTurnId:'turn'}, {openPromise:Promise.resolve()}, {nameWrite:Promise.resolve()}, {externalWriter:true}])test('process failure does not treat a real or unresolved state as metadata-only '+Object.keys(patch)[0],async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());
 const state=(runtime as any).state('one');Object.assign(state,{maintenanceOnly:true},patch);(runtime as any).onFailure(undefined,Error('stopped'));
 assert.ok(state.error);assert.equal(state.recoverOnIdle,true);
});
