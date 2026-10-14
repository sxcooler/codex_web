import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { parsePort, portAvailable } from '../scripts/portable.ts';
import * as packaging from '../scripts/package-portable.ts';
const {runtimeAllowed,runtimeFiles,sourceAllowed}=packaging;
import { appFile } from '../scripts/portable-manifest.ts';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { configuredOrigins, optionalDomain } from '../src/server/origins.ts';
import {mkdtemp,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

test('origin allowlist rejects malformed or ambiguous inputs and normalizes optional domains',()=>{
  assert.equal(optionalDomain('  '),undefined);
  assert.equal(optionalDomain(' Device.Example.test '),'https://device.example.test');
  assert.equal(optionalDomain('https://example.test:443/'),'https://example.test');
  for(const value of ['https://*.example.test','https://user:pass@example.test','https://example.test/path','https://example.test?x=1','https://example.test#x','ftp://example.test','https://exa mple.test','https:\\example.test'])assert.throws(()=>configuredOrigins(value));
  for(const extra of ['https://example.test',null,{},[null],[1]])assert.throws(()=>configuredOrigins('http://localhost:3000',extra));
  assert.throws(()=>configuredOrigins('http://example.test:3000',['https://example.test:3000']));
  assert.equal(configuredOrigins('http://localhost:3000',['http://localhost:3000/']).length,1);
});

test('portable ports are validated and an occupied listener is left untouched', async () => {
  assert.equal(parsePort('3000'), 3000);
  for (const value of ['0', '65536', '-1', '3.5', '3000x', '']) assert.throws(() => parsePort(value));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  try { assert.equal(await portAvailable(address.port), false); assert.equal(listener.listening, true); }
  finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  assert.equal(await portAvailable(address.port), true);
});

test('release exports exclude local state, credentials and history', () => {
  for (const path of ['.git/config', '.local/web/config.json', '.worktrees/a/README.md', '.superpowers/plan.md', '.env', '.env.production', 'secret.pem', 'a.sqlite-wal', 'releases/a.zip', 'nested/auth.json', 'vapid.json', 'credentials.json']) assert.equal(sourceAllowed(path), false, path);
  for (const path of ['.gitignore', '.env.example', 'README.md', 'src/server/auth.ts', 'tests/auth.test.ts']) assert.equal(sourceAllowed(path), true, path);
  assert.ok(runtimeFiles.every(path => sourceAllowed(path) || path === 'dist'));
  const sharedImport = readFileSync(new URL('../src/server/push.ts', import.meta.url), 'utf8').match(/from '([^']+notificationTarget\.ts)'/)![1];
  const sharedPath = relative(resolve('src'), resolve('src/server', sharedImport)).replaceAll('\\', '/');
  const packagedPath = 'src/' + sharedPath;
  assert.ok(appFile(packagedPath), 'Shared notification helper must be accepted by the existing portable updater');
  assert.ok(runtimeFiles.some(base => packagedPath === base || packagedPath.startsWith(base + '/')) && runtimeAllowed(packagedPath), 'Portable server must include its shared notification target import');
  for (const path of ['src/server/debug.log', 'src/codex/.env', 'dist/.local/auth.json']) assert.equal(runtimeAllowed(path), false, path);
  assert.equal(runtimeAllowed('dist/assets/index.js'), true);
  for (const path of ['scripts/windows/install-startup.ps1', 'scripts/windows/startup-launcher.cs', 'scripts/windows/codex-web.ico']) {
    assert.ok(runtimeFiles.some(base => path.startsWith(base + '/')) && runtimeAllowed(path), 'Portable package must include startup branding: ' + path);
  }
  assert.ok(!runtimeFiles.some(path => path.startsWith('.')));
  assert.ok(runtimeFiles.includes('scripts/tailscale.ts') && appFile('scripts/tailscale.ts'), 'Portable install and update must include the shared Tailscale setup');
});

test('portable documentation preserves bilingual README links and the existing updater docs boundary',async t=>{
  assert.equal(typeof (packaging as any).copyPortableDocs,'function');
  const root=await mkdtemp(join(process.cwd(),'.local','tailscale-docs-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),target=join(root,'portable');
  for(const directory of ['docs/verification','codex-drive/specs'])await mkdir(join(source,directory),{recursive:true});
  const architecture='codex-drive/specs/2026-10-14-internationalization.arch.md';
  await writeFile(join(source,architecture),'[源码](../../src/web/main.tsx)');
  await writeFile(join(source,'docs/README.md'),`[中文](../README_CN.md) · [English](../README.md)\n[国际化](../${architecture})\n源码文件 \`../README_CN.md\`。`);
  await writeFile(join(source,'README.md'),'[中文](README_CN.md)\n\nEnglish');
  await writeFile(join(source,'README_CN.md'),'[English](README.md)\n\n中文');
  await writeFile(join(source,'docs/verification/check.md'),`[方案](../../${architecture})`);
  await (packaging as any).copyPortableDocs(source,target,[architecture,'docs/README.md','docs/verification/check.md','README.md','README_CN.md']);
  assert.equal(await readFile(join(target,'README_EN.md'),'utf8'),'[English](README.md)\n\n中文');
  assert.equal(await readFile(join(target,'README.md'),'utf8'),'[中文](README_EN.md)\n\nEnglish');
  assert.ok(appFile('README.md')&&appFile('README_EN.md'),'Both languages must remain accepted by existing updaters');
  assert.ok(!(await readdir(target)).includes('README_CN.md'));
  const index=await readFile(join(target,'docs/README.md'),'utf8');
  assert.match(index,/\[中文\]\(\.\.\/README_EN\.md\)/);
  assert.ok(index.includes('源码文件 `../README_CN.md`。'),'Source file names in prose must remain accurate');
  const linked=index.match(/\[国际化\]\(([^)]+)\)/)![1];
  assert.equal(await readFile(resolve(target,'docs',linked),'utf8'),'[源码](../../src/web/main.tsx)');
  assert.ok(appFile('docs/'+linked),'Documentation must remain accepted by existing update paths');
  assert.ok(!(await readdir(target)).includes('codex-drive'));
  const verification=await readFile(join(target,'docs/verification/check.md'),'utf8');
  const verificationLink=verification.match(/\]\(([^)]+)\)/)![1];
  assert.equal(await readFile(resolve(target,'docs/verification',verificationLink),'utf8'),'[源码](../../src/web/main.tsx)');
});
