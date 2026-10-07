import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/codex/runtime.ts';
import {Projects} from '../src/projects.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';

const secret='PLUGIN_SOURCE_SECRET';
const plugin=(extra:any={})=>({id:'same-id',name:'same-name',installed:true,enabled:true,version:'remote-v9',interface:{displayName:'Same plugin',shortDescription:'Description',logoUrl:`https://host/icon?token=${secret}`},source:{type:'git',url:`https://user:${secret}@host/repo?token=${secret}`},...extra});
const market=(name:string,plugins:any[]=[],extra:any={})=>({name,path:null,plugins,...extra});
const response=(marketplaces:any[]=[],marketplaceLoadErrors:any[]=[])=>({marketplaces,marketplaceLoadErrors});

async function fixture(t:any,replies:any[]){
 const dir=await mkdtemp(join(tmpdir(),'installed-plugins-')),log=join(dir,'calls.jsonl'),peer=join(dir,'peer.mjs');
 await writeFile(peer,`import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const replies=${JSON.stringify(replies)};let next=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,params:m.params})+'\\n');
 const reply=m.method==='initialize'?{result:{userAgent:'fixture',codexHome:${JSON.stringify(dir)},platformFamily:'windows'}}:m.method==='plugin/installed'?replies[next++]:{error:{code:-32601,message:'Unexpected RPC'}};
 process.stdout.write(JSON.stringify({id:m.id,...reply})+'\\n');
});`);
 const runtime=new Runtime({executable:process.execPath,args:[peer],cwd:dir});
 t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
 return {dir,runtime,read:()=>runtime.installedPlugins(dir),calls:async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch(e:any){if(e.code==='ENOENT')return [];throw e;}}};
}

test('installed plugins distinguish marketplace identities and expose only safe local state',async t=>{
 const f=await fixture(t,[{result:response([
  market('market-a',[plugin({localVersion:'local-v1'}),plugin({installed:false,id:'suggestion'})]),
  market('market-b',[plugin({enabled:false,availability:'future-state',disabledReason:secret})]),
  market('market-a',[plugin({availability:'AVAILABLE',disabledReason:'plan_not_eligible'})],{path:`/private/${secret}/other-market`}),
  market(`https://user:${secret}@host/catalog?token=${secret}`,[plugin({id:'url-market'})])
 ])}]);
 assert.equal(typeof f.runtime.installedPlugins,'function','Runtime must provide the installed plugin read');
 const snapshot=await f.read();
 assert.equal(snapshot.supported,true);assert.equal(snapshot.partial,false);assert.equal(snapshot.errorCount,0);assert.ok(snapshot.updatedAt!>=Date.now()-5000);
 assert.equal(snapshot.items.length,4);assert.equal(new Set(snapshot.items.map(item=>item.key)).size,4);
 const [first,second,third,fourth]=snapshot.items;
 assert.deepEqual(Object.keys(first).sort(),['key','id','name','description','marketplace','localVersion','enabled','availability','reason'].sort());
 assert.equal(first.name,'Same plugin');assert.equal(first.description,'Description');assert.equal(first.marketplace,'market-a');assert.equal(first.localVersion,'local-v1');assert.equal(first.enabled,true);
 assert.equal(second.localVersion,null);assert.equal(second.enabled,false);assert.equal(second.availability,null);assert.equal(second.reason,null);
 assert.equal(third.availability,'AVAILABLE');assert.equal(third.reason,'plan_not_eligible');assert.equal(fourth.marketplace,null);
 assert.equal(JSON.stringify(snapshot).includes(secret),false);assert.equal(JSON.stringify(snapshot).includes('remote-v9'),false);
 assert.deepEqual((await f.calls()).map(call=>call.method),['initialize','plugin/installed']);
 assert.deepEqual((await f.calls())[1].params,{cwds:[f.dir]});
});

test('invalid Runtime cwd rejects before starting the native peer',async t=>{
 const f=await fixture(t,[]);await assert.rejects(()=>f.runtime.installedPlugins(''),{statusCode:400});assert.deepEqual(await f.calls(),[]);
});

