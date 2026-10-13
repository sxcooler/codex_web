const CACHE = 'codex-static-v2';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/','/icon.svg','/manifest.webmanifest']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('codex-static-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(()=>new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Codex Web · 离线</title><h1>暂时无法连接</h1><p>请检查网络，确认设备与开发机连接到同一局域网或虚拟网络，并确认服务在线。任务不会因为页面断线而停止。</p><a href="/">重新连接</a></html>',{headers:{'content-type':'text/html; charset=utf-8'}})));
  } else if (/^\/assets\/[\w.-]+$/.test(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) ?? fetch(event.request).then(async response=>{if(response.ok)await cache.put(event.request,response.clone());return response;})));
  }
});
let pendingClick,pendingProbe,latestClick=0,activation=Promise.resolve();
self.addEventListener('message',event=>{
  if(event.data?.type!=='codex-notification-ready')return;
  try{if(new URL(event.source.url).origin!==self.location.origin)return;}catch{return;}
  pendingProbe?.resend(event.source.id);
  const pending=pendingClick;if(!pending||pending.readyResent||event.source.id!==pending.clientId)return;
  pending.readyResent=true;pending.deliver();
});
async function currentThreadClient(clients,threadId,deadline){
  if(!clients.length||performance.now()>=deadline)return null;
  const channels=[],finished=new Set(),resent=new Set();let timer,pending;
  try{
    return await new Promise(resolve=>{
      const send=client=>{if(performance.now()>=deadline){resolve(null);return;}const channel=new MessageChannel();channels.push(channel);channel.port1.onmessage=event=>{if(event.data?.type!=='codex-notification-route'||finished.has(client))return;finished.add(client);if(event.data.threadId===threadId)resolve(performance.now()<deadline?client:null);else if(finished.size===clients.length)resolve(null);};try{client.postMessage({type:'codex-notification-route'},[channel.port2]);}catch{finished.add(client);if(finished.size===clients.length)resolve(null);}};
      pending={cancel:()=>resolve(null),resend:id=>{const client=clients.find(item=>item.id===id);if(client&&!finished.has(client)&&!resent.has(client)){resent.add(client);send(client);}}};pendingProbe=pending;
      timer=setTimeout(()=>resolve(null),deadline-performance.now());
      for(const client of clients)send(client);
    });
  }finally{clearTimeout(timer);for(const channel of channels){channel.port1.close();channel.port2.close();}if(pendingProbe===pending)pendingProbe=undefined;}
}
// A started focus cannot be cancelled; queue newer activations so the newest click finishes last.
function activate(click,action){const job=activation.then(()=>{if(click===latestClick)return action();});activation=job.catch(()=>{});return job;}
function notificationTarget(value){
  if(!value||typeof value.threadId!=='string'||!/^[a-zA-Z0-9-]{1,256}$/.test(value.threadId))return null;
  const target={threadId:value.threadId};
  for(const key of ['turnId','itemId','requestId']){if(value[key]===undefined)continue;if(typeof value[key]!=='string'||!/^[a-zA-Z0-9:_-]{1,256}$/.test(value[key]))return null;target[key]=value[key];}
  if(value.kind!==undefined){if(!['complete','failed','approval','input'].includes(value.kind))return null;target.kind=value.kind;}
  return target;
}

async function deliverNotificationTarget(client,target,deadline){
  if(performance.now()>=deadline)return false;
  const channels=[];let timer,pending;
  try{
    const accepted=new Promise(resolve=>{
      pendingClick?.cancel();timer=setTimeout(()=>resolve(false),deadline-performance.now());
      const deliver=()=>{if(performance.now()>=deadline){resolve(false);return;}const channel=new MessageChannel();channels.push(channel);channel.port1.onmessage=event=>{const reply=event.data;if(reply?.type==='codex-notification-accepted'&&Object.keys(target).every(key=>reply.target?.[key]===target[key]))resolve(performance.now()<deadline);};try{client.postMessage({type:'codex-notification-target',target},[channel.port2]);}catch{resolve(false);}};
      pending={target,clientId:client.id,deliver,cancel:()=>resolve(true),readyResent:false};pendingClick=pending;
    });
    pending.deliver();
    return await accepted;
  }finally{clearTimeout(timer);for(const channel of channels){channel.port1.close();channel.port2.close();}if(pendingClick===pending)pendingClick=undefined;}
}
self.addEventListener('push',event=>{
  let data;try{data=event.data?.json();}catch{return;}
  const target=notificationTarget(data);if(!target)return;
  const title=['任务完成','任务失败','需要确认'].includes(data.title)?data.title:'Codex 通知';
  const body=target.kind==='failed'?'点击查看失败原因':target.kind==='approval'||target.kind==='input'?'点击查看待确认项':target.kind==='complete'?'点击查看本轮答复':'点击打开会话';
  event.waitUntil(self.registration.showNotification(title,{body,requireInteraction:true,icon:'/icon.svg',tag:'codex-'+target.threadId,data:target}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=notificationTarget(event.notification.data);if(!target)return;
  const click=++latestClick,deadline=performance.now()+5000;pendingClick?.cancel();pendingProbe?.cancel();
  const url=new URL('/sessions/'+encodeURIComponent(target.threadId),self.location.origin);
  if(target.turnId||target.itemId||target.requestId||target.kind){url.searchParams.set('notification','1');for(const key of ['turnId','itemId','requestId','kind'])if(target[key])url.searchParams.set(key,target[key]);}
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    if(click!==latestClick)return;
    clients=clients.filter(item=>{try{return item.frameType==='top-level'&&new URL(item.url).origin===url.origin;}catch{return false;}});
    const client=await currentThreadClient(clients,target.threadId,deadline);
    return activate(click,async()=>{
      if(client&&await deliverNotificationTarget(client,target,deadline)){
        if(click!==latestClick)return;
        try{await client.focus();return;}catch{}
      }
      if(click===latestClick)return self.clients.openWindow(url.href);
    });
  }));
});
