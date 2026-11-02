import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataStore} from '../src/server/metadata.ts';

test('fork titles use the first free literal suffix without changing the source',()=>{
 const store=new MetadataStore(':memory:'),source={name:'Navigation'};
 try{
  assert.equal(store.nextForkTitle(source),'Navigation（1）');
  store.registerFork({id:'first',forkedFromId:'source',name:'Navigation（1）'});
  for(let i=0;i<33;i++)store.registerFork({id:'other-'+i,forkedFromId:'other',name:'Other'});
  assert.equal(store.nextForkTitle(source),'Navigation（2）');
  assert.equal(store.nextForkTitle({name:'Navigation（1）'}),'Navigation（2）');
  assert.equal(store.nextForkTitle({name:'Chapter（7）'}),'Chapter（1）');
  assert.equal(source.name,'Navigation');
 }finally{store.close();}
});

test('fork titles keep the native name limit and use the existing text fallback',()=>{
 const store=new MetadataStore(':memory:');
 try{
  const title=store.nextForkTitle({name:'x'.repeat(120)});
  assert.equal(title.length,120);assert.ok(title.endsWith('（1）'));
  assert.ok(!/[\uD800-\uDBFF]（/.test(store.nextForkTitle({name:'x'.repeat(116)+'😀'})));
  assert.equal(store.nextForkTitle({preview:'First prompt'}),'First prompt（1）');
  assert.equal(store.nextForkTitle({}),'Untitled（1）');
 }finally{store.close();}
});
