import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerCodexSettingsRoutes} from '../src/server/codex-settings.ts';

function setup(t:any){
 const calls:any[]=[],projectId='a'.repeat(24);
 const runtime={extensions:async(cwd:string,options:any)=>{calls.push({kind:'read',cwd,options});return {section:options?.section??'installed'};},searchExtensions:async(cwd:string,input:any)=>{calls.push({kind:'search',cwd,input});return {items:[],nextCursor:'opaque-next'};},installedPlugins:async(cwd:string)=>{calls.push({kind:'plugins',cwd});return {plugins:[]};}};
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
 registerCodexSettingsRoutes(app,{runtime,projects:{root:'C:/root',resolve:async(id:string)=>{assert.equal(id,projectId);return {path:'C:/project'};}},instructions:{}} as any);
 t.after(()=>app.close());return {app,calls,projectId};
}

test('extension section routes forward explicit section, refresh and scoped MCP detail',async t=>{
 const {app,calls,projectId}=setup(t),key='b'.repeat(64);
 assert.equal((await app.inject({url:`/api/codex/extensions?projectId=${projectId}&section=mcp&refresh=true&key=${key}`})).statusCode,200);
 assert.deepEqual(calls,[{kind:'read',cwd:'C:/project',options:{section:'mcp',refresh:true,key}}]);
 assert.equal((await app.inject({url:'/api/codex/extensions?section=apps&refresh=false'})).statusCode,200);
 assert.deepEqual(calls[1],{kind:'read',cwd:'C:/root',options:{section:'apps',refresh:false}});
 assert.equal((await app.inject({url:'/api/codex/extensions'})).statusCode,200);
 assert.deepEqual(calls[2],{kind:'read',cwd:'C:/root',options:{}});
 assert.equal((await app.inject({url:'/api/codex/plugins'})).statusCode,200);
 assert.deepEqual(calls[3],{kind:'plugins',cwd:'C:/root'});
});

test('extension search forwards one keyword page and its opaque cursor',async t=>{
 const {app,calls,projectId}=setup(t),cursor=encodeURIComponent('next+/=opaque');
 const response=await app.inject({url:`/api/codex/extensions/search?projectId=${projectId}&q=tool%20search&cursor=${cursor}&refresh=true`});
 assert.equal(response.statusCode,200);assert.equal(response.json().nextCursor,'opaque-next');
 assert.deepEqual(calls,[{kind:'search',cwd:'C:/project',input:{query:'tool search',cursor:'next+/=opaque',refresh:true}}]);
});

test('extension route input validation rejects invalid sections, paths, booleans and search scope before runtime',async t=>{
 const {app,calls}=setup(t),key='b'.repeat(64);
 for(const query of ['section=all','cwd=C:/private','refresh=1','refresh=yes','refresh=','section=apps&refresh=true&refresh=false',`section=apps&key=${key}`,`key=${key}`,'section=mcp&key=bad']){
  const response=await app.inject({url:'/api/codex/extensions?'+query});assert.equal(response.statusCode,400,query);
 }
 for(const query of ['','q=','q=%20%20','q=valid&cwd=C:/private','q=valid&section=apps','q=valid&refresh=1','q=valid&cursor=','q=a%00b','q=valid&cursor=a%00b']){
  const response=await app.inject({url:'/api/codex/extensions/search?'+query});assert.equal(response.statusCode,400,query);
 }
 assert.deepEqual(calls,[]);
});
