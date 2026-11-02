import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../src/codex/extension-catalog.ts';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {visibleExtensionCount,visibleExtensionItems} from '../src/web/extensionsState.ts';
import {readExtensionSources} from '../src/codex/extensions.ts';

function peer(extra:Record<string,(params:any)=>any>={}){
 const calls:any[]=[];return {calls,home:process.cwd(),cli:async()=>{throw Error('Unexpected CLI');},request:async(method:string,params:any)=>{
  calls.push({method,params});if(extra[method])return extra[method](params);
  if(method==='config/read')return {config:{mcp_servers:{demo:{command:'demo'}}},layers:[{name:{type:'user',file:'fixture.toml'},config:{},version:'v1'}]};
  if(method==='configRequirements/read')return {requirements:null};
  if(method==='plugin/installed')return {marketplaces:[],marketplaceLoadErrors:[]};
  if(method==='skills/list')return {data:[]};
  throw Object.assign(Error('Method not found'),{code:-32601});
 }};
}
test('installed reads only local definitions and does not force ordinary skills reload',async()=>{
 const p=peer({'app/installed':()=>new Promise(()=>{}),'mcpServerStatus/list':()=>new Promise(()=>{})});
 const s=await catalog.readExtensionSection(p,process.cwd(),'installed');
 assert.deepEqual(p.calls.map(c=>c.method).sort(),['config/read','configRequirements/read','plugin/installed','skills/list'].sort());
 assert.equal(p.calls.find(c=>c.method==='skills/list').params.forceReload,false);
 assert.equal(s.items[0].kind,'mcp');assert.equal(s.items[0].catalog,undefined);
 assert.equal(s.sources.find(x=>x.id==='apps')?.status,'notLoaded');
});

test('MCP membership needs its own definition evidence, not configuration read by Apps',async()=>{
 const p=peer({'app/installed':()=>({apps:[]})});
 const apps=await catalog.readExtensionSection(p,process.cwd(),'apps');
 assert.equal(apps.sources.find(source=>source.id==='configuration')?.status,'ok');
 assert.equal(visibleExtensionCount(apps,'mcp'),null);
 const installed=await catalog.readExtensionSection(p,process.cwd(),'installed');
 assert.equal(installed.sources.find(source=>source.id==='mcp-definitions')?.status,'ok');
 assert.equal(visibleExtensionCount(installed,'mcp'),1);
 const mcp=await catalog.readExtensionSection(p,process.cwd(),'mcp');
 assert.equal(mcp.sources.find(source=>source.id==='mcp')?.status,'unsupported');
 assert.equal(mcp.sources.find(source=>source.id==='mcp-definitions')?.status,'ok');
 assert.equal(visibleExtensionCount(mcp,'mcp'),1);
});
test('Apps inventory survives missing metadata and never infers authorization from callable',async()=>{
 const p=peer({'app/installed':()=>({apps:[{id:'a',runtimeName:'Runtime',enabled:true,callable:true}]}),'app/read':()=>({apps:[],missingAppIds:['a']})});
 const s=await catalog.readExtensionSection(p,process.cwd(),'apps');
 assert.equal(s.items[0].name,'Runtime');assert.equal(s.items[0].installed,true);assert.equal(s.items[0].callable,true);assert.equal(s.items[0].connected,null);assert.equal(s.items[0].authorization,null);
 assert.equal(s.sources.find(x=>x.id==='apps-metadata')?.status,'partial');
});

