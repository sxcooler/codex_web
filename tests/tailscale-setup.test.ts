import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';

const dns = 'laptop.tail123.ts.net';
const origin = 'https://laptop.tail123.ts.net';
const running = { BackendState: 'Running', Self: { DNSName: dns + '.' } };
const mapping = { TCP: { '443': { HTTPS: true } }, Web: { [dns + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3456' } } } } };
const ok = (value: unknown = '') => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const failed = (stderr = 'failure') => ({ status: 1, stdout: '', stderr });
const missing = () => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }), stdout: '', stderr: '' });

async function fixture(t: TestContext, config: unknown = { origin: 'http://localhost:3000', allowedOrigins: ['https://old.example'], workRoot: 'keep', extra: { keep: true } }) {
  const dir = await fs.mkdtemp(join(process.cwd(), '.local', 'tailscale-test-'));
  const file = join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(config));
  const before = await fs.readFile(file, 'utf8');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file, before };
}

function commands(t: TestContext, respond?: (file: string, args: string[]) => unknown) {
  const calls: { file: string; args: string[]; options: any }[] = [];
  let served = false;
  t.mock.method(childProcess, 'spawnSync', (file, args, options) => {
    calls.push({ file, args, options });
    const answer = respond?.(file, args);
    if (answer !== undefined) return answer;
    if (args[0] === '--version') return ok('1.90.0');
    if (args[0] === 'status') return ok(running);
    if (args.join(' ') === 'serve status --json') return ok(served ? mapping : {});
    if (args.join(' ') === 'serve --bg --https=443 http://127.0.0.1:3456') { served = true; return ok(); }
    throw new Error('Unexpected external command: ' + file + ' ' + args.join(' '));
  });
  return calls;
}

async function configure(dir: string, terminal?: { question(prompt: string): Promise<string> }) {
  const helper = await import('../scripts/tailscale.ts');
  return helper.configureTailscale(dir, 3456, terminal);
}

function answers(...values: string[]) {
  return { async question(_prompt: string) { assert.ok(values.length, 'Unexpected prompt'); return values.shift()!; } };
}

function platform(t: TestContext, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('shared Tailscale setup exposes the installer API', async () => {
  const helper = await import('../scripts/tailscale.ts').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof helper.configureTailscale, 'function', 'Missing shared configureTailscale implementation');
});

test('private Serve saves HTTPS while preserving configuration and localhost access', async t => {
  const { dir, file } = await fixture(t);
  const calls = commands(t);
  assert.equal(await configure(dir), origin);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    origin, allowedOrigins: ['https://old.example', 'http://localhost:3000', 'http://localhost:3456'],
    workRoot: 'keep', extra: { keep: true }, port: 3456,
  });
  assert.equal(calls.filter(call => call.args.join(' ') === 'serve status --json').length, 2);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.ok(call.options.timeout > 0);
    assert.ok(call.options.maxBuffer > 0);
  }
});

test('an identical private mapping is reused without mutation', async t => {
  const { dir } = await fixture(t);
  const calls = commands(t, (_file, args) => args.join(' ') === 'serve status --json' ? ok({ ...mapping, AllowFunnel: { [dns + ':443']: false }, Foreground: null }) : undefined);
  assert.equal(await configure(dir), origin);
  assert.equal(calls.some(call => call.args.includes('--bg')), false);
});

