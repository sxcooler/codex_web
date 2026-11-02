import test from 'node:test';
import assert from 'node:assert/strict';
import {ExtensionService} from '../src/codex/extension-service.ts';
import {join} from 'node:path';
function fixture(){
 let version='v1',account=0;const calls:string[]=[];
 const config={plugins:{},apps:{},mcp_servers:{demo:{command:'demo'}}};
 const peer={home:join(import.meta.dirname,'fixtures','extension-home'),cli:async()=>({marketplaces:[]}),request:async(method:string,params:any):Promise<any>=>{
  calls.push(method);
  if(method==='config/read')return {config,layers:[{name:{type:'user',file:join(process.cwd(),'fixture.toml'),profile:null},config,version}],origins:{}};
  if(method==='configRequirements/read')return {requirements:null};
  if(method==='plugin/installed')return {marketplaces:[],marketplaceLoadErrors:[]};
  if(method==='skills/list')return {data:[{skills:[],errors:[]}]};
  if(method==='app/installed')return {apps:[{id:'A'+account,runtimeName:'Runtime A',enabled:true,callable:false}]};
  if(method==='app/read')return {apps:params.appIds.map((id:string)=>({id,name:id})),missingAppIds:[]};
  if(method==='mcpServerStatus/list')return {data:[{name:'demo',runtimeStatus:'connected',authStatus:'notLoggedIn'}],nextCursor:null};
  if(method==='plugin/search')return {data:[{marketplaceName:'local',marketplacePath:'/fixture',plugin:{id:'demo@local',name:'Demo',installed:false,enabled:false,installPolicy:'AVAILABLE',authPolicy:'ON_USE',remotePluginId:null}}],nextCursor:null};
  throw Object.assign(Error('unsupported'),{code:-32601});
 }};
 const service=new ExtensionService({peer:async()=>peer,epoch:()=> 'epoch',normalize:p=>p});
 return {service,peer,calls,version:()=>version='v2',account:()=>{account++;service.invalidate('account/updated');}};
}
test('section reads cache independently and config changes cannot loop on old Apps versions',async()=>{
 const f=fixture(),first=await f.service.read(process.cwd(),{section:'installed'});assert.equal(first.section,'installed');
 await f.service.read(process.cwd(),{section:'installed'});assert.equal(f.calls.filter(m=>m==='skills/list').length,1);
 const apps=await f.service.read(process.cwd(),{section:'apps'});assert.equal(apps.items[0].id,'A0');assert.equal(f.calls.includes('app/list'),false);
 f.version();const fresh=await f.service.read(process.cwd(),{section:'installed',refresh:true});assert.notEqual(first.contextKey,fresh.contextKey);
 const next=await f.service.read(process.cwd(),{section:'apps'});assert.equal(next.userVersion,'v2');assert.equal(next.contextKey,fresh.contextKey);
 f.account();const other=await f.service.read(process.cwd(),{section:'apps'});assert.equal(other.items[0].id,'A1');assert.notEqual(next.contextKey,other.contextKey);
});
test('safe source errors preserve cached inventory and never expose challenge HTML',async()=>{
 const f=fixture();await f.service.read(process.cwd(),{section:'apps'});
 const original=f.peer.request;f.peer.request=async(method,params)=>{if(method==='app/installed')throw Object.assign(Error('HTTP 403 Cloudflare challenge <script>token=private</script>'),{httpStatus:403});return original(method,params);};
 const result=await f.service.read(process.cwd(),{section:'apps',refresh:true});assert.equal(result.cache.stale,true);assert.equal(result.items[0].id,'A0');assert.ok(result.sources.some(s=>s.code==='UPSTREAM_CHALLENGE'));assert.equal(JSON.stringify(result).includes('private'),false);
});
test('search registration rejects missing targets before any mutation',async()=>{
 const f=fixture(),page=await f.service.search(process.cwd(),{query:'Demo'});assert.equal(page.items.length,1);assert.ok(page.contextKey);
 await assert.rejects(f.service.change(process.cwd(),{action:'plugin.install',key:'0'.repeat(64),expectedVersion:'v1'}),{code:'EXTENSION_STALE'});
});

