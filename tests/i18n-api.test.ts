import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/web/api.ts';
import {formatDisplayError} from '../src/web/i18n/errors.ts';

test('transport errors change display language without changing uncertainty, raw diagnostics or retry count',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new TypeError('Failed to fetch');});
 await assert.rejects(api('/sessions/thread/messages',{}),(error:any)=>{
  assert.match(error.message,/提交结果待核实/);assert.equal(error.status,undefined);
  assert.match(formatDisplayError(error,'en'),/submission result is unconfirmed/);return true;
 });assert.equal(calls,1);
 t.mock.method(globalThis,'fetch',async()=>new Response('{broken',{status:502}));
 await assert.rejects(api('/sessions/thread/messages',{}),(error:any)=>{
  assert.equal(error.status,502);assert.match(formatDisplayError(error,'en'),/JSON \(502\).*unconfirmed/);return true;
 });
});

test('narrow coded errors translate while native payload and partial result remain exact',async t=>{
 const payload={error:'native diagnostic 原文',code:'RUNTIME_RESULT_UNKNOWN',partial:{threadId:'known-thread'}};
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(payload),{status:504}));
 await assert.rejects(api('/sessions/thread'),(error:any)=>{
  assert.equal(formatDisplayError(error,'en'),payload.error);assert.deepEqual(error.data,payload);assert.equal(error.status,504);return true;
 });
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'Invalid credentials',code:'AUTH_INVALID_CREDENTIALS'}),{status:401}));
 await assert.rejects(api('/auth/login',{}),(error:any)=>{assert.equal(error.message,'Invalid credentials');assert.equal(formatDisplayError(error,'en'),'Incorrect password. Please retry.');return true;});
});
