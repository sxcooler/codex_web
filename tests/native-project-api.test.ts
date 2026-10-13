import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import {Runtime} from '../src/codex/runtime.ts';
import {Projects} from '../src/projects.ts';
import {registerApi} from '../src/server/api.ts';
import {MetadataStore} from '../src/server/metadata.ts';

async function fixture(t:any,mode='normal'){
  const dir=await mkdtemp(join(tmpdir(),'native-project-')),root=join(dir,'work');await mkdir(root);await mkdir(join(root,'one'));await mkdir(join(root,'two'));
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url)),mode],cwd:dir,idleMs:60_000});
  const projects=new Projects(root),workspaces=await projects.list(),app=Fastify();
  app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode??500).send({error:error.message,code:error.code,partial:error.partial}));
  registerApi(app,{dataDir:dir,runtime,projects,authenticated:()=>()=>true});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const rpc=async(method:string,params:any={})=>(await (runtime as any).getServer()).request(method,params);
  const post=(url:string,payload:any)=>app.inject({method:'POST',url,payload});
  return {runtime,app,projects,workspaces,rpc,post,root,metadataPath:join(dir,'metadata.sqlite')};
}
test('catalog startup, read-only GET, legacy/new client identities and projectless creation',async t=>{
  const f=await fixture(t);await f.app.ready();await f.post('/api/projects/refresh',{});
  const catalog=(await f.app.inject('/api/project-catalog')).json();assert.equal(catalog.state,'ready');assert.equal(catalog.projects.length,2);
  const before=await f.rpc('fixture/stats');await f.app.inject('/api/project-catalog');assert.equal((await f.rpc('fixture/stats')).projectLists,before.projectLists);
  assert.equal(before.initializeParams.capabilities.experimentalApi,true);
  const legacy=await f.post('/api/sessions',{projectId:f.workspaces[0].id,clientRequestId:'legacy-create'});assert.equal(legacy.statusCode,200,legacy.body);
  const stats=await f.rpc('fixture/stats');assert.equal(stats.lastThread.cwd,f.workspaces[0].path);assert.ok(stats.lastThread.projectId);
  const snapshot=(await f.app.inject('/api/sessions/'+legacy.json().threadId)).json();assert.equal(snapshot.thread.projectId,stats.lastThread.projectId);
  assert.equal((await f.app.inject('/api/sessions')).json().data[0].projectId,stats.lastThread.projectId);
  const explicit=await f.post('/api/sessions',{projectId:f.workspaces[0].id,nativeProjectId:stats.lastThread.projectId,clientRequestId:'explicit-create'});assert.equal(explicit.statusCode,200,explicit.body);
  assert.equal((await f.post('/api/sessions',{clientRequestId:'projectless-create'})).statusCode,200);assert.equal((await f.rpc('fixture/stats')).lastThread.projectId,undefined);
  const outside=await f.post('/api/sessions',{nativeProjectId:'outside',clientRequestId:'outside-create'});assert.notEqual(outside.statusCode,200);
});
test('manual project assignment endpoints are retired without changing native membership or cwd',async t=>{
  const f=await fixture(t);await f.post('/api/projects/refresh',{});
  const created=await f.post('/api/sessions',{projectId:f.workspaces[0].id,clientRequestId:'membership-create'}),id=created.json().threadId;
  const projectId=(await f.rpc('fixture/stats')).lastThread.projectId;
  assert.equal((await f.post('/api/sessions/'+id+'/project',{nativeProjectId:null})).statusCode,404);
  assert.equal((await f.post('/api/sessions/'+id+'/project',{nativeProjectId:projectId})).statusCode,404);
  assert.equal((await f.post('/api/sessions/'+id+'/project',{nativeProjectId:'missing'})).statusCode,404);
  assert.equal((await f.rpc('fixture/stats')).lastMetadata,undefined);const snapshot=(await f.app.inject('/api/sessions/'+id)).json();assert.equal(snapshot.thread.projectId,projectId);assert.equal(snapshot.thread.cwd,f.workspaces[0].path);
  await f.rpc('fixture/native-thread',{threadId:'external',status:{type:'active'},thread:{projectId}});assert.equal((await f.post('/api/sessions/external/project',{nativeProjectId:null})).statusCode,404);
  await f.rpc('fixture/native-thread',{threadId:'internal',status:{type:'idle'},thread:{parentThreadId:'parent'}});assert.equal((await f.post('/api/sessions/internal/project',{nativeProjectId:null})).statusCode,404);
});

