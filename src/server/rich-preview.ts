import {createHash} from 'node:crypto';
import {posix,win32} from 'node:path';
import type {FastifyInstance} from 'fastify';
import type {Project,Projects} from '../projects.ts';

export const MAX_PREVIEW_BYTES=1024*1024;
const invalid=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode,code:'RICH_PREVIEW_INVALID'});

export function previewRelativePath(root:string,value:string):string{
 if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||/[\x00-\x1f\x7f]/.test(value)||/^(?:[\\/]{2}|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)||/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value))throw invalid('Invalid preview path');
 const windows=/^[a-z]:[\\/]/i.test(root),path=windows?win32:posix;
 if(!path.isAbsolute(root))throw invalid('Preview project root is invalid',403);
 if(windows&&(/^[a-z]:[^\\/]/i.test(value)||value.replace(/^[a-z]:/i,'').includes(':')))throw invalid('Invalid Windows preview path');
 if(!windows&&(/^[a-z]:/i.test(value)||value.includes('\\')||/^[a-z][a-z0-9+.-]*:/i.test(value)))throw invalid('Preview path is not local');
 const target=path.resolve(root,value),relative=path.relative(root,target);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw invalid('Preview path escapes project',403);
 return relative.split(path.sep).join('/');
}

export async function readPreviewSnapshot(projects:Pick<Projects,'readReportFile'>,project:Project,value:string){
 const relative=previewRelativePath(project.path,value);
 if(!/\.html?$/i.test(relative))throw invalid('Preview requires an HTML file',415);
 const {path,bytes}=await projects.readReportFile(project.id,relative,MAX_PREVIEW_BYTES);
 if(bytes.length>MAX_PREVIEW_BYTES)throw invalid('Preview exceeds 1 MiB',413);
 let source:string;
 try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw invalid('Preview is not complete UTF-8 text',415);}
 if(source.includes('\0')||!/^\s*<(?:!doctype\s+html\b|[a-z][\w:-]*(?:\s|\/?>))/i.test(source))throw invalid('Preview is not an HTML fragment',415);
 return {path,source,digest:createHash('sha256').update(bytes).digest('hex'),readAt:new Date().toISOString()};
}

export function registerRichPreviewRoutes(app:FastifyInstance,projects:Projects,boundProject:(threadId:string)=>Promise<Project>){
 app.post('/api/sessions/:threadId/rich-preview',{schema:{body:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string',minLength:1,maxLength:4096}}}}},async request=>{
  const {threadId}=request.params as {threadId:string};
  return readPreviewSnapshot(projects,await boundProject(threadId),(request.body as {path:string}).path);
 });
}
