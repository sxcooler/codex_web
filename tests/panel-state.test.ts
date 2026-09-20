import assert from 'node:assert/strict';
import test from 'node:test';
import {loadPanelState,savePanelState,type StorageLike} from '../src/web/panelState.ts';

const complete={tab:'files' as const,files:{collapsed:false,directory:'docs',path:'docs/readme.md',mode:'source' as const,listScroll:18,previewScroll:19,contentScroll:20},changes:{collapsed:false,staged:true,path:'a.ts',split:true,listScroll:7,previewScroll:8,contentScroll:9},history:{listCollapsed:false,filesCollapsed:false,filesScroll:0,ref:'all',commit:'abc',parent:'def',path:'old.ts',scroll:31,listScroll:120,pages:2}};

test('project panel state is isolated and only lightweight fields are persisted',()=>{
 const values=new Map<string,string>(),storage:StorageLike={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);}};
 savePanelState(storage,'one',complete);
 assert.equal(loadPanelState(storage,'two').tab,'changes');
 assert.deepEqual(loadPanelState(storage,'one'),complete);
 assert.equal(values.get('codex.project-panel.one')?.includes('content":"'),false);
});
test('invalid persisted panel state safely falls back',()=>{const storage:StorageLike={getItem:()=>'{bad',setItem:()=>{}};assert.equal(loadPanelState(storage,'one').tab,'changes');});
test('malformed nested fields are normalized',()=>{const storage:StorageLike={getItem:()=>JSON.stringify({tab:'files',files:{directory:7,mode:'wrong'}}),setItem:()=>{}};assert.deepEqual(loadPanelState(storage,'one').files,{collapsed:false,directory:'',path:'',mode:'preview',listScroll:0,previewScroll:0,contentScroll:0});});
test('blocked storage does not crash reads or writes',()=>{const storage:StorageLike={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};assert.equal(loadPanelState(storage,'one').tab,'changes');assert.doesNotThrow(()=>savePanelState(storage,'one',complete));});

test('section collapse preferences survive storage and old settings default to expanded',()=>{
 const values=new Map<string,string>(),storage:StorageLike={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);}};
 const state=loadPanelState(storage,'one');
 assert.equal(state.files.collapsed,false);
 assert.equal(state.history.filesCollapsed,false);
 state.files.collapsed=true;state.history.listCollapsed=true;state.history.filesCollapsed=true;state.history.filesScroll=42;
 savePanelState(storage,'one',state);
 assert.deepEqual(loadPanelState(storage,'one'),state);
 assert.equal(loadPanelState(storage,'two').files.collapsed,false);
 storage.setItem('codex.project-panel.old',JSON.stringify(complete,(key,value)=>['collapsed','listCollapsed','filesCollapsed','filesScroll'].includes(key)?undefined:value));
 assert.equal(loadPanelState(storage,'old').changes.collapsed,false);
 assert.equal(loadPanelState(storage,'old').history.listCollapsed,false);
});
