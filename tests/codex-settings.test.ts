import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/codex/runtime.ts';
import {Projects} from '../src/projects.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';

const keys=['model','model_reasoning_effort','approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess','web_search','service_tier','memoriesEnabled','generateMemories','useMemories','allowExternalMemory'];
const secret='FAKE_SECRET_MUST_NOT_LEAK';
const config=()=>({model:'model-a',model_reasoning_effort:'high',approval_policy:'on-request',approvals_reviewer:'user',sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:false,writable_roots:['preserved-root'],exclude_tmpdir_env_var:true,exclude_slash_tmp:true},web_search:'cached',model_provider:secret,mcp_servers:{test:{env:{TOKEN:secret}}}});
function fixture(t:any){
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()}),writes:any[]=[];
 let user=config(),effective:any=null,version='user-v1',requirements:any=null,layerExtra:any={},sourceExtra:any={},origins:any={},writeError:any=null,readError:any=null,readbackError=false,readCount=0,otherLayers:any[]=[];
 t.mock.method(runtime,'models',async()=>({data:[{model:'model-a',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:'model-b',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}));
 t.mock.method(runtime as any,'call',async(method:string,params:any)=>{
  if(method==='configRequirements/read')return {requirements};
  if(method==='config/read'){readCount++;if(readError)throw readError;if(readbackError&&writes.length)throw Error(secret);return {config:effective??user,origins,layers:[...otherLayers,{name:{type:'user',file:join(process.cwd(),'.local/tmp/fixture-config.toml'),profile:null,...sourceExtra},version,config:user,...layerExtra}]};}
  if(method==='config/batchWrite'){writes.push(params);if(writeError)throw writeError;for(const e of params.edits){const path=e.keyPath.split('.');let target:any=user;for(const key of path.slice(0,-1))target=target[key]??=( {} );target[path.at(-1)]=e.value;}version='user-v2';return {status:'ok',version,filePath:params.filePath};}
  throw Error('unexpected RPC');
 });
 t.after(()=>runtime.close());
 return {runtime,writes,set:(changes:any)=>{if('effective'in changes)effective=changes.effective;if('requirements'in changes)requirements=changes.requirements;if('source'in changes)sourceExtra=changes.source;if('layer'in changes)layerExtra=changes.layer;if('origins'in changes)origins=changes.origins;if('writeError'in changes)writeError=changes.writeError;if('readError'in changes)readError=changes.readError;if('readbackError'in changes)readbackError=changes.readbackError;if('user'in changes)user=changes.user;if('otherLayers'in changes)otherLayers=changes.otherLayers;},reads:()=>readCount};
}

test('deprecated approval writes are invalid before any native RPC',async t=>{
 for(const approval_policy of ['untrusted','on-failure']){
  const f=fixture(t);
  await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{approval_policy}}),{statusCode:400,code:'SETTINGS_INVALID_INPUT'});
  assert.equal(f.reads(),0);assert.equal(f.writes.length,0);
 }
});

test('deprecated approval values remain visible with permissions readonly and independent defaults writable',async t=>{
 for(const approval_policy of ['untrusted','on-failure']){
  const f=fixture(t);f.set({user:{...config(),approval_policy}});
  const snapshot=await f.runtime.readSettings(process.cwd());
  assert.equal(snapshot.fields.approval_policy.userValue,approval_policy);assert.equal(snapshot.fields.approval_policy.effectiveValue,approval_policy);
  for(const key of ['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'] as const){assert.equal(snapshot.fields[key].writable,false);assert.match(snapshot.fields[key].reason!,/停用|迁移/);}
  assert.equal(snapshot.writable,true);assert.equal(snapshot.fields.model.writable,true);assert.equal(snapshot.fields.web_search.writable,true);
  await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:snapshot.userVersion!,values:{sandbox_mode:'read-only'}}),{code:'SETTINGS_READ_ONLY'});assert.equal(f.writes.length,0);
  const model=await f.runtime.writeSettings(process.cwd(),{expectedVersion:snapshot.userVersion!,values:{model:'model-b',model_reasoning_effort:'low'}});
  const search=await f.runtime.writeSettings(process.cwd(),{expectedVersion:model.snapshot.userVersion!,values:{web_search:'live'}});
  assert.equal(search.snapshot.fields.approval_policy.userValue,approval_policy);assert.equal(search.snapshot.fields.web_search.userValue,'live');assert.equal(f.writes.length,2);
  f.set({effective:config()});assert.equal((await f.runtime.readSettings(process.cwd())).fields.approval_policy.writable,false);
 }
});