test('search detects a multi-page cursor cycle and keeps unsupported errors structured',async()=>{
 const f=fixture(),request=f.peer.request;f.peer.request=async(method,params)=>{const value=await request(method,params);if(method==='plugin/search')return {...value,nextCursor:params.cursor===null?'A':params.cursor==='A'?'B':'A'};return value;};
 assert.equal((await f.service.search(process.cwd(),{query:'Demo'})).nextCursor,'A');
 assert.equal((await f.service.search(process.cwd(),{query:'Demo',cursor:'A'})).nextCursor,'B');
 const third=await f.service.search(process.cwd(),{query:'Demo',cursor:'B'});assert.equal(third.source.code,'CATALOG_LIMIT');assert.equal(third.source.status,'error');
 f.service.invalidate();f.peer.request=async(method,params)=>{if(method==='plugin/search')throw Object.assign(Error('Method not found'),{code:-32601});return request(method,params);};
 assert.equal((await f.service.search(process.cwd(),{query:'missing'})).source.status,'unsupported');
});

test('a late old configuration cannot leave a cached envelope in a recovery loop',async()=>{
 const f=fixture(),request=f.peer.request;let release!:()=>void,entered!:()=>void,held=true;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 f.peer.request=async(method,params)=>{if(method==='app/read'&&held){held=false;entered();await gate;}return request(method,params);};
 const apps=f.service.read(process.cwd(),{section:'apps'});await started;
 f.version();const installed=await f.service.read(process.cwd(),{section:'installed',refresh:true});release();
 const result=await apps;assert.equal(result.userVersion,'v2');assert.equal(result.contextKey,installed.contextKey);
});

test('unsupported App metadata cannot disable a working installed inventory on refresh',async()=>{
 const f=fixture(),request=f.peer.request;f.peer.request=async(method,params)=>{if(method==='app/read'){f.calls.push(method);throw Object.assign(Error('Method not found'),{code:-32601});}if(method==='app/list'){f.calls.push(method);return {data:[],nextCursor:null};}return request(method,params);};
 const first=await f.service.read(process.cwd(),{section:'apps'}),second=await f.service.read(process.cwd(),{section:'apps',refresh:true});
 assert.equal(first.items[0]?.id,'A0');assert.equal(second.items[0]?.id,'A0');assert.equal(second.items[0]?.installed,true);
 assert.equal(f.calls.filter(m=>m==='app/installed').length,2);assert.equal(f.calls.includes('app/list'),false);assert.equal(f.calls.filter(m=>m==='app/read').length,1);
});

test('first configuration confirmation fences other reads already holding an old version',async()=>{
 const f=fixture(),request=f.peer.request;let configs=0,releaseConfig!:()=>void,releaseMetadata!:()=>void,configEntered!:()=>void,metadataEntered!:()=>void;
 const configGate=new Promise<void>(r=>releaseConfig=r),metadataGate=new Promise<void>(r=>releaseMetadata=r),configStarted=new Promise<void>(r=>configEntered=r),metadataStarted=new Promise<void>(r=>metadataEntered=r);
 f.peer.request=async(method,params)=>{if(method==='config/read'&&++configs===1){configEntered();await configGate;}if(method==='app/read'){metadataEntered();await metadataGate;}return request(method,params);};
 const installed=f.service.read(process.cwd(),{section:'installed'});await configStarted;const apps=f.service.read(process.cwd(),{section:'apps'});await metadataStarted;
 f.version();releaseConfig();const confirmed=await installed;releaseMetadata();const late=await apps;
 assert.equal(confirmed.userVersion,'v2');assert.equal(late.userVersion,'v2');assert.equal(late.contextKey,confirmed.contextKey);
});

