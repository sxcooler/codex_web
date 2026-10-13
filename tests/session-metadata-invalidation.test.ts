import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {registerApi} from '../src/server/api.ts';
import {MetadataStore} from '../src/server/metadata.ts';
import {Diagnostics} from '../src/server/diagnostics.ts';

async function fixture(t:TestContext,fork=false){
 const dir=await mkdtemp(join(tmpdir(),'session-metadata-')),thread:any={id:'thread-1',name:'Title',preview:'',cwd:dir,createdAt:1,updatedAt:2,turns:[],...(fork?{forkedFromId:'source',source:'vscode'}:{})};
 const store=new MetadataStore(join(dir,'metadata.sqlite'));store.save(thread.id,process.platform==='win32'?dir.toUpperCase():dir,null);if(fork)store.registerFork(thread);
 const project={id:'project',path:dir},projects:any={root:dir,list:async()=>[project]},events:any[]=[];
 const runtime=Object.assign(new EventEmitter(),{lists:0,list:async()=>{runtime.lists++;return {data:[thread],nextCursor:null};},snapshot:async()=>({thread,phase:'IDLE',pending:[]}),forkListHeader:async()=>({thread,archived:false}),release:async()=>({released:true}),requestRelease:async()=>({requested:true}),cancelRelease:async()=>({requested:false}),rename:async(_id:string,name:string)=>{thread.name=name;},archive:async(_id:string,archived:boolean)=>({archived}),invalidateForkHeader:()=>{},close:async()=>{}});
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});registerApi(app,{dataDir:dir,runtime:runtime as any,projects,authenticated:()=>()=>true,diagnostic:event=>events.push(event)});
 t.after(async()=>{await app.close();store.close();await rm(dir,{recursive:true,force:true});});return {app,store,runtime,thread,project,events};
}

for(const fork of [false,true])test(`repeated ${fork?'known fork':'session'} snapshots preserve an in-flight list and still save opening time`,async t=>{
 const {app,store,runtime}=await fixture(t,fork),before=store.get('thread-1')!.last_opened_at;
 let clock=Date.now()+1000;t.mock.method(Date,'now',()=>clock++);
 runtime.list=async()=>{runtime.lists++;assert.equal((await app.inject('/api/sessions/thread-1')).statusCode,200);assert.equal((await app.inject('/api/sessions/thread-1')).statusCode,200);return {data:[],nextCursor:null};};
 const response=await app.inject('/api/sessions');assert.equal(response.statusCode,200,response.body);assert.equal(runtime.lists,1);assert.ok(store.get('thread-1')!.last_opened_at>before);
});

test('fork registration reports list meaning changes while retaining fresh full headers',()=>{
 const store=new MetadataStore(':memory:');try{
  const header={id:'fork',forkedFromId:'source',name:'Title',cwd:'/project',createdAt:1,updatedAt:2,status:{type:'idle'},release:{requested:false},turns:[]};
  assert.equal(store.registerFork(header),'hard');
  assert.equal(store.registerFork({...header,status:{type:'active'},release:{requested:true},turns:[{id:'turn'}]}),false);
  assert.equal(store.knownForks()[0].header.status.type,'active');assert.equal(store.knownForks()[0].header.turns,undefined);
  assert.equal(store.registerFork({...header,name:'Renamed'}),'hard');assert.equal(store.registerFork({...header,name:'Renamed',updatedAt:3}),'soft');assert.equal(store.registerFork({...header,name:'Renamed',updatedAt:3,recencyAt:4}),'soft');
  const current={...header,name:'Renamed',updatedAt:3,recencyAt:4};assert.equal(store.registerFork(Object.fromEntries(Object.entries(current).reverse())),false);
  if(process.platform==='win32')assert.equal(store.registerFork({...current,cwd:'/PROJECT'}),false);
  assert.equal(store.registerFork({...current,modelProvider:'changed'}),'hard','unknown header changes stay conservative');
  assert.equal(store.registerFork({id:'not-fork'}),false);assert.equal(store.registerFork({...header,parentThreadId:'parent'}),false);
 }finally{store.close();}
});

test('known fork ordering refreshes softly during an in-flight list',async t=>{
 const {app,runtime,thread,store,events}=await fixture(t,true);
 runtime.list=async()=>{runtime.lists++;for(let read=0;read<2;read++){thread.updatedAt++;assert.equal((await app.inject('/api/sessions/thread-1')).statusCode,200);assert.equal(store.knownForks()[0].header.updatedAt,3+read);}return {data:[],nextCursor:null};};
 const result=await app.inject('/api/sessions');assert.equal(result.statusCode,200,result.body);assert.equal(runtime.lists,1);
 assert.equal(result.json().data[0].updatedAt,4);
 const changes=events.filter(event=>event.event==='shared_sessions_invalidation');assert.equal(changes.length,1);assert.ok(changes.every(event=>event.kind==='soft'&&event.reason==='fork'));
});

test('a newly saved metadata record invalidates an existing list',async t=>{
 const {app,runtime,store}=await fixture(t);store.clear('thread-1');await app.inject('/api/sessions');assert.equal(runtime.lists,1);
 await app.inject('/api/sessions/thread-1');await app.inject('/api/sessions');assert.equal(runtime.lists,2);assert.ok(store.get('thread-1'));
});