test('an old installation upgrades its directory-based history automatically, including archives and missing Web metadata, without loading model turns',async t=>{
 const f=await fixture(t),store=new MetadataStore(f.metadataPath);try{
 for(const [id,cwd] of [['legacy-web',f.root+'/dated/502'],['legacy-vscode',f.workspaces[1].path],['legacy-archive',f.workspaces[0].path],['internal',f.workspaces[0].path],['temporary',f.workspaces[0].path]])await f.rpc('fixture/native-thread',{threadId:id,status:{type:'notLoaded'},thread:{cwd,projectId:null,...(id==='internal'?{parentThreadId:'parent'}:{}),...(id==='temporary'?{ephemeral:true}:{})}});
 store.save('legacy-web',f.workspaces[0].path,'Legacy title');store.update('legacy-web',{favorite:true,hidden:true});const saved=store.get('legacy-web');
 await f.rpc('thread/archive',{threadId:'legacy-archive'});
 const ids=['legacy-web','legacy-vscode','legacy-archive'],read=(id:string)=>f.rpc('thread/read',{threadId:id,includeTurns:false});
 const before=await Promise.all(ids.map(read));await f.app.ready();
 let current:any[]=[];const deadline=Date.now()+5000;
 do{current=await Promise.all(ids.map(read));if(current.every(row=>row.thread.projectId))break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);
 assert.ok(current.every(row=>typeof row.thread.projectId==='string'),'Startup automatically fills all eligible legacy memberships');
 const catalog=(await f.app.inject('/api/project-catalog')).json();
 for(let i=0;i<ids.length;i++){const expected=catalog.workspaces.find((row:any)=>row.workspaceId===f.workspaces[i===1?1:0].id).nativeProjectId;assert.equal(current[i].thread.projectId,expected);assert.equal(current[i].thread.cwd,before[i].thread.cwd);assert.equal(current[i].thread.name,before[i].thread.name);}
 assert.deepEqual(store.get('legacy-web'),saved);assert.equal((await read('internal')).thread.projectId,null);assert.equal((await read('temporary')).thread.projectId,null);
 assert.ok((await f.runtime.list(undefined,true)).data.some(row=>row.id==='legacy-archive'));
 const stats=await f.rpc('fixture/stats');assert.equal(stats.turnStarts,0);assert.equal(stats.resumes,0);assert.equal(stats.fullTurnLists,0);
 }finally{store.close();}
});
test('cwd selection uses current project roots, changes only cwd, rejects outside/projectless/occupied states',async t=>{
  const f=await fixture(t);await f.post('/api/projects/refresh',{});
  const created=await f.post('/api/sessions',{projectId:f.workspaces[0].id,clientRequestId:'cwd-create'}),id=created.json().threadId;
  const projectId=(await f.rpc('fixture/stats')).lastThread.projectId;
  assert.equal((await f.post('/api/sessions/'+id+'/cwd',{workspaceId:f.workspaces[1].id})).statusCode,409);
  await f.rpc('fixture/projects',{data:[{id:projectId,name:'Ordered',roots:f.workspaces.map(p=>({path:p.path}))}]});
  const moved=await f.post('/api/sessions/'+id+'/cwd',{workspaceId:f.workspaces[1].id});assert.equal(moved.statusCode,200,moved.body);assert.deepEqual(moved.json(),{cwd:f.workspaces[1].path,workspaceId:f.workspaces[1].id,nativeProjectId:projectId});assert.deepEqual((await f.rpc('fixture/stats')).lastSettings,{threadId:id,cwd:f.workspaces[1].path});
  const blocked=await f.post('/api/sessions/'+id+'/messages',{text:'must open first',clientRequestId:'cwd-before-open'});assert.equal(blocked.statusCode,409,blocked.body);assert.equal((await f.rpc('fixture/stats')).turnStarts,0);
  const opened=await f.post('/api/sessions/'+id+'/open',{});assert.equal(opened.statusCode,200,opened.body);assert.equal(opened.json().phase,'IDLE');assert.equal((f.runtime as any).state(id).cwd,f.workspaces[1].path);
  assert.equal((await f.post('/api/sessions/'+id+'/cwd',{workspaceId:'unsafe'})).statusCode,404);
  assert.equal((await f.post('/api/sessions/'+id+'/cwd',{cwd:'/outside'})).statusCode,400);
  const blank=(await f.post('/api/sessions',{clientRequestId:'blank-cwd'})).json();assert.equal((await f.post('/api/sessions/'+blank.threadId+'/cwd',{workspaceId:f.workspaces[0].id})).statusCode,409);
  (f.runtime as any).state(id).externalWriter=true;assert.equal((await f.post('/api/sessions/'+id+'/cwd',{workspaceId:f.workspaces[0].id})).statusCode,409);
});
for(const mode of ['projects-partial','projects-loop','projects-unavailable','projects-create-fail'])test(mode+' stops session creation before thread/start and model turns',async t=>{
  const f=await fixture(t,mode);const result=await f.post('/api/sessions',{projectId:f.workspaces[0].id,clientRequestId:'failed-create',prompt:'never send'});assert.equal(result.statusCode,503,result.body);
  const stats=await f.rpc('fixture/stats');assert.equal(stats.lastThread,undefined);assert.equal(stats.turnStarts,0);if(mode!=='projects-create-fail')assert.equal(stats.projectCreates,0);
});
test('cwd verification failure reports error without claiming success',async t=>{
  const f=await fixture(t,'cwd-mismatch');await f.post('/api/projects/refresh',{});
  const id=(await f.post('/api/sessions',{projectId:f.workspaces[0].id,clientRequestId:'cwd-bad-create'})).json().threadId,projectId=(await f.rpc('fixture/stats')).lastThread.projectId;
  await f.rpc('fixture/projects',{data:[{id:projectId,name:'one',roots:f.workspaces.map(p=>({path:p.path}))}]});
  assert.equal((await f.post('/api/sessions/'+id+'/cwd',{workspaceId:f.workspaces[1].id})).statusCode,503);
});
test('native ignored identity preserves partial thread and never sends prompt',async t=>{
  const f=await fixture(t,'projects-ignore-identity');
  const result=await f.post('/api/sessions',{projectId:f.workspaces[0].id,clientRequestId:'ignored-identity',prompt:'never send'});
  assert.equal(result.statusCode,503,result.body);assert.ok(result.json().partial.threadId);assert.equal((await f.rpc('fixture/stats')).turnStarts,0);
});
test('project create without a session registers its directory; failed registration retains directory and retry state',async t=>{
  const f=await fixture(t,'projects-create-fail');
  const created=await f.post('/api/projects',{name:'New',folderName:'new'});assert.equal(created.statusCode,503,created.body);assert.ok(created.json().project.id);
  assert.equal((await f.projects.resolve(created.json().project.id)).name,'New');
  const status=(await f.app.inject('/api/project-catalog')).json();assert.equal(status.workspaces.find((row:any)=>row.workspaceId===created.json().project.id).status,'failed');assert.equal((await f.rpc('fixture/stats')).turnStarts,0);
});
test('runtime native project pagination accepts all pages and bounds malformed/endless reads',async t=>{
  const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());let calls=0;
  t.mock.method(runtime,'projectContext',async()=>({home:process.cwd(),epoch:'fixture'}));t.mock.method(runtime,'assertProjectContext',()=>{});
  t.mock.method(runtime as any,'call',async(_method:string,input:any)=>{calls++;return {data:[{id:'p'+calls,name:'Name',roots:[{path:process.cwd()}]}],...(input.cursor?{}:{nextCursor:'last'})};});
  assert.equal((await runtime.listProjects()).length,2);assert.equal(calls,2);
  t.mock.method(runtime as any,'call',async()=>({data:[],nextCursor:String(++calls)}));await assert.rejects(runtime.listProjects(),/page limit/);assert.equal(calls,102);
});
test('runtime project and settings notifications preserve identity/cwd and publish catalog invalidation',async t=>{
  const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());const changes:any[]=[];let catalogs=0;
  runtime.on('change',event=>changes.push(event));runtime.on('projectCatalogChanged',()=>catalogs++);
  (runtime as any).onNotification({method:'project/changed',params:{changeType:'updated',projectId:'p'}});
  (runtime as any).onNotification({method:'thread/project/updated',params:{threadId:'one',projectId:null}});
  (runtime as any).onNotification({method:'thread/settings/updated',params:{threadId:'one',threadSettings:{cwd:process.cwd(),model:'fixture',effort:'high'}}});
  assert.equal(catalogs,2);assert.equal(changes[0].patch.thread.projectId,null);assert.equal(changes.at(-1).patch.thread.cwd,process.cwd());
});
test('identity mutations refuse activity arriving while their fresh header is read',async t=>{
  const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());let writes=0;
  t.mock.method(runtime,'assertProjectContext',()=>{});
  t.mock.method(runtime,'threadHeaderRead',async()=>{(runtime as any).state('one').activeTurnId='active';return {id:'one',cwd:process.cwd(),status:{type:'idle'},projectId:'p'};});
  t.mock.method(runtime as any,'mutation',async()=>{writes++;});
  await assert.rejects(runtime.setThreadProject('one','p',{cwd:process.cwd(),context:{home:process.cwd(),epoch:'fixture'}}),/active/);assert.equal(writes,0);
});
