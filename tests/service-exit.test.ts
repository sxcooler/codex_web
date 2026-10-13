import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';

async function fixture(body=''){
 const root=await mkdtemp(join(tmpdir(),'codex exit '));
 for(const dir of ['scripts/windows','src/server','.local/web'])await mkdir(join(root,dir),{recursive:true});
 await copyFile(new URL('../scripts/server-control.ts',import.meta.url),join(root,'scripts/server-control.ts'));
 await copyFile(new URL('../scripts/windows/background-host.ps1',import.meta.url),join(root,'scripts/windows/background-host.ps1'));
 await copyFile(new URL('../src/server/lifecycle.ts',import.meta.url),join(root,'src/server/lifecycle.ts'));
 await writeFile(join(root,'src/server/main.ts'),`import {createServer} from 'node:http'; export async function startServer(diagnosticsEnabled=false){${body} const app=createServer((req,res)=>res.end(String(diagnosticsEnabled))); await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve)); return {server:app,prepareRestart:async()=>{},close:async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));${body==='/*close-failure*/'?"throw Error('close sentinel');":''}}};}`);
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as any).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 await writeFile(join(root,'.local/web/config.json'),JSON.stringify({port,origin:`http://localhost:${port}`,workRoot:root}));
 return root;
}
async function records(root:string){return (await readFile(join(root,'.local/web/lifecycle.jsonl'),'utf8').catch((e:any)=>{if(e.code==='ENOENT')return '';throw e;})).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
function run(root:string,...args:string[]){
 const child=spawn(process.execPath,[join(root,'scripts/server-control.ts'),'--worker',...args],{cwd:root,windowsHide:true});
 let stderr='';child.stderr.on('data',v=>stderr+=v);child.stdout.resume();
 const done=new Promise<number|null>(resolve=>child.once('close',resolve));return {child,done,stderr:()=>stderr};
}
async function ready(root:string){
 for(let i=0;i<200;i++){const value=await readFile(join(root,'.local/web/server-control.json'),'utf8').then(JSON.parse,()=>null);if(value)return value;await delay(15);}
 throw Error('Fixture did not become ready');
}
async function stop(state:any){return fetch(`http://127.0.0.1:${state.port}/stop`,{method:'POST',headers:{Authorization:`Bearer ${state.token}`,Connection:'close'}});}
async function cleanup(root:string,child?:ReturnType<typeof spawn>){if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('close',resolve));}await rm(root,{recursive:true,force:true});}

for(const diagnostics of [false,true])test(`worker records authenticated normal shutdown with diagnostics ${diagnostics}`,{timeout:10_000},async()=>{
 const root=await fixture(),worker=run(root,...(diagnostics?['--diagnostics']:[]));
 try{
  const state=await ready(root),url=`http://127.0.0.1:${state.port}`;
  assert.equal((await fetch(url+'/stop',{method:'POST'})).status,403);
  assert.equal((await records(root)).some(v=>v.event==='control_stop'),false);
  assert.equal((await stop(state)).status,200);assert.equal(await worker.done,0);
  const events=await records(root);assert.deepEqual(events.map(v=>v.event),['startup','ready','control_stop','shutdown_begin','shutdown_end','exit']);
  assert.equal(events[0].diagnosticsEnabled,diagnostics);assert.equal(events.at(-1).exitCode,0);
  assert.equal(events[1].controlPort,state.port);assert.equal(events[1].port,JSON.parse(await readFile(join(root,'.local/web/config.json'),'utf8')).port);
  assert.ok(events.every(v=>v.pid===worker.child.pid&&Number.isInteger(v.parentPid)));
  assert.equal(events[2].reason,'control_stop');assert.equal(events[3].reason,'control_stop');
  assert.doesNotMatch(JSON.stringify(events),new RegExp(state.token));
 }finally{await cleanup(root,worker.child);}
});

