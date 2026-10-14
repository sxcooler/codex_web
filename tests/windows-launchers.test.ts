import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

test('CMD launchers forward paths, arguments and exit codes with PowerShell 7 or built-in 5.1', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex cmd entry '));
  try {
    for(const name of ['start-server','stop-server','status-server','install-startup','uninstall-startup','configure-serve']){
      await copyFile(new URL(`../scripts/windows/${name}.cmd`,import.meta.url),join(root,name+'.cmd'));
      await writeFile(join(root,name+'.ps1'),"param([switch]$Background) Write-Output ('CHECK:' + $PSVersionTable.PSVersion.Major + ':' + $args[0] + ':' + $Background); exit 7");
      for(const [major,path] of [[7,process.env.PATH],[5,join(process.env.SystemRoot!,'System32')]] as const){
        const result=spawnSync(process.env.ComSpec!,['/d','/s','/c',`""${join(root,name+'.cmd')}" "two words""`],{cwd:tmpdir(),env:{...process.env,PATH:path},windowsVerbatimArguments:true,windowsHide:true,encoding:'utf8',input:'\n',timeout:15000});
        assert.equal(result.status,7,result.stdout+result.stderr); assert.match(result.stdout,new RegExp(`CHECK:${major}:two words:${name==='start-server'?'True':'False'}`));
      }
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Windows launchers forward diagnostics through the real PS1 on PowerShell 7 and 5.1', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex diagnostics entry '));
  try {
    for(const dir of ['scripts/windows','.local/web','dist'])await mkdir(join(root,dir),{recursive:true});
    for(const ext of ['cmd','ps1'])await copyFile(new URL(`../scripts/windows/start-server.${ext}`,import.meta.url),join(root,`scripts/windows/start-server.${ext}`));
    await writeFile(join(root,'scripts/windows/common.ps1'),`$projectRoot='${root.replaceAll("'","''")}'\n$nodePath='${process.execPath.replaceAll("'","''")}'\n$portableArgs=@()\n`);
    await writeFile(join(root,'.local/web/auth.json'),'{}');await writeFile(join(root,'dist/index.html'),'fixture');
    await writeFile(join(root,'scripts/server-control.ts'),`console.log('ARGS:'+JSON.stringify(process.argv.slice(2)));`);
    for(const path of [process.env.PATH,join(process.env.SystemRoot!,'System32')])for(const flag of ['','--diagnostics','--unknown']){
      const result=spawnSync(process.env.ComSpec!,['/d','/s','/c',`""${join(root,'scripts/windows/start-server.cmd')}" ${flag}"`],{cwd:tmpdir(),env:{...process.env,PATH:path},windowsVerbatimArguments:true,windowsHide:true,encoding:'utf8',input:'\n',timeout:15000});
      if(flag==='--unknown'){assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/ARGS:/);continue;}
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.match(/ARGS:(.*)/)![1]),['--background',...(flag?[flag]:[])]);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Windows 5.1 preserves Unicode network config', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex ps51 '));
  const legacy=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    for(const directory of ['scripts/windows','src/server','.local/web'])await mkdir(join(root,directory),{recursive:true});
    for(const file of ['scripts/windows/configure-serve.ps1','scripts/tailscale.ts','src/server/origins.ts'])await copyFile(new URL('../'+file,import.meta.url),join(root,file));
    await writeFile(join(root,'scripts/windows/common.ps1'),`$projectRoot='${root.replaceAll("'","''")}'\n$nodePath='${process.execPath.replaceAll("'","''")}'\n`);
    const preload=join(root,'fake-network.mjs');
    await writeFile(preload,`import childProcess from 'node:child_process';
let mapping={};childProcess.spawnSync=(file,args)=>{
 if(args[0]==='--version')return {status:0,stdout:'1.90.0'};
 if(args[0]==='status')return {status:0,stdout:JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.example.ts.net.'}})};
 if(args[0]!=='serve')throw Error('Unexpected external command');
 if(args[1]==='status')return {status:0,stdout:JSON.stringify(mapping)};
 if(args.join(' ')!=='serve --bg --https=443 http://127.0.0.1:3355')throw Error('Unexpected mapping');
 mapping={TCP:{443:{HTTPS:true}},Web:{'fixture.example.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:3355'}}}}};return {status:0};
};`);
    const run=(file:string)=>spawnSync(legacy,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,file)],{env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(preload).href},encoding:'utf8',windowsHide:true,timeout:15000});
    await writeFile(join(root,'.local/web/config.json'),JSON.stringify({workRoot:'C:\\项目\\测试',codexBin:'C:\\工具\\codex.exe'}));
    await writeFile(join(root,'network-check.ps1'),`
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'scripts/windows/configure-serve.ps1') -Port 3355
& (Join-Path $PSScriptRoot 'scripts/windows/configure-serve.ps1')
`);
    const configured=run('network-check.ps1');assert.equal(configured.status,0,configured.stdout+configured.stderr);
    const saved=JSON.parse(await readFile(join(root,'.local/web/config.json'),'utf8'));
    assert.equal(saved.workRoot,'C:\\项目\\测试');assert.equal(saved.codexBin,'C:\\工具\\codex.exe');assert.equal(saved.port,3355);assert.deepEqual(saved.allowedOrigins,['http://localhost:3355']);
  } finally {await rm(root,{recursive:true,force:true});}
});
