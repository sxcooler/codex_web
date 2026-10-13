export type NotificationTarget={threadId:string;turnId?:string;itemId?:string;requestId?:string;kind?:'complete'|'failed'|'approval'|'input'};
const kinds=new Set(['complete','failed','approval','input']);
export function notificationTarget(value:unknown):NotificationTarget|null{
 if(!value||typeof value!=='object')return null;const input=value as Record<string,unknown>;
 if(typeof input.threadId!=='string'||! /^[a-zA-Z0-9-]{1,256}$/.test(input.threadId))return null;
 const target:NotificationTarget={threadId:input.threadId};
 for(const key of ['turnId','itemId','requestId'] as const){if(input[key]===undefined)continue;if(typeof input[key]!=='string'||! /^[a-zA-Z0-9:_-]{1,256}$/.test(input[key]))return null;target[key]=input[key];}
 if(input.kind!==undefined){if(typeof input.kind!=='string'||!kinds.has(input.kind))return null;target.kind=input.kind as NotificationTarget['kind'];}
 return target;
}
export function routeThreadId(route:string){return /^\/sessions\/([a-zA-Z0-9-]{1,256})$/.exec(route.split('?')[0])?.[1];}
export function notificationFromRoute(route:string):NotificationTarget|null{
 const threadId=routeThreadId(route);if(!threadId)return null;
 const query=new URLSearchParams(route.slice(route.indexOf('?')+1));if(!route.includes('?')||query.get('notification')!=='1')return null;
 const input:Record<string,string>={threadId};for(const key of ['turnId','itemId','requestId','kind'])if(query.has(key))input[key]=query.get(key)!;
 return notificationTarget(input);
}
export function consumedNotificationRoute(route:string,target:NotificationTarget):string|null{
 const current=notificationFromRoute(route.split('#')[0]);if(!current||current.threadId!==target.threadId||(['turnId','itemId','requestId','kind'] as const).some(key=>current[key]!==target[key]))return null;
 const url=new URL(route,'http://notification.local');for(const key of ['notification','turnId','itemId','requestId','kind'])url.searchParams.delete(key);
 return url.pathname+url.search+url.hash;
}