test('close failure records failure and preserves exit 1 and control cleanup',{timeout:10_000},async()=>{
 const root=await fixture('/*close-failure*/'),worker=run(root);
 try{const state=await ready(root);await stop(state);assert.equal(await worker.done,1);const events=await records(root);assert.deepEqual(events.map(v=>v.event),['startup','ready','control_stop','shutdown_begin','shutdown_failure','exit']);assert.match(events[4].message,/close sentinel/);assert.equal(events.at(-1).exitCode,1);await assert.rejects(readFile(join(root,'.local/web/server-control.json')),{code:'ENOENT'});}finally{await cleanup(root,worker.child);}
});

test('startup failure retains bounded redacted error fields without expanding private properties',{timeout:10_000},async()=>{
 const root=await fixture(`throw Object.assign(Error('startup sentinel token=SECRET_TOKEN Bearer SECRET_BEARER cookie=SECRET_COOKIE credentials=SECRET_CREDS https://user:SECRET_PASSWORD@example.test/ '+ 'x'.repeat(20000)),{code:'E_STARTUP',config:'PRIVATE_CONFIG',request:{body:'PRIVATE_BODY'},token:'PRIVATE_TOKEN'});`),worker=run(root);
 try{assert.equal(await worker.done,1);const events=await records(root);assert.deepEqual(events.map(v=>v.event),['startup','startup_failure','exit']);const error=events[1];assert.equal(error.code,'E_STARTUP');assert.match(error.message,/startup sentinel/);assert.match(error.stack,/startServer/);assert.ok(error.message.length<=2048&&error.stack.length<=8192);assert.doesNotMatch(JSON.stringify(events),/SECRET_|PRIVATE_/);assert.equal(error.config,undefined);assert.equal(error.request,undefined);assert.equal(error.token,undefined);assert.equal(events.at(-1).exitCode,1);}finally{await cleanup(root,worker.child);}
});

for(const mode of ['exception','rejection'])test(`default fatal ${mode} writes synchronous monitor evidence and still exits 1`,{timeout:10_000},async()=>{
 const root=await fixture(`setTimeout(()=>{${mode==='exception'?"throw Error('fatal sentinel token=SECRET_FATAL');":"void Promise.reject(Error('fatal sentinel token=SECRET_FATAL'));"}},60);`),worker=run(root);
 try{assert.equal(await worker.done,1);const events=await records(root),fatal=events.find(v=>v.event==='fatal');assert.ok(fatal,'fatal record must survive immediate process termination');assert.equal(fatal.origin,mode==='exception'?'uncaughtException':'unhandledRejection');assert.match(fatal.message,/fatal sentinel/);assert.match(fatal.stack,/main.ts/);assert.doesNotMatch(JSON.stringify(events),/SECRET_FATAL/);assert.equal(events.at(-1).exitCode,1);assert.match(worker.stderr(),/fatal sentinel/,'Node retains its default fatal error output');}finally{await cleanup(root,worker.child);}
});

test('unwritable lifecycle log preserves normal shutdown and default fatal outcome',{timeout:10_000},async()=>{
 for(const body of ['',`setTimeout(()=>{throw Error('unwritable fatal');},60);`]){
  const root=await fixture(body);await mkdir(join(root,'.local/web/lifecycle.jsonl'));const worker=run(root);
  try{if(!body)await stop(await ready(root));assert.equal(await worker.done,body?1:0);if(body)assert.match(worker.stderr(),/unwritable fatal/);}finally{await cleanup(root,worker.child);}
 }
});

test('lifecycle records rotate at one MiB with one backup',{timeout:10_000},async()=>{
 const root=await fixture(`throw Error('rotation sentinel');`);
 try{
  const previous=JSON.stringify({event:'old',padding:'x'.repeat(1048576)})+'\n';
  for(let i=0;i<2;i++){await writeFile(join(root,'.local/web/lifecycle.jsonl'),previous);const worker=run(root);assert.equal(await worker.done,1);assert.ok((await records(root)).some(v=>v.event==='startup_failure'));assert.equal((await stat(join(root,'.local/web/lifecycle.jsonl.1'))).size,Buffer.byteLength(previous));assert.ok((await stat(join(root,'.local/web/lifecycle.jsonl'))).size<1048576);}
  await assert.rejects(stat(join(root,'.local/web/lifecycle.jsonl.2')),{code:'ENOENT'});
 }finally{await cleanup(root);}
});

