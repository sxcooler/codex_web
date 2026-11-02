import type {FastifyInstance} from 'fastify';
import type {Runtime} from '../codex/runtime.ts';
import type {Projects} from '../projects.ts';
import type {SettingsWriteInput} from '../codex/settings.ts';
import type {ExtensionMutation,ExtensionSection} from '../codex/extensions.ts';
import type {Instructions,InstructionTarget} from './instructions.ts';

const short={type:'string',minLength:1,maxLength:120};
const projectId={type:'string',pattern:'^[a-f0-9]{24}$'};
const empty={type:'object',additionalProperties:false,properties:{}};
const refresh={type:'string',enum:['true','false']};
const extensionKey={type:'string',pattern:'^[a-f0-9]{64}$'};
export function registerCodexSettingsRoutes(app:FastifyInstance,{runtime,projects,instructions}:{runtime:Runtime;projects:Projects;instructions:Instructions}){
 const cwd=async(id?:string)=>id?(await projects.resolve(id)).path:projects.root;
 app.get('/api/codex/settings',{schema:{querystring:{...empty,properties:{projectId}}}},async request=>runtime.readSettings(await cwd((request.query as any).projectId)));
 app.get('/api/codex/plugins',{schema:{querystring:{...empty,properties:{projectId}}}},async request=>runtime.installedPlugins(await cwd((request.query as any).projectId)));
 app.get('/api/codex/extensions',{schema:{querystring:{...empty,properties:{projectId,section:{type:'string',enum:['installed','apps','mcp','marketplaces']},refresh,key:extensionKey}}}},async request=>{
  const query=request.query as {projectId?:string;section?:ExtensionSection;refresh?:string;key?:string};
  if(query.key!==undefined&&query.section!=='mcp')throw Object.assign(Error('扩展详情 key 仅适用于 MCP 分组。'),{statusCode:400,code:'EXTENSION_INVALID_INPUT'});
  return runtime.extensions(await cwd(query.projectId),{...(query.section!==undefined?{section:query.section}:{}),...(query.refresh!==undefined?{refresh:query.refresh==='true'}:{}),...(query.key!==undefined?{key:query.key}:{})});
 });
 app.get('/api/codex/extensions/search',{schema:{querystring:{...empty,required:['q'],properties:{projectId,q:{type:'string',minLength:1,maxLength:200,allOf:[{pattern:'\\S'},{pattern:'^[^\\x00-\\x1f]*$'}]},cursor:{type:'string',minLength:1,maxLength:4096,pattern:'^[^\\x00-\\x1f]*$'},refresh}}}},async request=>{
  const query=request.query as {projectId?:string;q:string;cursor?:string;refresh?:string};
  return runtime.searchExtensions(await cwd(query.projectId),{query:query.q.trim(),...(query.cursor!==undefined?{cursor:query.cursor}:{}),...(query.refresh!==undefined?{refresh:query.refresh==='true'}:{})});
 });
 app.post('/api/codex/extensions/action',{bodyLimit:524288,schema:{querystring:empty,body:{...empty,required:['action'],properties:{projectId,action:{type:'string',enum:['enabled','plugin.install','plugin.remove','marketplace.add','marketplace.remove','marketplace.upgrade','mcp.save','mcp.policy','mcp.remove','mcp.login','mcp.logout','mcp.reload','skill.read','skill.create','skill.save','skill.import','skill.remove']},key:{type:'string',pattern:'^[a-f0-9]{64}$'},expectedVersion:{type:'string',minLength:1,maxLength:512},enabled:{type:'boolean'},name:short,source:{type:'string',minLength:1,maxLength:2048},ref:{type:'string',minLength:1,maxLength:512},sparsePaths:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:4096}},config:{type:'object',maxProperties:20},impactVersion:{type:'string',pattern:'^[a-f0-9]{64}$'},scope:{type:'string',enum:['user','repo']},content:{type:'string',maxLength:262144},expectedContentVersion:{type:'string',minLength:1,maxLength:512}}}}},async request=>{
  const {projectId,...input}=request.body as ExtensionMutation&{projectId?:string};
  return runtime.changeExtension(await cwd(projectId),input);
 });
 app.post('/api/codex/settings',{schema:{querystring:empty,body:{...empty,required:['expectedVersion','values'],properties:{projectId,expectedVersion:{type:'string',minLength:1,maxLength:512},values:{...empty,minProperties:1,properties:{model:short,model_reasoning_effort:short,approval_policy:short,approvals_reviewer:short,sandbox_mode:short,workspaceNetworkAccess:{type:'boolean'},web_search:short,service_tier:short,memoriesEnabled:{type:'boolean'},generateMemories:{type:'boolean'},useMemories:{type:'boolean'},allowExternalMemory:{type:'boolean'}}}}}}},async request=>{
  const input=request.body as SettingsWriteInput&{projectId?:string};
  return runtime.writeSettings(await cwd(input.projectId),{expectedVersion:input.expectedVersion,values:input.values});
 });
 const target={...empty,required:['scope'],properties:{scope:{type:'string',enum:['user','project']},projectId}};
 app.get('/api/codex/instructions',{schema:{querystring:target}},async request=>instructions.read(request.query as InstructionTarget));
 app.post('/api/codex/instructions',{bodyLimit:2*1024*1024,schema:{querystring:empty,body:{...target,required:['scope','expectedVersion','content'],properties:{...target.properties,expectedVersion:{type:'string',minLength:1,maxLength:512},content:{type:'string',maxLength:262144}}}}},async request=>{
  const {scope,projectId,expectedVersion,content}=request.body as InstructionTarget&{expectedVersion:string;content:string};
  return instructions.write({scope,...(projectId!==undefined?{projectId}:{})},{expectedVersion,content});
 });
}