test('settings project values and origins project only fixed public fields',async t=>{
 const f=fixture(t);f.set({effective:{...config(),model:'model-b'},origins:{model:{name:{type:'project',dotCodexFolder:'/project/.codex',secret},version:'project-v1'},model_provider:{name:{type:'sessionFlags',secret}}}});
 const result=await f.runtime.readSettings(process.cwd());
 assert.deepEqual(Object.keys(result.fields).sort(),keys.sort());
 assert.equal(result.fields.model.userValue,'model-a');assert.equal(result.fields.model.effectiveValue,'model-b');
 assert.equal(result.fields.model.origin?.type,'project');assert.equal(result.writable,true);assert.equal(result.userVersion,'user-v1');
 assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(f.writes.length,0);
});

test('memory projection preserves unset values, official defaults and nested origins',async t=>{
 const f=fixture(t);f.set({effective:{...config(),features:{memories:true,private:secret},memories:{use_memories:false,disable_on_external_context:true,private:secret}},origins:{features:{name:{type:'system',file:join(process.cwd(),'system.toml')}},'memories.use_memories':{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')}}}});
 const {fields}=await f.runtime.readSettings(process.cwd());
 assert.deepEqual([fields.memoriesEnabled.userValue,fields.memoriesEnabled.effectiveValue,fields.memoriesEnabled.defaultValue],[null,true,false]);
 assert.deepEqual([fields.generateMemories.userValue,fields.generateMemories.effectiveValue,fields.generateMemories.defaultValue],[null,null,true]);
 assert.deepEqual([fields.useMemories.userValue,fields.useMemories.effectiveValue,fields.useMemories.defaultValue],[null,false,true]);
 assert.deepEqual([fields.allowExternalMemory.userValue,fields.allowExternalMemory.effectiveValue,fields.allowExternalMemory.defaultValue],[null,false,true]);
 assert.equal(fields.memoriesEnabled.origin?.type,'system');assert.equal(fields.useMemories.origin?.type,'project');assert.equal(JSON.stringify(fields).includes(secret),false);
});

test('unset speed preserves the selected model catalog default and unknown catalog stays unknown',async t=>{
 const f=fixture(t);t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',serviceTiers:[{id:'priority'}],defaultServiceTier:'priority'},{model:'model-b',defaultServiceTier:null}],nextCursor:null}));
 const initial=await f.runtime.readSettings(process.cwd());assert.equal(initial.fields.service_tier.userValue,null);assert.equal(initial.fields.service_tier.effectiveValue,null);assert.equal(initial.fields.service_tier.defaultValue,'priority');
 f.set({effective:{...config(),model:'model-b'}});assert.equal((await f.runtime.readSettings(process.cwd())).fields.service_tier.defaultValue,null);
 t.mock.method(f.runtime,'models',async()=>{throw Error('catalog unavailable');});assert.equal((await f.runtime.readSettings(process.cwd())).fields.service_tier.defaultValue,null);
});

test('memory writes validate booleans and invert external context through native CAS',async t=>{
 const f=fixture(t);
 for(const values of [{memoriesEnabled:'true'},{generateMemories:null},{useMemories:1},{allowExternalMemory:'false'}])await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:values as any}),{code:'SETTINGS_INVALID_INPUT'});
 const result=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{memoriesEnabled:true,generateMemories:false,useMemories:true,allowExternalMemory:false}});
 assert.deepEqual(f.writes[0].edits,[{keyPath:'features.memories',value:true,mergeStrategy:'upsert'},{keyPath:'memories.generate_memories',value:false,mergeStrategy:'upsert'},{keyPath:'memories.use_memories',value:true,mergeStrategy:'upsert'},{keyPath:'memories.disable_on_external_context',value:true,mergeStrategy:'upsert'}]);
 assert.equal(f.writes[0].expectedVersion,'user-v1');assert.equal(result.snapshot.fields.allowExternalMemory.userValue,false);assert.equal(result.effect,'future-sessions');
});