test('worker signal shutdown is idempotent and records signal reason',{timeout:10_000},async()=>{
 const root=await fixture(`setTimeout(()=>{process.emit('SIGTERM');process.emit('SIGTERM');},100);`),worker=run(root);
 try{assert.equal(await worker.done,0);const events=await records(root);assert.equal(events.filter(v=>v.event==='signal').length,2);assert.equal(events.filter(v=>v.event==='shutdown_begin').length,1);assert.equal(events.find(v=>v.event==='shutdown_end').reason,'SIGTERM');assert.equal(events.at(-1).exitCode,0);}finally{await cleanup(root,worker.child);}
});

for(const mode of ['normal','startup-failure','close-failure','listen-close-failure'])test(`direct server entry records ${mode} without diagnostics`,{timeout:10_000},async()=>{
 const root=await fixture();
 try{
  await mkdir(join(root,'src/codex'),{recursive:true});
  await copyFile(new URL('../src/server/main.ts',import.meta.url),join(root,'src/server/main.ts'));
  await writeFile(join(root,'src/server/app.ts'),`import {createServer} from 'node:http';export async function buildServer(){${mode==='startup-failure'?"throw Error('direct startup sentinel');":''}const server=createServer((req,res)=>res.end('fixture'));return {addHook(){},decorate(){},async listen(options){${mode==='listen-close-failure'?"throw Error('listen original sentinel');":''}await new Promise(resolve=>server.listen(options.port,options.host,resolve));setTimeout(()=>process.emit('SIGTERM'),60);},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));${mode.includes('close-failure')?"throw Error('direct close sentinel');":''}}};}`);
  await writeFile(join(root,'src/codex/runtime.ts'),`export class Runtime{diagnosticState(){return {};}}`);
  await writeFile(join(root,'src/codex/executable.ts'),`export const resolveCodexExecutable=()=>process.execPath,assertCodexVersion=()=>{},codexUpgradeMessage='fixture';`);
  await writeFile(join(root,'src/projects.ts'),`export class Projects{}`);
  await writeFile(join(root,'src/server/diagnostics.ts'),`export class Diagnostics{close(){}record(){}attach(){}}`);
  await writeFile(join(root,'src/server/restart.ts'),`export const webRestart=()=>undefined;`);
  const config=JSON.parse(await readFile(join(root,'.local/web/config.json'),'utf8'));
  const result=spawnSync(process.execPath,[join(root,'src/server/main.ts')],{cwd:root,env:{...process.env,WEB_DATA_DIR:join(root,'.local/web'),WORK_ROOT:root,PORT:String(config.port),WEB_ORIGIN:config.origin},encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(result.status,mode==='normal'?0:1,result.stderr);
  const events=await records(root);assert.equal(events[0]?.event,'startup');assert.equal(events[0].reason,'server_start');
  if(mode==='startup-failure'){assert.match(events.find(v=>v.event==='startup_failure')?.message??'',/direct startup sentinel/);}
  else if(mode==='listen-close-failure'){assert.match(events.find(v=>v.reason==='listen_failed')?.message??'',/listen original sentinel/);assert.ok(events.some(v=>v.message?.includes('direct close sentinel')));}
  else {assert.ok(events.some(v=>v.event==='ready'));assert.equal(events.find(v=>v.event==='signal')?.signal,'SIGTERM');assert.ok(events.some(v=>v.event==='shutdown_begin'));assert.ok(events.some(v=>v.event===(mode==='normal'?'shutdown_end':'shutdown_failure')));}
  assert.equal(events.at(-1).event,'exit');assert.equal(events.at(-1).exitCode,mode==='normal'?0:1);
 }finally{await cleanup(root);}
});

test('controller startup failure is recorded before throwing close cleanup replaces it',{timeout:10_000},async()=>{
 const root=await fixture('/*close-failure*/');await mkdir(join(root,'.local/web/server-control.json'));const worker=run(root);
 try{assert.equal(await worker.done,1);const events=await records(root),original=events.find(v=>v.reason==='control_startup_failed');assert.ok(original,'original record publication failure must survive failing cleanup');assert.ok(original.code);assert.ok(events.some(v=>v.message?.includes('close sentinel')));assert.equal(events.at(-1).exitCode,1);}finally{await cleanup(root,worker.child);}
});

test('managed real server signal close failure completes controller finally-cleanup before exit',{timeout:10_000},async()=>{
 const root=await fixture();let worker:ReturnType<typeof run>|undefined;
 try{
  await mkdir(join(root,'src/codex'),{recursive:true});
  await copyFile(new URL('../src/server/main.ts',import.meta.url),join(root,'src/server/main.ts'));
  await writeFile(join(root,'src/server/app.ts'),`import {createServer} from 'node:http';export async function buildServer(){const server=createServer((req,res)=>res.end('fixture'));let closing;return {addHook(){},decorate(){},async listen(options){await new Promise(resolve=>server.listen(options.port,options.host,resolve));setTimeout(()=>process.emit('SIGTERM'),100);},close(){return closing??=(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw Error('managed signal close sentinel');})();}};}`);
  await writeFile(join(root,'src/codex/runtime.ts'),`export class Runtime{diagnosticState(){return {};}}`);
  await writeFile(join(root,'src/codex/executable.ts'),`export const resolveCodexExecutable=()=>process.execPath,assertCodexVersion=()=>{},codexUpgradeMessage='fixture';`);
  await writeFile(join(root,'src/projects.ts'),`export class Projects{}`);
  await writeFile(join(root,'src/server/diagnostics.ts'),`export class Diagnostics{close(){}record(){}attach(){}}`);
  await writeFile(join(root,'src/server/restart.ts'),`export const webRestart=()=>undefined;`);
  worker=run(root);const state=await ready(root);assert.equal(await worker.done,1);
  await assert.rejects(readFile(join(root,'.local/web/server-control.json')),{code:'ENOENT'},'managed shutdown must finish its ownership cleanup even when Web close throws');
  await assert.rejects(fetch(`http://127.0.0.1:${state.port}/status`));
  const events=await records(root);assert.ok(events.some(v=>v.event==='shutdown_failure'));assert.equal(events.at(-1).exitCode,1);
 }finally{await cleanup(root,worker?.child);}
});

test('Windows hidden host records actual Node exit and logging errors preserve that code',{skip:process.platform!=='win32',timeout:30_000},async()=>{
 const root=await fixture();
 try{
  await writeFile(join(root,'scripts/server-control.ts'),`console.log('host fixture');process.exitCode=23;`);
  for(const shell of [join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'pwsh.exe']){
   const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/windows/background-host.ps1'),'-NodePath',process.execPath,'-Worker'];
   await writeFile(join(root,'.local/web/server.log'),'x'.repeat(1048576));
   const result=spawnSync(shell,args,{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,23,result.stderr);
   const events=(await readFile(join(root,'.local/web/server.log'),'utf8')).trim().split('\n').flatMap(line=>{try{return [JSON.parse(line.replace(/^\uFEFF/,''))];}catch{return [];}});
   assert.deepEqual(events.map(v=>v.event),['host_start','host_end']);assert.equal(events[1].exitCode,23);assert.equal(events[1].reason,'node_exit');assert.ok(Number.isInteger(events[0].pid)&&Number.isInteger(events[0].parentPid));
   assert.equal((await stat(join(root,'.local/web/server.log.1'))).size,1048576);
   await rm(join(root,'.local/web/server.log'));await mkdir(join(root,'.local/web/server.log'));
   assert.equal(spawnSync(shell,args,{encoding:'utf8',windowsHide:true,timeout:10000}).status,23,'logging failure must not replace Node exit');
   await rm(join(root,'.local/web/server.log'),{recursive:true});
  }
  const missing=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',join(root,'scripts/windows/background-host.ps1'),'-NodePath',join(root,'missing-node.exe'),'-Worker'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(missing.status,0,'preserve existing null-LASTEXITCODE launch behavior');
  assert.match(await readFile(join(root,'.local/web/server.log'),'utf8'),/"event":"host_error"/);
 }finally{await cleanup(root);}
});
