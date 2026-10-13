import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {registerApi} from '../src/server/api.ts';
import {Projects} from '../src/projects.ts';
import {Runtime} from '../src/codex/runtime.ts';

test('recent dialogue ordering ignores internal update time and versions native pagination',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'recency-api-')),runtime=new Runtime({executable:process.execPath,cwd:dir});
  const rows=[{id:'viewed',createdAt:10,updatedAt:999,recencyAt:100},{id:'dialogue',createdAt:20,updatedAt:200,recencyAt:200},{id:'legacy',createdAt:50,updatedAt:9999,recencyAt:null}];
  t.mock.method(runtime,'list',async()=>({data:rows,nextCursor:'native-next'}));t.mock.method(runtime,'close',async()=>{});t.mock.method(runtime,'configurationHome',async()=>null);
  const app=Fastify();registerApi(app,{dataDir:dir,runtime,projects:{root:dir,list:async()=>[]} as any,authenticated:()=>()=>true});
  try{
    const first=await app.inject('/api/sessions');assert.deepEqual(first.json().data.map((row:any)=>row.id),['dialogue','viewed','legacy']);assert.match(first.json().nextCursor,/^web2:/);
    rows[0].updatedAt=99999;const viewed=await app.inject('/api/sessions?refresh=true');assert.deepEqual(viewed.json().data.map((row:any)=>row.id),['dialogue','viewed','legacy']);
    rows[0].recencyAt=300;assert.equal((await app.inject('/api/sessions?refresh=true')).json().data[0].id,'viewed');
    assert.deepEqual((await app.inject('/api/sessions?sortKey=created_at')).json().data.map((row:any)=>row.id),['legacy','dialogue','viewed']);
    const old=first.json().nextCursor.replace(/^web2:/,'web1:');const rejected=await app.inject('/api/sessions?cursor='+encodeURIComponent(old));assert.equal(rejected.statusCode,400);assert.equal(rejected.json().code,'SESSION_CURSOR_INVALID');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('project reads and refresh expose the same known Desktop root; session lists preserve native grouping evidence',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'project-group-api-')),root=join(dir,'work');await mkdir(root);
  const runtime=new Runtime({executable:process.execPath,cwd:root}),thread={id:'desktop-task',cwd:join(homedir(),'Documents','Codex','2026-10-07','task'),originator:'Codex Desktop',projectId:null,gitInfo:null};
  let listCalls=0;t.mock.method(runtime,'list',async()=>{listCalls++;return {data:[thread],nextCursor:null};});t.mock.method(runtime,'close',async()=>{});
  t.mock.method(runtime,'configurationHome',async()=>null);
  t.mock.method(runtime,'threadHeaderRead',async()=>{throw Error('Grouping must not read native thread headers');});
  const projects=new Projects(root);t.mock.method(projects,'list',async()=>[]);t.mock.method(projects,'refresh',async()=>[]);
  const app=Fastify();registerApi(app,{dataDir:dir,runtime,projects,authenticated:()=>()=>true});
  try{
    const expected=process.platform==='win32'?join(homedir(),'Documents','Codex'):null;
    for(const [method,url] of [['GET','/api/projects'],['POST','/api/projects/refresh']] as const){const response=await app.inject({method,url,...(method==='POST'?{payload:{}}:{})});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().desktopProjectlessRoot,expected);assert.equal(response.json().workRoot,root);}
    const response=await app.inject({url:'/api/sessions'});assert.equal(response.statusCode,200);
    assert.deepEqual(response.json().data,[{...thread,metadata:null}]);
    assert.equal((await app.inject({url:'/api/sessions'})).statusCode,200);assert.equal(listCalls,1);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
