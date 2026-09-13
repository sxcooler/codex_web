import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
test('push renders generic notification and clicks only a validated local thread URL',async()=>{
 const listeners:any={},notifications:any[]=[],opened:string[]=[];let pending:Promise<any>|undefined;
 const self={location:{origin:'https://codex.example'},addEventListener:(name:string,handler:any)=>listeners[name]=handler,registration:{showNotification:async(title:string,options:any)=>notifications.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async(url:string)=>opened.push(url)}};
 runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL});
 listeners.push({data:{json:()=>({threadId:'../../evil',title:'bad'})},waitUntil:(p:any)=>pending=p});assert.equal(notifications.length,0);
 listeners.push({data:{json:()=>({threadId:'thread-1',title:'private prompt',url:'https://evil.example'})},waitUntil:(p:any)=>pending=p});await pending;
 assert.equal(notifications[0].title,'Codex 通知');assert.equal(notifications[0].body,undefined);
 listeners.notificationclick({notification:{data:notifications[0].data,close:()=>{}},waitUntil:(p:any)=>pending=p});await pending;
 assert.deepEqual(opened,['https://codex.example/sessions/thread-1']);
});
