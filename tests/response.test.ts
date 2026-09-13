import assert from 'node:assert/strict';
import test from 'node:test';
import {gunzipSync} from 'node:zlib';
import Fastify from 'fastify';
import {registerResponseHooks} from '../src/server/response.ts';

test('gzip negotiation preserves content, cache variants, timing and excluded responses',async()=>{
  const app=Fastify();registerResponseHooks(app);
  const body={text:'中文 history output '.repeat(10000)};
  app.get('/large',async(_request,reply)=>reply.header('cache-control','no-store').header('vary','Origin').send(body));
  app.get('/small',async()=>({ok:true}));
  app.get('/asset',async(_request,reply)=>reply.type('text/javascript').header('cache-control','public, max-age=31536000, immutable').send('const text="'+body.text+'";'));
  app.get('/events',async(_request,reply)=>reply.type('text/event-stream').send('data: '+body.text+'\n\n'));
  app.get('/image',async(_request,reply)=>reply.type('image/png').send(Buffer.alloc(2048)));
  app.get('/encoded',async(_request,reply)=>reply.type('text/plain').header('content-encoding','br').send(body.text));
  app.get('/unchanged',async(_request,reply)=>reply.type('text/plain').header('cache-control','no-transform').send(body.text));
  app.get('/api/auth/session',async()=>body);
  app.get('/cookie',async(_request,reply)=>reply.header('set-cookie','secret=value').send(body));
  app.get('/empty',async(_request,reply)=>reply.code(204).send());
  app.get('/cached',async(_request,reply)=>reply.code(304).send());
  try{
    const zip=await app.inject({url:'/large',headers:{'accept-encoding':'br, gzip'}});
    assert.equal(zip.headers['content-encoding'],'gzip');assert.deepEqual(JSON.parse(gunzipSync(zip.rawPayload).toString()),body);
    assert.equal(zip.headers.vary,'Origin, Accept-Encoding');assert.equal(zip.headers['cache-control'],'no-store');
    assert.equal(Number(zip.headers['x-response-bytes']),zip.rawPayload.length);assert.equal(Number(zip.headers['x-response-uncompressed-bytes']),Buffer.byteLength(JSON.stringify(body)));
    assert.match(String(zip.headers['server-timing']),/^app;dur=\d+\.\d+, gzip;dur=\d+\.\d+$/);assert.ok(zip.rawPayload.length<Buffer.byteLength(body.text)/10);
    for(const encoding of ['identity','gzip;q=0, *;q=1','gzip;q=invalid','gzip;q=0.000','br','']){
      const response=await app.inject({url:'/large',headers:{'accept-encoding':encoding}});assert.equal(response.headers['content-encoding'],undefined,encoding);assert.deepEqual(response.json(),body);
    }
    for(const encoding of ['*;q=0.5','GZIP; q=0.5'])assert.equal((await app.inject({url:'/large',headers:{'accept-encoding':encoding}})).headers['content-encoding'],'gzip');
    for(const url of ['/small','/events','/image','/unchanged','/api/auth/session','/cookie','/empty','/cached'])assert.equal((await app.inject({url,headers:{'accept-encoding':'gzip'}})).headers['content-encoding'],undefined,url);
    assert.equal((await app.inject({url:'/encoded',headers:{'accept-encoding':'gzip'}})).headers['content-encoding'],'br');
    const asset=await app.inject({url:'/asset',headers:{'accept-encoding':'gzip'}});assert.equal(asset.headers['content-encoding'],'gzip');assert.match(String(asset.headers['cache-control']),/immutable/);
    const head=await app.inject({url:'/large',method:'HEAD',headers:{'accept-encoding':'gzip'}});assert.equal(head.body,'');assert.equal(head.headers['content-encoding'],undefined);assert.equal(Number(head.headers['x-response-bytes']),head.rawPayload.length);assert.equal(Number(head.headers['x-response-uncompressed-bytes']),0);
  }finally{await app.close();}
});
