import test from 'node:test';import assert from 'node:assert/strict';
import {notificationTarget,notificationFromRoute,consumedNotificationRoute,routeThreadId} from '../src/codex/notificationTarget.ts';
test('notification route preserves an authenticated thread path independently of search and validates every position',()=>{
 assert.equal(routeThreadId('/sessions/thread-1?notification=1&turnId=turn:1'),'thread-1');
 assert.deepEqual(notificationFromRoute('/sessions/thread-1?notification=1&turnId=turn:1&itemId=item_1&kind=complete'),{threadId:'thread-1',turnId:'turn:1',itemId:'item_1',kind:'complete'});
 for(const route of ['/sessions/thread-1?notification=1&itemId=../../secret','/sessions/thread-1?notification=1&requestId=','/sessions/thread-1?notification=1&kind=evil','/sessions/thread-1?turnId=turn:1'])assert.equal(notificationFromRoute(route),null);
 for(const value of [{threadId:'../../secret'},{threadId:'thread-1',turnId:'x'.repeat(257)},{threadId:'thread-1',requestId:3}])assert.equal(notificationTarget(value),null);
 assert.deepEqual(notificationTarget({threadId:'thread-legacy',text:'private',url:'https://evil.test'}),{threadId:'thread-legacy'});
});
test('consuming only the current notification preserves unrelated query and hash',()=>{
 const target={threadId:'thread-1',turnId:'turn:1',itemId:'item_1',kind:'complete' as const};
 const route='/sessions/thread-1?view=wide&notification=1&turnId=turn%3A1&itemId=item_1&kind=complete&view=second#reading';
 assert.equal(consumedNotificationRoute(route,target),'/sessions/thread-1?view=wide&view=second#reading');
 assert.equal(consumedNotificationRoute(route,{...target,itemId:'new-item'}),null);
 assert.equal(consumedNotificationRoute(route,{...target,threadId:'thread-2'}),null);
 assert.equal(consumedNotificationRoute('/sessions/thread-1?view=wide#reading',target),null);
 assert.equal(consumedNotificationRoute('/sessions/thread-1?notification=1&itemId=../../secret',target),null);
 assert.equal(consumedNotificationRoute('/sessions/thread-1?notification=1&view=wide#reading',{threadId:'thread-1'}),'/sessions/thread-1?view=wide#reading');
});
