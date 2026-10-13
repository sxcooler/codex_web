import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPushService } from '../src/server/push.ts';
import { Diagnostics } from '../src/server/diagnostics.ts';

const publicKey = createECDH('prime256v1').generateKeys().toString('base64url');
const subscription = { endpoint:'https://fcm.googleapis.com/fcm/send/private-device-token', keys:{p256dh:publicKey, auth:Buffer.alloc(16,2).toString('base64url')} };
const event = { threadId:'thread-1', eventKey:'event-1', kind:'complete' as const };
const base = { origin:'https://example.test', sessionValid:()=>true, resolve:async()=>['142.250.1.1'], sleep:async()=>{} };

test('ordinary Push delivery failures retain the original exception without diagnostics', async t => {
  const dir = await mkdtemp(join(tmpdir(),'push-error-')), lines:string[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  const failure = Object.assign(new Error('Socket access denied'),{code:'EACCES'});
  const service = await createPushService({...base,dataDir:dir,send:async()=>{throw failure;}});
  try {
    await service.subscribe('owner',subscription);
    assert.deepEqual(await service.notify(event),{sent:0,removed:0});
    assert.equal(lines.length,1);
    const log = JSON.parse(lines[0]);
    assert.equal(log.event,'push_error');
    assert.equal(log.threadId,'thread-1');
    assert.equal(log.provider,'fcm.googleapis.com');
    assert.equal(log.attempt,1);
    assert.equal(log.statusCode,0);
    assert.equal(log.name,'Error');
    assert.equal(log.code,'EACCES');
    assert.equal(log.message,'Socket access denied');
    assert.match(log.stack,/Socket access denied/);
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});

test('Push diagnostics and ordinary logs share bounded redacted exception fields', async t => {
  const dir = await mkdtemp(join(tmpdir(),'push-redact-')), lines:string[]=[], records:any[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  let failure:Error, attempts=0;
  const service = await createPushService({...base,dataDir:dir,diagnostic:record=>records.push(record),send:async()=>++attempts===1?{statusCode:503,error:failure}:{statusCode:201}});
  try {
    await service.subscribe('owner',subscription);
    const vapid = JSON.parse(await readFile(join(dir,'vapid.json'),'utf8'));
    failure = Object.assign(new Error(`Network unavailable ${subscription.endpoint} ${subscription.keys.p256dh} ${subscription.keys.auth} ${vapid.publicKey} ${vapid.privateKey} ${'x'.repeat(20_000)}`),{
      name:'N'.repeat(500),code:'C'.repeat(500),stack:`Error: Network unavailable\n    at ${subscription.endpoint}\n    at ${'s'.repeat(20_000)}\nAuthorization: Bearer private-authorization`,
      endpoint:subscription.endpoint,headers:{Authorization:'private-authorization'},body:'private-response-body'
    });
    assert.deepEqual(await service.notify(event),{sent:1,removed:0});
    assert.equal(attempts,2);
    assert.equal(lines.length,1);
    assert.equal(records.length,1);
    assert.deepEqual(JSON.parse(lines[0]),records[0]);
    const log = records[0];
    assert.equal(log.statusCode,503);
    assert.equal(log.attempt,1);
    assert.match(log.message,/Network unavailable/);
    assert(log.name.length<=64 && log.code.length<=64 && log.message.length<=1024 && log.stack.length<=4096);
    for(const value of [subscription.endpoint,subscription.keys.p256dh,subscription.keys.auth,vapid.publicKey,vapid.privateKey,'private-authorization','private-response-body']) assert(!lines[0].includes(value),value);
    for(const field of ['endpoint','headers','body','keys']) assert.equal(log[field],undefined);
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});

test('Push logs redact credentials and response bodies embedded in exception text', async t => {
  const dir = await mkdtemp(join(tmpdir(),'push-text-')), lines:string[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  const failure = Object.assign(new Error('TLS failed https://fcm.googleapis.com/other-private-token authorization: Bearer secret-auth'),{stack:'TLS failed\nheaders: {"secret":"private-header"}\nbody: private-body'});
  const service = await createPushService({...base,dataDir:dir,send:async()=>{throw failure;}});
  try {
    await service.subscribe('owner',subscription);
    await service.notify(event);
    assert.equal(lines.length,1);
    assert.match(JSON.parse(lines[0]).message,/TLS failed/);
    for(const secret of ['other-private-token','secret-auth','private-header','private-body']) assert(!lines[0].includes(secret),secret);
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});

test('Push errors persist through the existing Diagnostics record callback', async t => {
  const dir=await mkdtemp(join(tmpdir(),'push-durable-diagnostic-')), lines:string[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  const diagnostics=new Diagnostics(dir);
  const service=await createPushService({...base,dataDir:dir,diagnostic:diagnostics.record,send:async()=>{throw Object.assign(new Error('socket closed'),{code:'ECONNRESET'});}});
  try {
    await service.subscribe('owner',subscription);
    assert.deepEqual(await service.notify(event),{sent:0,removed:0});
    await diagnostics.flush();
    const records=(await readFile(join(dir,'diagnostics.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(record=>record.event==='push_error');
    assert.equal(records.length,1);
    assert.equal(records[0].message,'socket closed');
    assert.equal(records[0].code,'ECONNRESET');
    assert.equal(records[0].threadId,'thread-1');
    assert.equal(lines.length,1);
  } finally {service.close();await diagnostics.close();await rm(dir,{recursive:true,force:true});}
});

test('Push log sink failures cannot change retries or delivery and keep the other sink working', async t => {
  for (const broken of ['console','diagnostic']) {
    const dir = await mkdtemp(join(tmpdir(),'push-log-sink-')), lines:string[]=[], records:any[]=[];
    const stub=t.mock.method(console,'error',(line:string)=>{if(broken==='console')throw new Error('stderr unavailable');lines.push(line);});
    let attempts=0;
    const service = await createPushService({...base,dataDir:dir,diagnostic:record=>{if(broken==='diagnostic')throw new Error('diagnostics unavailable');records.push(record);},send:async()=>++attempts===1?{statusCode:503,error:new Error('temporary network error')}:{statusCode:201}});
    try {
      await service.subscribe('owner',subscription);
      assert.deepEqual(await service.notify(event),{sent:1,removed:0});
      assert.equal(attempts,2);
      assert.equal((broken==='console'?records:lines).length,1);
      assert.deepEqual(await service.notify(event),{sent:0,removed:0});
      assert.equal(attempts,2);
    } finally {stub.mock.restore();service.close();await rm(dir,{recursive:true,force:true});}
  }
});

test('Push DNS, pin and invalid stored endpoint errors are visible without bypassing SSRF checks', async t => {
  const dir = await mkdtemp(join(tmpdir(),'push-pin-error-')), lines:string[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  let mode='public', sends=0;
  const service=await createPushService({...base,dataDir:dir,resolve:async()=>{if(mode==='dns')throw Object.assign(new Error('DNS lookup failed'),{code:'ENOTFOUND'});return mode==='private'?['127.0.0.1']:['142.250.1.1'];},send:async()=>{sends++;return{statusCode:201};}});
  try {
    await service.subscribe('owner',subscription);
    mode='dns';assert.deepEqual(await service.notify(event),{sent:0,removed:0});
    assert.equal(JSON.parse(lines[0]).code,'ENOTFOUND');
    assert.equal(JSON.parse(lines[0]).message,'DNS lookup failed');
    mode='private';assert.deepEqual(await service.notify(event),{sent:0,removed:0});
    assert.match(JSON.parse(lines[1]).message,/not public/);
    const db=new DatabaseSync(join(dir,'push.sqlite'));
    try {db.prepare('UPDATE subscriptions SET endpoint=?').run('https://127.0.0.1/private-endpoint');}finally{db.close();}
    assert.deepEqual(await service.notify(event),{sent:0,removed:0});
    assert.match(JSON.parse(lines[2]).message,/Unsupported push provider endpoint/);
    assert.equal(JSON.parse(lines[2]).provider,undefined);
    assert.equal(sends,0);
    assert.equal(lines.length,3);
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});

test('Push HTTP errors remain logged when gone subscriptions are removed', async t => {
  const dir = await mkdtemp(join(tmpdir(),'push-gone-error-')), lines:string[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  const service=await createPushService({...base,dataDir:dir,send:async()=>({statusCode:410,error:new Error('Received unexpected response code')})});
  try {
    await service.subscribe('owner',subscription);
    assert.deepEqual(await service.notify(event),{sent:0,removed:1});
    assert.equal(service.subscriptionCount(),0);
    assert.equal(lines.length,1);
    assert.equal(JSON.parse(lines[0]).statusCode,410);
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});

test('the default Push sender preserves actual HTTPS exceptions through all existing retries', async t => {
  const dir = await mkdtemp(join(tmpdir(),'push-real-sender-error-')), lines:string[]=[], delays:number[]=[];
  t.mock.method(console,'error',(line:string)=>lines.push(line));
  t.mock.method(https,'request',()=>{
    const request=new EventEmitter() as EventEmitter&{write:()=>void;end:()=>void};
    request.write=()=>{};
    request.end=()=>queueMicrotask(()=>request.emit('error',Object.assign(new Error('connect EACCES 142.250.1.1:443'),{code:'EACCES'})));
    return request;
  });
  const service=await createPushService({...base,dataDir:dir,sleep:async ms=>{delays.push(ms);}});
  try {
    await service.subscribe('owner',subscription);
    assert.deepEqual(await service.notify(event),{sent:0,removed:0});
    assert.deepEqual(delays,[100,200]);
    assert.equal(lines.length,3);
    const records=lines.map(line=>JSON.parse(line));
    assert.deepEqual(records.map(log=>log.attempt),[1,2,3]);
    for(const log of records){assert.equal(log.statusCode,500);assert.equal(log.code,'EACCES');assert.equal(log.message,'connect EACCES 142.250.1.1:443');assert.match(log.stack,/connect EACCES/);}
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});