test('structured App owner names survive normalization while remote logos remain unavailable',async()=>{
 const p=peer({'app/installed':()=>({apps:[{id:'a'},{id:'b'}]}),'app/read':()=>({apps:[{id:'a',name:'App',logoUrl:'https://cdn.example/logo.png',pluginDisplayNames:['Owner']},{id:'b',name:'Private logo',logoUrl:'https://cdn.example/logo?token=private'}],missingAppIds:[]})});
 const s=await catalog.readExtensionSection(p,process.cwd(),'apps');assert.equal(s.items[0].iconUrl,null);assert.deepEqual(s.items[0].ownerNames,['Owner']);assert.equal(s.items[1].iconUrl,null);assert.equal(JSON.stringify(s).includes('token='),false);
});
test('Apps batches are at most 100 with at most two in flight and retain failed batch inventory',async()=>{
 let active=0,max=0;const sizes:number[]=[];
 const p=peer({'app/installed':()=>({apps:Array.from({length:301},(_,i)=>({id:String(i),runtimeName:`App ${i}`,enabled:false,callable:false}))}),'app/read':async({appIds})=>{sizes.push(appIds.length);max=Math.max(max,++active);await new Promise(r=>setTimeout(r,5));active--;if(appIds[0]==='100')throw Object.assign(Error('HTTP 403 token=secret'),{status:403});return {apps:appIds.map((id:string)=>({id,name:id})),missingAppIds:[]};}});
 const s=await catalog.readExtensionSection(p,process.cwd(),'apps');assert.equal(s.items.length,301);assert.deepEqual(sizes,[100,100,100,1]);assert.equal(max,2);assert.equal(s.sources.find(x=>x.id==='apps-metadata')?.code,'UPSTREAM_FORBIDDEN');assert.equal(JSON.stringify(s).includes('secret'),false);
});
test('empty Apps does not read metadata; 403 does not fall back; method unsupported does',async()=>{
 const p=peer({'app/installed':()=>({apps:[]})});await catalog.readExtensionSection(p,process.cwd(),'apps');assert.equal(p.calls.some(x=>x.method==='app/read'),false);
 const denied=peer({'app/installed':()=>{throw Object.assign(Error('HTTP 403'),{status:403});}});await assert.rejects(()=>catalog.readExtensionSection(denied,process.cwd(),'apps'));assert.equal(denied.calls.some(x=>x.method==='app/list'),false);
 const old=peer({'app/list':({cursor})=>({data:cursor?[{id:'b',name:'B',isAccessible:false}]:[{id:'a',name:'A',isAccessible:true}],nextCursor:cursor?null:'next'})});const s=await catalog.readExtensionSection(old,process.cwd(),'apps');assert.equal(s.items.length,1);assert.equal(s.items[0].installed,null);assert.equal(old.calls.filter(x=>x.method==='app/list').length,2);
});
test('read errors expose only bounded safe categories',()=>{
 for(const [error,code]of [[Error('HTTP 403 <html>Cloudflare challenge cf-chl-token=secret</html>'),'UPSTREAM_CHALLENGE'],[Error('HTTP 403 forbidden'),'UPSTREAM_FORBIDDEN'],[Object.assign(Error('denied'),{status:401}),'UNAUTHENTICATED'],[Object.assign(Error('timeout'),{code:'ETIMEDOUT'}),'TIMEOUT'],[new SyntaxError('bad json'),'INVALID_RESPONSE'],[Object.assign(Error('no'),{code:-32601}),'UNSUPPORTED'],[Error('secret'),'UNAVAILABLE']] as const){const result=catalog.classifyExtensionReadError(error);assert.equal(result.code,code);assert.equal(JSON.stringify(result).includes('secret'),false);}
 assert.equal(catalog.classifyExtensionReadError(Error('x'.repeat(16384)+'HTTP 403 Cloudflare challenge')).code,'UNAVAILABLE');
});
test('explicit refresh reaches native flags and MCP basic/detail requests remain separate',async()=>{
 const p=peer({'app/installed':()=>({apps:[]}),'mcpServerStatus/list':()=>({data:[{name:'demo',runtimeStatus:'connected',tools:{lookup:{description:'Lookup'}},resources:[],resourceTemplates:[]}],nextCursor:null})});
 await catalog.readExtensionSection(p,process.cwd(),'installed',{refresh:true});await catalog.readExtensionSection(p,process.cwd(),'apps',{refresh:true});
 assert.equal(p.calls.find(c=>c.method==='skills/list').params.forceReload,true);assert.deepEqual(p.calls.find(c=>c.method==='app/installed').params,{forceRefresh:true});
 const basic=await catalog.readExtensionSection(p,process.cwd(),'mcp');const entry=basic.items.find(x=>x.kind==='mcp')!;assert.equal(entry.catalog,undefined);
 const detail=await catalog.readExtensionSection(p,process.cwd(),'mcp',{key:entry.key});assert.equal(detail.items.find(x=>x.kind==='mcp')!.catalog!.tools[0].name,'lookup');
 assert.deepEqual(p.calls.filter(c=>c.method==='mcpServerStatus/list').map(c=>c.params.detail),['toolsAndAuthOnly','full']);
});
test('MCP plugin-owned target key is freshly verified before targeted detail reads',async()=>{
 const p=peer({'mcpServerStatus/list':({serverName})=>({data:[{name:'owned',pluginId:'owner@local',runtimeStatus:'connected',tools:{lookup:{}},resources:[],resourceTemplates:[]}],nextCursor:null})});
 const basic=await catalog.readExtensionSection(p,process.cwd(),'mcp'),entry=basic.items.find(x=>x.id==='owned')!;
 const detail=await catalog.readExtensionSection(p,process.cwd(),'mcp',{key:entry.key});assert.equal(detail.items.find(x=>x.id==='owned')!.catalog!.tools.length,1);assert.equal(p.calls.at(-1).params.serverName,'owned');
});
test('actual native status 403 Cloudflare RPC text is classified without leaking challenge content',()=>{
 const error=Object.assign(Error('failed to list apps: Request failed with status 403 Forbidden: <html><script>window._cf_chl_opt={cType:"managed",token:"secret"}</script></html>'),{code:-32603});
 assert.deepEqual(catalog.classifyExtensionReadError(error),{code:'UPSTREAM_CHALLENGE',rpcCode:-32603,httpStatus:403});
 assert.deepEqual(catalog.classifyExtensionReadError(Error('Request failed with status 403 Forbidden: Access denied')),{code:'UPSTREAM_FORBIDDEN',httpStatus:403});
});
test('safe classified challenge survives cache and service classification boundaries',()=>{
 assert.deepEqual(catalog.classifyExtensionReadError({message:'Extension source unavailable',code:'UPSTREAM_CHALLENGE',rpcCode:-32603,httpStatus:403}),{code:'UPSTREAM_CHALLENGE',rpcCode:-32603,httpStatus:403});
 assert.deepEqual(catalog.classifyExtensionReadError({message:'secret',code:'attacker-token',rpcCode:'secret',httpStatus:'secret'}),{code:'UNAVAILABLE'});
});
test('malformed Apps metadata preserves inventory and reports invalid response',async()=>{
 const p=peer({'app/installed':()=>({apps:[{id:'a',runtimeName:'Runtime',enabled:true,callable:false}]}),'app/read':()=>({apps:[{id:'a',name:123}],missingAppIds:[]})});
 const result=await catalog.readExtensionSection(p,process.cwd(),'apps');assert.equal(result.items[0].name,'Runtime');assert.equal(result.items[0].installed,true);assert.equal(result.sources.find(x=>x.id==='apps-metadata')?.code,'INVALID_RESPONSE');
});
test('challenge scanning is bounded to 16 KiB of UTF-8 rather than code units',()=>{
 assert.deepEqual(catalog.classifyExtensionReadError(Error('界'.repeat(6000)+'HTTP 403 Cloudflare challenge token=secret')),{code:'UNAVAILABLE'});
});

