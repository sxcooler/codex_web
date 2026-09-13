import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex linux-%$-'));
  await cp(new URL('../scripts/linux/', import.meta.url), join(root, 'scripts/linux'), { recursive: true });
  await mkdir(join(root, '.local/web'), { recursive: true });
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'fixture');
  await writeFile(join(root, '.local/web/auth.json'), '{}');
  return root;
}

test('Linux foreground start is exclusive and stop verifies PID identity without killing unrelated Node', { skip: process.platform !== 'linux', timeout: 20_000 }, async () => {
  const root = await fixture();
  let service: ReturnType<typeof spawn> | undefined, other: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(join(root, 'src/server'), { recursive: true });
    await writeFile(join(root, 'src/server/main.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, 'ready'))}, String(process.pid)); setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));`);
    service = spawn('bash', [join(root, 'scripts/linux/start-server.sh')], { stdio: 'ignore' });
    for (let i=0; i<100 && !await readFile(join(root, 'ready')).catch(()=>null); i++) await delay(25);
    const pid = Number(await readFile(join(root, 'ready'), 'utf8'));
    assert.ok(alive(pid));
    const recordPath = join(root, '.local/web/server.pid');
    const record = await readFile(recordPath, 'utf8');
    await assert.rejects(exec('bash', [join(root, 'scripts/linux/start-server.sh')], { timeout: 2000 }));
    assert.equal(await readFile(recordPath, 'utf8'), record);
    other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    assert.ok(other.pid);
    const stat = await readFile(`/proc/${other.pid}/stat`, 'utf8');
    const tick = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
    await writeFile(recordPath, `${other.pid} ${tick}\n`);
    await assert.rejects(exec('bash', [join(root, 'scripts/linux/stop-server.sh')]));
    assert.ok(alive(other.pid));
    await writeFile(recordPath, record);
    await exec('bash', [join(root, 'scripts/linux/stop-server.sh')]);
    assert.equal(alive(pid), false);
    assert.ok(alive(other.pid));
    await exec('bash', [join(root, 'scripts/linux/stop-server.sh')]);
  } finally {
    service?.kill(); other?.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('Linux user systemd starts and stops the isolated workspace with its child process', { skip: process.platform !== 'linux' || process.env.LINUX_SERVICE_TEST_SYSTEMD !== '1', timeout: 25_000 }, async () => {
  const root = await fixture();
  const unit='codex-web-'+createHash('sha256').update(root).digest('hex').slice(0,12)+'.service';
  const unitFile=join(process.env.XDG_CONFIG_HOME || join(process.env.HOME!,'.config'),'systemd/user',unit);
  try {
    await mkdir(join(root,'src/server'),{recursive:true});
    await writeFile(join(root,'.local/web/service.env'),'CODEX_WEB_SERVICE_TEST=loaded\n');
    await writeFile(join(root,'child.mjs'), 'setInterval(()=>{},1000);');
    await writeFile(join(root,'src/server/main.ts'), `import assert from 'node:assert/strict'; import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; assert.equal(process.env.CODEX_WEB_SERVICE_TEST,'loaded'); const child=spawn(process.execPath,[${JSON.stringify(join(root,'child.mjs'))}],{stdio:'ignore'}); writeFileSync(${JSON.stringify(join(root,'ready'))},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));`);
    await exec('bash',[join(root,'scripts/linux/install-startup.sh'),'--start']);
    for(let i=0;i<100&&!await readFile(join(root,'ready')).catch(()=>null);i++)await delay(25);
    const pids=JSON.parse(await readFile(join(root,'ready'),'utf8')) as number[];
    assert.ok(pids.every(alive));
    const contents=await readFile(unitFile,'utf8');
    assert.match(contents,/KillMode=control-group/);
    await exec('bash',[join(root,'scripts/linux/stop-server.sh')]);
    for(let i=0;i<30&&pids.some(alive);i++)await delay(50);
    assert.ok(pids.every(pid=>!alive(pid)),'service and child exited');
    await exec('bash',[join(root,'scripts/linux/install-startup.sh')]);
    await writeFile(unitFile,'# unrelated service\n');
    await assert.rejects(exec('bash',[join(root,'scripts/linux/install-startup.sh')]));
    assert.equal(await readFile(unitFile,'utf8'),'# unrelated service\n');
  } catch (error) {
    const diagnostic=await exec('systemd-analyze',['--user','verify',unitFile]).then(result=>result.stderr,error=>error.stderr);
    throw new Error(String(error)+'\n'+diagnostic);
  } finally {
    await exec('systemctl',['--user','disable','--now',unit]).catch(()=>{});
    await rm(unitFile,{force:true});
    await exec('systemctl',['--user','daemon-reload']);
    await rm(root,{recursive:true,force:true});
  }
});

test('Linux Serve helper preserves config and refuses existing mappings or failed CLI operations', { skip: process.platform !== 'linux' }, async () => {
  const root = await fixture();
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    const calls = join(root, 'calls');
    await writeFile(join(bin, 'tailscale'), `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'example.test.ts.net.'}}));
else if(args[1]==='status') console.log(process.env.MAPPINGS||'{}');
else if(process.env.FAIL_SERVE) process.exit(1);
`, { mode: 0o700 });
    const configPath=join(root,'.local/web/config.json');
    const initial={workRoot:'/tmp/example',port:3412};
    await writeFile(configPath,JSON.stringify(initial));
    const env={...process.env,PATH:`${bin}:${process.env.PATH}`,CALLS:calls};
    const args=[join(root,'scripts/linux/configure-serve.sh'),'3412'];
    await assert.rejects(exec('bash',args,{env:{...env,MAPPINGS:'{"TCP":{"443":{}}}'}}));
    await assert.rejects(exec('bash',args,{env:{...env,FAIL_SERVE:'1'}}));
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),initial);
    await exec('bash',args,{env});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{...initial,origin:'https://example.test.ts.net'});
    const commands=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(commands.filter(args=>args.includes('--bg')).length,2);
    assert.deepEqual(commands.at(-1),['serve','--bg','--https=443','http://127.0.0.1:3412']);
  } finally { await rm(root,{recursive:true,force:true}); }
});
