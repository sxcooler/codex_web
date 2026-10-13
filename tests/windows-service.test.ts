import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Windows startup preserves diagnostics and disabled state across exact owned command migrations', { skip: process.platform !== 'win32' }, async () => {
 const root = await mkdtemp(join(tmpdir(), 'codex startup mode '));
 try {
  await mkdir(join(root, 'scripts/windows'), { recursive: true });
  for (const file of ['install-startup.ps1', 'startup-launcher.cs', 'codex-web.ico']) await copyFile(new URL('../scripts/windows/' + file, import.meta.url), join(root, 'scripts/windows', file));
  await writeFile(join(root, 'scripts/windows/start-server.ps1'), `param([switch]$Background, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
if(-not $Background){throw 'Expected background mode'}
Set-Content -LiteralPath (Join-Path $PSScriptRoot '../../started.txt') -Value ($Arguments -join ' ')
`);
  await writeFile(join(root, 'check.ps1'), `
$ErrorActionPreference='Stop'
$runKey='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$sha=[Security.Cryptography.SHA256]::Create()
try{$hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant()))).Replace('-','').Substring(0,12)}finally{$sha.Dispose()}
$expectedName="CodexWeb-$hash"
$state=@{Value=$null;Task=$null;Writes=0;Approved=[byte[]](3,0,0,0,11,22,33,44,0,0,0,0)}
function Get-ItemProperty { param($LiteralPath) if($LiteralPath -ne $runKey){throw 'Unexpected registry read'}; [pscustomobject]@{ $expectedName=$state.Value } }
function New-Item { throw 'Unexpected registry key creation' }
function New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) if($LiteralPath -ne $runKey -or $Name -ne $expectedName -or $PropertyType -ne 'String'){throw 'Unexpected registry write'}; $state.Value=$Value; $state.Writes++ }
function Remove-ItemProperty { param($LiteralPath,$Name) if($LiteralPath -ne $runKey -or $Name -ne $expectedName){throw 'Unexpected registry removal'}; $state.Value=$null }
function Set-ItemProperty { throw 'Unexpected registry write' }
function Test-Path { param($LiteralPath) if($LiteralPath -like 'HKCU:*'){if($LiteralPath -ne $runKey){throw 'Unexpected registry access'};return $true}; Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath }
function Get-ScheduledTask { $state.Task }
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) if($TaskName -ne 'Codex Remote Web'){throw 'Unexpected task deletion'}; $state.Task=$null }
$installer=Join-Path $PSScriptRoot 'scripts/windows/install-startup.ps1'
$script=Join-Path $PSScriptRoot 'scripts/windows/start-server.ps1'
$shell=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$legacy='"'+$shell+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$script+'" -Background'
$branded='"'+(Join-Path $PSScriptRoot '.local/startup/codex_web.exe')+'"'
foreach($approved in @([byte]2,[byte]3)) {
 $state.Approved[0]=$approved
 $before=[Convert]::ToBase64String($state.Approved)
 foreach($old in @($legacy,$branded)) {
  foreach($suffix in @('', ' --diagnostics')) {
   $state.Value=$old+$suffix
   Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'started.txt') -ErrorAction SilentlyContinue
   & $installer
   if($state.Value -cne $branded+$suffix){throw 'Diagnostic mode or startup name changed'}
   if(Microsoft.PowerShell.Management\\Test-Path -LiteralPath (Join-Path $PSScriptRoot 'started.txt')){throw 'Install unexpectedly started server'}
   if([Convert]::ToBase64String($state.Approved) -ne $before){throw 'StartupApproved state changed'}
  }
 }
}
foreach($suffix in @('', ' --diagnostics')) {
 $state.Value=$legacy+$suffix
 & $installer -Start
 $received=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'started.txt') -Raw).Trim()
 if($received -cne $suffix.Trim()){throw 'Explicit start lost diagnostic mode'}
}
foreach($foreign in @('unrelated command',($legacy+' --diagnostics --extra'),($legacy+' --extra'),($branded+' --extra'),($branded+' --diagnostics --diagnostics'),$branded.Replace('codex_web.exe','other.exe'),$legacy.Replace('start-server.ps1','other.ps1'))) {
 $state.Value=$foreign; $writes=$state.Writes; $rejected=$false
 try{& $installer}catch{$rejected=$true}
 if(-not $rejected -or $state.Value -cne $foreign -or $state.Writes -ne $writes){throw "Foreign startup changed: $foreign"}
}
$state.Value=$legacy+' --diagnostics'
$state.Task=[pscustomobject]@{Actions=@([pscustomobject]@{Arguments='-File unrelated.ps1'})}
$rejected=$false
try{& $installer}catch{$rejected=$true}
if(-not $rejected -or -not $state.Task -or $state.Value -cne $legacy+' --diagnostics'){throw 'Foreign task changed'}
$state.Task=$null
$source=Join-Path $PSScriptRoot 'scripts/windows/startup-launcher.cs'
$original=Get-Content -LiteralPath $source -Raw
Set-Content -LiteralPath $source -Value 'invalid C#'
$writes=$state.Writes; $rejected=$false
try{& $installer}catch{$rejected=$true}finally{Set-Content -LiteralPath $source -Value $original}
if(-not $rejected -or $state.Value -cne $legacy+' --diagnostics' -or $state.Writes -ne $writes){throw 'Compile failure changed startup'}
if(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.local/startup') -Filter 'codex_web-*.exe'){throw 'Temporary launcher leaked'}
$launcher=Join-Path $PSScriptRoot '.local/startup/codex_web.exe'
$locked=[IO.File]::Open($launcher,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
$rejected=$false
try{& $installer}catch{$rejected=$true}finally{$locked.Dispose()}
if(-not $rejected -or $state.Value -cne $legacy+' --diagnostics' -or $state.Writes -ne $writes){throw 'Launcher replacement failure changed startup'}
if(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.local/startup') -Filter 'codex_web-*.exe'){throw 'Temporary launcher leaked'}
& $installer -Remove
if($state.Value){throw 'Diagnostic startup was not removed'}
`);
  for (const shell of [join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh.exe']) {
   const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'check.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 40_000 });
   assert.equal(result.status, 0, result.stdout + result.stderr || String(result.error));
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows startup launcher forwards only optional diagnostics and preserves child exit', { skip: process.platform !== 'win32' }, async () => {
 const root = await mkdtemp(join(tmpdir(), 'codex launcher mode '));
 try {
  await mkdir(join(root, '.local/startup'), { recursive: true });
  await mkdir(join(root, 'scripts/windows'), { recursive: true });
  await writeFile(join(root, 'scripts/windows/start-server.ps1'), `param([switch]$Background, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
if(-not $Background){exit 9}
Set-Content -LiteralPath (Join-Path $PSScriptRoot '../../launched.txt') -Value ('background:' + ($Arguments -join ' '))
exit 23
`);
  const launcher = join(root, '.local/startup/codex_web.exe');
  const compiler = join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
  const built = spawnSync(compiler, ['/nologo', '/target:winexe', '/out:' + launcher, '/win32icon:' + fileURLToPath(new URL('../scripts/windows/codex-web.ico', import.meta.url)), fileURLToPath(new URL('../scripts/windows/startup-launcher.cs', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(built.status, 0, built.stdout + built.stderr || String(built.error));
  for (const args of [[], ['--diagnostics']]) {
   assert.equal(spawnSync(launcher, args, { windowsHide: true, timeout: 10_000 }).status, 23);
   assert.equal((await readFile(join(root, 'launched.txt'), 'utf8')).trim(), args.length ? 'background:--diagnostics' : 'background:');
  }
  await rm(join(root, 'launched.txt'));
  for (const args of [['--extra'], ['--Diagnostics'], ['--diagnostics', '--extra'], ['--diagnostics', '--diagnostics']]) assert.equal(spawnSync(launcher, args, { windowsHide: true, timeout: 10_000 }).status, 1);
  await assert.rejects(readFile(join(root, 'launched.txt')), { code: 'ENOENT' });
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows startup is branded, forwards launch and migrates only this workspace on PowerShell 5.1 and 7', {skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex logon '));
 try {
  await mkdir(join(root,'scripts/windows'),{recursive:true});
  await copyFile(new URL('../scripts/windows/install-startup.ps1',import.meta.url),join(root,'scripts/windows/install-startup.ps1'));
  for(const name of ['startup-launcher.cs','codex-web.ico'])await copyFile(new URL('../scripts/windows/'+name,import.meta.url),join(root,'scripts/windows',name));
  await writeFile(join(root,'check.ps1'),"\n$ErrorActionPreference='Stop'\n$state=@{Value=$null;Task=$null;Deleted=$false}\nfunction Get-ItemProperty { [pscustomobject]@{ $name=$state.Value } }\nfunction New-Item { }\nfunction New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) $state.Value=$Value }\nfunction Remove-ItemProperty { $state.Value=$null }\nfunction Get-ScheduledTask { $state.Task }\nfunction Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) $state.Deleted=$true; $state.Task=$null }\n$installer=Join-Path $PSScriptRoot 'scripts/windows/install-startup.ps1'\n& $installer\n$expected=$state.Value\nif($expected -notlike '*codex_web.exe*') {throw 'Expected branded startup executable'}\n$script=Join-Path $PSScriptRoot 'scripts/windows/start-server.ps1'\n$state.Task=[pscustomobject]@{Actions=@([pscustomobject]@{Arguments=\"-File `\"$script`\"\"})}\n& $installer\nif(-not $state.Deleted){throw 'Legacy task not migrated'}\n& $installer -Remove\nif($state.Value){throw 'Startup not removed'}\n$state.Value='unrelated command'\n$rejected=$false\ntry{ & $installer }catch{$rejected=$true}\nif(-not $rejected -or $state.Value -ne 'unrelated command'){throw 'Unrelated startup overwritten'}\n$state.Value=$null\n$state.Task=[pscustomobject]@{Actions=@([pscustomobject]@{Arguments='-File unrelated.ps1'})}\n$rejected=$false\ntry{ & $installer }catch{$rejected=$true}\nif(-not $rejected -or $state.Value){throw 'Unrelated task changed'}\n");
  for(const shell of [join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'pwsh.exe']){
   const result=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'check.ps1')],{encoding:'utf8',windowsHide:true,timeout:15000});
   assert.equal(result.status,0,result.stdout+result.stderr||String(result.error));
  }
  await writeFile(join(root,'scripts/windows/start-server.ps1'),"param([switch]$Background)\nif(-not $Background){exit 9}\nSet-Content -LiteralPath (Join-Path $PSScriptRoot '../../launched.txt') -Value 'launched'\nexit 23\n");
  const launcher=join(root,'.local/startup/codex_web.exe');
  assert.equal(spawnSync(launcher,[],{windowsHide:true,timeout:10000}).status,23);
  assert.equal((await readFile(join(root,'launched.txt'),'utf8')).trim(),'launched');
  await writeFile(join(root,'metadata.ps1'),"$path=Join-Path $PSScriptRoot '.local/startup/codex_web.exe'\n$info=[Diagnostics.FileVersionInfo]::GetVersionInfo($path)\nif($info.FileDescription -ne 'codex_web' -or $info.ProductName -ne 'codex_web'){throw 'Missing codex_web branding'}\nif($info.CompanyName -ne 'sxcooler'){throw 'Missing sxcooler publisher metadata'}\nAdd-Type -AssemblyName System.Drawing\n$icon=[Drawing.Icon]::ExtractAssociatedIcon($path)\nif(-not $icon){throw 'Missing icon'}\n$icon.Dispose()\n");
  const metadata=spawnSync('pwsh.exe',['-NoProfile','-File',join(root,'metadata.ps1')],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(metadata.status,0,metadata.stdout+metadata.stderr);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows stop script never terminates unmanaged servers or unrelated Node processes', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-stop-'));
  const pids: number[] = [];
  try {
    await mkdir(join(root, 'scripts/windows'), { recursive: true });
    await mkdir(join(root, 'src/server'), { recursive: true });
    await copyFile(new URL('../scripts/windows/stop-server.ps1', import.meta.url), join(root, 'scripts/windows/stop-server.ps1'));
    await copyFile(new URL('../scripts/windows/common.ps1', import.meta.url), join(root, 'scripts/windows/common.ps1'));
    await copyFile(new URL('../scripts/server-control.ts', import.meta.url), join(root, 'scripts/server-control.ts'));
    await copyFile(new URL('../src/server/lifecycle.ts', import.meta.url), join(root, 'src/server/lifecycle.ts'));
    await writeFile(join(root, 'src/server/main.ts'), `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, [${JSON.stringify(join(root, 'worker.mjs'))}, 'child'], { stdio: 'ignore', windowsHide: true });
      setInterval(() => {}, 1000);
    `);
    await writeFile(join(root, 'worker.mjs'), `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const role = process.argv[2];
      writeFileSync(${JSON.stringify(root)} + '/' + role + '.pid', String(process.pid));
      if (role === 'child') spawn(process.execPath, [import.meta.filename, 'grandchild'], { stdio: 'ignore', windowsHide: true });
      setInterval(() => {}, 1000);
    `);
    const server = spawn(process.execPath, [join(root, 'src/server/main.ts')], { stdio: 'ignore', windowsHide: true });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    assert.ok(server.pid && unrelated.pid);
    pids.push(server.pid, unrelated.pid);
    for (const role of ['child', 'grandchild']) {
      let pid = 0;
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        pid = Number(await readFile(join(root, role + '.pid'), 'utf8').catch(() => ''));
        if (!pid) await delay(25);
      }
      assert.ok(pid, role + ' started'); pids.push(pid);
    }
    // Isolate Task Scheduler from the real user's deployment; exercise real process matching and termination.
    const harness = join(root, 'stop.ps1');
    await writeFile(harness, `Import-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility,CimCmdlets\n$PSModuleAutoLoadingPreference = 'None'\nfunction Get-ScheduledTask { $null }\nfunction Stop-ScheduledTask { throw 'Tests must not stop real scheduled tasks' }\n& (Join-Path $PSScriptRoot 'scripts/windows/stop-server.ps1')\n`);
    const stopped = spawnSync('pwsh.exe', ['-NoProfile', '-File', harness], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(stopped.status, 0, stopped.stderr || String(stopped.error));
    for (let attempt = 0; attempt < 40 && [pids[0], pids[2], pids[3]].some(alive); attempt++) await delay(25);
    assert.equal(alive(pids[0]), true, 'unmanaged Web entry preserved');
    assert.equal(alive(pids[2]), true, 'unmanaged child preserved');
    assert.equal(alive(pids[3]), true, 'unmanaged grandchild preserved');
    assert.equal(alive(pids[1]), true, 'unrelated Node remains alive');
    const repeated = spawnSync('pwsh.exe', ['-NoProfile', '-File', harness], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(repeated.status, 0, repeated.stderr);
  } finally {
    for (const pid of pids) try { process.kill(pid); } catch (error:any) { if(error.code!=='ESRCH')throw error; }
    await rm(root, { recursive: true, force: true });
  }
});
