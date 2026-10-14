import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {buildServer} from '../src/server/app.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {Diagnostics} from '../src/server/diagnostics.ts';

async function fixture(t:TestContext,diagnosticMode=false){
  const local=resolve('.local');await mkdir(local,{recursive:true});
  const dir=await mkdtemp(join(local,'api-error-logging-'));
  await initializeAuth(dir,'fixture-password-long-enough');
  const diagnostics=diagnosticMode?new Diagnostics(dir):undefined;
  const app=await buildServer({dataDir:dir,origin:'http://localhost:3000',diagnostics});
  t.after(async()=>{await app.close();await diagnostics?.close();await rm(dir,{recursive:true,force:true});});
  const logs:string[]=[];t.mock.method(console,'error',(...args:unknown[])=>logs.push(args.map(String).join(' ')));
  const login=async()=>{
    const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
    const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
    const signed=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'fixture-password-long-enough'}});
    headers.cookie+='; '+String(signed.headers['set-cookie']).split(';')[0];return headers;
  };
  return {app,dir,diagnostics,logs,login};
}

for(const diagnosticMode of [false,true])test(`API exceptions retain message and stack in ${diagnosticMode?'diagnostic and ordinary':'ordinary'} logs without request secrets`,async t=>{
  const {app,dir,diagnostics,logs,login}=await fixture(t,diagnosticMode);
  const cause=Object.assign(new Error('metadata query failed'),{code:'SQLITE_ERROR',privatePayload:'private-error-property-sentinel'});
  cause.stack='Error: metadata query failed\n    at readMetadata (fixture.ts:12:3)';
  app.post('/api/failure/:threadId',async()=>{throw cause;});
  const headers=await login();headers['x-private-header']='private-header-sentinel';
  const response=await app.inject({method:'POST',url:'/api/failure/test-thread?search=private-query-sentinel',headers,payload:{prompt:'private-prompt-sentinel'}});
  assert.equal(response.statusCode,500);assert.deepEqual(response.json(),{error:'Internal server error',code:'INTERNAL_ERROR'});
  assert.equal(logs.length,1,'ordinary mode must always log the exception');
  const ordinary=JSON.parse(logs[0]);
  assert.equal(ordinary.event,'api_error');assert.equal(ordinary.route,'/api/failure/:threadId');assert.equal(ordinary.method,'POST');
  assert.equal(typeof ordinary.requestId,'string');assert.equal(ordinary.name,'Error');assert.equal(ordinary.code,'SQLITE_ERROR');
  assert.match(ordinary.time,/^\d{4}-\d{2}-\d{2}T.*Z$/);assert.equal(ordinary.pid,process.pid);
  assert.equal(ordinary.message,'metadata query failed');assert.equal(ordinary.stack,'Error: metadata query failed\n    at readMetadata (fixture.ts:12:3)');
  let evidence=logs.join('\n');
  if(diagnostics){
    await diagnostics.flush();const diagnosticText=await readFile(join(dir,'diagnostics.jsonl'),'utf8');evidence+='\n'+diagnosticText;
    const events=diagnosticText.trim().split('\n').map(line=>JSON.parse(line));
    const failure=events.find(event=>event.event==='http_error'),ended=events.find(event=>event.event==='http_end'&&event.route==='/api/failure/:threadId');
    assert.ok(failure,'diagnostics must preserve the exception cause');assert.equal(failure.id,ended.id);assert.equal(failure.requestId,ordinary.requestId);
    for(const field of ['route','method','code','name','message','stack'])assert.equal(failure[field],ordinary[field]);
  }
  assert.doesNotMatch(evidence,/private-(?:query|header|prompt|error-property)-sentinel/);
  assert.doesNotMatch(evidence,new RegExp(headers.cookie.split('; ')[1].split('=')[1]));
});

test('shared availability errors return their 503 code while preserving server stack',async t=>{
  const {app,logs,login}=await fixture(t);
  app.get('/api/shared-failure',async()=>{throw Object.assign(new Error('Shared read is unavailable'),{statusCode:503,code:'SHARED_STATE_UNAVAILABLE'});});
  const response=await app.inject({url:'/api/shared-failure',headers:await login()});
  assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{error:'Shared read is unavailable',code:'SHARED_STATE_UNAVAILABLE'});
  assert.equal(JSON.parse(logs[0]).code,'SHARED_STATE_UNAVAILABLE');assert.match(JSON.parse(logs[0]).stack,/Shared read is unavailable/);
});

test('error logging failures never change the API error response',async t=>{
  const {app,diagnostics,login}=await fixture(t,true);
  app.get('/api/failure',async()=>{throw new Error('original exception');});
  const headers=await login();
  t.mock.method(console,'error',()=>{throw new Error('stderr failed');});
  (diagnostics as any).recordHttpError=()=>{throw new Error('diagnostic failed');};
  const response=await app.inject({url:'/api/failure',headers});
  assert.equal(response.statusCode,500);assert.deepEqual(response.json(),{error:'Internal server error',code:'INTERNAL_ERROR'});
});

test('diagnostics still records the exception when ordinary logging fails',async t=>{
  const {app,dir,diagnostics,login}=await fixture(t,true);
  app.get('/api/failure',async()=>{throw new Error('original exception');});
  const headers=await login();t.mock.method(console,'error',()=>{throw new Error('stderr failed');});
  const response=await app.inject({url:'/api/failure',headers});assert.equal(response.statusCode,500);
  await diagnostics!.flush();
  const events=(await readFile(join(dir,'diagnostics.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events.find(event=>event.event==='http_error').message,'original exception');
});

test('ordinary logging still records the exception when diagnostics fails',async t=>{
  const {app,diagnostics,logs,login}=await fixture(t,true);
  app.get('/api/failure',async()=>{throw new Error('original exception');});
  const headers=await login();(diagnostics as any).recordHttpError=()=>{throw new Error('diagnostic failed');};
  const response=await app.inject({url:'/api/failure',headers});assert.equal(response.statusCode,500);
  assert.equal(JSON.parse(logs[0]).message,'original exception');
});
