import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeExtensionSection,visibleExtensionItems,visibleExtensionMarketplaces} from '../src/web/extensionsState.ts';
import {extensionPlugin,extensionsFixture} from './extensions-fixture.ts';
import type {ExtensionSection,ExtensionSectionSnapshot} from '../src/codex/extensions.ts';
import * as state from '../src/web/extensionsState.ts';
const section=(kind:ExtensionSection,items:any[],extra:any={}):ExtensionSectionSnapshot=>({...extensionsFixture(items),section:kind,contextKey:'A',cache:{fetchedAt:1,lastSuccessAt:1,stale:false},...extra});

test('App icon fallback requires one exact installed owner and its normalized PNG',()=>{
 const fallback=(state as any).appIconFallback;assert.equal(typeof fallback,'function');
 const png='data:image/png;base64,iVBORw0KGgo=',owner=extensionPlugin({key:'owner',name:'Owner',iconUrl:png}),app=extensionPlugin({key:'app',kind:'app',iconUrl:'https://files.openai.com/app.png',ownerNames:['Owner']});
 assert.equal(fallback(app,[owner]),png);
 assert.equal(fallback(app,[{...owner,source:'openai-primary-runtime'},{...owner,key:'uninstalled',installed:false}]),png);
 for(const entry of [{...app,kind:'plugin'},{...app,iconUrl:null},{...app,iconUrl:''},{...app,ownerNames:[]},{...app,ownerNames:['Owner','Owner']},{...app,ownerNames:['owner']}])assert.equal(fallback(entry,[owner]),null);
 for(const rows of [[],[owner,{...owner,key:'second'}],[{...owner,installed:false}],[{...owner,installed:null}],[{...owner,iconUrl:'https://files.openai.com/owner.png'}],[{...owner,iconUrl:'data:image/svg+xml;base64,AAAA'}],[{...owner,iconUrl:'data:image/png;base64,'}],[{...owner,iconUrl:'data:image/png;base64,<invalid>'}]])assert.equal(fallback(app,rows),null);
 assert.equal(app.iconUrl,'https://files.openai.com/app.png');assert.equal(owner.iconUrl,png);
});

test('native categories select explicit user inventory without deleting runtime capabilities',()=>{
 const rows=[extensionPlugin({key:'public',source:'local',name:'primary-runtime helper'}),extensionPlugin({key:'runtime',source:'openai-primary-runtime'}),extensionPlugin({key:'implicit',source:'remote',installPolicySource:'IMPLICIT_CANONICAL_APP'} as any),
  extensionPlugin({key:'app',kind:'app',callable:true}),extensionPlugin({key:'uncallable',kind:'app',callable:false}),extensionPlugin({key:'defined',kind:'mcp',configured:true} as any),extensionPlugin({key:'transport',kind:'mcp',configured:false} as any),
  extensionPlugin({key:'skill',kind:'skill',id:'guide',scope:'user',recommended:false} as any),extensionPlugin({key:'duplicate',kind:'skill',id:'guide',scope:'user',recommended:false} as any),extensionPlugin({key:'package-skill',kind:'skill',scope:'user',owner:'public@local',recommended:false} as any),extensionPlugin({key:'repo',kind:'skill',scope:'repo',recommended:false} as any),extensionPlugin({key:'recommended',kind:'skill',scope:'user',recommended:true} as any)];
 assert.deepEqual(visibleExtensionItems(rows).map(item=>item.key),['public','app','defined','skill']);assert.equal(rows.length,12);
 const markets=['local','openai-bundled','openai-primary-runtime','openai-curated','openai-curated-remote','implicit'];
 assert.deepEqual(visibleExtensionMarketplaces(markets.map(name=>({name,configured:name!=='implicit'} as any))).map(m=>m.name),['local']);
});

test('category counts distinguish unknown and partial from a verified empty inventory',()=>{
 const count=(state as any).visibleExtensionCount;assert.equal(typeof count,'function');
 const snapshot=extensionsFixture([],[{id:'plugins',status:'error',count:null,reason:null}]);
 assert.equal(count(snapshot,'plugin'),null);
 snapshot.sources=[{id:'plugins',status:'ok',count:0,reason:null}];assert.equal(count(snapshot,'plugin'),0);
 snapshot.sources.push({id:'plugin-directories',status:'partial',count:1,reason:null});assert.equal(count(snapshot,'plugin'),null);
 snapshot.sources=[{id:'skills',status:'ok',count:0,reason:null},{id:'skill-recommendations',status:'partial',count:null,reason:null}];assert.equal(count(snapshot,'skill'),null);
 snapshot.sources[1]={id:'skill-recommendations',status:'ok',count:0,reason:null};assert.equal(count(snapshot,'skill'),0);
 snapshot.sources=[{id:'mcp',status:'ok',count:0,reason:null},{id:'configuration',status:'error',count:null,reason:null}];assert.equal(count(snapshot,'mcp'),null);
 snapshot.sources=[{id:'configuration',status:'ok',count:1,reason:null}];assert.equal(count(snapshot,'mcp'),null);
 snapshot.sources.push({id:'mcp-definitions',status:'ok',count:0,reason:null},{id:'mcp',status:'error',count:null,reason:null});assert.equal(count(snapshot,'mcp'),0);
 assert.equal(count(null,'marketplace'),null);
});

