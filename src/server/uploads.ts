import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const IMAGE_MIMES=new Map([['image/png','.png'],['image/jpeg','.jpg'],['image/webp','.webp']]);
const FILE_MIMES=new Set(['text/plain','text/markdown','text/csv','application/json','application/pdf']);
const FILE_EXTENSIONS=new Map([['text/plain',new Set(['.txt'])],['text/markdown',new Set(['.md','.markdown'])],['text/csv',new Set(['.csv'])],['application/json',new Set(['.json'])],['application/pdf',new Set(['.pdf'])]]);
const DEFAULTS={maxFileBytes:15*1024*1024,maxBatchBytes:75*1024*1024,maxFiles:5,quotaBytes:1024**3,draftTtlMs:86400_000};
type StoredUpload={uploadId:string;name:string;mime:string;size:number;kind:'file'|'image'};
type UploadInput={name:string;mime:string;data:Buffer};
type UploadStream={name:string;mime:string;data:AsyncIterable<Uint8Array>&{truncated?:boolean}};
type NativeInput={type:'localImage';path:string}|{type:'text';text:string;text_elements:[]};
function uploadError(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode,code:'UPLOAD_ERROR'});}
function safeName(value:string){return basename(value.replaceAll('\\','/')).replace(/[\r\n"]/g,'_').slice(0,255)||'attachment';}
function mutex(){let tail=Promise.resolve();return <T>(work:()=>Promise<T>|T)=>{const next=tail.then(work,work);tail=next.then(()=>undefined,()=>undefined);return next;};}

async function validate(input:{name:string;mime:string},path:string,head:Buffer){
  const ext=extname(input.name).toLowerCase();
  if(IMAGE_MIMES.has(input.mime)){
    const expected=IMAGE_MIMES.get(input.mime)!;
    try{const image=sharp(path,{limitInputPixels:40_000_000,failOn:'error'});const meta=await image.metadata();const actual=meta.format==='jpeg'?'image/jpeg':`image/${meta.format}`;if(actual!==input.mime||!meta.width||!meta.height||meta.width*meta.height>40_000_000)throw new Error();await image.toBuffer();}catch{throw uploadError(400,'Invalid image content or dimensions');}
    if(expected==='.jpg'?!['.jpg','.jpeg'].includes(ext):ext!==expected)throw uploadError(400,'Image extension does not match content type');
    return 'image' as const;
  }
  if(!FILE_MIMES.has(input.mime)||['.svg','.html','.htm','.exe','.dll','.zip','.rar','.7z','.tar','.gz'].includes(ext))throw uploadError(400,'File content type is not allowed');
  if(!FILE_EXTENSIONS.get(input.mime)?.has(ext))throw uploadError(400,'File extension does not match content type');
  const signature=head.subarray(0,4).toString('hex'),text=head.toString('utf8').trimStart().toLowerCase();
  if(input.mime==='application/pdf'){if(head.subarray(0,5).toString()!=='%PDF-')throw uploadError(400,'File content does not match MIME type');return 'file' as const;}
  if(head.includes(0)||head.subarray(0,2).toString()==='MZ'||signature==='7f454c46'||signature.startsWith('504b')||signature.startsWith('1f8b')||/^(?:<!doctype\s+html|<html|<svg|<script)/.test(text))throw uploadError(400,'Binary or executable content is not allowed');
  return 'file' as const;
}

export async function createUploadService(options:{dataDir:string;maxFileBytes?:number;maxBatchBytes?:number;maxFiles?:number;quotaBytes?:number;draftTtlMs?:number}){
  const limits={...DEFAULTS,...options},uploadDir=join(options.dataDir,'uploads'),exclusive=mutex();
  await mkdir(uploadDir,{recursive:true,mode:0o700});await chmod(uploadDir,0o700);
  const db=new DatabaseSync(join(options.dataDir,'uploads.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,original_name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,relative_path TEXT NOT NULL,created_at INTEGER NOT NULL,claimed_thread_id TEXT,claimed_request_id TEXT,accepted_at INTEGER);CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner_id);`);
  const columns=db.prepare('PRAGMA table_info(uploads)').all() as any[];if(!columns.some(x=>x.name==='accepted_at'))db.exec('ALTER TABLE uploads ADD COLUMN accepted_at INTEGER');
  const get=db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=?');
  const metadata=(row:any):StoredUpload=>({uploadId:row.id,name:row.original_name,mime:row.mime,size:row.size,kind:row.mime.startsWith('image/')?'image':'file'});
  const service={
    limits,
    async store(ownerId:string,input:UploadInput){return(await service.storeMany(ownerId,[input]))[0];},
    async storeMany(ownerId:string,inputs:UploadInput[]):Promise<StoredUpload[]>{
      if(!ownerId)throw uploadError(401,'Authentication required');
      if(!inputs.length||inputs.length>limits.maxFiles)throw uploadError(400,`At most ${limits.maxFiles} files are allowed`);
      if(inputs.some(input=>input.data.length>limits.maxFileBytes))throw uploadError(413,`File exceeds ${limits.maxFileBytes} bytes`);
      if(inputs.reduce((total,input)=>total+input.data.length,0)>limits.maxBatchBytes)throw uploadError(413,`Batch exceeds ${limits.maxBatchBytes} bytes`);
      return service.storeStreams(ownerId,inputs.map(input=>({...input,data:(async function*(){yield input.data;})()})));
    },
    storeStreams(ownerId:string,inputs:AsyncIterable<UploadStream>|Iterable<UploadStream>):Promise<StoredUpload[]>{
      // ponytail: one storage/decode queue bounds quota and image memory; split reservations if throughput requires parallel uploads.
      return exclusive(async()=>{
        if(!ownerId)throw uploadError(401,'Authentication required');
        const used=Number((db.prepare('SELECT COALESCE(SUM(size),0) used FROM uploads').get() as any).used);
        const paths:string[]=[],created:{item:StoredUpload;relative:string;sha:string}[]=[];
        let total=0,transaction=false;
        try{
          for await(const input of inputs){
            if(created.length>=limits.maxFiles)throw uploadError(400,`At most ${limits.maxFiles} files are allowed`);
            const id=randomUUID(),relative=`${id}${IMAGE_MIMES.get(input.mime)??'.bin'}`,final=join(uploadDir,relative),temp=`${final}.tmp`;
            paths.push(temp,final);
            const hash=createHash('sha256');let size=0,head=Buffer.alloc(0);
            const handle=await open(temp,'wx',0o600);
            try{
              for await(const chunk of input.data){
                size+=chunk.length;total+=chunk.length;
                if(size>limits.maxFileBytes)throw uploadError(413,`File exceeds ${limits.maxFileBytes} bytes`);
                if(total>limits.maxBatchBytes)throw uploadError(413,`Batch exceeds ${limits.maxBatchBytes} bytes`);
                if(used+total>limits.quotaBytes)throw uploadError(507,'Private upload quota exceeded');
                if(head.length<256)head=Buffer.concat([head,chunk.subarray(0,256-head.length)]);
                hash.update(chunk);await handle.writeFile(chunk);
              }
              if(input.data.truncated)throw uploadError(413,`File exceeds ${limits.maxFileBytes} bytes`);
              await handle.sync();
            }finally{await handle.close();}
            const kind=await validate(input,temp,head);
            await rename(temp,final);
            created.push({item:{uploadId:id,name:safeName(input.name),mime:input.mime,size,kind},relative,sha:hash.digest('hex')});
          }
          if(!created.length)throw uploadError(400,`At most ${limits.maxFiles} files are allowed`);
          db.exec('BEGIN IMMEDIATE');transaction=true;
          for(const {item,relative,sha} of created)db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL)').run(item.uploadId,ownerId,item.name,item.mime,item.size,sha,relative,Date.now());
          db.exec('COMMIT');transaction=false;
          return created.map(x=>x.item);
        }catch(e){if(transaction)db.exec('ROLLBACK');for(const path of paths)await rm(path,{force:true}).catch(()=>{});throw e;}
      });
    },
    claim(ownerId:string,threadId:string|null,requestId:string,ids:string[]){return exclusive(()=>{if(!ids.length||ids.length>limits.maxFiles||new Set(ids).size!==ids.length)throw uploadError(400,'Invalid attachment IDs');const rows=ids.map(id=>get.get(id,ownerId) as any);if(rows.some(row=>!row))throw uploadError(404,'Upload not found');if(rows.reduce((n,row)=>n+row.size,0)>limits.maxBatchBytes)throw uploadError(413,`Attachments exceed ${limits.maxBatchBytes} bytes`);db.exec('BEGIN IMMEDIATE');try{for(const row of rows){if(row.claimed_request_id&&(row.claimed_request_id!==requestId||(threadId&&row.claimed_thread_id&&row.claimed_thread_id!==threadId)))throw uploadError(409,'Upload already claimed');db.prepare('UPDATE uploads SET claimed_thread_id=COALESCE(claimed_thread_id,?),claimed_request_id=? WHERE id=?').run(threadId,requestId,row.id);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}const inputs:NativeInput[]=rows.map(row=>row.mime.startsWith('image/')?{type:'localImage',path:resolve(uploadDir,row.relative_path)}:{type:'text',text:`Attached file ${JSON.stringify(row.original_name)} is stored at ${JSON.stringify(resolve(uploadDir,row.relative_path))}. Read it only if needed for this request.`,text_elements:[]});return{inputs,uploads:rows.map(metadata)};});},
    bindClaim(ownerId:string,requestId:string,threadId:string){return exclusive(()=>{const conflict=db.prepare('SELECT 1 FROM uploads WHERE owner_id=? AND claimed_request_id=? AND claimed_thread_id IS NOT NULL AND claimed_thread_id<>?').get(ownerId,requestId,threadId);if(conflict)throw uploadError(409,'Upload claim belongs to another thread');return Number(db.prepare('UPDATE uploads SET claimed_thread_id=?,accepted_at=COALESCE(accepted_at,?) WHERE owner_id=? AND claimed_request_id=?').run(threadId,Date.now(),ownerId,requestId).changes);});},
    rollbackClaim(ownerId:string,requestId:string){return exclusive(()=>Number(db.prepare('UPDATE uploads SET claimed_thread_id=NULL,claimed_request_id=NULL WHERE owner_id=? AND claimed_request_id=? AND accepted_at IS NULL').run(ownerId,requestId).changes));},
    listForThread(ownerId:string,threadId:string){return(db.prepare('SELECT * FROM uploads WHERE owner_id=? AND claimed_thread_id=? AND accepted_at IS NOT NULL ORDER BY created_at').all(ownerId,threadId) as any[]).map(row=>({...metadata(row),path:resolve(uploadDir,row.relative_path)}));},
    async read(ownerId:string,id:string){const row=get.get(id,ownerId) as any;if(!row)throw uploadError(404,'Upload not found');return{...row,path:join(uploadDir,row.relative_path),data:await readFile(join(uploadDir,row.relative_path))};},
    cleanup(now=Date.now()){return exclusive(async()=>{const rows=db.prepare('SELECT id,relative_path FROM uploads WHERE claimed_request_id IS NULL AND created_at<?').all(now-limits.draftTtlMs) as any[];for(const row of rows){await rm(join(uploadDir,row.relative_path),{force:true});db.prepare('DELETE FROM uploads WHERE id=? AND claimed_request_id IS NULL').run(row.id);}return rows.length;});},
    close(){db.close();}
  };return service;
}
export type UploadService=Awaited<ReturnType<typeof createUploadService>>;
type Access={authenticated:(request:FastifyRequest)=>boolean;owner:(request:FastifyRequest)=>string};
export async function registerUploadRoutes(app:FastifyInstance,service:UploadService,access:Access){await app.register((await import('@fastify/multipart')).default,{limits:{fileSize:service.limits.maxFileBytes,files:service.limits.maxFiles,parts:service.limits.maxFiles}});app.post('/api/uploads',async(request,reply)=>{if(!access.authenticated(request))return reply.code(401).send({error:'Authentication required'});async function* files(){for await(const part of request.files())yield{name:part.filename,mime:part.mimetype,data:part.file};}const uploads=await service.storeStreams(access.owner(request),files());return uploads.length===1?uploads[0]:{uploads};});app.get('/api/uploads/:id',async(request,reply)=>{if(!access.authenticated(request))return reply.code(401).send({error:'Authentication required'});const item=await service.read(access.owner(request),(request.params as any).id);reply.headers({'x-content-type-options':'nosniff','cache-control':'no-store','content-disposition':`${item.mime.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.original_name)}`,'content-type':item.mime});return item.data;});}
