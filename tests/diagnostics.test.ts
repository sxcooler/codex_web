import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import {get} from 'node:http';
import {createServer} from 'node:net';
import {Diagnostics} from '../src/server/diagnostics.ts';
import {AppServer} from '../src/codex/app-server.ts';
import {Runtime} from '../src/codex/runtime.ts';
import {startServer} from '../src/server/main.ts';
import {initializeAuth} from '../src/server/auth.ts';

const fixture=fileURLToPath(new URL('./fixtures/rpc-server.mjs',import.meta.url));
test('diagnostics correlate concurrent RPC waits and timeouts without retaining payloads or retrying',async t=>{
  const events:any[]=[];
  const server=new AppServer({executable:process.execPath,args:[fixture],timeoutMs:1200,diagnostic:event=>events.push(event)});
  t.after(()=>server.close().catch(()=>{}));await server.initialize();
  const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  const calls=ids.map(threadId=>server.request('ignore',{threadId,text:'secret-sentinel',path:'private-file'}));
  const done=Promise.all(calls.map(call=>assert.rejects(call,/timed out/)));
  const waiting=server.diagnosticState();assert.equal(waiting.pendingCount,2);assert.deepEqual(waiting.pending.map((v:any)=>v.threadId),ids);assert.ok(waiting.nativePid>0);
  await done;assert.equal(await server.request('count',{}),2,'diagnostics must not retry');
  const timeouts=events.filter(v=>v.event==='rpc_end'&&v.outcome==='timeout');assert.equal(timeouts.length,2);assert.ok(timeouts.every(v=>v.elapsedMs>=1000));
  assert.equal(server.diagnosticState().pendingCount,0);assert.doesNotMatch(JSON.stringify([waiting,events]),/secret-sentinel|private-file/);
});

test('HTTP diagnostics observe pending/failed requests and resource samples without URLs, bodies or headers',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-diagnostics-')),diagnostics=new Diagnostics(dir),app=Fastify();
  t.after(async()=>{await app.close();await diagnostics.close();await rm(dir,{recursive:true,force:true});});
  diagnostics.attach(app);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  app.post('/api/sessions/:threadId/test',async(_request,reply)=>{await held;return reply.code(503).send({error:'secret-sentinel'});});
  await app.ready();const request=app.inject({method:'POST',url:'/api/sessions/00000000-0000-4000-8000-000000000001/test?path=secret-sentinel',headers:{cookie:'secret-sentinel'},payload:{text:'secret-sentinel'}});
  const result=request.then(value=>value);await new Promise(resolve=>setTimeout(resolve,50));
  diagnostics.sample();release();assert.equal((await result).statusCode,503);await diagnostics.close();
  const text=await readFile(join(dir,'diagnostics.jsonl'),'utf8'),events=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.some(v=>v.event==='sample'&&v.http.active===1&&v.http.pending[0].route==='/api/sessions/:threadId/test'&&v.cpuUserMs>=0&&v.rssBytes>0));
  assert.ok(events.some(v=>v.event==='http_end'&&v.statusCode===503));assert.doesNotMatch(text,/secret-sentinel|cookie|\?path/);
});

test('log rotation and pressure are bounded and disk failure does not throw into the service',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'diagnostics.jsonl'),'x'.repeat(1024*1024));
  const diagnostics=new Diagnostics(dir);
  for(let i=0;i<1000;i++)diagnostics.record({event:'test',value:'x'.repeat(1000)});
  await diagnostics.flush();diagnostics.sample();await diagnostics.close();
  assert.ok((await stat(join(dir,'diagnostics.jsonl'))).size<=1024*1024);assert.equal((await stat(join(dir,'diagnostics.jsonl.1'))).size,1024*1024);
  const text=await readFile(join(dir,'diagnostics.jsonl'),'utf8');assert.ok(text.trim().split('\n').map(JSON.parse).some(v=>v.dropped>0));
  const bad=new Diagnostics(join(dir,'not-created'));bad.record({event:'test'});await bad.close();
});

