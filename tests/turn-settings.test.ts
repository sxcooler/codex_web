import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTurnSettings,rememberNewTaskSettings} from '../src/web/turnSettings.ts';

test('only a confirmed new task caller records portable last-used options',t=>{
  let saved:string|null=null,writes=0;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete (globalThis as any).localStorage;});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>saved,setItem:(_key:string,value:string)=>{saved=value;writes++;}}});
  rememberNewTaskSettings({model:'gpt-6-astra',effort:'high',permissionMode:'auto-review'});
  assert.deepEqual(loadTurnSettings(),{model:'gpt-6-astra',effort:'high',permissionMode:'auto-review'});
  rememberNewTaskSettings({model:'gpt-6-astra',effort:'high',permissionMode:'auto-review'});
  assert.equal(writes,1);
  rememberNewTaskSettings({model:'gpt-6-sol',effort:'medium',permissionMode:'custom'});
  assert.deepEqual(loadTurnSettings(),{model:'gpt-6-sol',effort:'medium'});
  for(const value of ['null','[]','{broken','{"model":123}','{"effort":"high"}']){saved=value;assert.deepEqual(loadTurnSettings(),{});}
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('blocked');}});
  assert.deepEqual(loadTurnSettings(),{});assert.doesNotThrow(()=>rememberNewTaskSettings({model:'gpt-6-sol'}));
});
