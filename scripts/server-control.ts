import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = join(root, '.local', 'web');
const record = join(data, 'server-control.json');
const windows = process.platform === 'win32';
type Instance = { token: string; port: number; pid: number; root: string; origin: string; diagnosticsEnabled?: boolean };

// A private local control endpoint proves ownership without trusting a reusable PID.
export async function managedServer(stop = false): Promise<Instance | null> {
  let state: Instance;
  try { state = JSON.parse(await readFile(record, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (state.root !== root || !/^[a-f0-9]{64}$/.test(state.token) || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('Invalid local server record; no process was stopped.');
  return new Promise(resolve => {
    const req = request({ hostname: '127.0.0.1', port: state.port, path: stop ? '/stop' : '/status', method: stop ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.token}`, Connection: 'close' }, timeout: 1000 }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 2048) res.destroy(); });
      res.on('error', () => resolve(null));
      res.on('end', () => { try { const result = JSON.parse(text); resolve(res.statusCode === 200 && result.token === state.token && result.root === root ? state : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => req.destroy()); req.end();
  });
}

export async function stopServer() {
  const state = await managedServer();
  if (!state) { process.stdout.write('No managed Codex Web server is running.\n'); return; }
  if (!await managedServer(true)) throw new Error('Could not confirm shutdown; no other process was stopped.');
  for (let attempt = 0; attempt < 150; attempt++) {
    const current = await managedServer();
    if (!current || current.token !== state.token) { process.stdout.write('Codex Web stopped.\n'); return; }
    await delay(100);
  }
  throw new Error('Shutdown is taking longer than expected; inspect server.log. No process was forcibly killed.');
}

export async function runServer(portable = false, diagnosticsEnabled = false) {
  if (portable) for (const key of ['WEB_ORIGIN', 'PORT', 'WORK_ROOT', 'CODEX_BIN']) delete process.env[key];
  process.env.WEB_DATA_DIR = data;
  await mkdir(data, { recursive: true, mode: 0o700 });
  const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const { startServer } = await import('../src/server/main.ts');
  const app = await startServer(diagnosticsEnabled); // Returns only after this instance successfully binds its Web port.
  const token = randomBytes(32).toString('hex');
  let state: Instance;
  let closing: Promise<void> | undefined;
  const shutdown = () => closing ??= (async () => {
    await app.close();
    control.closeAllConnections();
    await new Promise<void>(resolve => control.close(() => resolve()));
    const saved = JSON.parse(await readFile(record, 'utf8').catch(() => '{}'));
    if (saved.token === token) await unlink(record).catch(() => {});
  })();
  const control = createServer((req, res) => {
    if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (!((req.method === 'GET' && req.url === '/status') || (req.method === 'POST' && ['/stop','/prepare-update'].includes(req.url??'')))) { res.writeHead(404).end(); return; }
    if(req.url==='/prepare-update'){try{if(typeof (app as any).prepareUpdate!=='function')throw Error('Update preparation unavailable');(app as any).prepareUpdate();}catch{res.writeHead(409).end();return;}}
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Connection', 'close');
    res.end(JSON.stringify(state));
    if (req.url === '/stop') res.on('finish', () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
  });
  try {
    await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    const address = control.address(); if (!address || typeof address === 'string') throw new Error('Control address unavailable');
    state = { token, port: address.port, pid: process.pid, root, origin: process.env.WEB_ORIGIN ?? config.origin ?? 'http://localhost:3000', diagnosticsEnabled };
    const temporary = record + '.' + token;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temporary, record);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
  } catch (error) { control.close(); await app.close(); throw error; }
}

export async function startBackground(portable = false, diagnosticsEnabled = false) {
  const existing = await managedServer();
  if (existing) {
    if (diagnosticsEnabled && !existing.diagnosticsEnabled) throw new Error('Already running without diagnostics; stop and restart with --diagnostics to enable diagnostics.');
    process.stdout.write(`Already running: ${existing.origin} (diagnostics: ${existing.diagnosticsEnabled?'on':'off'})\n`);
    return existing;
  }
  await mkdir(data, { recursive: true, mode: 0o700 });
  const logs = ['server.log', 'server-error.log'].map(name => join(data, name));
  // ponytail: Linux rotates on launch; use logrotate if uninterrupted runs need bounded logs.
  for (const log of logs) if ((await stat(log).catch(() => null))?.size! >= 1048576) await rename(log, log + '.1');
  const entry = fileURLToPath(import.meta.url);
  const args = [entry, '--worker', ...(portable ? ['--portable'] : []),...(diagnosticsEnabled?['--diagnostics']:[])];
  if (windows) {
    // Use the built-in shell to detach a hidden window; no PowerShell 7 dependency.
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root,'scripts/windows/background-host.ps1'), '-NodePath', process.execPath, ...(portable ? ['-Portable'] : []),...(diagnosticsEnabled?['-DiagnosticsEnabled']:[])], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (result.error || result.status !== 0) throw new Error(`Background launch failed: ${result.stderr || result.error}`);
  } else {
    const out = await open(logs[0], 'a', 0o600), err = await open(logs[1], 'a', 0o600);
    try {
      const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', out.fd, err.fd] });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { await out.close(); await err.close(); }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await managedServer();
    if (current) {
      if (diagnosticsEnabled && !current.diagnosticsEnabled) throw new Error('Another instance started without diagnostics; stop and restart with --diagnostics.');
      process.stdout.write(`Running in background: ${current.origin} (diagnostics: ${current.diagnosticsEnabled?'on':'off'})\nLogs: ${logs.join(', ')}\n`);
      return current;
    }
    await delay(100);
  }
  throw new Error(`Background server did not become ready. Check ${logs.join(' and ')}. Port may be occupied or configuration invalid.`);
}

async function main() {
  const args = process.argv.slice(2);
  if(!args.includes('--stop')&&!args.includes('--status')){
    const lock=await readFile(join(root,'.local/update-lock.json'),'utf8').catch((e:any)=>{if(e.code==='ENOENT')return '';throw e;});
    const pending=await stat(join(root,'.local/updates/pending.json')).then(()=>true,(e:any)=>{if(e.code==='ENOENT')return false;throw e;});
    if((lock||pending)&&(!lock||JSON.parse(lock).token!==process.env.CODEX_WEB_UPDATE_TOKEN))throw Error('Application update in progress or interrupted; run Update --recover.');
  }
  if (args.some(arg => !['--worker', '--portable', '--background', '--foreground', '--status', '--stop','--diagnostics'].includes(arg))) throw new Error('Unknown server control argument');
  if (args.includes('--stop')) return stopServer();
  if (args.includes('--status')) { const state = await managedServer(); process.stdout.write(state ? `Running: ${state.origin} (PID ${state.pid}, diagnostics: ${state.diagnosticsEnabled?'on':'off'})\n` : 'No managed Codex Web server is running.\n'); return; }
  if (args.includes('--worker') || args.includes('--foreground')) return runServer(args.includes('--portable'),args.includes('--diagnostics'));
  await startBackground(args.includes('--portable'),args.includes('--diagnostics'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
