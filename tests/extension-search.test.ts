import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import * as catalog from '../src/codex/extension-catalog.ts';
import {changeExtension,extensionKey} from '../src/codex/extensions.ts';
import {visibleExtensionItems} from '../src/web/extensionsState.ts';

test('discovery preserves implicit App policy for the same visible plugin classification',async()=>{
 const p={home:process.cwd(),cli:async()=>{},request:async()=>({data:[{marketplaceName:'remote',marketplacePath:null,plugin:{id:'wrapper@remote',name:'Wrapper',installPolicySource:'IMPLICIT_CANONICAL_APP'}}],nextCursor:null})};
 const page=await catalog.searchExtensions(p,process.cwd(),{query:'wrapper'});assert.equal(page.items[0].installPolicySource,'IMPLICIT_CANONICAL_APP');assert.deepEqual(visibleExtensionItems(page.items),[]);
});

test('search validates nonempty bounded words before native access and fixes global scope and limit',async()=>{
 const calls:any[]=[];const p={home:process.cwd(),cli:async()=>{throw Error('CLI forbidden');},request:async(method:string,params:any)=>{calls.push({method,params});return {data:[],nextCursor:null};}};
 for(const query of ['', '  ', 'x'.repeat(201)])await assert.rejects(()=>catalog.searchExtensions(p,process.cwd(),{query}),{code:'EXTENSION_INVALID_INPUT'});
 assert.equal(calls.length,0);const page=await catalog.searchExtensions(p,process.cwd(),{query:' github ',cursor:'opaque'});assert.equal(page.query,'github');assert.deepEqual(calls,[{method:'plugin/search',params:{searchTerm:'github',scope:'global',cwds:[process.cwd()],limit:50,cursor:'opaque'}}]);
});
test('search uses cursor even when native page exceeds limit and keeps marketplace identity',async()=>{
 const p={home:process.cwd(),cli:async()=>{throw Error('CLI forbidden');},request:async()=>({data:Array.from({length:52},(_,i)=>({plugin:{id:`same@market${i}`,name:'Same',installPolicy:'AVAILABLE',remotePluginId:null,availability:'AVAILABLE'},marketplaceName:`market${i}`,marketplacePath:null})),nextCursor:'more'})};
 const page=await catalog.searchExtensions(p,process.cwd(),{query:'same'});assert.equal(page.items.length,52);assert.equal(page.nextCursor,'more');assert.equal(new Set(page.items.map(x=>x.key)).size,52);
});
test('unsupported search has no CLI fallback and unchanged cursor is rejected',async()=>{
 let cli=0;const p={home:process.cwd(),cli:async()=>{cli++;},request:async()=>{throw Object.assign(Error('unsupported'),{code:-32601});}};
 await assert.rejects(()=>catalog.searchExtensions(p,process.cwd(),{query:'same'}));assert.equal(cli,0);
 p.request=async()=>({data:[],nextCursor:'same'} as never);await assert.rejects(()=>catalog.searchExtensions(p,process.cwd(),{query:'same',cursor:'same'}));
});
test('search installation binds server context and fresh page policy before any CLI write',async()=>{
 let policy='AVAILABLE',installed=false;const calls:string[]=[];
 const p={home:process.cwd(),cli:async(args:string[])=>{calls.push(args.join(' '));installed=true;return {pluginId:'demo@local'};},request:async(method:string):Promise<any>=>{
  if(method==='config/read')return {config:{},layers:[{name:{type:'user',profile:null,file:join(process.cwd(),'config.toml')},config:{},version:'v1'}]};if(method==='configRequirements/read')return {requirements:null};
  if(method==='plugin/search')return {data:[{plugin:{id:'demo@local',name:'Demo',installPolicy:policy,remotePluginId:null,availability:'AVAILABLE'},marketplaceName:'local',marketplacePath:null}],nextCursor:null};
  if(method==='plugin/installed')return {marketplaces:[{name:'local',path:null,plugins:installed?[{id:'demo@local',name:'Demo',installed:true,enabled:true}]:[]}],marketplaceLoadErrors:[]};
  throw Error('Unexpected unrelated read '+method);
 }};
 const key=extensionKey('plugin',JSON.stringify(['local',null,'demo@local'])),mutation={action:'plugin.install' as const,key,expectedVersion:'v1'},searchTarget={contextKey:'A',query:'demo',key};
 await assert.rejects(()=>changeExtension(p,process.cwd(),mutation,{contextKey:'B',searchTarget}),{code:'EXTENSION_STALE'});
 await assert.rejects(()=>changeExtension(p,process.cwd(),mutation,{contextKey:'A'}),{code:'EXTENSION_STALE'});
 policy='NOT_AVAILABLE';await assert.rejects(()=>changeExtension(p,process.cwd(),mutation,{contextKey:'A',searchTarget}),{code:'EXTENSION_READ_ONLY'});assert.equal(calls.length,0);
 policy='AVAILABLE';const result=await changeExtension(p,process.cwd(),mutation,{contextKey:'A',searchTarget});assert.equal(result.status,'written');assert.deepEqual(calls,['plugin add demo@local --json']);assert.deepEqual(result.invalidatedSections,['installed','apps','mcp']);
});
test('mcp save reads and verifies its source while Apps, skills and discovery stay untouched',async()=>{
 let config:any={},version='v1';const methods:string[]=[];
 const p={home:process.cwd(),cli:async()=>{throw Error('Unexpected CLI');},request:async(method:string,params:any):Promise<any>=>{methods.push(method);
  if(method==='config/read')return {config,layers:[{name:{type:'user',profile:null,file:join(process.cwd(),'config.toml')},config,version}]};if(method==='configRequirements/read')return {requirements:null};
  if(method==='config/batchWrite'){config={mcp_servers:{demo:params.edits[0].value}};version='v2';return {status:'ok',filePath:join(process.cwd(),'config.toml'),version};}
  throw Error('Unexpected unrelated read '+method);
 }};
 const r=await changeExtension(p,process.cwd(),{action:'mcp.save',name:'demo',expectedVersion:'v1',config:{command:'demo'}});assert.equal(r.status,'written');assert.deepEqual(r.invalidatedSections,['installed','mcp']);assert.equal(methods.some(x=>['app/list','app/installed','skills/list','plugin/search','mcpServerStatus/list'].includes(x)),false);
});
test('remote or ambiguous search identities are metadata-only and duplicate identities collapse',async()=>{
 const row={plugin:{id:'demo@local',name:'Demo',installPolicy:'AVAILABLE',availability:'AVAILABLE',remotePluginId:'remote'},marketplaceName:'local',marketplacePath:null};
 const p={home:process.cwd(),cli:async()=>{},request:async()=>({data:[row,row,{...row,marketplacePath:'/other'},{...row,plugin:{...row.plugin,id:'ambiguous',remotePluginId:null}}],nextCursor:null})};
 const result=await catalog.searchExtensions(p,process.cwd(),{query:'demo'});assert.equal(result.items.length,3);assert.equal(result.items.every(x=>!x.writable),true);
});
test('search target disappearance and changed runtime context cannot reach CLI mutation',async()=>{
 let present=true,checks=0,writes=0;const p={home:process.cwd(),cli:async()=>{writes++;},request:async(method:string):Promise<any>=>{
  if(method==='config/read')return {config:{},layers:[{name:{type:'user',profile:null,file:join(process.cwd(),'config.toml')},config:{},version:'v1'}]};if(method==='configRequirements/read')return {requirements:null};if(method==='plugin/installed')return {marketplaces:[{name:'local',path:null,plugins:[]}],marketplaceLoadErrors:[]};
  if(method==='plugin/search')return {data:present?[{plugin:{id:'demo@local',name:'Demo',installPolicy:'AVAILABLE',availability:'AVAILABLE',remotePluginId:null},marketplaceName:'local',marketplacePath:null}]:[],nextCursor:null};throw Error('Unexpected read');}};
 const key=extensionKey('plugin',JSON.stringify(['local',null,'demo@local'])),mutation={action:'plugin.install' as const,key,expectedVersion:'v1'},options={contextKey:'A',searchTarget:{contextKey:'A',query:'demo',key}};
 present=false;await assert.rejects(()=>changeExtension(p,process.cwd(),mutation,options),{code:'EXTENSION_STALE'});present=true;
 await assert.rejects(()=>changeExtension(p,process.cwd(),mutation,{...options,assertCurrent:()=>{checks++;throw Object.assign(Error('Context changed'),{code:'EXTENSION_STALE'});}}),{code:'EXTENSION_STALE'});assert.equal(checks,1);assert.equal(writes,0);
});
test('a CLI id shared by distinct marketplace paths is never installable',async()=>{
 const plugin={id:'demo@local',name:'Demo',installPolicy:'AVAILABLE',availability:'AVAILABLE',remotePluginId:null};
 const p={home:process.cwd(),cli:async()=>{},request:async()=>({data:[{plugin,marketplaceName:'local',marketplacePath:'/one'},{plugin,marketplaceName:'local',marketplacePath:'/two'}],nextCursor:null})};
 const result=await catalog.searchExtensions(p,process.cwd(),{query:'demo'});assert.equal(result.items.length,2);assert.equal(result.items.every(x=>!x.writable),true);
});