test('presentation hides bundled provenance and its owned capabilities without name matching or inventory mutation',()=>{
 const bundled=extensionPlugin({key:'hidden',id:'browser@openai-bundled',source:'openai-bundled',name:'Internal'}),publicPlugin=extensionPlugin({key:'public',id:'public@local',source:'local',name:'openai-bundled helper'});
 const rows=[bundled,publicPlugin,extensionPlugin({key:'skill',kind:'skill',owner:bundled.id}),extensionPlugin({key:'mcp',kind:'mcp',owner:bundled.id,configured:false}),extensionPlugin({key:'app',kind:'app',source:'openai-bundled'}),extensionPlugin({key:'other',kind:'skill',owner:publicPlugin.id})];
 assert.deepEqual(visibleExtensionItems(rows).map(x=>x.key),['public']);assert.equal(rows.length,6);
 assert.deepEqual(visibleExtensionItems([rows[2],rows[3]]),[]);
 const snapshot=extensionsFixture(rows);assert.deepEqual(visibleExtensionMarketplaces(snapshot.marketplaces).map(x=>x.name),['local']);assert.equal(snapshot.marketplaces.length,2);
});

test('Apps hide only when every native owner name resolves uniquely to bundled provenance',()=>{
 const hidden=extensionPlugin({key:'hidden',source:'openai-bundled',name:'Internal'}),external=extensionPlugin({key:'external',source:'local',name:'Public'});
 const app=(key:string,ownerNames:string[])=>extensionPlugin({key,kind:'app',ownerNames} as any);
 const rows=[hidden,external,app('hidden-app',['Internal']),app('mixed',['Internal','Public']),app('unknown',['Missing']),app('unowned',[])];
 assert.deepEqual(visibleExtensionItems(rows).map(x=>x.key),['external','mixed','unknown','unowned']);
 assert.equal(visibleExtensionItems([...rows,{...hidden}]).some(x=>x.key==='hidden-app'),false);
 assert.equal(visibleExtensionItems([...rows,extensionPlugin({key:'duplicate',source:'local',name:'Internal'})]).some(x=>x.key==='hidden-app'),true);
});

test('App owner display names ending in the bundled id suffix remain visible for external and mixed ownership',()=>{
 const external=extensionPlugin({key:'external',source:'local',name:'External @openai-bundled'}),hidden=extensionPlugin({key:'hidden',source:'openai-bundled',name:'Internal'});
 const app=extensionPlugin({key:'app',kind:'app',source:null,owner:external.name,ownerNames:[external.name]});
 const mixed={...app,key:'mixed',owner:'Internal, '+external.name,ownerNames:[hidden.name,external.name]};
 assert.deepEqual(visibleExtensionItems([external,hidden,app,mixed]).map(item=>item.key),['external','app','mixed']);
});

test('callable Apps owned by primary runtime remain visible independently of plugin category visibility',()=>{
 const owner=extensionPlugin({key:'runtime',id:'sheets@openai-primary-runtime',source:'openai-primary-runtime',name:'Sheets'}),app=extensionPlugin({key:'app',kind:'app',ownerNames:['Sheets'],callable:true});
 assert.deepEqual(visibleExtensionItems([owner,app]).map(item=>item.key),['app']);
});
test('Apps and MCP enrichment retain plugin/skill rows and definition config',()=>{
 const plugin=extensionPlugin({key:'plugin'}),skill=extensionPlugin({key:'skill',kind:'skill'}),mcp=extensionPlugin({key:'mcp',kind:'mcp',config:{command:'demo'}}),app=extensionPlugin({key:'app',kind:'app'});
 let current=mergeExtensionSection(null,section('installed',[plugin,skill,mcp]));
 current=mergeExtensionSection(current,section('apps',[app]));assert.deepEqual(current.items.map(x=>x.key),['plugin','skill','mcp','app']);
 current=mergeExtensionSection(current,section('mcp',[{...mcp,config:undefined,connection:'connected'}]));assert.equal(current.items.find(x=>x.key==='mcp')?.config?.command,'demo');assert.equal(current.items.find(x=>x.key==='mcp')?.connection,'connected');
});