test('noninteractive missing CLI and logged out states never install or log in', async t => {
  const { dir, file, before } = await fixture(t);
  let state = 'missing';
  const calls = commands(t, (_file, args) => state === 'missing' ? missing() : args[0] === 'status' ? ok({ BackendState: 'NeedsLogin' }) : undefined);
  await assert.rejects(configure(dir), /tailscale\.com\/download/);
  state = 'logged-out';
  await assert.rejects(configure(dir), /登录|login|tailscale up/i);
  assert.equal(calls.some(call => ['install', 'up'].includes(call.args[0])), false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('interactive cancellation and declining installation cause no machine changes', async t => {
  const { dir, file, before } = await fixture(t);
  const calls = commands(t, () => missing());
  await assert.rejects(configure(dir, answers('cancel')), /取消|cancel/i);
  assert.equal(calls.every(call => call.args[0] === '--version'), true);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('manual installation is retried without an installer command', async t => {
  const { dir } = await fixture(t);
  let installed = false;
  const calls = commands(t, (_file, args) => args[0] === '--version' && !installed ? missing() : undefined);
  const terminal = { async question(prompt: string) { assert.match(prompt, /tailscale\.com\/download/); installed = true; return 'retry'; } };
  assert.equal(await configure(dir, terminal), origin);
  assert.equal(calls.some(call => /winget|curl|sh/.test(call.file)), false);
});

test('login failure can be handled manually and retried without changing accounts', async t => {
  const { dir } = await fixture(t);
  let loggedIn = false, prompts = 0;
  const calls = commands(t, (_file, args) => args[0] === 'status' && !loggedIn ? ok({ BackendState: 'Stopped' }) : args[0] === 'up' ? failed('permission denied') : undefined);
  const terminal = { async question(prompt: string) { prompts++; if (prompts === 1) return 'up'; assert.match(prompt, /sudo tailscale up|operator/); loggedIn = true; return 'retry'; } };
  assert.equal(await configure(dir, terminal), origin);
  assert.equal(calls.filter(call => call.args[0] === 'up').length, 1);
  assert.equal(calls.some(call => call.args.some(arg => /reset|logout|auth-key/.test(arg))), false);
});

test('existing mappings, public Funnel and unknown structures are protected', async t => {
  const { dir, file, before } = await fixture(t);
  let serve: unknown;
  const calls = commands(t, (_file, args) => args.join(' ') === 'serve status --json' ? ok(serve) : undefined);
  for (serve of [
    { ...mapping, AllowFunnel: { [dns + ':443']: true } },
    { ...mapping, TCP: { '443': { HTTPS: true }, '8080': { HTTP: true } } },
    { ...mapping, Web: { [dns + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
    { ...mapping, Foreground: { session: mapping } }, { Unexpected: {} }, [], null,
  ]) await assert.rejects(configure(dir), /Serve|Funnel|映射/);
  assert.equal(calls.some(call => call.args.includes('--bg')), false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('malformed status and DNS never reach Serve', async t => {
  const { dir, file, before } = await fixture(t);
  let status: unknown;
  const calls = commands(t, (_file, args) => args[0] === 'status' ? ok(status) : undefined);
  for (status of ['not-json', [], null, { BackendState: 'Running' }, ...['evil.example', 'user@host.ts.net', 'host.ts.net/path', 'host.ts.net:443', '*.ts.net', '-host.ts.net', ' host.ts.net', 'host..ts.net'].map(DNSName => ({ BackendState: 'Running', Self: { DNSName } }))]) {
    await assert.rejects(configure(dir), /状态|status|DNS|JSON/);
  }
  assert.equal(calls.some(call => call.args[0] === 'serve'), false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('invalid web configuration is rejected before machine changes', async t => {
  const { dir, file } = await fixture(t);
  const calls = commands(t);
  for (const config of [[], null, { origin: null }, { origin: 'https://bad/path' }, { origin: 'http://localhost:3000', allowedOrigins: 'bad' }]) {
    await fs.writeFile(file, JSON.stringify(config));
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(configure(dir), /配置|origin|allowedOrigins/i);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
  assert.equal(calls.length, 0);
});

test('Windows install uses the exact official winget package only after consent and retries failure', async t => {
  platform(t, 'win32');
  const { dir } = await fixture(t);
  const previousProgramFiles = process.env.ProgramFiles;
  const taskProgramFiles = join(dir, 'program-files');
  process.env.ProgramFiles = taskProgramFiles;
  t.after(() => {
    if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = previousProgramFiles;
  });
  let installed = false, attempts = 0, prompts = 0;
  const calls = commands(t, (file, args) => {
    if (args[0] === '--version' && !installed) return missing();
    if (file === 'winget') {
      assert.deepEqual(args, ['install', '--id', 'Tailscale.Tailscale', '--exact', '--source', 'winget']);
      attempts++;
      if (attempts === 1) return failed('administrator required');
      installed = true;
      return ok();
    }
  });
  const terminal = { async question(prompt: string) {
    assert.match(prompt, /系统级安装.*管理员.*sudo/);
    if (++prompts === 2) assert.match(prompt, /安装失败/);
    return 'install';
  } };
  assert.equal(await configure(dir, terminal), origin);
  assert.equal(attempts, 2);
  assert.ok(calls.some(call => call.file === join(taskProgramFiles, 'Tailscale', 'tailscale.exe')));
});

test('missing winget directs manual installation without silently using another installer', async t => {
  platform(t, 'win32');
  const { dir } = await fixture(t);
  let installed = false, prompts = 0;
  const calls = commands(t, (file, args) => {
    if (file === 'winget' || (args[0] === '--version' && !installed)) return missing();
  });
  const terminal = { async question(prompt: string) {
    if (++prompts === 1) return 'install';
    assert.match(prompt, /没有 winget.*tailscale\.com\/download/);
    installed = true;
    return 'retry';
  } };
  assert.equal(await configure(dir, terminal), origin);
  assert.equal(calls.filter(call => call.file === 'winget').length, 1);
  assert.equal(calls.some(call => /curl|powershell|sh/.test(call.file)), false);
});

test('Linux consent downloads official script; failed download is never piped to a shell', async t => {
  platform(t, 'linux');
  const { dir } = await fixture(t);
  let installed = false, downloads = 0, shells = 0;
  const calls = commands(t, (file, args) => {
    if (args[0] === '--version' && !installed) return missing();
    if (file === 'curl') {
      assert.deepEqual(args, ['--fail', '--show-error', '--silent', '--location', 'https://tailscale.com/install.sh']);
      return ++downloads === 1 ? failed('network failed') : ok('official-script-fixture');
    }
    if (file === 'sh') { installed = true; shells++; return ok(); }
  });
  assert.equal(await configure(dir, answers('install', 'install')), origin);
  assert.equal(downloads, 2);
  assert.equal(shells, 1);
  assert.equal(calls.find(call => call.file === 'sh')!.options.input, 'official-script-fixture');
  assert.ok(calls.some(call => call.file === '/usr/bin/tailscale'));
});

test('CLI fallback and empty nullable fields work without exposing status stderr', async t => {
  platform(t, 'linux');
  const { dir } = await fixture(t);
  let served = false;
  const calls = commands(t, (file, args) => {
    if (file === 'tailscale') return missing();
    if (args.join(' ') === 'serve status --json') return ok(served ? mapping : { TCP: null, Web: null, AllowFunnel: null, Foreground: null });
    if (args.includes('--bg')) { served = true; return ok(); }
  });
  assert.equal(await configure(dir), origin);
  assert.ok(calls.filter(call => call.args[0] !== '--version').every(call => call.file === '/usr/bin/tailscale'));
});

test('invalid ports and command timeouts preserve config without attempting install', async t => {
  const { dir, file, before } = await fixture(t);
  const calls = commands(t, (_file, args) => args[0] === 'status' ? { ...failed(), error: Object.assign(new Error('tskey-private'), { code: 'ETIMEDOUT' }) } : undefined);
  const { configureTailscale } = await import('../scripts/tailscale.ts');
  for (const port of [0, 65536, 1.5, NaN]) await assert.rejects(configureTailscale(dir, port), /端口/);
  assert.equal(calls.length, 0);
  await assert.rejects(configure(dir, answers()), error => /status/.test(String(error)) && !String(error).includes('tskey-private'));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('CLI accepts argument order, honors saved port and requires a real terminal for interactive mode', async t => {
  const { dir } = await fixture(t);
  await fs.mkdir(join(dir, 'scripts'));
  await fs.mkdir(join(dir, 'src', 'server'), { recursive: true });
  await fs.mkdir(join(dir, '.local', 'web'), { recursive: true });
  await fs.copyFile(join(process.cwd(), 'scripts', 'tailscale.ts'), join(dir, 'scripts', 'tailscale.ts'));
  await fs.copyFile(join(process.cwd(), 'src', 'server', 'origins.ts'), join(dir, 'src', 'server', 'origins.ts'));
  await fs.writeFile(join(dir, 'package.json'), '{"type":"module"}');
  const file = join(dir, '.local', 'web', 'config.json');
  const entry = join(dir, 'scripts', 'tailscale.ts');
  const wrapper = join(dir, 'run.mjs');
  await fs.writeFile(wrapper, `import cp from 'node:child_process';let served=false;cp.spawnSync=(file,args)=>{
    const ok=value=>({status:0,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''});
    if(args[0]==='--version')return ok('1.90.0');
    if(args[0]==='status')return ok(${JSON.stringify(running)});
    if(args.join(' ')==='serve status --json')return ok(served?${JSON.stringify({ ...mapping, Web: { [dns + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4567' } } } } })}:{});
    if(args.join(' ')==='serve --bg --https=443 http://127.0.0.1:4567'){served=true;return ok('');}
    throw Error('Unexpected external command');
  };process.argv=[process.execPath,${JSON.stringify(entry)},...process.argv.slice(2)];await import(${JSON.stringify(pathToFileURL(entry).href)});`);
  const run = (args: string[]) => childProcess.spawnSync(process.execPath, [wrapper, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, env: { ...process.env, TEMP: dir, TMP: dir } });
  await fs.writeFile(file, JSON.stringify({ origin: 'http://localhost:4567', port: 4567, workRoot: 'keep' }));
  const success = run([]);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /https:\/\/laptop\.tail123\.ts\.net.*重启/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).port, 4567);
  const before = await fs.readFile(file, 'utf8');
  for (const args of [['--interactive', '--port', '4567'], ['--port', '4567', '--interactive']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /需要交互式终端/);
  }
  for (const args of [['--port', '4567', '--port', '4567'], ['--interactive', '--interactive'], ['--invalid'], ['--port', 'bad']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /用法/);
  }
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, '{"port":null}');
  const invalid = run([]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /port.*有效端口/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"port":null}');
});

test('missing web data directory is created only after validating the private mapping', async t => {
  const { dir } = await fixture(t);
  const dataDir = join(dir, 'new', 'web');
  commands(t);
  assert.equal(await configure(dataDir), origin);
  assert.deepEqual(JSON.parse(await fs.readFile(join(dataDir, 'config.json'), 'utf8')), { origin, allowedOrigins: ['http://localhost:3456'], port: 3456 });
});

test('Serve failure or misleading success never saves the web configuration', async t => {
  const { dir, file, before } = await fixture(t);
  let misleading = false;
  commands(t, (_file, args) => args.includes('--bg') ? misleading ? ok() : failed('private diagnostic') : args.join(' ') === 'serve status --json' ? ok({}) : undefined);
  await assert.rejects(configure(dir), /Serve/);
  misleading = true;
  await assert.rejects(configure(dir), /Serve/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(dir), ['config.json']);
});

test('failed staging prevents Serve; failed rename preserves config with recovery instructions', async t => {
  const { dir, file, before } = await fixture(t);
  const calls = commands(t);
  const write = t.mock.method(fs, 'writeFile', async () => { throw new Error('disk full'); });
  await assert.rejects(configure(dir), /配置|config/i);
  assert.equal(calls.some(call => call.args.includes('--bg')), false);
  write.mock.restore();
  t.mock.method(fs, 'rename', async () => { throw new Error('rename denied'); });
  await assert.rejects(configure(dir), /映射.*保留|mapping.*retained/i);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(dir), ['config.json']);
  assert.equal(calls.some(call => call.args.includes('reset') || call.args.includes('off')), false);
});