test('managed memory features and nested sources reject writes independently',async t=>{
 for(const forced of [true,false]){const f=fixture(t);f.set({requirements:{featureRequirements:{memories:forced}}});assert.equal((await f.runtime.readSettings(process.cwd())).fields.memoriesEnabled.writable,false);await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{memoriesEnabled:!forced}}),{code:'SETTINGS_READ_ONLY'});assert.equal(f.writes.length,0);}
 const f=fixture(t);f.set({origins:{memories:{name:{type:'enterpriseManaged'}}}});
 const read=await f.runtime.readSettings(process.cwd());assert.equal(read.fields.generateMemories.writable,false);assert.equal(read.fields.memoriesEnabled.writable,true);
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{generateMemories:false}}),{code:'SETTINGS_READ_ONLY'});assert.equal(f.writes.length,0);
});

test('standard speed is default and additional speed must exist in both user and effective model catalogs',async t=>{
 const f=fixture(t);t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',serviceTiers:[{id:'priority',name:'Fast',description:''}],defaultServiceTier:'priority'},{model:'model-b',serviceTiers:[{id:'flex',name:'Flex',description:''}]}],nextCursor:null}));
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{service_tier:'fast'}}),{code:'RUNTIME_INVALID_SERVICE_TIER'});assert.equal(f.writes.length,0);
 f.set({effective:{...config(),model:'model-b'},origins:{model:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')}}}});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{service_tier:'priority'}}),{code:'RUNTIME_INVALID_SERVICE_TIER'});assert.equal(f.writes.length,0);
 const saved=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{service_tier:'default'}});assert.equal(saved.snapshot.fields.service_tier.userValue,'default');
 assert.deepEqual(f.writes[0].edits,[{keyPath:'service_tier',value:'default',mergeStrategy:'upsert'}]);
 const priority=fixture(t);t.mock.method(priority.runtime,'models',async()=>({data:[{model:'model-a',serviceTiers:[{id:'priority',name:'Fast',description:''}]}],nextCursor:null}));
 assert.equal((await priority.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{service_tier:'priority'}})).snapshot.fields.service_tier.userValue,'priority');
});

test('model changes reject incompatible existing speed and managed service tier remains read only',async t=>{
 const f=fixture(t);f.set({user:{...config(),service_tier:'priority'}});t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',serviceTiers:[{id:'priority'}],supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:'model-b',serviceTiers:[],supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}));
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'low'}}),{code:'RUNTIME_INVALID_SERVICE_TIER'});assert.equal(f.writes.length,0);
 await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'low',service_tier:'default'}});assert.equal(f.writes.length,1);
 const managed=fixture(t);managed.set({requirements:{models:{newThread:{serviceTier:'priority'}}}});assert.equal((await managed.runtime.readSettings(process.cwd())).fields.service_tier.writable,false);
 await assert.rejects(managed.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{service_tier:'default'}}),{code:'SETTINGS_READ_ONLY'});assert.equal(managed.writes.length,0);
});

test('project standard speed cannot hide an inherited user speed when changing models',async t=>{
 const f=fixture(t),userFile=join(process.cwd(),'.local/tmp/fixture-config.toml');
 f.set({effective:{...config(),service_tier:'default'},otherLayers:[{name:{type:'system',file:join(process.cwd(),'system.toml')},version:'system-v1',config:{service_tier:'priority'}},{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')},version:'project-v1',config:{service_tier:'default'}}],origins:{model:{name:{type:'user',file:userFile,profile:null}},model_reasoning_effort:{name:{type:'user',file:userFile,profile:null}},service_tier:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')}}}});
 t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',serviceTiers:[{id:'priority'}],supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:'model-b',serviceTiers:[],supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}));
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'low'}}),{code:'RUNTIME_INVALID_SERVICE_TIER'});assert.equal(f.writes.length,0);
 const saved=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'low',service_tier:'default'}});
 assert.equal(saved.snapshot.fields.service_tier.userValue,'default');assert.equal(f.writes.length,1);
});

test('native model projection validates service tier metadata and strips private fields',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());
 t.mock.method(runtime as any,'call',async()=>({data:[{model:'a',serviceTiers:[{id:'priority',name:'Fast',description:'Faster',private:secret},{id:12,name:'bad',description:''},{id:'',name:'bad',description:''}],defaultServiceTier:'priority',private:secret},{model:'b',serviceTiers:secret,defaultServiceTier:12},{model:'c',serviceTiers:[],defaultServiceTier:'missing'}],nextCursor:null}));
 const result=await (runtime as any).loadModels();
 assert.deepEqual(result.data[0].serviceTiers,[{id:'priority',name:'Fast',description:'Faster'}]);assert.equal(result.data[0].defaultServiceTier,'priority');assert.deepEqual(result.data[1].serviceTiers,[]);assert.equal(result.data[1].defaultServiceTier,null);assert.equal(result.data[2].defaultServiceTier,null);assert.equal(JSON.stringify(result).includes(secret),false);
});

