import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { launchPreference } from '../scripts/portable.ts';

test('portable remembers explicit launch preference and never changes unattended defaults',async()=>{
  assert.equal(await launchPreference({}),false);
  assert.equal(await launchPreference({background:true}),true);
  const answers=['invalid','n'];
  const terminal={question:async()=>answers.shift()!};
  assert.equal(await launchPreference({},terminal),false);
  assert.equal(await launchPreference({background:false},{question:async()=>''},true),true);
});

test('background startup survives launcher exit, authenticates control, reuses and stops only its instance', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex background 'space "));
  const run = (...args: string[]) => new Promise<{code:number|null;output:string}>(resolve => {
    const child = spawn(process.execPath, [join(root,'scripts/server-control.ts'), ...args], { cwd: root, windowsHide: true });
    let output=''; child.stdout.on('data', chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
    child.on('close',code=>resolve({code,output}));
  });
  let port=0;
  const occupied=createServer();
  await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  port=(occupied.address() as any).port;
  await new Promise<void>(resolve=>occupied.close(()=>resolve()));
  try {
    await mkdir(join(root,'scripts'),{recursive:true}); await mkdir(join(root,'src/server'),{recursive:true}); await mkdir(join(root,'.local/web'),{recursive:true});
    await copyFile(new URL('../scripts/server-control.ts',import.meta.url),join(root,'scripts/server-control.ts'));
    await mkdir(join(root,'scripts/windows'),{recursive:true});
    await copyFile(new URL('../scripts/windows/background-host.ps1',import.meta.url),join(root,'scripts/windows/background-host.ps1'));
    await writeFile(join(root,'.local/web/config.json'),JSON.stringify({origin:`http://localhost:${port}`}));
    await writeFile(join(root,'src/server/main.ts'),`import {createServer} from 'node:http'; export async function startServer(){ const app=createServer((req,res)=>res.end('fixture')); await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(${port},'127.0.0.1',resolve)}); return {close:()=>new Promise(resolve=>{app.closeAllConnections();app.close(resolve)})}; }`);
    const starts=await Promise.all([run('--background'),run('--background')]);
    for(const start of starts) assert.equal(start.code,0,start.output);
    const state=JSON.parse(await readFile(join(root,'.local/web/server-control.json'),'utf8'));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'fixture');
    const forbidden=await fetch(`http://127.0.0.1:${state.port}/stop`,{method:'POST'}); assert.equal(forbidden.status,403);
    const crossOrigin=await fetch(`http://127.0.0.1:${state.port}/stop`,{method:'POST',headers:{Authorization:`Bearer ${state.token}`,Origin:'https://example.invalid'}}); assert.equal(crossOrigin.status,403);
    await writeFile(join(root,'.local/web/server-control.json'),JSON.stringify({...state,token:'0'.repeat(64)}));
    assert.equal((await run('--stop')).code,0);
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status,200,'stale identity cannot stop live server');
    await writeFile(join(root,'.local/web/server-control.json'),JSON.stringify(state));
    const again=await run('--background'); assert.equal(again.code,0,again.output); assert.match(again.output,/Already running/);
    const same=JSON.parse(await readFile(join(root,'.local/web/server-control.json'),'utf8')); assert.equal(same.token,state.token);
    const status=await run('--status'); assert.match(status.output,/Running:/);
    const stop=await run('--stop'); assert.equal(stop.code,0,stop.output);
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    assert.equal((await run('--stop')).code,0);
    await new Promise<void>(resolve=>occupied.listen(port,'127.0.0.1',resolve));
    const failed=await run('--background'); assert.notEqual(failed.code,0,failed.output); assert.equal(occupied.listening,true,'unrelated listener preserved');
    assert.match(failed.output,/did not become ready/);
  } finally { await run('--stop'); if(occupied.listening)await new Promise<void>(resolve=>occupied.close(()=>resolve())); await rm(root,{recursive:true,force:true}); }
});