test('search targets with the same CLI id on different pages cannot be installed',async()=>{
 const f=fixture(),request=f.peer.request;let writes=0;
 f.peer.request=async(method,params)=>{if(method==='plugin/search')return {data:[{marketplaceName:'local',marketplacePath:params.cursor?'/second':'/first',plugin:{id:'demo@local',name:'Demo',availability:'AVAILABLE',installPolicy:'AVAILABLE',remotePluginId:null}}],nextCursor:params.cursor?null:'more'};return request(method,params);};
 f.peer.cli=async()=>{writes++;return {pluginId:'demo@local'} as any;};
 await f.service.read(process.cwd(),{section:'installed'});const first=await f.service.search(process.cwd(),{query:'Demo'}),second=await f.service.search(process.cwd(),{query:'Demo',cursor:'more'});
 assert.notEqual(first.items[0].key,second.items[0].key);
 for(const item of [first.items[0],second.items[0]])await assert.rejects(f.service.change(process.cwd(),{action:'plugin.install',key:item.key,expectedVersion:'v1'}),{code:'EXTENSION_STALE'});
 assert.equal(writes,0);
});

test('uncertain writes remain locked across cached reads until every related section is freshly reconciled',async()=>{
 const f=fixture(),request=f.peer.request;let writes=0;
 await f.service.read(process.cwd(),{section:'installed'});
 f.peer.request=async(method,params)=>{if(method==='config/batchWrite'){writes++;throw Error('Transport disconnected');}return request(method,params);};
 const mutation={action:'mcp.save' as const,name:'new-demo',config:{command:'demo'},expectedVersion:'v1'};
 await assert.rejects(f.service.change(process.cwd(),mutation),{code:'EXTENSION_WRITE_UNKNOWN'});
 const retained=await f.service.read(process.cwd(),{section:'installed'});assert.deepEqual(retained.writePendingSections,['installed','mcp']);
 await assert.rejects(f.service.change(process.cwd(),mutation),{code:'EXTENSION_WRITE_UNKNOWN'});assert.equal(writes,1);
 const checked=await f.service.read(process.cwd(),{section:'installed',refresh:true});assert.deepEqual(checked.writePendingSections,['mcp']);
 await f.service.read(process.cwd(),{section:'mcp'});await assert.rejects(f.service.change(process.cwd(),mutation),{code:'EXTENSION_WRITE_UNKNOWN'});assert.equal(writes,1);
 const reconciled=await f.service.read(process.cwd(),{section:'mcp',refresh:true});assert.deepEqual(reconciled.writePendingSections,[]);
 await assert.rejects(f.service.change(process.cwd(),mutation),{code:'EXTENSION_WRITE_UNKNOWN'});assert.equal(writes,2);
});

test('unknown-write reconciliation cannot combine sections from different configuration generations',async()=>{
 const f=fixture(),request=f.peer.request;await f.service.read(process.cwd(),{section:'installed'});
 f.peer.request=async(method,params)=>{if(method==='config/batchWrite')throw Error('Transport disconnected');return request(method,params);};
 await assert.rejects(f.service.change(process.cwd(),{action:'mcp.save',name:'new-demo',config:{command:'demo'},expectedVersion:'v1'}),{code:'EXTENSION_WRITE_UNKNOWN'});
 await f.service.read(process.cwd(),{section:'installed',refresh:true});f.version();
 assert.deepEqual((await f.service.read(process.cwd(),{section:'mcp',refresh:true})).writePendingSections,['installed']);
 assert.deepEqual((await f.service.read(process.cwd(),{section:'installed'})).writePendingSections,['installed']);
 assert.deepEqual((await f.service.read(process.cwd(),{section:'installed',refresh:true})).writePendingSections,[]);
});

test('missing recommendation metadata keeps skill membership unknown without blocking native write reconciliation',async()=>{
 const f=fixture(),request=f.peer.request;f.peer.home=join(process.cwd(),'.local','absent-recommendation-home');
 await f.service.read(process.cwd(),{section:'installed'});
 f.peer.request=async(method,params)=>{if(method==='config/batchWrite')throw Error('Transport disconnected');return request(method,params);};
 await assert.rejects(f.service.change(process.cwd(),{action:'mcp.save',name:'new-demo',config:{command:'demo'},expectedVersion:'v1'}),{code:'EXTENSION_WRITE_UNKNOWN'});
 const installed=await f.service.read(process.cwd(),{section:'installed',refresh:true});
 assert.equal(installed.sources.find(source=>source.id==='skill-recommendations')?.status,'partial');assert.deepEqual(installed.writePendingSections,['mcp']);
 assert.deepEqual((await f.service.read(process.cwd(),{section:'mcp',refresh:true})).writePendingSections,[]);
});

