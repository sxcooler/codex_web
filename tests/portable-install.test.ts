import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import * as portable from '../scripts/portable.ts';

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'portable-install-'));
  const saved = { ...process.env };
  process.env.LOCALAPPDATA = dir;
  process.env.PATH = '';
  process.env.CODEX_BIN = join(dir, 'ignored-developer.exe');
  delete process.env.CODEX_INSTALL_DIR;
  t.after(async () => { process.env = saved; await rm(dir, { recursive: true, force: true }); });
  const bin = join(dir, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  await mkdir(join(bin, '..'), { recursive: true });
  const installed = new Set<string>();
  const installCalls: any[] = [];
  t.mock.method(childProcess, 'spawnSync', (file: string, args: string[], options: any) => {
    if (args[0] === '--version') return { status: installed.has(file) ? 0 : 1, stdout: installed.has(file) ? 'codex-cli 0.135.0\n' : '', stderr: '' };
    installCalls.push({ file, args, options });
    if (installCalls.length > 1) { writeFileSync(bin, 'fake'); installed.add(bin); return { status: 0 }; }
    return { status: 1 };
  });
  let opens = 0;
  t.mock.method(childProcess, 'spawn', () => { opens++; throw new Error('Browser unavailable'); });
  const prompts: string[] = [];
  const terminal = (answers: string[]) => ({ question: async (prompt: string) => {
    prompts.push(prompt);
    assert.ok(answers.length, `Unexpected question: ${prompt}`);
    return answers.shift()!;
  } });
  return { dir, bin, installed, installCalls, terminal, prompts, opens: () => opens };
}

test('portable discovers verified configured, official and PATH executables without developer override', async t => {
  const f = await fixture(t);
  assert.equal(typeof portable.discoverPortableCodex, 'function');
  const configured = join(f.dir, 'configured.exe'), pathBin = join(f.dir, 'codex.exe');
  for (const file of [configured, f.bin, pathBin, process.env.CODEX_BIN!]) { await writeFile(file, 'fake'); f.installed.add(file); }
  process.env.PATH = f.dir;
  assert.equal(await portable.discoverPortableCodex(configured), configured);
  f.installed.delete(configured);
  assert.equal(await portable.discoverPortableCodex(configured), f.bin);
  f.installed.delete(f.bin);
  assert.equal(await portable.discoverPortableCodex(configured), pathBin);
  f.installed.delete(pathBin);
  assert.equal(await portable.discoverPortableCodex(configured), undefined);
  assert.equal(f.installCalls.length, 0);
});

test('portable defaults to manual installation and cancellation leaves no saved configuration', async t => {
  const f = await fixture(t);
  assert.equal(typeof portable.loadPortableConfig, 'function');
  await assert.rejects(portable.loadPortableConfig(f.dir, f.terminal([f.dir, '3100', '', '0'])), /退出|取消/);
  assert.equal(f.installCalls.length, 0);
  assert.equal(f.opens(), 1);
  await assert.rejects(readFile(join(f.dir, 'config.json')), { code: 'ENOENT' });
});

test('portable retries consented installer failures and saves verified CLI without asking inputs again', async t => {
  const f = await fixture(t);
  assert.equal(typeof portable.loadPortableConfig, 'function');
  process.env.CODEX_NON_INTERACTIVE = '1';
  const config = await portable.loadPortableConfig(f.dir, f.terminal([f.dir, '3100', 'invalid', '2', '2']));
  assert.equal(config.codexBin, f.bin);
  assert.equal(config.workRoot, f.dir);
  assert.equal(config.port, 3100);
  assert.equal(f.prompts.filter(prompt => prompt.startsWith('工作目录')).length, 1);
  assert.equal(f.installCalls.length, 2);
  for (const call of f.installCalls) {
    assert.ok(call.file.endsWith('powershell.exe'));
    assert.ok(call.args.includes('-NoProfile'));
    assert.ok(!call.args.includes('-NonInteractive'));
    assert.match(call.args.at(-1), /https:\/\/chatgpt\.com\/codex\/install\.ps1/);
    assert.equal(call.options.env.CODEX_NON_INTERACTIVE, undefined);
    assert.equal(call.options.stdio, 'inherit');
    assert.equal(call.options.shell, false);
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'config.json'), 'utf8')), config);
});

