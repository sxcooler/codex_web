import { BlockList, isIP } from 'node:net';
import { Agent } from 'node:https';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import webpush, { type PushSubscription } from 'web-push';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const PROVIDERS=new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com']);
const blocked=new BlockList();
for(const [network,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(network,prefix,'ipv4');
for(const [network,prefix] of [['::',128],['::1',128],['64:ff9b:1::',48],['100::',64],['2001:db8::',32],['2001:10::',28],['fc00::',7],['fe80::',10],['ff00::',8]] as const)blocked.addSubnet(network,prefix,'ipv6');
function pushError(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode,code:'PUSH_ERROR'});}
function decodeKey(value:string,length:number){if(!/^[A-Za-z0-9_-]+$/.test(value))return false;try{return Buffer.from(value,'base64url').length===length;}catch{return false;}}
function publicAddress(address:string){const mapped=/^(?:::ffff:|(?:0{1,4}:){5}ffff:)(\d+\.\d+\.\d+\.\d+)$/i.exec(address);if(mapped)return !blocked.check(mapped[1],'ipv4');const mappedHex=/^(?:::ffff:|(?:0{1,4}:){5}ffff:)([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(address);if(mappedHex){const value=(parseInt(mappedHex[1],16)*65536+parseInt(mappedHex[2],16))>>>0;return !blocked.check([value>>>24,(value>>>16)&255,(value>>>8)&255,value&255].join('.'),'ipv4');}const family=isIP(address);return family!==0&&!blocked.check(address,family===4?'ipv4':'ipv6');}
function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}

type Delivery={address:string;agent:Agent};
type Options={dataDir:string;origin:string;sessionValid:(id:string)=>boolean|Promise<boolean>;resolve?:(host:string)=>Promise<string[]>;sleep?:(ms:number)=>Promise<void>;send?:(subscription:PushSubscription,payload:string,delivery:Delivery)=>Promise<{statusCode:number}>};
export async function createPushService(options:Options){
  await mkdir(options.dataDir,{recursive:true});const keyPath=join(options.dataDir,'vapid.json');
  let keys:{publicKey:string;privateKey:string};
  try{keys=JSON.parse(await readFile(keyPath,'utf8'));if(!decodeKey(keys.publicKey,65)||!decodeKey(keys.privateKey,32))throw pushError(500,'Stored VAPID keys are invalid');}
  catch(error:any){if(error?.code!=='ENOENT')throw error?.code==='PUSH_ERROR'?error:pushError(500,'Stored VAPID keys are invalid');keys=webpush.generateVAPIDKeys();await writeFile(keyPath,JSON.stringify(keys),{mode:0o600,flag:'wx'});await chmod(keyPath,0o600);}
  let origin:URL;try{origin=new URL(options.origin);}catch{throw pushError(500,'Push origin is invalid');}if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.hash)throw pushError(500,'Push origin is invalid');const available=origin.protocol==='https:';
  const db=new DatabaseSync(join(options.dataDir,'push.sqlite'));db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,endpoint TEXT NOT NULL UNIQUE,p256dh TEXT NOT NULL,auth TEXT NOT NULL);CREATE TABLE IF NOT EXISTS deliveries(subscription_id INTEGER NOT NULL,thread_id TEXT NOT NULL,event_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(subscription_id,thread_id,event_key));`);
  const resolveHost=options.resolve??(async host=>(await lookup(host,{all:true})).map(x=>x.address)),wait=options.sleep??sleep;
  async function endpoint(value:string){let url:URL;try{url=new URL(value);}catch{throw pushError(400,'Invalid push provider endpoint');}if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!PROVIDERS.has(url.hostname)||isIP(url.hostname))throw pushError(400,'Unsupported push provider endpoint');return url;}
  async function pin(url:URL){const addresses=await resolveHost(url.hostname);if(!addresses.length||addresses.some(address=>!publicAddress(address)))throw pushError(400,'Push provider address is not public');const address=addresses[0],family=isIP(address) as 4|6;const agent=new Agent({lookup:(_hostname,lookupOptions,callback)=>lookupOptions?.all?callback(null,[{address,family}]):callback(null,address,family)});return{address,agent};}
  const send=options.send??(async(subscription,payload,delivery)=>{try{const result=await webpush.sendNotification(subscription,payload,{TTL:300,timeout:10_000,agent:delivery.agent,vapidDetails:{subject:origin.origin,publicKey:keys.publicKey,privateKey:keys.privateKey}});return{statusCode:result.statusCode};}catch(error:any){return{statusCode:error?.statusCode??500};}});
  const service={
    available,
    publicKey:keys.publicKey,
    async subscribe(ownerId:string,subscription:PushSubscription){if(!available)throw pushError(503,'Web Push requires HTTPS');if(!ownerId)throw pushError(401,'Authentication required');if(!subscription||!decodeKey(subscription.keys?.p256dh??'',65)||Buffer.from(subscription.keys.p256dh,'base64url')[0]!==4||!decodeKey(subscription.keys?.auth??'',16))throw pushError(400,'Invalid push subscription');const url=await endpoint(subscription.endpoint);await pin(url).then(x=>x.agent.destroy());db.prepare('INSERT INTO subscriptions(owner_id,endpoint,p256dh,auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET owner_id=excluded.owner_id,p256dh=excluded.p256dh,auth=excluded.auth').run(ownerId,url.href,subscription.keys.p256dh,subscription.keys.auth);},
    remove(ownerId:string,endpointValue:string){return Number(db.prepare('DELETE FROM subscriptions WHERE owner_id=? AND endpoint=?').run(ownerId,endpointValue).changes);},
    revokeOwner(ownerId:string){return Number(db.prepare('DELETE FROM subscriptions WHERE owner_id=?').run(ownerId).changes);},
    async pruneInvalid(){let removed=0;for(const row of db.prepare('SELECT id,owner_id FROM subscriptions').all() as any[])if(!await options.sessionValid(row.owner_id)){db.prepare('DELETE FROM subscriptions WHERE id=?').run(row.id);removed++;}return removed;},
    subscriptionCount(){return Number((db.prepare('SELECT COUNT(*) count FROM subscriptions').get() as any).count);},
    async notify(event:{threadId:string;eventKey:string;kind:'complete'|'failed'|'approval'|'input'}){
      let sent=0,removed=0;if(!available)return{sent,removed};for(const row of db.prepare('SELECT * FROM subscriptions').all() as any[]){if(!await options.sessionValid(row.owner_id)){db.prepare('DELETE FROM subscriptions WHERE id=?').run(row.id);removed++;continue;}
        const reserved=db.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?)').run(row.id,event.threadId,event.eventKey,Date.now());if(!reserved.changes)continue;
        const payload=JSON.stringify({title:event.kind==='approval'||event.kind==='input'?'需要确认':event.kind==='failed'?'任务失败':'任务完成',threadId:event.threadId,url:`/sessions/${encodeURIComponent(event.threadId)}`});let status=0;
        try{const url=await endpoint(row.endpoint);for(let attempt=0;attempt<3;attempt++){const delivery=await pin(url);try{status=(await send({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},payload,delivery)).statusCode;}finally{delivery.agent.destroy();}if(status!==429&&status<500)break;if(attempt<2)await wait(100*2**attempt);}}
        catch{status=0;}
        if(status===404||status===410){db.prepare('DELETE FROM subscriptions WHERE id=?').run(row.id);db.prepare('DELETE FROM deliveries WHERE subscription_id=?').run(row.id);removed++;continue;}
        if(status>=200&&status<300){sent++;continue;}db.prepare('DELETE FROM deliveries WHERE subscription_id=? AND thread_id=? AND event_key=?').run(row.id,event.threadId,event.eventKey);
      }
      db.prepare('DELETE FROM deliveries WHERE created_at<?').run(Date.now()-7*86400_000);return{sent,removed};
    },
    close(){db.close();}
  };return service;
}
export type PushService=Awaited<ReturnType<typeof createPushService>>;
type Access={authenticated:(request:FastifyRequest)=>boolean;owner:(request:FastifyRequest)=>string;secure?:(request:FastifyRequest)=>boolean};
export function registerPushRoutes(app:FastifyInstance,service:PushService,access:Access){app.get('/api/push/public-key',async(request,reply)=>!access.authenticated(request)?reply.code(401).send({error:'Authentication required'}):(!service.available||access.secure?.(request)===false)?reply.code(503).send({error:'Web Push requires HTTPS',code:'PUSH_ERROR'}):{publicKey:service.publicKey});app.post('/api/push/subscriptions',{schema:{body:{type:'object',additionalProperties:false,required:['endpoint','keys'],properties:{endpoint:{type:'string',maxLength:2048},keys:{type:'object',additionalProperties:false,required:['p256dh','auth'],properties:{p256dh:{type:'string',maxLength:512},auth:{type:'string',maxLength:512}}}}}}},async(request,reply)=>{if(!access.authenticated(request))return reply.code(401).send({error:'Authentication required'});if(access.secure?.(request)===false)throw pushError(503,'Web Push requires HTTPS');await service.subscribe(access.owner(request),request.body as PushSubscription);return{ok:true};});app.post('/api/push/subscriptions/remove',{schema:{body:{type:'object',additionalProperties:false,required:['endpoint'],properties:{endpoint:{type:'string',maxLength:2048}}}}},async(request,reply)=>{if(!access.authenticated(request))return reply.code(401).send({error:'Authentication required'});return{removed:service.remove(access.owner(request),(request.body as any).endpoint)};});}