test('unsupported and successful empty reads are different snapshots',async t=>{
 const unsupported=await fixture(t,[{error:{code:-32601,message:secret,data:{credential:secret}}}]);
 assert.deepEqual(await unsupported.read(),{supported:false,items:[],partial:false,errorCount:0,updatedAt:null});
 const empty=await fixture(t,[{result:response()}]);const read=await empty.runtime.installedPlugins();
 assert.equal(read.supported,true);assert.equal(read.items.length,0);assert.equal(read.partial,false);assert.equal(typeof read.updatedAt,'number');
 assert.deepEqual((await empty.calls())[1],{method:'plugin/installed',params:{}});
});

test('partial market failures preserve installed items without leaking native failures',async t=>{
 const f=await fixture(t,[{result:response([market('good',[plugin()])],[{marketplacePath:`/private/${secret}`,message:secret}])}]);
 const snapshot=await f.read();assert.equal(snapshot.items.length,1);assert.equal(snapshot.partial,true);assert.equal(snapshot.errorCount,1);assert.equal(snapshot.supported,true);
 assert.equal(JSON.stringify(snapshot).includes(secret),false);
});

test('all-market failure and transport errors stay sanitized read failures rather than empty',async t=>{
 for(const reply of [{result:response([],[{message:secret}])},{error:{code:-32000,message:secret,data:{credential:secret}}},{result:{marketplaces:[]}}]){
  const f=await fixture(t,[reply]);await assert.rejects(f.read(),(e:any)=>e.statusCode===503&&e.code==='PLUGINS_READ_FAILED'&&!JSON.stringify(e).includes(secret)&&!e.message.includes(secret));
  assert.deepEqual((await f.calls()).map(call=>call.method),['initialize','plugin/installed']);
 }
});

test('plugin keys survive reorder and missing optional fields remain unknown',async t=>{
 const a=market('a',[plugin({enabled:undefined,interface:null})]),b=market('b',[plugin()]);
 const f=await fixture(t,[{result:response([a,b])},{result:response([b,a])}]);
 const first=await f.read(),second=await f.read();assert.equal(first.items[0].key,second.items[1].key);assert.equal(first.items[1].key,second.items[0].key);
 assert.equal(first.items[0].enabled,null);assert.equal(first.items[0].description,null);assert.equal(first.items[0].availability,null);assert.equal(first.items[0].reason,null);
});

test('plugin API authenticates before native work and resolves only selected project IDs',async t=>{
 const f=await fixture(t,[{result:response()},{error:{code:-32000,message:secret}}]);
 const apiDir=await mkdtemp(join(tmpdir(),'plugins-api-')),root=join(apiDir,'work');await mkdir(join(root,'project'),{recursive:true});const projects=new Projects(root),[project]=await projects.list();
 const dataDir=join(apiDir,'data');await initializeAuth(dataDir,'plugins-test-password');
 const app=await buildServer({dataDir,origin:'http://localhost:3000',runtime:f.runtime,projects});t.after(async()=>{await app.close();await rm(apiDir,{recursive:true,force:true});});
 assert.equal((await app.inject({url:'/api/codex/plugins',headers:{host:'localhost:3000'}})).statusCode,401);assert.deepEqual(await f.calls(),[]);
 const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
 const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'plugins-test-password'}});headers.cookie+='; '+String(login.headers['set-cookie']).split(';')[0];
 for(const query of ['cwd=/private','projectId=../../escape','projectId=aaaaaaaaaaaaaaaaaaaaaaaa'])assert.ok((await app.inject({url:'/api/codex/plugins?'+query,headers})).statusCode>=400);
 assert.deepEqual(await f.calls(),[]);
 const read=await app.inject({url:'/api/codex/plugins?projectId='+project.id,headers});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().supported,true);
 assert.deepEqual((await f.calls())[1],{method:'plugin/installed',params:{cwds:[project.path]}});
 const failure=await app.inject({url:'/api/codex/plugins',headers});assert.equal(failure.statusCode,503,failure.body);assert.equal(failure.json().code,'PLUGINS_READ_FAILED');assert.equal(failure.body.includes(secret),false);
 assert.deepEqual((await f.calls()).map(call=>call.method),['initialize','plugin/installed','plugin/installed']);
 assert.equal((await app.inject({method:'POST',url:'/api/codex/plugins',headers,payload:{}})).statusCode,404);
});