test('opening a Desktop task directory preserves saved Web affiliation without granting file access',async t=>{
 const {app,store,runtime,thread}=await fixture(t);const saved=store.get(thread.id)!.project_path;
 await app.inject('/api/sessions');thread.cwd=join(thread.cwd,'Documents','Codex','2026-10-11','502');
 const response=await app.inject('/api/sessions/'+thread.id);
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().project,null);
 assert.equal(response.json().metadata.project_path,saved);assert.equal(store.get(thread.id)!.project_path,saved);
 assert.equal(response.json().thread.cwd,thread.cwd);
 await app.inject('/api/sessions');assert.equal(runtime.lists,1,'Preserving affiliation does not invalidate a cached list');
});

test('opening another registered cwd preserves source affiliation and resolves file access only from the actual cwd',async t=>{
 const {app,store,thread,project}=await fixture(t);const saved=store.get(thread.id)!.project_path;
 project.path=join(project.path,'other');thread.cwd=project.path;
 const response=await app.inject('/api/sessions/'+thread.id);assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().metadata.project_path,saved);assert.equal(response.json().project.path,thread.cwd);
});

test('project association changes and explicit visibility/title mutations still invalidate lists',async t=>{
 const {app,runtime,project,thread,store,events}=await fixture(t);await app.inject('/api/sessions');assert.equal(runtime.lists,1);
 await app.inject('/api/sessions/thread-1');await app.inject('/api/sessions');assert.equal(runtime.lists,1,'path aliases and opening timestamps do not change list meaning');
 store.save(thread.id,null,null);project.path=join(project.path,'different');thread.cwd=project.path;await app.inject('/api/sessions/thread-1');await app.inject('/api/sessions');assert.equal(runtime.lists,2);
 for(const [suffix,payload]of [['metadata',{favorite:true}],['name',{name:'Renamed'}],['metadata/clear',{}],['archive',{}]] as const){
  assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/'+suffix,payload})).statusCode,200);await app.inject('/api/sessions');assert.equal(runtime.lists,3+['metadata','name','metadata/clear','archive'].indexOf(suffix));
  assert.equal(events.filter(event=>event.event==='shared_sessions_invalidation').at(-1)?.reason,suffix==='name'?'name':suffix==='archive'?'archive':'metadata');
 }
 await app.inject({method:'POST',url:'/api/sessions/thread-1/metadata',payload:{hidden:true}});assert.deepEqual((await app.inject('/api/sessions')).json().data,[]);
});

test('recovery is a strict non-key hint and shared reads carry the HTTP request identity',async t=>{
 const {app,runtime,events}=await fixture(t);
 for(const recovery of ['foreground','stream-ready','shared-update','manual'])assert.equal((await app.inject('/api/sessions?recovery='+recovery)).statusCode,200);
 assert.equal(runtime.lists,1);assert.equal((await app.inject('/api/sessions?recovery=private-sentinel')).statusCode,400);
 assert.ok(events.some(event=>event.event==='shared_sessions_start'&&typeof event.requestId==='string'));
});

test('release routes use soft updates without discarding a successful list',async t=>{
 const {app,runtime,events}=await fixture(t);await app.inject('/api/sessions');const calls:string[]=[];let requested=false;
 t.mock.method(runtime,'release',async(id:string)=>{calls.push('release:'+id);return {released:true};});
 t.mock.method(runtime,'requestRelease',async(id:string)=>{calls.push('request:'+id);requested=true;return {requested};});
 t.mock.method(runtime,'cancelRelease',async(id:string)=>{calls.push('cancel:'+id);requested=false;return {requested};});
 for(const [suffix,expected]of [['release',{released:true}],['release-on-leave',{requested:true}],['cancel-release',{requested:false}]] as const){const response=await app.inject({method:'POST',url:'/api/sessions/thread-1/'+suffix,payload:{}});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),expected);assert.equal(requested,suffix==='release-on-leave');}
 assert.deepEqual(calls,['release:thread-1','request:thread-1','cancel:thread-1']);assert.equal(runtime.lists,1);
 const invalidations=events.filter(event=>event.event==='shared_sessions_invalidation');assert.equal(invalidations.length,1);assert.ok(invalidations.every(event=>event.kind==='soft'&&event.reason==='release'));
});

test('HTTP diagnostics record only request identity and allowlisted list recovery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'session-diagnostics-')),diagnostics=new Diagnostics(dir),app=Fastify(),events:any[]=[];
 t.mock.method(diagnostics,'record',event=>events.push(event));diagnostics.attach(app);
 app.get('/api/sessions',async(_request,reply)=>reply.code(503).send({error:'fixture'}));app.get('/api/other',async(_request,reply)=>reply.code(503).send({error:'fixture'}));
 t.after(async()=>{await app.close();await diagnostics.close();await rm(dir,{recursive:true,force:true});});
 await app.inject('/api/sessions?recovery=foreground&searchTerm=private-sentinel');await app.inject('/api/sessions?recovery=private-sentinel');await app.inject('/api/other?recovery=manual');
 const http=events.filter(event=>event.event==='http_end');assert.equal(http.length,3);assert.equal(http[0].recovery,'foreground');assert.equal(typeof http[0].requestId,'string');assert.equal(http[1].recovery,undefined);assert.equal(http[2].recovery,undefined);assert.doesNotMatch(JSON.stringify(events),/private-sentinel|searchTerm/);
});
