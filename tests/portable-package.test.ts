import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Run against a fresh extracted release, never a user's configured installation.
const root = process.env.PORTABLE_TEST_DIR;
const windows = process.platform === 'win32';
test('extracted release runs with bundled Node and isolated data', { skip: !root, timeout: 90_000 }, async () => {
  const directory = root!;
  assert.equal(await access(join(directory, '.local')).then(() => true, () => false), false, 'Use a fresh extracted package');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    assert.ok(!/(^|\/)(\.local|\.git)(\/|$)/.test(entry.path));
    const bytes = await readFile(join(directory, entry.path));
    assert.equal(bytes.length, entry.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  const executable = join(directory, 'runtime', windows ? 'node.exe' : 'node');
  const codexBin = process.env.PORTABLE_TEST_CODEX;
  assert.ok(codexBin, 'Set PORTABLE_TEST_CODEX to an installed Codex executable; startup only checks --version');
  const env = { ...process.env, PATH: windows ? join(process.env.SystemRoot!, 'System32') : '/usr/bin:/bin', WEB_DATA_DIR: 'invalid-inherited-data', WEB_ORIGIN: 'invalid-inherited-origin', PORT: 'invalid', WORK_ROOT: 'invalid', CODEX_BIN: 'invalid' };
  const start = windows ? executable : 'bash';
  const args = [windows ? 'scripts/portable.ts' : 'Start.sh', '--no-browser'];
  const first = spawnSync(start, args, { cwd: directory, env, encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 1);
  assert.match(first.stderr, windows ? /Start\.cmd/ : /Start\.sh/);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const origin = `http://localhost:${port}`;
  const data = join(directory, '.local', 'web'), workRoot = join(directory, '.local', 'test work');
  await mkdir(workRoot, { recursive: true });
  // Startup verifies --version; the app-server remains lazy and makes no model request.
  const remoteOrigin = 'https://portable.example.test';
  await writeFile(join(data, 'config.json'), JSON.stringify({ port, origin, workRoot, codexBin, allowedOrigins:[remoteOrigin] }));
  const remoteRequest = (path:string, method='GET', headers:Record<string,string>={}, payload?:unknown) => new Promise<{status:number;headers:any;body:any}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers:{Host:'portable.example.test',...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text)});}catch(error){reject(error);}});});
    req.on('error',reject);req.end(payload===undefined?undefined:JSON.stringify(payload));
  });
  try {
    const busy = spawnSync(start, args, { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    assert.equal(busy.status, 1); assert.match(busy.stderr, new RegExp(String(port))); assert.equal(listener.listening, true);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  const password = 'Portable-fixture-only-2468';
  const auth = spawnSync(executable, ['scripts/setup-auth.ts'], { cwd: directory, env, input: password + '\n', encoding: 'utf8', windowsHide: true });
  assert.equal(auth.status, 0, auth.stderr);
  const child = spawn(start, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const closed = once(child, 'close');
  const url = origin;
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) assert.fail(output);
      try { const response = await fetch(`${url}/api/auth/session`, { headers: { Host: `localhost:${port}` } }); if (response.status === 200) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, output);
    const page = await fetch(url, { headers: { Host: `localhost:${port}` } }); assert.equal(page.status, 200);
    const html = await page.text(); assert.match(html, /\/assets\/.+\.js/);
    const session = await fetch(url + '/api/auth/session');
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await session.json();
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { Host: `localhost:${port}`, Origin: origin, Cookie: cookie, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200, await login.text());
    assert.ok(login.headers.get('set-cookie'));
    const remoteSession=await remoteRequest('/api/auth/session');
    assert.equal(remoteSession.status,200);assert.match(remoteSession.headers['set-cookie'][0],/; Secure/);
    const remoteHeaders={Origin:remoteOrigin,Cookie:remoteSession.headers['set-cookie'][0].split(';')[0],'x-csrf-token':remoteSession.body.csrfToken,'Content-Type':'application/json'};
    assert.equal((await remoteRequest('/api/auth/login','POST',{...remoteHeaders,Origin:origin},{password})).status,403);
    const remoteLogin=await remoteRequest('/api/auth/login','POST',remoteHeaders,{password});assert.equal(remoteLogin.status,200);assert.match(remoteLogin.headers['set-cookie'][0],/; Secure/);
    assert.equal(output.includes(password), false);
  } finally { child.kill(); await closed; }
  const backgroundArgs = [...args, '--background'];
  try {
    const started = windows
      ? spawnSync(process.env.ComSpec!, ['/d','/s','/c', 'Start.cmd --no-browser --background'], {cwd:directory,env,encoding:'utf8',windowsHide:true,input:'\n',timeout:20000})
      : spawnSync(start, backgroundArgs, {cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(started.status,0,started.stdout+started.stderr);
    assert.equal((await fetch(url+'/api/auth/session')).status,200,'server survives launcher exit');
    assert.equal((await remoteRequest('/api/auth/session')).status,200,'background server retains additional origin');
    const state = JSON.parse(await readFile(join(data,'server-control.json'),'utf8'));
    const repeat = spawnSync(start,backgroundArgs,{cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(repeat.status,0,repeat.stdout+repeat.stderr);
    assert.equal(JSON.parse(await readFile(join(data,'server-control.json'),'utf8')).token,state.token);
    const status=spawnSync(start,[...args,'--status'],{cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(status.status,0,status.stderr);assert.match(status.stdout,new RegExp(String(port)));
    const archive=process.env.PORTABLE_TEST_UPDATE;
    if(archive){
      const config=await readFile(join(data,'config.json')),auth=await readFile(join(data,'auth.json'));
      const checksum=createHash('sha256').update(await readFile(archive)).digest('hex');
      const updated=spawnSync(executable,['scripts/update-portable.ts',archive,checksum],{cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:60000});
      assert.equal(updated.status,0,updated.stdout+updated.stderr);
      assert.notEqual(JSON.parse(await readFile(join(data,'server-control.json'),'utf8')).token,state.token);
      assert.equal((await fetch(url+'/api/auth/session')).status,200);
      assert.deepEqual(await readFile(join(data,'config.json')),config);assert.deepEqual(await readFile(join(data,'auth.json')),auth);
    }
  } finally {
    const stop=spawnSync(start,[...args,'--stop'],{cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(stop.status,0,stop.stderr);
  }
  await assert.rejects(fetch(url+'/api/auth/session'));
});
