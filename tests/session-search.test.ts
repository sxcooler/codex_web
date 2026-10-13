import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Runtime} from '../src/codex/runtime.ts';
import {registerApi} from '../src/server/api.ts';
import {MetadataStore} from '../src/server/metadata.ts';

test('session title search reaches native list, binds cursors and filters fork supplements',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'session-search-')),runtime=new Runtime({executable:process.execPath,cwd:dir}),calls:any[]=[];
  t.mock.method(runtime,'close',async()=>{});
  t.mock.method(runtime,'configurationHome',async()=>null);
  t.mock.method(runtime as any,'call',async(method:string,input:any)=>{assert.equal(method,'thread/list');calls.push(input);return {data:[{id:'native',name:'Needle native'}],nextCursor:input.cursor?null:'next'};});
  t.mock.method(runtime,'forkListHeader',async id=>({thread:{id,name:id==='matching'?'NEEDLE fork':'different',cwd:dir},archived:false}));
  const store=new MetadataStore(join(dir,'metadata.sqlite'));for(const id of ['matching','different'])store.registerFork({id,cwd:dir,forkedFromId:'source'});store.close();
  const app=Fastify();registerApi(app,{dataDir:dir,runtime,projects:{root:dir,list:async()=>[]} as any,authenticated:()=>()=>true});
  try{
    const first=await app.inject('/api/sessions?searchTerm=%20Needle%20');assert.equal(first.statusCode,200,first.body);
    assert.equal(calls[0].searchTerm,'Needle');assert.deepEqual(first.json().data.map((x:any)=>x.id).sort(),['matching','native']);
    const cursor=encodeURIComponent(first.json().nextCursor);
    assert.equal((await app.inject('/api/sessions?searchTerm=other&cursor='+cursor)).statusCode,400);
    assert.equal((await app.inject('/api/sessions?searchTerm=Needle&cursor='+cursor)).statusCode,200);assert.equal(calls.at(-1).cursor,'next');
    assert.equal((await app.inject('/api/sessions?searchTerm='+ 'x'.repeat(201))).statusCode,400);
    const old='web1:'+Buffer.from(JSON.stringify({native:'old-next',forkBefore:1,sortKey:'updated_at',archived:false,includeHidden:false})).toString('base64url');
    assert.equal((await app.inject('/api/sessions?cursor='+encodeURIComponent(old))).statusCode,400);
    assert.equal((await app.inject('/api/sessions?searchTerm=Needle&cursor='+encodeURIComponent(old))).statusCode,400);
    assert.equal((await app.inject('/api/projects')).json().workRoot,dir);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
