import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseOnLeave,cancelReleaseOnReturn} from '../src/web/handoff.ts';

test('a later leave waits for an in-flight return cancellation',async()=>{
  const original=globalThis.fetch,calls:string[]=[];
  let started!:()=>void,finish!:()=>void;
  const cancelling=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  globalThis.fetch=async input=>{const path=String(input);calls.push(path);if(path.endsWith('/cancel-release')){started();await gate;}return new Response('{}',{headers:{'content-type':'application/json'}});};
  try{
    const returning=cancelReleaseOnReturn('queue-test',()=>true);await cancelling;
    const leaving=releaseOnLeave('queue-test');await Promise.resolve();assert.equal(calls.length,1);
    finish();await Promise.all([returning,leaving]);assert.deepEqual(calls,['/api/sessions/queue-test/cancel-release','/api/sessions/queue-test/release-on-leave']);
  }finally{finish();globalThis.fetch=original;}
});