test('installation verifies the selected marketplace path after the CLI receipt',async t=>{
 for(const actualPath of ['/other','/selected'])await t.test(actualPath,async()=>{
  let installed=false;const writes:string[][]=[];
  const plugin={id:'demo@local',name:'Demo',installPolicy:'AVAILABLE',availability:'AVAILABLE',remotePluginId:null};
  const p={home:process.cwd(),cli:async(args:string[])=>{writes.push(args);installed=true;return {pluginId:'demo@local'};},request:async(method:string):Promise<any>=>{
   if(method==='config/read')return {config:{},layers:[{name:{type:'user',profile:null,file:join(process.cwd(),'config.toml')},config:{},version:'v1'}]};
   if(method==='configRequirements/read')return {requirements:null};
   if(method==='plugin/search')return {data:[{plugin,marketplaceName:'local',marketplacePath:'/selected'}],nextCursor:null};
   if(method==='plugin/installed')return {marketplaces:[{name:'local',path:installed?actualPath:'/selected',plugins:installed?[{...plugin,installed:true,enabled:true}]:[]}],marketplaceLoadErrors:[]};
   throw Error('Unexpected unrelated read '+method);
  }};
  const page=await catalog.searchExtensions(p,process.cwd(),{query:'demo'}),key=page.items[0].key;
  const change=()=>changeExtension(p,process.cwd(),{action:'plugin.install',key,expectedVersion:'v1'},{contextKey:'A',searchTarget:{contextKey:'A',query:'demo',key}});
  if(actualPath==='/other')await assert.rejects(change,{code:'EXTENSION_WRITE_UNKNOWN'});
  else assert.equal((await change()).status,'written');
  assert.deepEqual(writes,[['plugin','add','demo@local','--json']]);
 });
});

