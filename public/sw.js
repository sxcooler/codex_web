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
self.addEventListener('push',event=>{
  let data;try{data=event.data?.json();}catch{return;}
  if(!data||typeof data.threadId!=='string'||!/^[a-zA-Z0-9-]+$/.test(data.threadId))return;
  const title=['任务完成','任务失败','需要确认'].includes(data.title)?data.title:'Codex 通知';
  event.waitUntil(self.registration.showNotification(title,{icon:'/icon.svg',tag:'codex-'+data.threadId,data:{threadId:data.threadId}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const id=event.notification.data?.threadId;
  if(typeof id!=='string'||!/^[a-zA-Z0-9-]+$/.test(id))return;
  const url=new URL('/sessions/'+encodeURIComponent(id),self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{const client=clients.find(item=>item.url===url);if(client)return client.focus();return self.clients.openWindow(url);}));
});
