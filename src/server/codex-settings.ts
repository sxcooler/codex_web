import type {FastifyInstance} from 'fastify';
import type {Runtime} from '../codex/runtime.ts';
import type {Projects} from '../projects.ts';
import type {SettingsWriteInput} from '../codex/settings.ts';
import type {Instructions,InstructionTarget} from './instructions.ts';

const short={type:'string',minLength:1,maxLength:120};
const projectId={type:'string',pattern:'^[a-f0-9]{24}$'};
const empty={type:'object',additionalProperties:false,properties:{}};
export function registerCodexSettingsRoutes(app:FastifyInstance,{runtime,projects,instructions}:{runtime:Runtime;projects:Projects;instructions:Instructions}){
 const cwd=async(id?:string)=>id?(await projects.resolve(id)).path:projects.root;
 app.get('/api/codex/settings',{schema:{querystring:{...empty,properties:{projectId}}}},async request=>runtime.readSettings(await cwd((request.query as any).projectId)));
 app.get('/api/codex/plugins',{schema:{querystring:{...empty,properties:{projectId}}}},async request=>runtime.installedPlugins(await cwd((request.query as any).projectId)));
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
