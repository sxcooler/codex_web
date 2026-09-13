import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {FastifyInstance,FastifyRequest} from 'fastify';

const compress=promisify(gzip);
const textType=/^(?:text\/(?!event-stream)[^;]+|application\/(?:json|javascript|[a-z0-9.+-]+\+json)|image\/svg\+xml)(?:;|$)/i;
function acceptsGzip(header:string|undefined):boolean {
  const encodings=(header??'').split(',').map(part=>{const [name,...params]=part.trim().toLowerCase().split(';');const q=params.find(p=>p.trim().startsWith('q='))?.trim().slice(2);return {name,q:q===undefined?1:/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)?Number(q):0};});
  const explicit=encodings.filter(entry=>entry.name==='gzip'),matched=explicit.length?explicit:encodings.filter(entry=>entry.name==='*');
  return matched.length>0&&matched.every(entry=>entry.q>0);
}

export function registerResponseHooks(app:FastifyInstance):void {
  const starts=new WeakMap<FastifyRequest,number>();
  app.addHook('onRequest',async request=>{starts.set(request,performance.now());});
  app.addHook('onSend',async(request,reply,payload)=>{
    const ready=performance.now();
    if(typeof payload!=='string'&&!Buffer.isBuffer(payload))return payload;
    const original=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
    let result=original,gzipMs=0;
    const eligible=request.method!=='HEAD'&&![204,304].includes(reply.statusCode)&&!reply.getHeader('content-encoding')&&!reply.getHeader('set-cookie')
      &&!request.routeOptions.url?.startsWith('/api/auth/')&&textType.test(String(reply.getHeader('content-type')??''))
      &&!/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(String(reply.getHeader('cache-control')??''));
    if(eligible){
      const vary=String(reply.getHeader('vary')??'').split(',').map(value=>value.trim()).filter(Boolean);
      if(!vary.some(value=>value==='*'||value.toLowerCase()==='accept-encoding'))reply.header('vary',[...vary,'Accept-Encoding'].join(', '));
      if(original.length>=1024&&acceptsGzip(request.headers['accept-encoding'])){
        const start=performance.now(),compressed=await compress(original);gzipMs=performance.now()-start;
        if(compressed.length<original.length){result=compressed;reply.header('content-encoding','gzip');reply.removeHeader('content-length');}
      }
    }
    const timing=[`app;dur=${Math.max(0,ready-(starts.get(request)??ready)).toFixed(2)}`,`gzip;dur=${gzipMs.toFixed(2)}`].join(', ');
    reply.header('server-timing',[reply.getHeader('server-timing'),timing].filter(Boolean).join(', '));
    const bodyless=request.method==='HEAD'||[204,304].includes(reply.statusCode);
    reply.header('x-response-uncompressed-bytes',bodyless?0:original.length);
    reply.header('x-response-bytes',bodyless?0:result.length);
    return result===original?payload:result;
  });
}
