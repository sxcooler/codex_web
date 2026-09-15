import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Windows 5.1 user startup is hidden and migrates or removes only this workspace', {skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex logon '));
 try {
  await mkdir(join(root,'scripts/windows'),{recursive:true});
  await copyFile(new URL('../scripts/windows/install-startup.ps1',import.meta.url),join(root,'scripts/windows/install-startup.ps1'));
  await writeFile(join(root,'check.ps1'),"\n$ErrorActionPreference='Stop'\n$state=@{Value=$null;Task=$null;Deleted=$false}\nfunction Get-ItemProperty { [pscustomobject]@{ $name=$state.Value } }\nfunction New-Item { }\nfunction New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) $state.Value=$Value }\nfunction Remove-ItemProperty { $state.Value=$null }\nfunction Get-ScheduledTask { $state.Task }\nfunction Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) $state.Deleted=$true; $state.Task=$null }\n$installer=Join-Path $PSScriptRoot 'scripts/windows/install-startup.ps1'\n& $installer\n$expected=$state.Value\nif($expected -notlike '*System32\\WindowsPowerShell\\v1.0\\powershell.exe*' -or $expected -notlike '*-WindowStyle Hidden*-Background') {throw 'Expected hidden built-in shell startup'}\n$script=Join-Path $PSScriptRoot 'scripts/windows/start-server.ps1'\n$state.Task=[pscustomobject]@{Actions=@([pscustomobject]@{Arguments=\"-File `\"$script`\"\"})}\n& $installer\nif(-not $state.Deleted){throw 'Legacy task not migrated'}\n& $installer -Remove\nif($state.Value){throw 'Startup not removed'}\n$state.Value='unrelated command'\n$rejected=$false\ntry{ & $installer }catch{$rejected=$true}\nif(-not $rejected -or $state.Value -ne 'unrelated command'){throw 'Unrelated startup overwritten'}\n$state.Value=$null\n$state.Task=[pscustomobject]@{Actions=@([pscustomobject]@{Arguments='-File unrelated.ps1'})}\n$rejected=$false\ntry{ & $installer }catch{$rejected=$true}\nif(-not $rejected -or $state.Value){throw 'Unrelated task changed'}\n");
  const result=spawnSync(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'check.ps1')],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr||String(result.error));
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
    for (const pid of pids) if (alive(pid)) process.kill(pid);
    await rm(root, { recursive: true, force: true });
  }
});