test('successful definition refresh removes old MCP membership even when runtime status fails',()=>{
 const mcp=extensionPlugin({key:'A',kind:'mcp',connection:'connected'}),definitions=(count:number)=>[{id:'configuration',status:'ok' as const,count:1,reason:null},{id:'mcp-definitions',status:'ok' as const,count,reason:null}];
 let current=mergeExtensionSection(null,section('mcp',[mcp],{sources:[...definitions(1),{id:'mcp',status:'ok',count:1,reason:null}]}));
 assert.equal(state.visibleExtensionCount(current,'mcp'),1);
 current=mergeExtensionSection(current,section('installed',[],{sources:definitions(0)}));
 assert.equal(state.visibleExtensionCount(current,'mcp'),0);
 assert.equal(current.items.find(item=>item.key==='A')?.configured,false);
 assert.equal(current.items.find(item=>item.key==='A')?.connection,'connected');
 current=mergeExtensionSection(current,section('mcp',[],{sources:[...definitions(0),{id:'mcp',status:'error',count:null,reason:null}]}));
 assert.equal(state.visibleExtensionCount(current,'mcp'),0);
 const retained=mergeExtensionSection(null,section('installed',[mcp],{sources:definitions(1)}));
 const unrelated=mergeExtensionSection(retained,section('apps',[],{sources:[{id:'configuration',status:'ok',count:1,reason:null},{id:'mcp-definitions',status:'notLoaded',count:null,reason:null}]}));
 assert.equal(state.visibleExtensionCount(unrelated,'mcp'),1);
 const stale=mergeExtensionSection(retained,section('installed',[],{sources:definitions(0),cache:{stale:true,fetchedAt:3,lastSuccessAt:1}}));
 assert.equal(stale.items.find(item=>item.key==='A')?.configured,true);
 assert.equal(mcp.configured,true);
});
test('failed Apps section retains known inventory; partial new inventory is accepted',()=>{
 const app=extensionPlugin({key:'A',kind:'app'});let current=mergeExtensionSection(null,section('apps',[app]));
 current=mergeExtensionSection(current,section('apps',[],{sources:[{id:'apps',status:'error',count:null,reason:null}]}));assert.equal(current.items.length,1);
 current=mergeExtensionSection(current,section('apps',[app,{...app,key:'B'}],{sources:[{id:'apps',status:'ok',count:2,reason:null},{id:'apps-metadata',status:'partial',count:1,reason:null}]}));assert.equal(current.items.length,2);
});
test('context and configuration mismatch require reread rather than merging old envelopes',()=>{
 const current=mergeExtensionSection(null,section('installed',[]));
 assert.throws(()=>mergeExtensionSection(current,section('apps',[],{contextKey:'B'})),/EXTENSION_CONTEXT_CHANGED/);
 assert.throws(()=>mergeExtensionSection(current,section('apps',[],{userVersion:'different'})),/EXTENSION_CONTEXT_CHANGED/);
});
test('notLoaded sources never overwrite evidence already returned by another section',()=>{
 const current=mergeExtensionSection(null,section('apps',[],{sources:[{id:'apps',status:'ok',count:0,reason:null}]}));
 const next=mergeExtensionSection(current,section('installed',[],{sources:[{id:'apps',status:'notLoaded',count:null,reason:null},{id:'skills',status:'ok',count:0,reason:null}]}));assert.equal(next.sources.find(s=>s.id==='apps')?.status,'ok');
});
test('fresh section failures preserve successful sibling inventories and stale envelopes remain visible on remount',()=>{
 const plugin=extensionPlugin({key:'plugin'}),skill=extensionPlugin({key:'skill',kind:'skill'}),mcp=extensionPlugin({key:'mcp',kind:'mcp'});let current=mergeExtensionSection(null,section('installed',[plugin,skill,mcp]));
 current=mergeExtensionSection(current,section('installed',[skill],{sources:[{id:'plugins',status:'error',count:null,reason:null},{id:'skills',status:'ok',count:1,reason:null}]}));assert.equal(current.items.some(x=>x.key==='plugin'),true);
 current=mergeExtensionSection(current,section('mcp',[],{sources:[{id:'mcp',status:'error',count:null,reason:null}]}));assert.equal(current.items.some(x=>x.key==='mcp'),true);
 const app=extensionPlugin({key:'app',kind:'app'}),remount=mergeExtensionSection(null,section('apps',[app],{cache:{stale:true,fetchedAt:3,lastSuccessAt:1},sources:[{id:'apps',status:'error',count:null,reason:null}]}));assert.equal(remount.items[0].key,'app');
});