test('native category provenance survives normalization without hiding raw runtime inventory',async()=>{
 const p=peer({'plugin/installed':()=>({marketplaces:[{name:'local',plugins:[{id:'wrapper@local',name:'Wrapper',installed:true,installPolicySource:'IMPLICIT_CANONICAL_APP'}]}],marketplaceLoadErrors:[]}),
  'config/read':()=>({config:{mcpServers:{defined:{command:'demo'}},marketplaces:{local:{source_type:'local',source:'/fixture'}}},layers:[{name:{type:'user',file:'fixture.toml'},config:{},version:'v1'}]}),
  'mcpServerStatus/list':()=>({data:[{name:'transport',pluginId:'wrapper@local'}],nextCursor:null})});
 const s=await catalog.readExtensionSection(p,process.cwd(),'mcp');
 assert.equal((s.items.find(item=>item.kind==='plugin') as any).installPolicySource,'IMPLICIT_CANONICAL_APP');
 assert.equal((s.items.find(item=>item.id==='defined') as any)?.configured,true);
 assert.equal((s.items.find(item=>item.id==='transport') as any)?.configured,false);
});

test('legacy Apps accessibility supplies callable membership without account inference',async()=>{
 const p=peer({'app/list':()=>({data:[{id:'a',name:'A',isAccessible:true}],nextCursor:null})});
 const s=await catalog.readExtensionSection(p,process.cwd(),'apps');
 assert.equal(s.items[0].callable,true);assert.equal(s.items[0].connected,null);assert.equal(s.items[0].installed,null);
});

