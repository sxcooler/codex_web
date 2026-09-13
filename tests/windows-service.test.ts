import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('startup task uses a stable PowerShell Store alias and upgrades only the matching task', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-startup-'));
  try {
    const installer = join(root, 'install-startup.ps1');
    await copyFile(new URL('../scripts/install-startup.ps1', import.meta.url), installer);
    const harness = join(root, 'check.ps1');
    await writeFile(harness, `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference = 'None'
$old = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'WindowsApps/Microsoft.PowerShell_7.0.0.0_x64__8wekyb3d8bbwe/pwsh.exe'))
$alias = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Microsoft/WindowsApps/pwsh.exe'))
function Get-Command { [pscustomobject]@{Source=$old} }
function Test-Path { $true }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskTrigger { @{} }
function New-ScheduledTaskPrincipal { @{} }
function New-ScheduledTaskSettingsSet { @{} }
$taskState = @{ Existing=$null; Registered=$null }
function Get-ScheduledTask { $taskState.Existing }
function Register-ScheduledTask {
  param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force)
  $taskState.Registered = $Action
}
& (Join-Path $PSScriptRoot 'install-startup.ps1')
if ($taskState.Registered.Execute -ne $alias) { throw "Expected stable alias $alias; got $($taskState.Registered.Execute)" }
$taskState.Existing = [pscustomobject]@{Actions=[pscustomobject]@{Execute=$old; Arguments=$taskState.Registered.Arguments}}
& (Join-Path $PSScriptRoot 'install-startup.ps1')
if ($taskState.Registered.Execute -ne $alias) { throw 'Existing Store task was not migrated' }
$taskState.Existing.Actions.Arguments = '-File unrelated.ps1'
$rejected = $false
try { & (Join-Path $PSScriptRoot 'install-startup.ps1') } catch { $rejected = $true }
if (-not $rejected) { throw 'Unrelated scheduled task was overwritten' }
`);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', harness], { encoding: 'utf8', timeout: 12_000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr || String(result.error));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows stop script removes its complete process tree and preserves unrelated Node processes', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-stop-'));
  const pids: number[] = [];
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'src/server'), { recursive: true });
    await copyFile(new URL('../scripts/stop-server.ps1', import.meta.url), join(root, 'scripts/stop-server.ps1'));
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
    await writeFile(harness, `Import-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility,CimCmdlets\n$PSModuleAutoLoadingPreference = 'None'\nfunction Get-ScheduledTask { $null }\nfunction Stop-ScheduledTask { throw 'Tests must not stop real scheduled tasks' }\n& (Join-Path $PSScriptRoot 'scripts/stop-server.ps1')\n`);
    const stopped = spawnSync('pwsh.exe', ['-NoProfile', '-File', harness], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(stopped.status, 0, stopped.stderr || String(stopped.error));
    for (let attempt = 0; attempt < 40 && [pids[0], pids[2], pids[3]].some(alive); attempt++) await delay(25);
    assert.equal(alive(pids[0]), false, 'Web entry exited');
    assert.equal(alive(pids[2]), false, 'owned child exited');
    assert.equal(alive(pids[3]), false, 'owned grandchild exited');
    assert.equal(alive(pids[1]), true, 'unrelated Node remains alive');
    const repeated = spawnSync('pwsh.exe', ['-NoProfile', '-File', harness], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(repeated.status, 0, repeated.stderr);
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid);
    await rm(root, { recursive: true, force: true });
  }
});