test('disconnects are logged but healthy SSE streams are not slow requests; samples detect an event-loop stall',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-diagnostics-')),diagnostics=new Diagnostics(dir),app=Fastify();
  let finish!:()=>void;const waiting=new Promise<void>(resolve=>{finish=resolve;});
  t.after(async()=>{finish();await app.close();await diagnostics.close();await rm(dir,{recursive:true,force:true});});
  diagnostics.attach(app);
  app.get('/api/slow',async()=>{await waiting;return {};});
  app.get('/api/sessions/:threadId/events',async(request,reply)=>{reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream'});reply.raw.write(': connected\n\n');await new Promise<void>(resolve=>reply.raw.once('close',resolve));});
  await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;
  const slow=get(`http://127.0.0.1:${port}/api/slow`);slow.on('error',()=>{});
  const stream=await new Promise<any>(resolve=>get(`http://127.0.0.1:${port}/api/sessions/test/events`,resolve));
  stream.resume();await new Promise(resolve=>setTimeout(resolve,50));
  const end=performance.now()+80;while(performance.now()<end){} // Isolated test process only.
  await new Promise(resolve=>setTimeout(resolve,30));diagnostics.sample();
  slow.destroy();stream.destroy();await new Promise(resolve=>setTimeout(resolve,50));finish();diagnostics.sample();await diagnostics.close();
  const text=await readFile(join(dir,'diagnostics.jsonl'),'utf8'),events=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.some(v=>v.event==='sample'&&v.http.active===1&&v.http.streams===1&&v.loopMaxMs>=50));
  assert.ok(events.some(v=>v.event==='http_end'&&v.route==='/api/slow'&&v.outcome==='aborted'));
  assert.equal(events.filter(v=>v.event==='http_end'&&v.route.endsWith('/events')).length,0);
  assert.ok(events.some(v=>v.event==='sample'&&v.http.active===0&&v.http.streams===0));
});

test('two read-only history requests share a project key without taking ownership or exposing cwd',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-diagnostics-')),path=join(dir,'native.mjs');
  await writeFile(path,`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id' in m)||m.method==='thread/turns/list')return;const result=m.method==='thread/read'?{thread:{id:m.params.threadId,cwd:'/private/project-sentinel',turns:[],status:{type:'idle'}}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const runtime=new Runtime({executable:process.execPath,cwd:dir,args:[path],diagnostic:()=>{}});
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  const done=Promise.all(ids.map(id=>assert.rejects(runtime.snapshot(id,{window:true}))));
  const deadline=Date.now()+3000;
  while(runtime.diagnosticState().native?.pending.filter(v=>v.method==='thread/turns/list').length!==2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const sample=runtime.diagnosticState();assert.equal(sample.native?.pendingCount,2);assert.equal(sample.threads.length,2);
  assert.ok(sample.threads.every(v=>v.projectKey&&v.projectKey===sample.threads[0].projectKey));assert.doesNotMatch(JSON.stringify(sample),/private|project-sentinel/);
  await runtime.close();await done;
});

test('the real server entry writes periodic diagnostics without starting an idle native runtime',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-diagnostics-')),probe=createServer();
  await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as any).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));await initializeAuth(dir,'fixture-password-long-enough');
  const overrides={WEB_DATA_DIR:dir,WORK_ROOT:dir,PORT:String(port),WEB_ORIGIN:`http://127.0.0.1:${port}`,CODEX_BIN:join(dir,'must-not-be-spawned')};
  const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  const signals={SIGINT:process.listeners('SIGINT'),SIGTERM:process.listeners('SIGTERM')};let app:Awaited<ReturnType<typeof startServer>>|undefined;
  t.after(async()=>{await app?.close();for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}for(const signal of ['SIGINT','SIGTERM'] as const)for(const listener of process.listeners(signal))if(!signals[signal].includes(listener))process.removeListener(signal,listener);await rm(dir,{recursive:true,force:true});});
  Object.assign(process.env,overrides);app=await startServer();
  await new Promise(resolve=>setTimeout(resolve,50));
  await assert.rejects(stat(join(dir,'diagnostics.jsonl')), {code:'ENOENT'}, 'normal startup must not create diagnostic logs');
  await app.close();app=await startServer(true);
  assert.equal((await app.inject({url:'/api/auth/session',headers:{host:`127.0.0.1:${port}`}})).statusCode,200);
  let events:any[]=[];const deadline=Date.now()+13_000;
  while(!events.some(v=>v.event==='sample')&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));events=(await readFile(join(dir,'diagnostics.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
  assert.ok(events.some(v=>v.event==='sample'&&v.runtime.inFlight===0&&!v.runtime.native));assert.equal(events.filter(v=>v.event==='native_start').length,0);
  await app.close();assert.match(await readFile(join(dir,'diagnostics.jsonl'),'utf8'),/"event":"stop"/);
  const saved=await readFile(join(dir,'diagnostics.jsonl'),'utf8');app=await startServer();await app.close();
  assert.equal(await readFile(join(dir,'diagnostics.jsonl'),'utf8'),saved,'normal restart must not inherit diagnostics or erase previous logs');
});