test('search evidence permits more than 64 ordinary pages but has a global identity budget',async()=>{
 const f=fixture();f.peer.request=async(_method,params)=>{const index=Number(params.cursor??0),large=params.searchTerm==='large',count=large?1000:50;return {data:Array.from({length:count},(_,i)=>({marketplaceName:'local',marketplacePath:null,plugin:{id:`demo${index*count+i}@local`,name:'Demo',availability:'AVAILABLE',installPolicy:'AVAILABLE',remotePluginId:null}})),nextCursor:!large&&index===195?null:String(index+1)};};
 let cursor:string|undefined;for(let i=0;i<196;i++){const page=await f.service.search(process.cwd(),{query:'normal',cursor});assert.equal(page.source.status,'ok');cursor=page.nextCursor??undefined;}assert.equal(cursor,undefined);
 cursor=undefined;for(let i=0;i<64;i++){const page=await f.service.search(process.cwd(),{query:'large',cursor});assert.equal(page.source.status,'ok');cursor=page.nextCursor!;}
 assert.equal((await f.service.search(process.cwd(),{query:'large',cursor})).source.code,'CATALOG_LIMIT');
});

test('expired search evidence never silently accepts an old continuation cursor',async t=>{
 const f=fixture(),request=f.peer.request;let now=Date.now();t.mock.method(Date,'now',()=>now);
 f.peer.request=async(method,params)=>{const result=await request(method,params);return method==='plugin/search'?{...result,nextCursor:'more'}:result;};
 await f.service.search(process.cwd(),{query:'Demo'});now+=900_001;
 assert.equal((await f.service.search(process.cwd(),{query:'Demo',cursor:'more'})).source.code,'CATALOG_LIMIT');
});

test('a late mutation snapshot cannot roll back a newer confirmed configuration or replay its write',async()=>{
 let version='v1',config:any={},configReads=0,hold=false,writes=0;
 const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>(),file=join(process.cwd(),'fixture.toml');
 const peer={home:join(import.meta.dirname,'fixtures','extension-home'),cli:async()=>{},request:async(method:string,params:any):Promise<any>=>{
  if(method==='config/read'){if(++configReads===4)hold=true;return {config:structuredClone(config),layers:[{name:{type:'user',file,profile:null},config:structuredClone(config),version}]};}
  if(method==='configRequirements/read'){if(hold){hold=false;entered.resolve();await gate.promise;}return {requirements:null};}
  if(method==='config/batchWrite'){writes++;config={mcp_servers:{demo:params.edits[0].value}};version='v2';return {status:'ok',filePath:file,version};}
  if(method==='plugin/installed')return {marketplaces:[],marketplaceLoadErrors:[]};
  if(method==='skills/list')return {data:[]};
  if(method==='mcpServerStatus/list')return {data:[{name:'demo',runtimeStatus:'connected'}],nextCursor:null};
  throw Error('Unexpected native read '+method);
 }};
 const service=new ExtensionService({peer:async()=>peer,epoch:()=> 'epoch',normalize:p=>p});
 await service.read(process.cwd(),{section:'installed'});
 const changing=service.change(process.cwd(),{action:'mcp.save',name:'demo',expectedVersion:'v1',config:{command:'demo'}});await entered.promise;
 version='v3';const confirmed=await service.read(process.cwd(),{section:'installed',refresh:true});gate.resolve();
 await assert.rejects(changing,{code:'EXTENSION_WRITE_UNKNOWN'});assert.equal(writes,1);
 const retained=await service.read(process.cwd(),{section:'installed'});assert.equal(retained.userVersion,'v3');assert.equal(retained.contextKey,confirmed.contextKey);assert.deepEqual(retained.writePendingSections,['installed','mcp']);
 const checked=await service.read(process.cwd(),{section:'installed',refresh:true});assert.equal(checked.userVersion,'v3');assert.deepEqual(checked.writePendingSections,['mcp']);
 assert.deepEqual((await service.read(process.cwd(),{section:'mcp',refresh:true})).writePendingSections,[]);assert.equal(writes,1);
});
