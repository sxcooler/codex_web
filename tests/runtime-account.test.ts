import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {Runtime} from '../src/codex/runtime.ts';

test('account RPCs keep credentials private, gate reviewed protocol and recheck identity before consume',async t=>{
  const runtime=new Runtime({executable:process.execPath,cwd:process.cwd()});
  t.after(()=>runtime.close());
  const calls:Array<{method:string;params:any}>=[];
  let accountId='native-account',throwConsume=false;
  const server={close:async()=>{},request:async(method:string,params:any)=>{calls.push({method,params});if(method==='account/read')return {account:{type:'chatgpt',email:'private@example.test',planType:'plus'}};if(method==='account/rateLimits/read')return {accountId};if(method==='account/rateLimitResetCredit/consume'){if(throwConsume)throw Error('private native diagnostic');return {outcome:'reset'};}throw Error(method);}};
  (runtime as any).server=server;(runtime as any).initializeInfo={userAgent:'codex_remote_web/0.153.4 (fixture)'};
  t.mock.method(runtime as any,'getServer',async()=>server);
  const identity=await runtime.accountIdentity();assert.equal(identity.resetProtocol,true);assert.match(identity.identity,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(identity).includes('private'));
  const expected=createHash('sha256').update(accountId).digest('hex'),input={creditId:'credit',idempotencyKey:'034886c2-4676-454c-bf02-99b705862906'};
  assert.deepEqual(await runtime.consumeAccountReset(input,expected),{outcome:'reset'});
  assert.deepEqual(calls.slice(-2),[{method:'account/rateLimits/read',params:{}},{method:'account/rateLimitResetCredit/consume',params:input}]);
  accountId='other-account';await assert.rejects(runtime.consumeAccountReset(input,expected),{code:'RUNTIME_ACCOUNT_CHANGED'});assert.equal(calls.filter(c=>c.method.endsWith('/consume')).length,1);
  for(const version of ['codex_remote_web/0.153.4-beta','codex_remote_web/0.200.0 (client 0.153.4)']){(runtime as any).initializeInfo.userAgent=version;assert.equal((await runtime.accountIdentity()).resetProtocol,false);await assert.rejects(runtime.consumeAccountReset(input,expected),{code:'RUNTIME_ACCOUNT_UNSUPPORTED'});}
  (runtime as any).initializeInfo.userAgent='codex_remote_web/0.153.4 (fixture)';accountId='native-account';throwConsume=true;
  await assert.rejects(runtime.consumeAccountReset(input,expected),(e:any)=>e.code==='RUNTIME_RESULT_UNKNOWN'&&!e.message.includes('private'));
  assert.ok(calls.every(c=>c.method.startsWith('account/')),'usage must never open threads or start model tasks');
});
