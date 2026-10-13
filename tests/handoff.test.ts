import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseOnLeave,writeSession} from '../src/web/handoff.ts';

test('leaving a read-only view never requests or cancels ownership',async()=>{
  const original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=async input=>{calls.push(String(input));return new Response('{}');};
  try{await releaseOnLeave('read-only-view');assert.deepEqual(calls,[]);}
  finally{globalThis.fetch=original;}
});

test('a later leave waits for explicit write cancellation and the write itself',async()=>{
  const original=globalThis.fetch,calls:string[]=[];
  let started!:()=>void,finish!:()=>void;
  const cancelling=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  globalThis.fetch=async input=>{const path=String(input);calls.push(path);if(path.endsWith('/cancel-release')){started();await gate;}return new Response('{}',{headers:{'content-type':'application/json'}});};
  try{
    const returning=writeSession('queue-test',async()=>{calls.push('write');return {};});await cancelling;
    const leaving=releaseOnLeave('queue-test');await Promise.resolve();assert.equal(calls.length,1);
    finish();await Promise.all([returning,leaving]);assert.deepEqual(calls,['/api/sessions/queue-test/cancel-release','write','/api/sessions/queue-test/release-on-leave']);
    await releaseOnLeave('queue-test');assert.equal(calls.length,3,'a later read-only visit does not inherit ownership');
  }finally{finish();globalThis.fetch=original;}
});

test('a hung cancellation is bounded and cannot strand the following leave',async t=>{
  const original=globalThis.fetch,timeout=AbortSignal.timeout.bind(AbortSignal);let writes=0,leaves=0;
  t.mock.method(AbortSignal,'timeout',ms=>{assert.equal(ms,30_000);return timeout(10);});
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith('/cancel-release')){assert.ok(init?.signal,'ownership cancellation must carry a deadline');await new Promise((_,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));}
    else leaves++;
    return new Response('{}');
  };
  const keepAlive=setTimeout(()=>{},1000);
  try{const writing=writeSession('hung-write',async()=>{writes++;return {};});const leaving=releaseOnLeave('hung-write');await assert.rejects(writing,/等待服务器响应超时/);await leaving;assert.equal(writes,0);assert.equal(leaves,1);}
  finally{clearTimeout(keepAlive);globalThis.fetch=original;}
});
