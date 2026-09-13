import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('CMD launchers forward paths, arguments and exit codes with PowerShell 7 or built-in 5.1', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex cmd entry '));
  try {
    for(const name of ['start-server','stop-server','install-startup','configure-serve']){
      await copyFile(new URL(`../scripts/windows/${name}.cmd`,import.meta.url),join(root,name+'.cmd'));
      await writeFile(join(root,name+'.ps1'),"param([switch]$Background) Write-Output ('CHECK:' + $PSVersionTable.PSVersion.Major + ':' + $args[0] + ':' + $Background); exit 7");
      for(const [major,path] of [[7,process.env.PATH],[5,join(process.env.SystemRoot!,'System32')]] as const){
        const result=spawnSync(process.env.ComSpec!,['/d','/s','/c',`""${join(root,name+'.cmd')}" "two words""`],{cwd:tmpdir(),env:{...process.env,PATH:path},windowsVerbatimArguments:true,windowsHide:true,encoding:'utf8',input:'\n',timeout:15000});
        assert.equal(result.status,7,result.stdout+result.stderr); assert.match(result.stdout,new RegExp(`CHECK:${major}:two words:${name==='start-server'?'True':'False'}`));
      }
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Windows 5.1 runs startup, installs its own scheduler entry and preserves Unicode network config', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex ps51 '));
  const legacy=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const children:number[]=[];
  try {
    for(const directory of ['scripts/windows','.local/web','dist','src/server'])await mkdir(join(root,directory),{recursive:true});
    await copyFile(new URL('../scripts/windows/start-server.ps1',import.meta.url),join(root,'scripts/windows/start-server.ps1'));
    await copyFile(new URL('../scripts/windows/install-startup.ps1',import.meta.url),join(root,'scripts/windows/install-startup.ps1'));
    await writeFile(join(root,'.local/web/auth.json'),'{}'); await writeFile(join(root,'dist/index.html'),'fixture');
    await writeFile(join(root,'src/server/main.ts'),"console.log('fixture started')");
    const run=(file:string)=>spawnSync(legacy,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,file)],{env:{...process.env,PATH:dirname(process.execPath)+';'+join(process.env.SystemRoot!,'System32')},encoding:'utf8',windowsHide:true,timeout:15000});
    const started=run('scripts/windows/start-server.ps1'); assert.equal(started.status,0,started.stdout+started.stderr);
    assert.match(await readFile(join(root,'.local/web/server.log'),'utf8'),/fixture started/);
    await writeFile(join(root,'src/server/main.ts'),"const fs = require('node:fs'); fs.writeFileSync('.local/web/fixture.pid',String(process.pid)); console.log('background ready'); setInterval(()=>{},1000);");
    for(let attempt=0;attempt<2;attempt++){
      const background=spawnSync(legacy,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/windows/start-server.ps1'),'-Background'],{encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(background.status,0,background.stdout+background.stderr);
      children.push(Number(background.stdout.match(/PID (\d+)/)![1]));
      for(let i=0;i<50;i++){if((await readFile(join(root,'.local/web/server.log'),'utf8')).includes('background ready'))break;await delay(100);}
    }
    const pid=Number(await readFile(join(root,'.local/web/fixture.pid'),'utf8'));children.push(pid);
    await delay(300);
    assert.equal((await readFile(join(root,'.local/web/server.log'),'utf8')).match(/background ready/g)?.length,1,'Duplicate background server');
    await copyFile(new URL('../scripts/windows/stop-server.ps1',import.meta.url),join(root,'scripts/windows/stop-server.ps1'));
    await writeFile(join(root,'stop-check.ps1'),"function Get-ScheduledTask { $null }; & (Join-Path $PSScriptRoot 'scripts/windows/stop-server.ps1')");
    const stopped=run('stop-check.ps1');assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);
    for(let i=0;i<30;i++){try{process.kill(pid,0);}catch{break;}await delay(100);}
    assert.throws(()=>process.kill(pid,0),'Background Node survived stop');
    await writeFile(join(root,'install-check.ps1'),`
$ErrorActionPreference='Stop'
function Get-Command { $null }
function Get-ScheduledTask { $null }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) if($Execute -ne (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')){throw 'Wrong runtime'}; @{} }
function New-ScheduledTaskTrigger { @{} }
function New-ScheduledTaskPrincipal { @{} }
function New-ScheduledTaskSettingsSet { @{} }
function Register-ScheduledTask { Write-Output 'fixture task' }
& (Join-Path $PSScriptRoot 'scripts/windows/install-startup.ps1')
`);
    const installed=run('install-check.ps1'); assert.equal(installed.status,0,installed.stdout+installed.stderr);
    const network=(await readFile(new URL('../scripts/windows/configure-serve.ps1',import.meta.url),'utf8')).replace("$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe'","$tailscalePath = 'Invoke-TestNetwork'");
    await writeFile(join(root,'scripts/windows/configure-serve.ps1'),network);
    await writeFile(join(root,'.local/web/config.json'),JSON.stringify({workRoot:'C:\\项目\\测试',codexBin:'C:\\工具\\codex.exe'}));
    await writeFile(join(root,'network-check.ps1'),`
$ErrorActionPreference='Stop'
function Invoke-TestNetwork {
 $global:LASTEXITCODE=0
 if($args[0] -eq 'status'){'{"BackendState":"Running","Self":{"DNSName":"fixture.example.ts.net."}}'}
 elseif($args[1] -eq 'status'){'{}'}
}
& (Join-Path $PSScriptRoot 'scripts/windows/configure-serve.ps1') -Port 3355
`);
    const configured=run('network-check.ps1');assert.equal(configured.status,0,configured.stdout+configured.stderr);
    const saved=JSON.parse(await readFile(join(root,'.local/web/config.json'),'utf8'));
    assert.equal(saved.workRoot,'C:\\项目\\测试');assert.equal(saved.codexBin,'C:\\工具\\codex.exe');assert.equal(saved.port,3355);
  } finally {for(const pid of children){try{process.kill(pid);}catch{}}await delay(100);await rm(root,{recursive:true,force:true});}
});
