import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataStore} from '../src/server/metadata.ts';
import {ProjectCatalog,rootKey} from '../src/server/project-catalog.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workspace=(id:string,path='/work/'+id,name=id)=>({id,path,name});
const native=(id:string,path:string,name=id)=>({id,name,roots:[{path}]});
function fixture(workspaces=[workspace('one')],initial:any[]=[]){
  const metadata=new MetadataStore(':memory:');let rows=initial,home='/native/one',fail=false,active=0,maxActive=0;
  const calls:any[]=[];
  const runtime:any={projectContext:async()=>({home,epoch:home}),assertProjectContext:(context:any)=>{if(context.home!==home)throw Object.assign(Error('changed'),{code:'RUNTIME_SYNC_RESTARTED'});},configurationHome:async()=>home,listProjects:async()=>{if(fail)throw Error('incomplete list');return structuredClone(rows);},createProject:async(input:any)=>{
    calls.push(input);active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,2));active--;
    const project=native('created-'+input.name,input.roots[0].path,input.name);rows.push(project);return project;
  }};
  const projects:any={list:async()=>workspaces,resolve:async(id:string)=>{const item=workspaces.find(p=>p.id===id);if(!item)throw Error('unsafe workspace');return item;}};
  const catalog=new ProjectCatalog(runtime,projects,metadata,()=>{});
  return {catalog,metadata,calls,runtime,workspaces,setRows:(value:any[])=>rows=value,setHome:(value:string)=>home=value,setFail:(value:boolean)=>fail=value,max:()=>maxActive};
}
test('root matching reuses official names and ordered roots; same names at other roots are distinct',async()=>{
  const f=fixture([workspace('one')],[{id:'official',name:'Renamed',roots:[{path:'/outside'},{path:'/work/one'}]},native('other','/elsewhere','one')]);
  try{await f.catalog.sync();assert.equal(f.calls.length,0);assert.equal(await f.catalog.resolve('one'),'official');assert.deepEqual(f.catalog.snapshot().projects[0].roots,[{path:'/outside',workspaceId:null,available:false},{path:'/work/one',workspaceId:'one',available:true}]);
    f.workspaces.push(workspace('two','/work/two','one'));await f.catalog.sync();assert.equal(f.calls.length,1);
  }finally{f.metadata.close();}
});
test('Windows extended drive and UNC aliases normalize without collapsing different roots',()=>{
  assert.equal(rootKey('\\\\?\\C:\\Work\\Repo\\','win32'),rootKey('c:/work/repo','win32'));
  assert.equal(rootKey('\\\\?\\UNC\\HOST\\Share\\Repo','win32'),rootKey('\\\\host\\share\\repo\\','win32'));
  assert.notEqual(rootKey('C:\\Work\\A','win32'),rootKey('C:\\Work\\B','win32'));
});
test('shared sync registers at most two concurrently and merges in-flight callers',async()=>{
  const f=fixture(Array.from({length:6},(_,i)=>workspace('w'+i)));
  try{await Promise.all([f.catalog.sync(),f.catalog.sync(),f.catalog.resolve('w0')]);assert.equal(f.calls.length,6);assert.equal(f.max(),2);await f.catalog.sync();assert.equal(f.calls.length,6);}finally{f.metadata.close();}
});
test('incomplete catalog retains stale snapshot and does not create or suppress missing objects',async()=>{
  const f=fixture([workspace('one')],[native('official','/work/one')]);
  try{await f.catalog.sync();f.setFail(true);f.workspaces.push(workspace('two'));await f.catalog.sync();assert.equal(f.calls.length,0);assert.equal(f.catalog.snapshot().state,'unavailable');assert.equal(f.catalog.snapshot().projects[0].id,'official');assert.ok(f.catalog.snapshot().updatedAt);f.setFail(false);await f.catalog.sync();assert.equal(await f.catalog.resolve('one'),'official');}finally{f.metadata.close();}
});
test('official deletion persists suppression until explicit retry and isolates native homes',async()=>{
  const f=fixture([workspace('one')],[native('official','/work/one')]);
  try{await f.catalog.sync();f.setRows([]);await f.catalog.sync();assert.equal(f.catalog.snapshot().workspaces[0].status,'removed');await f.catalog.sync();assert.equal(f.calls.length,0);await assert.rejects(f.catalog.resolve('one'),/移除/);
    const restored=new ProjectCatalog(f.runtime,{list:async()=>f.workspaces,resolve:async()=>f.workspaces[0]} as any,f.metadata,()=>{});await restored.sync();assert.equal(restored.snapshot().workspaces[0].status,'removed');await restored.retry('one');assert.equal(f.calls.length,1);
    f.setHome('/native/two');f.setRows([]);await f.catalog.sync();assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].idempotencyKey,f.calls[1].idempotencyKey);
  }finally{f.metadata.close();}
});
test('failed response reuses persistent idempotency key and recovered native result',async()=>{
  const f=fixture();let first=true;
  f.runtime.createProject=async(input:any)=>{f.calls.push(input);if(first){first=false;throw Error('response lost');}return native('created','/work/one');};
  try{await f.catalog.sync();assert.equal(f.catalog.snapshot().workspaces[0].status,'failed');await f.catalog.sync();assert.equal(f.calls.length,2);assert.equal(f.calls[0].idempotencyKey,f.calls[1].idempotencyKey);
    f.setRows([native('created','/work/one')]);await f.catalog.sync();assert.equal(await f.catalog.resolve('one'),'created');assert.equal(f.calls.length,2);
  }finally{f.metadata.close();}
});
test('ambiguous roots require an explicit matching identity; outside roots never become cwd',async()=>{
  const f=fixture([workspace('one')],[native('a','/work/one'),native('b','/work/one'),native('outside','/outside')]);
  try{await f.catalog.sync();assert.equal(f.calls.length,0);assert.equal(f.catalog.snapshot().workspaces[0].status,'ambiguous');await assert.rejects(f.catalog.resolve('one'),/多个/);assert.equal(await f.catalog.resolve('one','b'),'b');await assert.rejects(f.catalog.resolve('one','outside'),/目录/);await assert.rejects(f.catalog.resolve(undefined,'outside'),/目录/);}finally{f.metadata.close();}
});
test('changing native home with a failed list cannot expose another homes cached projects',async()=>{
  const f=fixture([workspace('one')],[native('official','/work/one')]);
  try{await f.catalog.sync();f.setHome('/native/other');f.setFail(true);await f.catalog.sync();assert.equal(f.catalog.snapshot().state,'unavailable');assert.deepEqual(f.catalog.snapshot().projects,[]);assert.equal(f.catalog.snapshot().updatedAt,null);}finally{f.metadata.close();}
});
test('a workspace discovered during registration is synchronized by the same shared job',async()=>{
  const f=fixture();const gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),create=f.runtime.createProject;
  f.runtime.createProject=async(input:any)=>{started.resolve();await gate.promise;return create(input);};
  try{const first=f.catalog.sync();await started.promise;f.workspaces.push(workspace('two'));const second=f.catalog.sync();gate.resolve();await Promise.all([first,second]);assert.equal(f.calls.length,2);assert.equal(f.catalog.snapshot().workspaces.length,2);}finally{f.metadata.close();}
});
test('native change notification during a catalog read refreshes after that shared read finishes',async()=>{
  const f=fixture([workspace('one')],[native('official','/work/one','Old')]),gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();let first=true;
  f.runtime.listProjects=async()=>{if(first){first=false;started.resolve();await gate.promise;return [native('official','/work/one','Old')];}return [native('official','/work/one','New')];};
  try{const initial=f.catalog.sync();await started.promise;const notified=f.catalog.refreshNative();gate.resolve();await Promise.all([initial,notified]);assert.equal(f.catalog.snapshot().projects[0].name,'New');assert.equal(f.calls.length,0);}finally{f.metadata.close();}
});
test('metadata mapping, suppression and idempotency persist across reopen without changing historical sessions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'project-sync-store-')),path=join(dir,'metadata.sqlite');let store=new MetadataStore(path);
  try{const history=store.save('historical','/historical','Old'),record=store.projectSync('/home','workspace');record.native_project_id='native';record.suppressed=true;store.saveProjectSync('/home','workspace',record);store.close();store=new MetadataStore(path);assert.deepEqual(store.projectSync('/home','workspace'),record);assert.deepEqual(store.get('historical'),history);assert.notEqual(store.projectSync('/other-home','workspace').idempotency_key,record.idempotency_key);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});