test('portable repairs invalid saved CLI with quoted path and preserves other configuration', async t => {
  const f = await fixture(t);
  assert.equal(typeof portable.loadPortableConfig, 'function');
  const selected = join(f.dir, 'custom path', 'codex.exe');
  await mkdir(join(selected, '..')); await writeFile(selected, 'fake'); f.installed.add(selected);
  const original = { port: 3200, origin: 'https://example.test', workRoot: f.dir, codexBin: 'missing.exe', custom: 'preserved' };
  await writeFile(join(f.dir, 'config.json'), JSON.stringify(original));
  const config = await portable.loadPortableConfig(f.dir, f.terminal(['3', 'invalid.cmd', '3', `"${selected}"`]));
  assert.deepEqual(config, { ...original, codexBin: resolve(selected) });
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'config.json'), 'utf8')), config);
  assert.equal(f.installCalls.length, 0);
});

test('portable manual recheck discovers installation without refreshing PATH', async t => {
  const f = await fixture(t);
  assert.equal(typeof portable.loadPortableConfig, 'function');
  const terminal = f.terminal([f.dir, '3100', '1', '']);
  const question = terminal.question;
  terminal.question = async prompt => {
    if (prompt.includes('重新检测')) { await writeFile(f.bin, 'fake'); f.installed.add(f.bin); }
    return question(prompt);
  };
  assert.equal((await portable.loadPortableConfig(f.dir, terminal)).codexBin, f.bin);
  assert.equal(f.installCalls.length, 0);
});

test('portable missing CLI cannot install noninteractively or overwrite cancelled saved configuration', async t => {
  const f = await fixture(t);
  assert.equal(typeof portable.loadPortableConfig, 'function');
  const original = { port: 3200, origin: 'http://localhost:3200', workRoot: f.dir, codexBin: 'missing.exe' };
  await writeFile(join(f.dir, 'config.json'), JSON.stringify(original));
  assert.equal(Boolean(process.stdin.isTTY), false, 'Run this test with noninteractive stdin');
  await assert.rejects(portable.loadPortableConfig(f.dir), /Start\.cmd/);
  await assert.rejects(portable.loadPortableConfig(f.dir, f.terminal(['0'])), /退出|取消/);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'config.json'), 'utf8')), original);
  assert.equal(f.installCalls.length, 0);
});

test('portable skips installation choices when an existing CLI is verified', async t => {
  const f = await fixture(t);
  await writeFile(f.bin, 'fake'); f.installed.add(f.bin);
  const config = await portable.loadPortableConfig(f.dir, f.terminal([f.dir, '3100']));
  assert.equal(config.codexBin, f.bin);
  assert.equal(f.prompts.length, 2);
  assert.equal(f.installCalls.length, 0);
  assert.equal(f.opens(), 0);
});

test('portable installer success without usable CLI does not save a success state', async t => {
  const f = await fixture(t);
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: 'not-codex\n' }));
  await assert.rejects(portable.loadPortableConfig(f.dir, f.terminal([f.dir, '3100', '2', '0'])), /退出/);
  await assert.rejects(readFile(join(f.dir, 'config.json')), { code: 'ENOENT' });
});

test('portable manual recheck submenu cannot grant installer consent', async t => {
  const f = await fixture(t);
  await assert.rejects(portable.loadPortableConfig(f.dir, f.terminal([f.dir, '3100', '1', '2', '0'])), /退出/);
  assert.equal(f.installCalls.length, 0);
});

test('portable first configuration rejects occupied port without saving config', async t => {
  const f = await fixture(t);
  await writeFile(f.bin, 'fake'); f.installed.add(f.bin);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => listener.close(() => resolve())));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(portable.loadPortableConfig(f.dir, f.terminal([f.dir, String(address.port)])), /端口.*已占用/);
  assert.equal(listener.listening, true);
  await assert.rejects(readFile(join(f.dir, 'config.json')), { code: 'ENOENT' });
});
