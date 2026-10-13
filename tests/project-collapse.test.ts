import assert from 'node:assert/strict';
import test from 'node:test';
import * as preferences from '../src/web/preferences.ts';

test('project collapse persists path keys independently, validates stored data and reports failed writes',t=>{
  const values=new Map<string,string>(),events:string[]=[];
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)};
  const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'localStorage',{value:storage,configurable:true});
  Object.defineProperty(globalThis,'window',{value:{dispatchEvent:(event:Event)=>events.push(event.type)},configurable:true});
  t.after(()=>{for(const [name,original] of [['localStorage',originalStorage],['window',originalWindow]] as const){if(original)Object.defineProperty(globalThis,name,original);else delete (globalThis as any)[name];}});
  assert.equal(typeof preferences.readCollapsedProjects,'function');
  assert.deepEqual([...preferences.readCollapsedProjects()],[]);
  assert.equal(preferences.writeCollapsedProjects(new Set(['c:/work/one','c:/external/one',''])),true);
  assert.deepEqual([...preferences.readCollapsedProjects()],['c:/work/one','c:/external/one','']);
  assert.deepEqual(events,['project-collapse-changed']);
  values.set(preferences.projectCollapseKey,'{"c:/work/one":true}');assert.deepEqual([...preferences.readCollapsedProjects()],[]);
  values.set(preferences.projectCollapseKey,'["c:/work/one",false,"c:/work/one",null]');assert.deepEqual([...preferences.readCollapsedProjects()],['c:/work/one']);
  t.mock.method(storage,'setItem',()=>{});assert.equal(preferences.writeCollapsedProjects(new Set(['c:/other'])),false);assert.equal(events.length,1);
  t.mock.method(storage,'getItem',()=>{throw Error('blocked');});assert.deepEqual([...preferences.readCollapsedProjects()],[]);
});