test('settings validates whitelist model compatibility and sends original version without reload',async t=>{
 const f=fixture(t);
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_provider:secret} as any}),{statusCode:400});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'high'}}),{statusCode:400});
 assert.equal(f.writes.length,0);
 const result=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'low'}});
 assert.equal(result.status,'written');assert.equal(result.effect,'future-sessions');assert.equal(result.snapshot.fields.model.userValue,'model-b');
 assert.equal(f.writes[0].expectedVersion,'user-v1');assert.notEqual(f.writes[0].reloadUserConfig,true);
 assert.deepEqual(f.writes[0].edits.map((e:any)=>e.keyPath),['model','model_reasoning_effort']);
});

test('partial model edits validate the resulting user pair despite project overrides',async t=>{
 const modelOnly=fixture(t);modelOnly.set({effective:{...config(),model_reasoning_effort:'low'}});
 await assert.rejects(modelOnly.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b'}}),{statusCode:400,code:'RUNTIME_INVALID_EFFORT'});
 assert.equal(modelOnly.writes.length,0);
 const effortOnly=fixture(t);effortOnly.set({user:{...config(),model:'model-b',model_reasoning_effort:'low'},effective:{...config(),model:'model-a'}});
 await assert.rejects(effortOnly.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'high'}}),{statusCode:400,code:'RUNTIME_INVALID_EFFORT'});
 assert.equal(effortOnly.writes.length,0);
});

test('a compatible user edit cannot create an incompatible project effective pair',async t=>{
 const f=fixture(t);t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'model-b',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}));
 f.set({user:{...config(),model_reasoning_effort:'low'},effective:{...config(),model:'model-b',model_reasoning_effort:'low'},origins:{model:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')},version:'project-v1'},model_reasoning_effort:{name:{type:'user',file:join(process.cwd(),'.local/tmp/fixture-config.toml'),profile:null},version:'user-v1'}}});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'high'}}),{statusCode:400,code:'RUNTIME_INVALID_EFFORT'});assert.equal(f.writes.length,0);
 const modelEdit=fixture(t);modelEdit.set({effective:config(),origins:{model:{name:{type:'user',file:join(process.cwd(),'.local/tmp/fixture-config.toml'),profile:null},version:'user-v1'},model_reasoning_effort:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')},version:'project-v1'}}});
 await assert.rejects(modelEdit.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b',model_reasoning_effort:'low'}}),{statusCode:400,code:'RUNTIME_INVALID_EFFORT'});assert.equal(modelEdit.writes.length,0);
});

test('harmless edits fully overridden by the project keep the observed effective pair',async t=>{
 const f=fixture(t);t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'model-b',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}));
 f.set({user:{...config(),model_reasoning_effort:'low'},effective:{...config(),model:'model-b',model_reasoning_effort:'low'},origins:{model:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')},version:'project-v1'},model_reasoning_effort:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')},version:'project-v1'}}});
 const saved=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'high'}});
 assert.equal(f.writes.length,1);assert.equal(saved.snapshot.fields.model_reasoning_effort.userValue,'high');assert.equal(saved.snapshot.fields.model.effectiveValue,'model-b');assert.equal(saved.snapshot.fields.model_reasoning_effort.effectiveValue,'low');
});

test('unset user model uses a known lower-layer default but never a project override',async t=>{
 const {model:unused,...user}=config();
 const inherited=fixture(t);inherited.set({user,effective:config(),origins:{model:{name:{type:'packagedDefaults',file:join(process.cwd(),'defaults.toml')},version:'default-v1'}}});
 await inherited.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'high'}});assert.equal(inherited.writes.length,1);
 const catalogDefault=fixture(t);catalogDefault.set({user,effective:{...config(),model:null}});
 t.mock.method(catalogDefault.runtime,'models',async()=>({data:[{model:'model-a',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}));
 await catalogDefault.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'high'}});assert.equal(catalogDefault.writes.length,1);
 const project=fixture(t);project.set({user,effective:config(),origins:{model:{name:{type:'project',dotCodexFolder:join(process.cwd(),'.codex')},version:'project-v1'}}});
 await assert.rejects(project.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'high'}}),{statusCode:400});assert.equal(project.writes.length,0);
});

