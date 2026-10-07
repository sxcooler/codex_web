import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';

test('diagnostic restart passes the requested flag to the new worker and preserves existing diagnostics', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex diagnostic restart '));
  const shell=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    for(const dir of ['scripts/windows','.local/web','dist'])await mkdir(join(root,dir),{recursive:true});
    await copyFile(new URL('../scripts/windows/restart-server.ps1',import.meta.url),join(root,'scripts/windows/restart-server.ps1'));
    await writeFile(join(root,'dist/index.html'),'fixture');
    await writeFile(join(root,'scripts/windows/common.ps1'),`
$ErrorActionPreference='Stop'
$projectRoot='${root.replaceAll("'","''")}'
$nodePath='${process.execPath.replaceAll("'","''")}'
$portableArgs=@()
$env:FIXTURE_WORKER_PID=[string]$PID
function Get-CimInstance {param($ClassName,$Filter) [pscustomobject]@{CreationDate=[datetime]'2026-10-03T00:00:00Z'}}
function Get-NetTCPConnection {param($State,$LocalPort) $state=Get-Content (Join-Path $projectRoot '.local/web/state.json') -Raw | ConvertFrom-Json; if(-not $state.stopped){[pscustomobject]@{OwningProcess=$state.pid}}}
function Invoke-WebRequest {param($Uri,$Headers,[switch]$UseBasicParsing,$TimeoutSec) [pscustomobject]@{StatusCode=200}}
`);
    await writeFile(join(root,'scripts/server-control.ts'),`
import {readFileSync,writeFileSync} from 'node:fs';
const path=new URL('../.local/web/state.json',import.meta.url);
export async function managedServer(){return JSON.parse(readFileSync(path,'utf8'));}
if(process.argv.includes('--stop-if-idle'))writeFileSync(path,JSON.stringify({...await managedServer(),stopped:true}));
if(process.argv.includes('--background')){writeFileSync(new URL('../.local/web/start-args.json',import.meta.url),JSON.stringify(process.argv.slice(2)));writeFileSync(path,JSON.stringify({pid:Number(process.env.FIXTURE_WORKER_PID),origin:'http://localhost:3333',diagnosticsEnabled:process.argv.includes('--diagnostics')}));}
`);
    const session=spawnSync(shell,['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{encoding:'utf8',windowsHide:true});
    assert.equal(session.status,0,session.stderr);
    for(const [requested,existing] of [[true,false],[false,true],[false,false]]){
      await writeFile(join(root,'.local/web/state.json'),JSON.stringify({pid:process.pid,origin:'http://localhost:3333',diagnosticsEnabled:existing}));
      const request=join(root,'request.json');
      await writeFile(request,JSON.stringify({sessionId:Number(session.stdout.trim()),oldPid:process.pid,oldStarted:'2026-10-03T00:00:00.0000000Z',port:3333,environment:{},requireIdle:true,diagnosticsEnabled:requested}));
      const run=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/windows/restart-server.ps1'),'-Worker','-RequestFile',request],{encoding:'utf8',windowsHide:true,timeout:20000});
      assert.equal(run.status,0,run.stdout+run.stderr);
      const result=JSON.parse((await readFile(request+'.result.json','utf8')).replace(/^\uFEFF/,''));
      assert.equal(result.status,'success');
      const args=JSON.parse(await readFile(join(root,'.local/web/start-args.json'),'utf8'));
      assert.equal(args.includes('--diagnostics'),requested||existing);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('restart worker rejects wrong sessions and reused PIDs; preflight never stops the server', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex restart '));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const shell = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    await mkdir(join(root, 'scripts/windows'), { recursive: true });
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), 'ready');
    for (const name of ['common.ps1', 'restart-server.ps1']) {
      await copyFile(new URL('../scripts/windows/' + name, import.meta.url), join(root, 'scripts/windows', name));
    }
    // Replace only the service-control boundary: stopping would leave an observable marker.
    await writeFile(join(root, 'scripts/server-control.ts'), `
      import { writeFileSync } from 'node:fs';
      export async function managedServer() { return {pid:${process.pid}, origin:'http://localhost:${port}'}; }
      if(process.argv.includes('--stop') || process.argv.includes('--background')) {
        writeFileSync(${JSON.stringify(join(root, 'unexpected-stop'))}, 'called'); process.exit(8);
      }
    `);
    const inspected = spawnSync(shell, ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'; @{sessionId=$p.SessionId;oldStarted=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json`], { encoding: 'utf8', windowsHide: true });
    assert.equal(inspected.status, 0, inspected.stderr);
    const identity = JSON.parse(inspected.stdout);
    for (const scenario of ['session', 'pid', 'ready']) {
      const request = join(root, scenario + '.json');
      await writeFile(request, JSON.stringify({
        ...identity, oldPid: process.pid, port,
        sessionId: scenario === 'session' ? -1 : identity.sessionId,
        oldStarted: scenario === 'pid' ? 'stale' : identity.oldStarted,
      }));
      const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/windows/restart-server.ps1'), '-Worker', '-CheckOnly', '-RequestFile', request], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      const result = JSON.parse((await readFile(request + '.result.json', 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(result.status, scenario === 'ready' ? 'ready' : 'failed', run.stdout + run.stderr);
      assert.equal(run.status, scenario === 'ready' ? 0 : 1);
      if (scenario !== 'ready') assert.match(result.message, scenario === 'session' ? /session/i : /identity/i);
      assert.equal(await readFile(join(root, 'unexpected-stop'), 'utf8').catch(() => ''), '');
      assert.doesNotThrow(() => process.kill(process.pid, 0));
    }
  } finally {
    listener.close();
    await rm(root, { recursive: true, force: true });
  }
});