test('installation requires one complete fresh CLI marketplace identity before writing',async t=>{
 const cases=[
  {name:'missing marketplace',markets:[],errors:[]},
  {name:'mismatched path',markets:[{name:'local',path:'/other'}],errors:[]},
  {name:'duplicate name',markets:[{name:'local',path:'/selected'},{name:'local',path:'/other'}],errors:[]},
  {name:'incomplete directories',markets:[{name:'local',path:'/selected'}],errors:[{path:'/broken',message:'Unavailable directory'}]},
 ];
 for(const scenario of cases)await t.test(scenario.name,async()=>{
  let writes=0;const plugin={id:'demo@local',name:'Demo',installPolicy:'AVAILABLE',availability:'AVAILABLE',remotePluginId:null};
  const p={home:process.cwd(),cli:async()=>{writes++;return {pluginId:'demo@local'};},request:async(method:string):Promise<any>=>{
   if(method==='config/read')return {config:{},layers:[{name:{type:'user',profile:null,file:join(process.cwd(),'config.toml')},config:{},version:'v1'}]};
   if(method==='configRequirements/read')return {requirements:null};
   if(method==='plugin/search')return {data:[{plugin,marketplaceName:'local',marketplacePath:'/selected'}],nextCursor:null};
   if(method==='plugin/installed')return {marketplaces:scenario.markets.map(m=>({...m,plugins:[]})),marketplaceLoadErrors:scenario.errors};
   throw Error('Unexpected unrelated read '+method);
  }};
  const page=await catalog.searchExtensions(p,process.cwd(),{query:'demo'}),key=page.items[0].key;
  await assert.rejects(()=>changeExtension(p,process.cwd(),{action:'plugin.install',key,expectedVersion:'v1'},{contextKey:'A',searchTarget:{contextKey:'A',query:'demo',key}}),{code:'EXTENSION_STALE'});
  assert.equal(writes,0);
 });
});