test('unset inherited effort uses the selected model native catalog default',async t=>{
 const {model_reasoning_effort:unused,...user}=config();const f=fixture(t);f.set({user,effective:{...config(),model_reasoning_effort:null}});
 const saved=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-b'}});
 assert.equal(saved.snapshot.fields.model.userValue,'model-b');assert.deepEqual(f.writes[0].edits.map((e:any)=>e.keyPath),['model']);
});

test('workspace network edits require the resulting user sandbox to remain workspace-write',async t=>{
 for(const sandbox_mode of ['read-only','danger-full-access']){
  const f=fixture(t);await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{sandbox_mode,workspaceNetworkAccess:true}}),{statusCode:400});assert.equal(f.writes.length,0);
 }
 const project=fixture(t);project.set({user:{...config(),sandbox_mode:'read-only'},effective:config()});
 await assert.rejects(project.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{workspaceNetworkAccess:true}}),{statusCode:400});assert.equal(project.writes.length,0);
});

test('stale versions and native verified conflict reject without overwriting',async t=>{
 const f=fixture(t);
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'stale',values:{web_search:'live'}}),{statusCode:409});
 assert.equal(f.writes.length,0);
 f.set({writeError:Object.assign(Error(secret),{code:-32600,data:{config_write_error_code:'configVersionConflict'}})});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{web_search:'live'}}),{statusCode:409,code:'SETTINGS_CONFLICT'});
 assert.equal(f.writes.length,1);
});

test('native conflict data survives Runtime transport mapping and remains sanitized',async t=>{
 const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url)),'settings-conflict'],cwd:process.cwd()});t.after(()=>runtime.close());
 await assert.rejects(runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{web_search:'live'}}),(e:any)=>e.code==='SETTINGS_CONFLICT'&&e.statusCode===409&&!e.message.includes(secret));
});

test('unknown native permission representations stay read only while model and search save',async t=>{
 for(const extra of [{permissions:{custom:secret}},{default_permissions:'custom'},{approval_policy:{granular:{sandbox_approval:true}}}]){
  const f=fixture(t);f.set({user:{...config(),...extra}});
  const read=await f.runtime.readSettings(process.cwd());assert.equal(read.fields.approval_policy.writable,false);assert.equal(JSON.stringify(read).includes(secret),false);
  await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{approval_policy:'never'}}),{statusCode:409});
  await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-a',web_search:'live'}});assert.equal(f.writes.length,1);
 }
});

test('managed permissions and search restrictions preserve independent fields',async t=>{
 const f=fixture(t);f.set({requirements:{allowedSandboxModes:['read-only'],allowedApprovalPolicies:['on-request'],allowedWebSearchModes:['cached']}});
 const read=await f.runtime.readSettings(process.cwd());assert.equal(read.fields.sandbox_mode.writable,false);
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{sandbox_mode:'danger-full-access'}}),{statusCode:409});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{web_search:'live'}}),{statusCode:400});
 await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model:'model-a'}});assert.equal(f.writes.length,1);
});

test('profile ambiguity disables writes and malformed write readback remains unknown',async t=>{
 const f=fixture(t);f.set({source:{profile:'selected'}});
 assert.equal((await f.runtime.readSettings(process.cwd())).writable,false);
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{web_search:'live'}}),{statusCode:409});
 f.set({source:{},readbackError:true});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{web_search:'live'}}),{statusCode:504,code:'SETTINGS_WRITE_UNKNOWN'});
 assert.equal(f.writes.length,1);
});

test('timeout and unknown transport outcome never retry and use sanitized unknown error',async t=>{
 const f=fixture(t);f.set({writeError:Error('RPC timed out '+secret)});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{web_search:'live'}}),(e:any)=>e.statusCode===504&&e.code==='SETTINGS_WRITE_UNKNOWN'&&!e.message.includes(secret));
 assert.equal(f.writes.length,1);assert.ok(f.reads()>=2,'unknown outcomes trigger readback verification');
});

test('network updates preserve unknown workspace keys and only apply to workspace-write',async t=>{
 const f=fixture(t);
 await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{workspaceNetworkAccess:true}});
 assert.deepEqual(f.writes[0].edits,[{keyPath:'sandbox_workspace_write.network_access',value:true,mergeStrategy:'upsert'}]);
 f.set({user:{...config(),sandbox_mode:'read-only'}});
 await assert.rejects(f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v2',values:{workspaceNetworkAccess:false}}),{statusCode:409});
});