test('recommended skill membership uses the native cache and keeps an unknown cache diagnostic',async t=>{
 const home=await mkdtemp(join(tmpdir(),'extension-recommendations-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const p=peer({'skills/list':()=>({data:[{skills:[{name:'guide',path:join(home,'skills','guide','SKILL.md'),scope:'user'}],errors:[]}]})});p.home=home;
 const unknown=await catalog.readExtensionSection(p,process.cwd(),'installed');assert.equal(unknown.items.find(item=>item.kind==='skill')?.recommended,null);assert.equal(unknown.sources.find(source=>source.id==='skill-recommendations')?.status,'partial');
 await mkdir(join(home,'vendor_imports'));await writeFile(join(home,'vendor_imports','skills-curated-cache.json'),JSON.stringify({fetchedAt:Date.now(),skills:[{id:'guide',name:'Guide'}]}));
 const known=await catalog.readExtensionSection(p,process.cwd(),'installed');assert.equal(known.items.find(item=>item.kind==='skill')?.recommended,true);assert.equal(known.sources.find(source=>source.id==='skill-recommendations')?.status,'ok');
});

test('marketplace membership follows merged configuration keys and retains implicit raw entries',async()=>{
 const p=peer({'config/read':()=>({config:{marketplaces:{configured:{source_type:'local',source:'/fixture'}}},layers:[{name:{type:'user',file:'fixture.toml'},config:{},version:'v1'}]})});
 (p as any).cli=async()=>({marketplaces:[{name:'implicit',root:'/native'}]});
 const s=await catalog.readExtensionSection(p,process.cwd(),'marketplaces');
 assert.equal(s.marketplaces.find(m=>m.name==='configured')?.configured,true);assert.equal(s.marketplaces.find(m=>m.name==='configured')?.writable,false);assert.equal(s.marketplaces.find(m=>m.name==='implicit')?.configured,false);
});

test('a successful retry clears earlier plugin and skill directory partial evidence',async()=>{
 let partial=true;const p=peer({'plugin/installed':()=>({marketplaces:[],marketplaceLoadErrors:partial?[{message:'Unavailable'}]:[]}),'skills/list':()=>({data:[{skills:[],errors:partial?[{message:'Unavailable'}]:[]}]})});
 const failed=await catalog.readExtensionSection(p,process.cwd(),'installed');assert.equal(failed.sources.find(source=>source.id==='plugin-directories')?.status,'partial');assert.equal(failed.sources.find(source=>source.id==='skill-directories')?.status,'partial');
 partial=false;const fresh=await catalog.readExtensionSection(p,process.cwd(),'installed');assert.equal(fresh.sources.find(source=>source.id==='plugin-directories')?.status,'ok');assert.equal(fresh.sources.find(source=>source.id==='skill-directories')?.status,'ok');
});

test('configured MCP definitions remain known when runtime status is unavailable',async()=>{
 const p=peer({'mcpServerStatus/list':()=>{throw Error('Runtime unavailable');}}),s=await catalog.readExtensionSection(p,process.cwd(),'mcp');
 assert.equal(s.items.find(item=>item.id==='demo')?.configured,true);assert.equal(s.items.find(item=>item.id==='demo')?.connection,null);assert.equal(visibleExtensionCount(s,'mcp'),1);
 const owned={...s.items.find(item=>item.id==='demo')!,owner:'package@local'};assert.equal(visibleExtensionItems([owned]).length,1);
});

test('an explicit MCP definition owns its configuration even when runtime metadata reports a plugin owner',async()=>{
 const p=peer({'config/read':()=>({config:{mcp_servers:{same:{command:'local',enabled:false}},plugins:{'wrapper@local':{mcp_servers:{same:{enabled:true}}}}},layers:[{name:{type:'user',file:'fixture.toml'},config:{},version:'v1'}]}),
  'plugin/installed':()=>({marketplaces:[{name:'local',plugins:[{id:'wrapper@local',installed:true}]}],marketplaceLoadErrors:[]}),
  'mcpServerStatus/list':()=>({data:[{name:'same',pluginId:'wrapper@local'}],nextCursor:null})});
 const s=await catalog.readExtensionSection(p,process.cwd(),'mcp'),entry=s.items.find(item=>item.kind==='mcp')!;
 assert.equal(entry.owner,null);assert.equal(entry.config?.command,'local');assert.equal(entry.enabled,false);assert.equal(visibleExtensionCount(s,'mcp'),1);
});

test('plugin source counts exclude Apps whose metadata finishes before the plugin response',async()=>{
 const gate=Promise.withResolvers<void>();
 const p=peer({'plugin/installed':async()=>{await gate.promise;return {marketplaces:[{name:'local',plugins:[{id:'demo@local',installed:true}]}],marketplaceLoadErrors:[]};},
  'app/installed':()=>({apps:[{id:'app',callable:true}]}),'app/read':()=>{setImmediate(()=>gate.resolve());return {apps:[{id:'app',name:'App'}],missingAppIds:[]};}});
 const {snapshot:s}=await readExtensionSources(p,process.cwd(),{sources:['configuration','plugins','apps']});assert.equal(s.sources.find(source=>source.id==='plugins')?.count,1);
});
