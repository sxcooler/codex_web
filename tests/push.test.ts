import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushService, registerPushRoutes } from '../src/server/push.ts';
import Fastify from 'fastify';

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/device', keys: { p256dh: Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString('base64url'), auth: Buffer.alloc(16,2).toString('base64url') } };

test('mixed origins expose Push only for the HTTPS request context',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-origins-'));const app=Fastify();
  const service=await createPushService({dataDir:dir,origin:'https://example.test',sessionValid:()=>true,resolve:async()=>['142.250.1.1']});
  try{
    registerPushRoutes(app,service,{authenticated:()=>true,owner:()=> 'session-1',secure:request=>request.headers.host==='example.test'});
    for(const host of ['localhost:3000','example.test']){
      const expected=host==='example.test'?200:503;
      assert.equal((await app.inject({url:'/api/push/public-key',headers:{host}})).statusCode,expected);
      assert.equal((await app.inject({method:'POST',url:'/api/push/subscriptions',headers:{host},payload:subscription})).statusCode,expected);
    }
    assert.equal(service.subscriptionCount(),1);
  }finally{await app.close();service.close();await rm(dir,{recursive:true,force:true});}
});

test('push refuses invalid persisted VAPID keys',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-'));
  try{await writeFile(join(dir,'vapid.json'),JSON.stringify({publicKey:'bad',privateKey:'bad'}));await assert.rejects(createPushService({dataDir:dir,origin:'https://example.test',sessionValid:()=>true}),/VAPID/);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('HTTP origin starts with push unavailable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-'));const app=Fastify();let service:Awaited<ReturnType<typeof createPushService>>|undefined;
  try{service=await createPushService({dataDir:dir,origin:'http://localhost:3000',sessionValid:()=>true});assert.equal(service.available,false);registerPushRoutes(app,service,{authenticated:()=>true,owner:()=> 'session-1'});assert.equal((await app.inject('/api/push/public-key')).statusCode,503);await assert.rejects(service.subscribe('session-1',subscription),(error:any)=>error.statusCode===503);assert.deepEqual(await service.notify({threadId:'t',eventKey:'e',kind:'complete'}),{sent:0,removed:0});}
  finally{service?.close();await app.close();await rm(dir,{recursive:true,force:true});}
});

test('push rejects SSRF endpoints and revokes invalid sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-'));
  const valid = new Set(['session-1']);
  try {
    let resolved=['142.250.1.1'];
    const service = await createPushService({ dataDir: dir, origin: 'https://example.test', sessionValid: id => valid.has(id), resolve: async () => resolved, send: async () => ({ statusCode: 201 }) });
    await assert.rejects(service.subscribe('session-1', { ...subscription, endpoint: 'https://127.0.0.1/x' }), /provider|address/i);
    await assert.rejects(service.subscribe('session-1', { ...subscription, endpoint: 'https://user:pass@fcm.googleapis.com/x#fragment' }), /endpoint/i);
    await assert.rejects(service.subscribe('session-1', { ...subscription, keys:{...subscription.keys,auth:'bad'} }), /subscription/i);
    for(const address of ['100.64.0.1','192.0.2.1','2001:db8::1','ff02::1','::ffff:7f00:1']){resolved=[address];await assert.rejects(service.subscribe('session-1',subscription),/public/);}
    resolved=['142.250.1.1'];
    await service.subscribe('session-1', subscription);
    valid.clear();
    assert.equal(await service.pruneInvalid(),1);
    assert.equal((await service.notify({threadId:'thread-1',eventKey:'done-1',kind:'complete'})).sent, 0);
    assert.equal(service.subscriptionCount(), 0);
    service.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('push deduplicates events, retries bounded failures, and removes gone subscriptions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-'));
  let attempts = 0;
  try {
    const delays:number[]=[]; const pinned:string[]=[];
    const service = await createPushService({ dataDir: dir, origin:'https://example.test', sessionValid: () => true, resolve: async () => ['142.250.1.1'], sleep:async ms=>{delays.push(ms)}, send: async (_s,_p,delivery) => {pinned.push(delivery.address);return { statusCode: ++attempts < 3 ? 503 : 201 };} });
    await service.subscribe('session-1', subscription);
    assert.equal((await service.notify({threadId:'thread-1',eventKey:'done-1',kind:'complete'})).sent, 1);
    assert.equal(attempts, 3);
    assert.deepEqual(delays,[100,200]);
    assert.deepEqual(pinned,['142.250.1.1','142.250.1.1','142.250.1.1']);
    assert.equal((await service.notify({threadId:'thread-1',eventKey:'done-1',kind:'complete'})).sent, 0);
    service.close();

    const gone = await createPushService({ dataDir: dir, origin:'https://example.test', sessionValid: () => true, resolve: async () => ['142.250.1.1'], send: async () => ({statusCode:410}) });
    assert.equal((await gone.notify({threadId:'thread-1',eventKey:'done-2',kind:'approval'})).removed, 1);
    assert.equal(gone.subscriptionCount(), 0);
    gone.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('push pins delivery DNS, rejects rebound reserved addresses, and atomically deduplicates concurrent sends', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-'));let sends=0;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve});let answers=[['142.250.1.1'],['::ffff:127.0.0.1']];
  try{
    const service=await createPushService({dataDir:dir,origin:'https://example.test',sessionValid:()=>true,resolve:async()=>answers.shift()!,send:async()=>{sends++;await gate;return{statusCode:201}}});
    await service.subscribe('session-1',subscription);
    const first=service.notify({threadId:'thread-1',eventKey:'same',kind:'complete'});
    const duplicate=service.notify({threadId:'thread-1',eventKey:'same',kind:'complete'});
    release();
    const results=await Promise.all([first,duplicate]);
    assert.equal(sends,0);
    assert.equal(results[0].sent+results[1].sent,0);
    service.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('push concurrently delivers a public endpoint only once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-'));let sends=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  try{
    const service=await createPushService({dataDir:dir,origin:'https://example.test',sessionValid:()=>true,resolve:async()=>['142.250.1.1'],send:async()=>{sends++;await gate;return{statusCode:201}}});
    await service.subscribe('session-1',subscription);
    const a=service.notify({threadId:'t',eventKey:'e',kind:'complete'}),b=service.notify({threadId:'t',eventKey:'e',kind:'complete'});release();
    const results=await Promise.all([a,b]);assert.equal(sends,1);assert.equal(results[0].sent+results[1].sent,1);service.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('pinned agent lookup supports scalar and all-address callback contracts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-'));const results:any[]=[];
  try{
    const service=await createPushService({dataDir:dir,origin:'https://example.test',sessionValid:()=>true,resolve:async()=>['142.250.1.1'],send:async(_s,_p,delivery)=>{
      const lookup=(delivery.agent.options as any).lookup;
      await new Promise<void>((resolve,reject)=>lookup('fcm.googleapis.com',{},(e:any,address:any,family:any)=>{if(e)reject(e);else{results.push([address,family]);resolve();}}));
      await new Promise<void>((resolve,reject)=>lookup('fcm.googleapis.com',{all:true},(e:any,addresses:any)=>{if(e)reject(e);else{results.push(addresses);resolve();}}));
      return{statusCode:201};
    }});
    await service.subscribe('session-1',subscription);await service.notify({threadId:'t',eventKey:'lookup',kind:'complete'});
    assert.deepEqual(results,[['142.250.1.1',4],[{address:'142.250.1.1',family:4}]]);
    service.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
