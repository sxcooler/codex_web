import assert from 'node:assert/strict';
import test from 'node:test';
import {readSendShortcut,writeSendShortcut,shouldSubmit,readSessionSort,writeSessionSort} from '../src/web/preferences.ts';

const key='codex-web:send-shortcut:v1';
test('session sort defaults to native update time and notifies only a confirmed preference write',t=>{
  const values=new Map<string,string>(),events:string[]=[];
  const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const storage={getItem:(name:string)=>values.get(name)??null,setItem:(name:string,value:string)=>{values.set(name,value);}};
  Object.defineProperty(globalThis,'localStorage',{value:storage,configurable:true});
  Object.defineProperty(globalThis,'window',{value:{dispatchEvent:(event:Event)=>events.push(event.type)},configurable:true});
  t.after(()=>{for(const [name,original] of [['localStorage',originalStorage],['window',originalWindow]] as const){if(original)Object.defineProperty(globalThis,name,original);else delete (globalThis as any)[name];}});
  assert.equal(readSessionSort(),'updated_at');values.set('codex-web:session-sort:v1','invalid');assert.equal(readSessionSort(),'updated_at');
  assert.equal(writeSessionSort('created_at'),true);assert.equal(readSessionSort(),'created_at');assert.deepEqual(events,['session-sort-changed']);
  t.mock.method(storage,'setItem',()=>{throw Error('blocked');});assert.equal(writeSessionSort('updated_at'),false);assert.equal(readSessionSort(),'created_at');assert.equal(events.length,1);
  assert.equal(writeSessionSort('invalid' as any),false);
});
test('send preference defaults safely and reports storage failures',t=>{
  const values=new Map<string,string>();
  const storage={getItem:(name:string)=>values.get(name)??null,setItem:(name:string,value:string)=>{values.set(name,value);}};
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{value:storage,configurable:true});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete (globalThis as any).localStorage;});
  assert.equal(readSendShortcut(),'enter');
  values.set(key,'invalid');assert.equal(readSendShortcut(),'enter');
  assert.equal(writeSendShortcut('mod-enter'),true);assert.equal(values.get(key),'mod-enter');assert.equal(readSendShortcut(),'mod-enter');
  t.mock.method(storage,'setItem',()=>{throw Error('storage blocked');});
  assert.equal(writeSendShortcut('enter'),false);assert.equal(readSendShortcut(),'mod-enter');
  t.mock.method(storage,'getItem',()=>{throw Error('storage blocked');});assert.equal(readSendShortcut(),'enter');
});

test('desktop shortcuts protect Shift, IME and mobile Enter for both modes',()=>{
  const enter={key:'Enter',shiftKey:false,ctrlKey:false,metaKey:false,isComposing:false,keyCode:13};
  for(const [event,mobile,shortcut,want] of [
    [enter,false,'enter',true],
    [enter,false,'mod-enter',false],
    [{...enter,ctrlKey:true},false,'mod-enter',true],
    [{...enter,metaKey:true},false,'mod-enter',true],
    [{...enter,key:'a'},false,'enter',false],
    ...(['enter','mod-enter'] as const).flatMap(shortcut=>[
      [{...enter,ctrlKey:true,shiftKey:true},false,shortcut,false],
      [{...enter,metaKey:true,isComposing:true},false,shortcut,false],
      [{...enter,ctrlKey:true,keyCode:229},false,shortcut,false],
      [{...enter,ctrlKey:true,metaKey:true},true,shortcut,false],
    ]),
  ] as const)assert.equal(shouldSubmit(event as typeof enter,{mobile:mobile as boolean,shortcut:shortcut as 'enter'|'mod-enter'}),want,JSON.stringify({event,mobile,shortcut}));
});
