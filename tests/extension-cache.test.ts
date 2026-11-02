import test from 'node:test';
import assert from 'node:assert/strict';
import {ExtensionCatalogCache} from '../src/codex/extension-cache.ts';
const context={epoch:'e',home:'/codex',cwd:'/work',authRevision:0,configGeneration:0};
const policy={ttlMs:30_000,maxAgeMs:900_000};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

test('cache coalesces reads, refreshes past TTL and retains safe stale data on failure',async()=>{
 let now=0,calls=0;const cache=new ExtensionCatalogCache({now:()=>now});const pending=deferred<string>();
 const load=()=>{calls++;return pending.promise;};
 const a=cache.read(context,'installed',policy,load),b=cache.read(context,'installed',policy,load);
 pending.resolve('first');assert.equal((await a).data,'first');assert.equal((await b).data,'first');assert.equal(calls,1);
 now=100;assert.equal((await cache.read(context,'installed',policy,async()=>{throw Error('must not run');})).stale,false);
 now=31_000;const stale=await cache.read(context,'installed',policy,async()=>{calls++;throw Object.assign(Error('<script>token=secret</script>'),{code:'UPSTREAM_CHALLENGE',httpStatus:403});});
 assert.equal(stale.data,'first');assert.equal(stale.lastSuccessAt,0);assert.equal(stale.stale,true);assert.equal(stale.error?.code,'UPSTREAM_CHALLENGE');assert.equal(JSON.stringify(stale).includes('secret'),false);
 await cache.read(context,'installed',policy,async()=>{calls++;return 'bad';});assert.equal(calls,2);
 assert.equal((await cache.read(context,'installed',policy,async()=>{calls++;return 'new';},true)).data,'new');assert.equal(calls,3);
 now+=900_001;await assert.rejects(cache.read(context,'installed',policy,async()=>{throw Error('failed');}));
});

test('cache separates identity, configuration generation and MCP target/detail keys',async()=>{
 const cache=new ExtensionCatalogCache();let calls=0;
 for(const c of [context,{...context,epoch:'next'},{...context,home:'/other'},{...context,cwd:'/other'},{...context,authRevision:1},{...context,configGeneration:1}])assert.equal((await cache.read(c,'installed',policy,async()=>++calls)).data,calls);
 for(const key of ['mcp:status','mcp:detail:A','mcp:detail:B'])await cache.read(context,key,policy,async()=>++calls);
 assert.equal(calls,9);
});

test('invalidated inflight results cannot return or repopulate a newer cache generation',async()=>{
 const cache=new ExtensionCatalogCache(),pending=deferred<string>();const old=cache.read(context,'installed',policy,()=>pending.promise);
 cache.invalidate(context,['installed']);pending.resolve('obsolete');await assert.rejects(old,{code:'EXTENSION_CONTEXT_CHANGED'});
 assert.equal((await cache.read(context,'installed',policy,async()=>'current')).data,'current');
});

test('partial inventory keeps new IDs even when metadata failed',async()=>{
 const cache=new ExtensionCatalogCache();await cache.read(context,'apps',policy,async()=>({ids:['A'],metadata:'ok'}));
 const result=await cache.read(context,'apps',policy,async()=>({ids:['A','B'],metadata:'error'}),true);
 assert.deepEqual(result.data.ids,['A','B']);assert.equal(result.data.metadata,'error');assert.equal(result.stale,false);
});

test('bounded LRU evicts old contexts and search pages without flushing unrelated sections',async()=>{
 const cache=new ExtensionCatalogCache({maxContexts:2,maxSearchPages:2});let calls=0;
 const read=(c:typeof context,key:string)=>cache.read(c,key,policy,async()=>++calls);
 await read(context,'installed');await read({...context,cwd:'/two'},'installed');await read({...context,cwd:'/three'},'installed');await read(context,'installed');assert.equal(calls,4);
 for(const key of ['search:a:1','search:a:2','search:a:3'])await read(context,key);
 await read(context,'search:a:1');assert.equal(calls,8);
 await read(context,'installed');assert.equal(calls,8);
 cache.invalidate(context,['search']);await read(context,'search:a:1');assert.equal(calls,9);
});
