import assert from 'node:assert/strict';
import test from 'node:test';
import {forwardSharedState,sharedStateEvent,type SharedStateChange} from '../src/web/sharedState.ts';

test('shared events reuse one transport, ignore malformed payloads and stop forwarding after detach',t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),target=new EventTarget(),source=new EventTarget(),changes:SharedStateChange[]=[];
  Object.defineProperty(globalThis,'window',{configurable:true,value:target});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  target.addEventListener(sharedStateEvent,event=>changes.push((event as CustomEvent<SharedStateChange>).detail));
  const detach=forwardSharedState(source as EventSource);
  source.dispatchEvent(new Event('ready'));
  source.dispatchEvent(new MessageEvent('usage',{data:'{"accountId":"account-a","updatedAt":123}'}));
  source.dispatchEvent(new MessageEvent('sessions',{data:'invalid'}));
  source.dispatchEvent(new MessageEvent('sessions',{data:'{"revision":2}'}));
  source.dispatchEvent(new MessageEvent('usage-invalidated',{data:'{}'}));
  assert.deepEqual(changes,[{kind:'ready'},{kind:'usage',value:{accountId:'account-a',updatedAt:123}},{kind:'sessions',value:{revision:2}},{kind:'usage-invalidated',value:{}}]);
  detach();source.dispatchEvent(new Event('ready'));source.dispatchEvent(new MessageEvent('usage-error',{data:'{"message":"late"}'}));
  assert.equal(changes.length,4);
});
