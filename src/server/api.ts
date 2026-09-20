import { join, resolve, isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Runtime } from '../codex/runtime.ts';
import type { Projects } from '../projects.ts';
import { pathKey } from '../projects.ts';
import { MetadataStore } from './metadata.ts';
import { AccountUsage } from './account-usage.ts';
import { parseTestReport } from './test-reports.ts';
import type { UploadService } from './uploads.ts';
import {renderNativeImage} from './native-images.ts';

const text = { type: 'string', minLength: 1, maxLength: 12_000 };
const short = { type: 'string', minLength: 1, maxLength: 120 };
const requestId = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const body = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  body: { type: 'object', additionalProperties: false, properties, required },
});
const params = (request: FastifyRequest) => request.params as { threadId: string; requestId: string; turnId: string; itemId: string };

export function registerApi(app: FastifyInstance, options: {
  dataDir: string; runtime: Runtime; projects: Projects; authenticated: (request: FastifyRequest) => () => boolean;
  uploads?: UploadService; uploadOwner?: (request:FastifyRequest)=>string;
}) {
  const { runtime, projects } = options;
  const empty = { type: 'object', additionalProperties: false, properties: {} };
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/projects') && !route.url.startsWith('/api/sessions')) return;
    const fields: Record<string, unknown> = {};
    if (route.url.includes(':threadId')) fields.threadId = { ...short, pattern: '^[a-zA-Z0-9-]+$' };
    if (route.url.includes(':requestId')) fields.requestId = { ...short, maxLength: 256, pattern: '^[a-zA-Z0-9:_-]+$' };
    for (const name of ['turnId', 'itemId']) if (route.url.includes(':' + name)) fields[name] = { ...short, maxLength: 256, pattern: '^[a-zA-Z0-9:_-]+$' };
    if(route.url.includes(':imageId'))fields.imageId={type:'string',pattern:'^[a-f0-9]{64}$'};
    route.schema = { querystring: empty, ...route.schema,
      ...(Object.keys(fields).length ? { params: { ...empty, required: Object.keys(fields), properties: fields } } : {}),
      ...(/\/(abort|release|refresh|release-on-leave|cancel-release)$/.test(route.url) ? { body: empty } : {}),
    };
  });
  const metadata = new MetadataStore(join(options.dataDir, 'metadata.sqlite'));
  const accountUsage=new AccountUsage(runtime,metadata.db);
  app.get('/api/account/usage',{schema:{querystring:{type:'object',additionalProperties:false,properties:{refresh:{type:'string',enum:['true']}}}}},async request=>accountUsage.read((request.query as any).refresh==='true'));
  app.post('/api/account/usage/reset',{schema:{...body({accountId:{type:'string',pattern:'^[a-f0-9]{64}$'},creditId:{type:'string',minLength:1,maxLength:512},idempotencyKey:{type:'string',format:'uuid'}}),querystring:empty}},async request=>accountUsage.reset(request.body as any));
  const readMeta = (threadId: string) => { try { return metadata.get(threadId); } catch { return null; } };
  const saveMeta = (threadId: string, projectPath: string | null, title: string | null) => {
    try { metadata.save(threadId, projectPath, title); return undefined; }
    catch { return 'Web metadata could not be saved; native thread history remains available.'; }
  };
  const connections = new Set<{ valid: () => boolean; close: () => void }>();
  const closeInvalid = () => { for (const connection of connections) if (!connection.valid()) connection.close(); };
  const expiry = setInterval(closeInvalid, 10_000); expiry.unref();
  app.addHook('preClose', async () => { for (const connection of [...connections]) connection.close(); });
  app.addHook('onClose', async () => {
    clearInterval(expiry); for (const connection of [...connections]) connection.close();
    accountUsage.close(); await runtime.close(); metadata.close();
  });

  async function projectForCwd(cwd: unknown) {
    return typeof cwd === 'string' && isAbsolute(cwd) && (process.platform === 'win32' || !cwd.startsWith('//'))
      ? (await projects.list()).find(p => pathKey(resolve(p.path)) === pathKey(resolve(cwd))) ?? null : null;
  }

  async function associated(threadId: string) {
    const snapshot = await runtime.snapshot(threadId, { window: true });
    const project = await projectForCwd(snapshot.thread.cwd);
    const warning = saveMeta(threadId, project?.path ?? null, null);
    return { ...snapshot, project, metadata: readMeta(threadId), warning };
  }

  const turnFields={model:short,effort:short,permissionMode:{type:'string',enum:['ask','auto-review','full-access','custom']},attachmentIds:{type:'array',maxItems:5,uniqueItems:true,items:{type:'string',pattern:'^[a-f0-9-]{36}$'}}};
  async function attachments(input:any,request:FastifyRequest,threadId:string|null){
    if(!input.attachmentIds?.length)return [];
    if(!options.uploads||!options.uploadOwner)throw Object.assign(new Error('Attachments unavailable'),{statusCode:503});
    const claimed=await options.uploads.claim(options.uploadOwner(request),threadId,input.clientRequestId,input.attachmentIds);
    return claimed.inputs.map(item=>item.type==='text'?{...item,text_elements:[] as []}:item);
  }
  async function rollbackRejected(input:any,request:FastifyRequest,error:any){
    const safe=['RUNTIME_INVALID_INPUT','RUNTIME_INVALID_MODEL','RUNTIME_INVALID_EFFORT','RUNTIME_MODEL_INPUT_UNSUPPORTED','RUNTIME_THREAD_BUSY','RUNTIME_THREAD_CONFLICT','RUNTIME_STEER_CONFLICT','RUNTIME_NOT_FOUND','RUNTIME_PERMISSION_UNAVAILABLE'];
    if(input.attachmentIds?.length&&!error.partial?.threadId&&error.statusCode<500&&safe.includes(error.code))await options.uploads!.rollbackClaim(options.uploadOwner!(request),input.clientRequestId);
  }
  async function createSession(input: any,request:FastifyRequest) {
    const project = input.projectId ? await projects.resolve(input.projectId) : null;
    const nativeInput=await attachments(input,request,null);
    let result:any;
    try{result=await runtime.create({ cwd: project?.path ?? projects.root, clientRequestId: input.clientRequestId, prompt: input.prompt, model: input.model,effort:input.effort,permissionMode:input.permissionMode,...(nativeInput.length?{nativeInput}:{}) });}
    catch(error:any){if(error.partial?.threadId&&nativeInput.length)await options.uploads!.bindClaim(options.uploadOwner!(request),input.clientRequestId,error.partial.threadId);else await rollbackRejected(input,request,error);throw error;}
    if(nativeInput.length)await options.uploads!.bindClaim(options.uploadOwner!(request),input.clientRequestId,result.threadId);
    const warning = saveMeta(result.threadId, project?.path ?? null, input.prompt?.slice(0, 80) ?? null);
    return { ...result, warning };
  }

  app.get('/api/projects', async () => ({ projects: await projects.list() }));
  app.post('/api/projects/refresh', async () => ({ projects: await projects.refresh() }));
  app.get('/api/models',async()=>runtime.models());
  app.get('/api/permission-modes',{schema:{querystring:{type:'object',additionalProperties:false,properties:{projectId:short}}}},async request=>runtime.permissionModes((request.query as any).projectId?(await projects.resolve((request.query as any).projectId)).path:projects.root));
  const projectFields = { name: short, folderName: { ...short, maxLength: 80 }, initialPrompt: {...text,minLength:0}, clientRequestId: requestId, ...turnFields };
  for (const clone of [false, true]) {
    app.post(clone ? '/api/projects/clone' : '/api/projects', {
      schema: body({ ...projectFields, ...(clone ? { repoUrl: { ...text, maxLength: 2048 } } : {}) }, clone ? ['name','folderName','repoUrl'] : ['name','folderName']),
    }, async (request, reply) => {
      const input = request.body as any;
      if (input.initialPrompt && !input.clientRequestId) return reply.code(400).send({ error: 'clientRequestId required with initialPrompt' });
      const project = await projects.create(input);
      if (!input.clientRequestId) return { project };
      try {
        return { project, session: await createSession({ ...input, projectId: project.id, prompt: input.initialPrompt },request) };
      } catch (error: any) {
        const known = typeof error.code === 'string' && error.code.startsWith('RUNTIME_');
        return reply.code(known ? error.statusCode : 500).send({
          error: error.statusCode === 504 ? 'Project created; session result is uncertain. Check Recent Sessions before retrying.' : 'Project created; session could not be confirmed. Check Recent Sessions before retrying.',
          code: known ? error.code : 'SESSION_CREATION_FAILED', project, partial: known ? error.partial : undefined,
        });
      }
    });
  }
  app.get('/api/sessions', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { cursor: { ...text, maxLength: 2048 }, includeHidden:{type:'string',enum:['true','false']},archived:{type:'string',enum:['true','false']} } } } }, async request => {
    const query=request.query as any; let result=await runtime.list(query.cursor,query.archived==='true'); const wanted=result.data.length; const data:any[]=[];
    while(true){for(const thread of result.data){const meta=readMeta(thread.id);if(query.archived==='true'||query.includeHidden==='true'||!meta?.hidden)data.push({...thread,metadata:meta});}if(data.length>=wanted||!result.nextCursor)break;result=await runtime.list(result.nextCursor,query.archived==='true');}
    return { ...result, data, nextCursor:result.nextCursor };
  });
  app.post('/api/sessions', { schema: body({ projectId: short, clientRequestId: requestId, prompt: {...text,minLength:0}, ...turnFields }, ['clientRequestId']) }, async request => createSession(request.body,request));
  app.get('/api/sessions/:threadId', async request => {const id=params(request).threadId;return {...await associated(id),attachmentPreviews:options.uploads&&options.uploadOwner?options.uploads.listForThread(options.uploadOwner(request),id).map(item=>({...item,url:'/api/uploads/'+item.uploadId})):[]};});
  app.get('/api/sessions/:threadId/history', { schema: { querystring: { type: 'object', additionalProperties: false, required: ['before'], properties: { before: { ...short, maxLength: 256, pattern: '^[a-zA-Z0-9:_-]+$' } } } } }, async request => {
    const id = params(request).threadId;
    return { ...await runtime.history(id, (request.query as any).before), attachmentPreviews: options.uploads && options.uploadOwner ? options.uploads.listForThread(options.uploadOwner(request), id).map(item => ({ ...item, url: '/api/uploads/' + item.uploadId })) : [] };
  });
  app.get('/api/sessions/:threadId/turns/:turnId/items/:itemId/output', async request => {
    const { threadId, turnId, itemId } = params(request);
    return runtime.output(threadId, turnId, itemId);
  });
  // At most 4 MiB of thumbnails; two workers keep decoding off the history response path.
  type ImageResult=Awaited<ReturnType<typeof renderNativeImage>>;
  const thumbnails=new Map<string,ImageResult>(),imageJobs=new Map<string,Promise<ImageResult>>(),workers=[Promise.resolve(),Promise.resolve()];let nextWorker=0;
  app.get('/api/sessions/:threadId/turns/:turnId/items/:itemId/images/:imageId',{schema:{querystring:{type:'object',additionalProperties:false,properties:{size:{type:'string',enum:['thumbnail','original']}}}}},async(request,reply)=>{
    const {threadId,turnId,itemId,imageId}=request.params as any,original=(request.query as any).size==='original';
    const key=JSON.stringify([threadId,turnId,itemId,imageId,original]);
    let result=!original?thumbnails.get(key):undefined;
    if(!result){
      let job=imageJobs.get(key);
      if(!job){
        if(imageJobs.size>=32)return reply.code(429).header('retry-after','2').send({error:'图片加载繁忙，请稍后重试。'});
        const worker=nextWorker++%workers.length;
        job=workers[worker].then(async()=>renderNativeImage(await runtime.image(threadId,turnId,itemId,imageId),original));
        workers[worker]=job.then(()=>{},()=>{});imageJobs.set(key,job);
      }
      try{result=await job;if(!original){thumbnails.set(key,result);while(thumbnails.size>64)thumbnails.delete(thumbnails.keys().next().value!);}}
      finally{if(imageJobs.get(key)===job)imageJobs.delete(key);}
    }
    return reply.header('cache-control','no-store').header('content-disposition','inline').type(result.type).send(result.bytes);
  });
  app.post('/api/sessions/:threadId/messages', { schema: body({ text:{...text,minLength:0}, clientRequestId: requestId, expectedTurnId:short, ...turnFields }, ['text','clientRequestId']) }, async request => {const input=request.body as any;const nativeInput=await attachments(input,request,params(request).threadId);try{const result=await runtime.send(params(request).threadId,{text:input.text,clientRequestId:input.clientRequestId,expectedTurnId:input.expectedTurnId,model:input.model,effort:input.effort,permissionMode:input.permissionMode,...(nativeInput.length?{nativeInput}:{})});if(nativeInput.length)await options.uploads!.bindClaim(options.uploadOwner!(request),input.clientRequestId,params(request).threadId);return result;}catch(error){await rollbackRejected(input,request,error);throw error;}});
  app.post('/api/sessions/:threadId/abort', async request => runtime.abort(params(request).threadId));
  for(const archived of [true,false])app.post('/api/sessions/:threadId/'+(archived?'archive':'unarchive'),{schema:body({},[])},async request=>runtime.archive(params(request).threadId,archived));
  app.post('/api/sessions/:threadId/open',{schema:body({},[])},async request=>runtime.open(params(request).threadId));
  app.post('/api/sessions/:threadId/release', async request => runtime.release(params(request).threadId));
  app.post('/api/sessions/:threadId/release-on-leave', async request => runtime.requestRelease(params(request).threadId));
  app.post('/api/sessions/:threadId/cancel-release', async request => runtime.cancelRelease(params(request).threadId));
  app.post('/api/sessions/:threadId/name',{schema:body({name:short},['name'])},async request=>{const id=params(request).threadId;const name=(request.body as any).name.trim();if(!name)throw Object.assign(new Error('Invalid name'),{statusCode:400});await runtime.rename(id,name);const current=readMeta(id);const value=metadata.update(id,{webTitle:name});return {name,metadata:value,warning:current===null?'Web metadata created':undefined};});
  app.post('/api/sessions/:threadId/metadata',{schema:body({favorite:{type:'boolean'},hidden:{type:'boolean'}},[])},async request=>({metadata:metadata.update(params(request).threadId,request.body as any)}));
  app.post('/api/sessions/:threadId/metadata/clear',{schema:body({},[])},async request=>{metadata.clear(params(request).threadId);return {metadata:null};});
  app.post('/api/sessions/:threadId/requests/:requestId/respond', { schema: body({ answer: { type: 'object', maxProperties: 8 } }) }, async request => runtime.respond(params(request).threadId, params(request).requestId, (request.body as any).answer));

  const boundProject=async(threadId:string)=>{const project=await projectForCwd(await runtime.threadCwd(threadId));if(!project)throw Object.assign(new Error('This thread is not bound to a project in WORK_ROOT'),{statusCode:404,code:'PROJECT_ERROR'});return project;};
  app.get('/api/sessions/:threadId/git/status', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { staged: { type: 'string', enum: ['true','false'] } } } } }, async request => {
    const project = await boundProject(params(request).threadId);
    return projects.gitStatus(project.id);
  });
  app.post('/api/sessions/:threadId/git/fetch',{schema:body({},[])},async request=>{const project=await boundProject(params(request).threadId);return projects.fetchRemotes(project.id);});
  app.get('/api/sessions/:threadId/git/log',{schema:{querystring:{type:'object',additionalProperties:false,properties:{ref:{type:'string',minLength:1,maxLength:512},cursor:{type:'string',minLength:1,maxLength:4096}}}}},async request=>{const project=await boundProject(params(request).threadId),q=request.query as any;return projects.gitLog(project.id,q.ref??'HEAD',q.cursor);});
  app.get('/api/sessions/:threadId/git/commit',{schema:{querystring:{type:'object',additionalProperties:false,required:['commit'],properties:{commit:{type:'string',pattern:'^[0-9a-fA-F]{40,64}$'},parent:{type:'string',pattern:'^[0-9a-fA-F]{40,64}$'}}}}},async request=>{const project=await boundProject(params(request).threadId),q=request.query as any;return projects.gitCommit(project.id,q.commit,q.parent);});
  app.get('/api/sessions/:threadId/git/commit/diff',{schema:{querystring:{type:'object',additionalProperties:false,required:['commit','path'],properties:{commit:{type:'string',pattern:'^[0-9a-fA-F]{40,64}$'},parent:{type:'string',pattern:'^[0-9a-fA-F]{40,64}$'},path:{type:'string',minLength:1,maxLength:1024}}}}},async request=>{const project=await boundProject(params(request).threadId),q=request.query as any;return projects.gitCommitDiff(project.id,q.commit,q.parent,q.path);});
  app.get('/api/sessions/:threadId/git/files',{schema:{querystring:{type:'object',additionalProperties:false,properties:{staged:{type:'string',enum:['true','false']}}}}},async request=>{const project=await boundProject(params(request).threadId);return projects.gitFiles(project.id,(request.query as any).staged==='true');});
  app.get('/api/sessions/:threadId/git/diff',{schema:{querystring:{type:'object',additionalProperties:false,properties:{staged:{type:'string',enum:['true','false']},path:{type:'string',minLength:1,maxLength:1024}}}}},async request=>{const project=await boundProject(params(request).threadId),q=request.query as any;return q.path?projects.gitFileDiff(project.id,q.path,q.staged==='true'):projects.gitDiff(project.id,q.staged==='true');});
  app.get('/api/sessions/:threadId/git/diff/patch',{schema:{querystring:{type:'object',additionalProperties:false,required:['path'],properties:{staged:{type:'string',enum:['true','false']},path:{type:'string',minLength:1,maxLength:1024}}}}},async(request,reply)=>{const project=await boundProject(params(request).threadId),q=request.query as any;const patch=await projects.gitPatch(project.id,q.path,q.staged==='true');if(Buffer.byteLength(patch)>5*1024*1024)return reply.code(413).send({error:'Patch exceeds 5 MiB'});return reply.type('text/x-diff; charset=utf-8').header('content-disposition','attachment; filename="change.patch"').send(patch);});
  app.get('/api/sessions/:threadId/files',{schema:{querystring:{type:'object',additionalProperties:false,properties:{directory:{type:'string',maxLength:1024}}}}},async request=>{const project=await boundProject(params(request).threadId);return projects.listFiles(project.id,(request.query as any).directory??'');});
  app.get('/api/sessions/:threadId/files/content',{schema:{querystring:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string',minLength:1,maxLength:1024}}}}},async request=>{const project=await boundProject(params(request).threadId);return projects.readFile(project.id,(request.query as any).path);});
  app.get('/api/sessions/:threadId/files/image',{schema:{querystring:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string',minLength:1,maxLength:1024},v:{type:'string',maxLength:64},revision:{type:'string',pattern:'^(index|[0-9a-fA-F]{40,64})$'}}}}},async(request,reply)=>{const project=await boundProject(params(request).threadId);const image=await projects.readImage(project.id,(request.query as any).path,(request.query as any).revision);return reply.headers({'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}).type('image/webp').send(image);});
  app.post('/api/sessions/:threadId/test-reports',{schema:body({commandItemId:short,relativePath:{type:'string',minLength:1,maxLength:1024},format:{type:'string',enum:['junit']}},['commandItemId','relativePath','format'])},async request=>{const id=params(request).threadId,project=await boundProject(id),snapshot=await runtime.snapshot(id);return parseTestReport(projects,project.id,snapshot,request.body as any);});

  app.get('/api/sessions/:threadId/status', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { epoch: { ...short, pattern: '^[a-zA-Z0-9-]+$' } } } } }, async request => runtime.status(params(request).threadId, (request.query as any).epoch));
  app.get('/api/sessions/:threadId/events', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 160, pattern: '^[a-zA-Z0-9-]+:[0-9]+$' } } } } }, async (request, reply) => {
    const threadId = params(request).threadId;
    const valid = options.authenticated(request);
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      clearInterval(heartbeat); runtime.off('change', changed); connections.delete(connection); stream.end();
    };
    const write = (kind: string, data: unknown, id?: string) => {
      if (closed) return;
      if (!valid() || stream.writableLength > 256 * 1024) return close();
      stream.write(`${id ? `id: ${id}\n` : ''}event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const changed = (event: any) => { if (event.threadId === threadId) write(event.kind === 'resync' ? 'resync' : 'change', event, event.id); };
    const heartbeat = setInterval(() => write('ping', {}), 15_000); heartbeat.unref();
    const connection = { valid, close }; connections.add(connection);
    stream.on('close', close); runtime.on('change', changed);
    const lastId = request.headers['last-event-id'];
    const replay = runtime.replay(threadId, typeof lastId === 'string' ? lastId : (request.query as any).cursor);
    if (replay.reset) write('resync', {});
    else for (const event of replay.events) write(event.kind === 'resync' ? 'resync' : 'change', event, event.id);
    write('ready', {});
  });
  return { closeInvalid };
}