test('model effort follows the dynamic catalog instead of a static effort whitelist',async t=>{
 const f=fixture(t);t.mock.method(f.runtime,'models',async()=>({data:[{model:'model-a',supportedReasoningEfforts:[{reasoningEffort:'future-effort'}]}],nextCursor:null}));
 const result=await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{model_reasoning_effort:'future-effort'}});
 assert.equal(result.snapshot.fields.model_reasoning_effort.userValue,'future-effort');
});

test('a missing native method returns unsupported while read failures remain explicit',async t=>{
 const f=fixture(t);f.set({readError:Object.assign(Error(secret),{code:-32601})});
 const result=await f.runtime.readSettings(process.cwd());assert.equal(result.supported,false);assert.equal(result.writable,false);assert.equal(result.userVersion,null);
 assert.equal(JSON.stringify(result).includes(secret),false);
 f.set({readError:Error(secret)});await assert.rejects(f.runtime.readSettings(process.cwd()),{statusCode:503,code:'SETTINGS_READ_FAILED'});
});

test('permission preset fields write atomically and can enable network with workspace mode',async t=>{
 const f=fixture(t);f.set({user:{...config(),sandbox_mode:'read-only'}});
 await f.runtime.writeSettings(process.cwd(),{expectedVersion:'user-v1',values:{approval_policy:'on-request',approvals_reviewer:'auto_review',sandbox_mode:'workspace-write',workspaceNetworkAccess:true}});
 assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].edits.map((e:any)=>e.keyPath),['approval_policy','approvals_reviewer','sandbox_mode','sandbox_workspace_write.network_access']);
 const read=await f.runtime.readSettings(process.cwd());assert.equal(read.fields.workspaceNetworkAccess.userValue,true);
});

test('settings routes enforce auth csrf fixed inputs project boundary and legacy version requirement',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'settings-api-'));
 const root=join(dir,'work');await mkdir(root);const dataDir=join(dir,'data');await initializeAuth(dataDir,'settings-test-password');
 const f=fixture(t),app=await buildServer({dataDir,origin:'http://localhost:3000',runtime:f.runtime,projects:new Projects(root)});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 assert.equal((await app.inject({url:'/api/codex/settings',headers:{host:'localhost:3000'}})).statusCode,401);
 const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
 const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'settings-test-password'}});headers.cookie+='; '+String(login.headers['set-cookie']).split(';')[0];
 const input={expectedVersion:'user-v1',values:{web_search:'live'}};
 assert.equal((await app.inject({method:'POST',url:'/api/codex/settings',headers:{...headers,'x-csrf-token':''},payload:input})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/codex/settings',headers:{...headers,origin:'http://evil.example'},payload:input})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/codex/settings',headers:{...headers,cookie:headers.cookie.split(';')[0]},payload:input})).statusCode,401);
 for(const payload of [{...input,filePath:'/secret'},{...input,values:{model_provider:secret}},{...input,cwd:'/secret'}])assert.equal((await app.inject({method:'POST',url:'/api/codex/settings',headers,payload})).statusCode,400);
 assert.equal((await app.inject({url:'/api/codex/settings?filePath=/secret',headers})).statusCode,400);
 assert.equal((await app.inject({url:'/api/codex/settings?projectId=../../escape',headers})).statusCode,400);
 const conflict=await app.inject({method:'POST',url:'/api/codex/settings',headers,payload:{...input,expectedVersion:'stale'}});assert.equal(conflict.statusCode,409);assert.equal(f.writes.length,0);
 assert.equal((await app.inject({method:'POST',url:'/api/model-defaults',headers,payload:{model:'model-a'}})).statusCode,409);
 const saved=await app.inject({method:'POST',url:'/api/model-defaults',headers,payload:{expectedVersion:'user-v1',model:'model-a',effort:'high'}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().effectiveModel,'model-a');assert.equal(JSON.stringify(saved.json()).includes(secret),false);
 const native=await app.inject({method:'POST',url:'/api/codex/settings',headers,payload:{expectedVersion:'user-v2',values:{service_tier:'default',memoriesEnabled:true,generateMemories:false,useMemories:true,allowExternalMemory:false}}});assert.equal(native.statusCode,200,native.body);assert.equal(native.json().snapshot.fields.allowExternalMemory.userValue,false);
 for(const values of [{memoriesEnabled:'true'},{generateMemories:1},{service_tier:false},{memories:{use_memories:false}}])assert.equal((await app.inject({method:'POST',url:'/api/codex/settings',headers,payload:{expectedVersion:'user-v2',values}})).statusCode,400);
});
