import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {readExtensions as readInstalled,readExtensionSources,extensionKey,changeExtension,runExtensionCli} from '../src/codex/extensions.ts';

import {readExtensionSection,searchExtensions} from '../src/codex/extension-catalog.ts';
async function readExtensions(peer:any,cwd:string){const s=(await readExtensionSources(peer,cwd,{sources:['configuration','plugins','skills','apps','mcp','marketplaces']})).snapshot;s.available=(await searchExtensions(peer,cwd,{query:'next'})).items;return s;}
const searchOptions=(key:string)=>({contextKey:'fixture',searchTarget:{contextKey:'fixture',query:'next',key}});
function fixture(){
 let config:any={marketplaces:{local:{source_type:'local',source:'/fixture/market'}},mcp_servers:{demo:{command:'demo',args:[],env:{TOKEN:'secret'},enabled:true}},plugins:{'demo@local':{enabled:true}},apps:{app:{enabled:true}}},version='v1';
 const calls:any[]=[],cli:any[]=[];let managed=false,managedPlugin=false,unknown=false,pluginServer=false;
 const request=async(method:string,params:any):Promise<any>=>{
  calls.push({method,params});
  if(method==='config/read')return {config,origins:managed?{mcp_servers:{name:{type:'enterpriseManaged'}}}:managedPlugin?{plugins:{name:{type:'enterpriseManaged'}}}:{},layers:[{name:{type:'user',file:join(process.cwd(),'fixture.toml'),profile:null},config,version}]};
  if(method==='configRequirements/read')return {requirements:null};
  if(method==='plugin/installed')return {marketplaces:[{name:'local',plugins:[{id:'demo@local',name:'demo',installed:true,enabled:config.plugins['demo@local'].enabled,source:{type:'local'},localVersion:'1'}]}],marketplaceLoadErrors:[]};
  if(method==='skills/list')return {data:[{cwd:process.cwd(),skills:[{name:'guide',description:'Guide',path:join(process.cwd(),'.agents/skills/guide/SKILL.md'),scope:'repo',enabled:true,pluginId:null}],errors:[]}]};
  if(method==='app/installed')return {apps:[{id:'app',runtimeName:'App',enabled:config.apps.app.enabled,callable:false}]};
  if(method==='app/read')return {apps:[{id:'app',name:'App',description:null,pluginDisplayNames:[],installUrl:'https://chatgpt.com/apps/app'}],missingAppIds:[]};
  if(method==='plugin/search')return {data:[{plugin:{id:'next@local',name:'next',installed:false,enabled:false,remotePluginId:null,installPolicy:'AVAILABLE',availability:'AVAILABLE'},marketplaceName:'local',marketplacePath:null}],nextCursor:null};
  if(method==='app/list')return {data:[{id:'app',name:'App',isEnabled:config.apps.app.enabled,isAccessible:false,installUrl:'https://chatgpt.com/apps/app'}],nextCursor:null};
  if(method==='mcpServerStatus/list')return {data:[{name:'demo',runtimeStatus:'failed',authStatus:'notLoggedIn',pluginId:pluginServer?'demo@local':null,tools:{},resources:[],resourceTemplates:[]}],nextCursor:null};
  if(method==='config/batchWrite'){
   if(unknown)throw Error('secret');
   for(const edit of params.edits){const parts=edit.keyPath.match(/"(?:[^"\\]|\\.)*"|[^.]+/g)!.map((p:string)=>p.startsWith('"')?JSON.parse(p):p);let target=config;for(const key of parts.slice(0,-1))target=target[key]??={};const last=parts.at(-1)!;target[last]=edit.mergeStrategy==='upsert'?{...target[last],...edit.value}:edit.value;}
   version='v2';return {status:'ok',filePath:params.filePath,version};
  }
  throw Object.assign(Error('unsupported'),{code:-32601});
 };
 const peer={request,home:process.cwd(),cli:async(args:string[])=>{cli.push(args);if(args.includes('--available'))return {installed:[],available:[{pluginId:'next@local',name:'next',marketplaceName:'local',installed:false,enabled:false,source:{source:'local',path:'/fixture/plugin'},marketplaceSource:{sourceType:'local',source:'/fixture/market'},installPolicy:'AVAILABLE',authPolicy:'ON_USE'}]};return {marketplaces:[{name:'local',root:'/fixture/market',marketplaceSource:{sourceType:'local',source:'/fixture/market'}}]};}};
 return {peer,calls,cli,setManaged:()=>managed=true,setManagedPlugin:()=>managedPlugin=true,setUnknown:()=>unknown=true,setHttp:()=>config.mcp_servers.demo={url:'https://host/private/mcp?x=secret',http_headers:{Authorization:'secret'},startup_timeout_sec:30},setPluginServer:()=>{pluginServer=true;delete config.mcp_servers.demo;config.plugins['demo@local'].mcp_servers={demo:{enabled:true,default_tools_approval_mode:'prompt'}};}};
}
test('extensions bounded snapshot separates state, partial sources and redacts secrets',async()=>{
 const f=fixture(),s=await readExtensions(f.peer,process.cwd());
 assert.equal(s.userVersion,'v1');assert.equal(s.items.filter(x=>x.kind==='plugin').length,1);
 assert.equal(s.items.find(x=>x.kind==='app')?.connected,null);
 assert.equal(s.items.find(x=>x.kind==='mcp')?.connection,'failed');
 assert.equal(s.available[0]?.id,'next@local');assert.equal(s.available[0]?.writable,true);assert.equal(s.marketplaces[0]?.writable,true);
 assert.equal(JSON.stringify(s).includes('secret'),false);
 assert.deepEqual(f.cli,[['plugin','marketplace','list','--json']]);
 const local=await readInstalled(f.peer,process.cwd());assert.equal(local.items.some(x=>x.kind==='app'),false);assert.equal(local.available.length,0);
 assert.equal(f.calls.some(x=>['plugin/list','plugin/read'].includes(x.method)),false);
});
test('MCP metadata exposes bounded native names and descriptions without resource URI secrets',async()=>{
 const f=fixture(),request=f.peer.request;f.peer.request=async(method,params)=>{const result=await request(method,params);if(method==='mcpServerStatus/list')Object.assign(result.data[0],{tools:{lookup:{name:'lookup',description:'Find docs'}},resources:[{name:'Guide',description:'Read guide',uri:'https://host?token=secret'}],resourceTemplates:[{name:'Files',description:'Find files',uriTemplate:'https://host/{secret}'}],toolsError:'diagnostic with secret'});return result;};
 const entry=(await readExtensionSection(f.peer,process.cwd(),'mcp',{key:extensionKey('mcp','demo')})).items.find(x=>x.kind==='mcp')!;assert.deepEqual(entry.catalog?.resources,[{name:'Guide',description:'Read guide'}]);assert.equal(entry.catalog?.tools[0].name,'lookup');assert.equal(entry.catalog?.toolsError,true);assert.equal(entry.catalog?.toolsKnown,false);assert.equal(JSON.stringify(entry).includes('secret'),false);
});
test('config mutations use CAS, preserve secrets and verify readback',async()=>{
 const f=fixture(),s=await readExtensions(f.peer,process.cwd()),mcp=s.items.find(x=>x.kind==='mcp')!;
 const result=await changeExtension(f.peer,process.cwd(),{action:'mcp.save',key:mcp.key,expectedVersion:'v1',name:'demo',config:{command:'updated',args:['one']}});
 assert.equal(result.status,'written');
 const w=f.calls.find(x=>x.method==='config/batchWrite');assert.equal(w.params.expectedVersion,'v1');assert.equal(w.params.edits[0].value.env.TOKEN,'secret');
});
test('HTTP edits retain full server endpoint and headers when browser omits them',async()=>{
 const f=fixture();f.setHttp();const s=await readExtensions(f.peer,process.cwd()),entry=s.items.find(x=>x.kind==='mcp')!;
 assert.equal(entry.config?.url,'https://host');assert.equal(JSON.stringify(s).includes('private/mcp'),false);
 await changeExtension(f.peer,process.cwd(),{action:'mcp.save',key:entry.key,expectedVersion:'v1',name:'demo',config:{tool_timeout_sec:10}});
 const value=f.calls.find(x=>x.method==='config/batchWrite').params.edits[0].value;assert.equal(value.url,'https://host/private/mcp?x=secret');assert.deepEqual(value.http_headers,{Authorization:'secret'});
});
test('transport changes replace the preserved record so opposite transport keys are removed',async()=>{
 const f=fixture(),s=await readExtensions(f.peer,process.cwd()),entry=s.items.find(x=>x.kind==='mcp')!;
 const result=await changeExtension(f.peer,process.cwd(),{action:'mcp.save',key:entry.key,expectedVersion:'v1',name:'demo',config:{url:'https://host/mcp'}});
 assert.equal(result.status,'written');const edit=f.calls.find(x=>x.method==='config/batchWrite').params.edits[0];assert.equal(edit.mergeStrategy,'replace');assert.equal(edit.value.command,undefined);assert.equal(edit.value.env,undefined);
});
test('MCP tool approval enum and HTTP env references save with secrets retained',async()=>{
 const f=fixture();f.setHttp();const s=await readExtensions(f.peer,process.cwd()),entry=s.items.find(x=>x.kind==='mcp')!;
 await changeExtension(f.peer,process.cwd(),{action:'mcp.save',key:entry.key,expectedVersion:'v1',name:'demo',config:{default_tools_approval_mode:'prompt',tools:{lookup:{approval_mode:'auto',output_token_limit:100}},env_http_headers:{'X-Api-Key':'API_KEY'},bearer_token_env_var:'TOKEN',auth:'oauth'}});
 const value=f.calls.find(x=>x.method==='config/batchWrite').params.edits[0].value;assert.equal(value.http_headers.Authorization,'secret');assert.equal(value.url,'https://host/private/mcp?x=secret');assert.equal(value.tools.lookup.approval_mode,'auto');
});
test('invalid MCP approval modes, policy keys and env references fail before native work',async()=>{
 const f=fixture();for(const config of [{default_tools_approval_mode:'always'},{tools:{lookup:{approval_mode:'yes'}}},{tools:{lookup:{output_token_limit:0}}},{tools:{lookup:{unexpected:true}}},{env_http_headers:{Authorization:'paste-secret-value!'}},{bearer_token_env_var:'a b'},{command:'demo',env_http_headers:{X:'ENV'}},{url:'https://host',env_vars:['TOKEN']}])await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'mcp.save',name:'demo',expectedVersion:'v1',config}),{statusCode:400});assert.equal(f.calls.length,0);
});
test('plugin MCP policy writes through the owning plugin and cannot change transport',async()=>{
 const f=fixture();f.setPluginServer();const s=await readExtensions(f.peer,process.cwd()),entry=s.items.find(x=>x.kind==='mcp')!;
 assert.equal(entry.writable,false);assert.equal(entry.policyWritable,true);
 await changeExtension(f.peer,process.cwd(),{action:'mcp.policy',key:entry.key,expectedVersion:'v1',config:{enabled:false,default_tools_approval_mode:'writes',tools:{lookup:{approval_mode:'prompt'}}}} as any);
 const edit=f.calls.find(x=>x.method==='config/batchWrite').params.edits[0];assert.equal(edit.keyPath,'plugins."demo@local"');assert.equal(edit.value.enabled,true);assert.equal(edit.value.mcp_servers.demo.enabled,false);assert.equal(edit.value.mcp_servers.demo.tools.lookup.approval_mode,'prompt');
 const calls=f.calls.length;await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'mcp.policy',key:entry.key,expectedVersion:'v2',config:{url:'https://other'}} as any),{statusCode:400});assert.equal(f.calls.length,calls);
});
test('managed plugin MCP policies remain read-only and unknown catalog install policies reject',async()=>{
 const f=fixture();f.setPluginServer();f.setManagedPlugin();const s=await readExtensions(f.peer,process.cwd()),entry=s.items.find(x=>x.kind==='mcp')!;assert.equal(entry.policyWritable,false);
 await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'mcp.policy',key:entry.key,expectedVersion:'v1',config:{default_tools_approval_mode:'approve'}}),{code:'EXTENSION_READ_ONLY'});assert.equal(f.calls.some(c=>c.method==='config/batchWrite'),false);
 const original=f.peer.request;f.peer.request=async(method,params)=>{const result=await original(method,params);if(method==='plugin/search')result.data[0].plugin.installPolicy='future';return result;};const after=await readExtensions(f.peer,process.cwd());assert.equal(after.available[0].writable,false);
});
test('marketplace sync validates Git source and destructive impact requires complete catalog',async()=>{
 const f=fixture(),s=await readExtensions(f.peer,process.cwd()),m=s.marketplaces[0];
 await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'marketplace.upgrade',key:m.key,expectedVersion:'v1'}),{code:'EXTENSION_READ_ONLY'});
 assert.equal(f.cli.some(args=>args.includes('upgrade')),false);
});
test('marketplace sources reject traversal and existing local junctions before any CLI mutation',async t=>{
 const f=fixture();await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'marketplace.add',source:'../outside-market',expectedVersion:'v1'}),{statusCode:400});assert.equal(f.calls.length,0);
 await mkdir(join(process.cwd(),'.local'),{recursive:true});
 const dir=await mkdtemp(join(process.cwd(),'.local/extensions-source-')),outside=await mkdtemp(join(process.cwd(),'.local/extensions-outside-'));t.after(async()=>{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
 await mkdir(join(dir,'local'));await symlink(outside,join(dir,'local/market'),'junction');f.peer.home=dir;
 await assert.rejects(()=>changeExtension(f.peer,dir,{action:'marketplace.add',source:'local/market',expectedVersion:'v1'}),{statusCode:400});assert.equal(f.cli.some(args=>args.includes('add')),false);
});
test('direct plugin install revalidates the catalog install policy on the server',async()=>{
 const f=fixture(),original=f.peer.request;f.peer.request=async(method,params)=>{const response=await original(method,params);if(method==='plugin/search')response.data[0].plugin.installPolicy='NOT_AVAILABLE';return response;};
 const s=await readExtensions(f.peer,process.cwd());assert.equal(s.available[0].writable,false);
 await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'plugin.install',key:s.available[0].key,expectedVersion:'v1'},searchOptions(s.available[0].key)),{code:'EXTENSION_READ_ONLY'});assert.equal(f.cli.some(args=>args.includes('add')),false);
});
test('managed, stale and unknown writes never replay',async()=>{
 for(const managed of [false,true]){
  const f=fixture(),s=await readExtensions(f.peer,process.cwd());if(managed)f.setManaged();
  await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'enabled',key:s.items.find(x=>x.kind==='mcp')!.key,expectedVersion:managed?'v1':'stale',enabled:false}),{code:managed?'EXTENSION_READ_ONLY':'EXTENSION_CONFLICT'});
  assert.equal(f.calls.filter(x=>x.method==='config/batchWrite').length,0);
 }
 const f=fixture(),s=await readExtensions(f.peer,process.cwd());f.setUnknown();
 await assert.rejects(()=>changeExtension(f.peer,process.cwd(),{action:'enabled',key:s.items.find(x=>x.kind==='app')!.key,expectedVersion:'v1',enabled:false}),{code:'EXTENSION_WRITE_UNKNOWN'});
 assert.equal(f.calls.filter(x=>x.method==='config/batchWrite').length,1);
});
test('invalid mutations reject before native reads and STDIO/HTTP never combine',async()=>{
 const f=fixture();
 for(const input of [{action:'rpc',method:'account/logout'},{action:'marketplace.add',source:'--help'},{action:'mcp.save',expectedVersion:'v1',name:'x',config:{command:'cmd',url:'https://example.com'}},{action:'mcp.save',expectedVersion:'v1',name:'x',config:{command:'cmd',unknown:'x'}}])await assert.rejects(()=>changeExtension(f.peer,process.cwd(),input as any),{statusCode:400});
 assert.equal(f.calls.length,0);
});
test('source failure remains visible and malformed CLI JSON is bounded',async()=>{
 const f=fixture();f.peer.cli=async()=>{throw Error('secret');};const s=await readExtensions(f.peer,process.cwd());
 assert.equal(s.sources.find(x=>x.id==='marketplaces')?.status,'error');assert.equal(s.items.some(x=>x.kind==='plugin'),true);assert.equal(JSON.stringify(s).includes('secret'),false);
 await assert.rejects(()=>runExtensionCli({executable:process.execPath,args:['-e','process.stdout.write("bad")'],home:process.cwd(),cwd:process.cwd()},['plugin','list','--available','--json']),{code:'EXTENSION_CLI_FAILED'});
 await assert.rejects(()=>runExtensionCli({executable:process.execPath,args:['-e','process.stderr.write("secret");process.stdout.write("{\\"available\\":[],\\"installed\\":[]}")'],home:process.cwd(),cwd:process.cwd()},['plugin','list','--available','--json']),{code:'EXTENSION_CLI_FAILED'});
 await assert.rejects(()=>runExtensionCli({executable:process.execPath,args:['-e','setTimeout(()=>{},5000)'],home:process.cwd(),cwd:process.cwd(),timeoutMs:50},['plugin','add','test@local','--json']),{code:'EXTENSION_WRITE_UNKNOWN'});
});
