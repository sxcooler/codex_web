import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Run against a fresh extracted release, never a user's configured installation.
const root = process.env.PORTABLE_TEST_DIR;
test('extracted release runs with bundled Node and isolated data', { skip: !root, timeout: 30_000 }, async () => {
  const directory = root!;
  assert.equal(await access(join(directory, '.local')).then(() => true, () => false), false, 'Use a fresh extracted package');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    assert.ok(!/(^|\/)(\.local|\.git)(\/|$)/.test(entry.path));
    const bytes = await readFile(join(directory, entry.path));
    assert.equal(bytes.length, entry.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  const executable = join(directory, 'runtime', 'node.exe');
  const env = { ...process.env, PATH: join(process.env.SystemRoot!, 'System32'), WEB_DATA_DIR: 'invalid-inherited-data', WEB_ORIGIN: 'invalid-inherited-origin', PORT: 'invalid', WORK_ROOT: 'invalid', CODEX_BIN: 'invalid' };
  const first = spawnSync(executable, ['scripts/portable.ts', '--no-browser'], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 1);
  assert.match(first.stderr, /Start\.cmd/);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const origin = `http://localhost:${port}`;
  const data = join(directory, '.local', 'web'), workRoot = join(directory, '.local', 'test work');
  await mkdir(workRoot, { recursive: true });
  // Runtime is lazy; no model request is made and this dummy executable is never launched.
  await writeFile(join(data, 'config.json'), JSON.stringify({ port, origin, workRoot, codexBin: executable }));
  try {
    const busy = spawnSync(executable, ['scripts/portable.ts', '--no-browser'], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    assert.equal(busy.status, 1); assert.match(busy.stderr, new RegExp(String(port))); assert.equal(listener.listening, true);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  const password = 'Portable-fixture-only-2468';
  const auth = spawnSync(executable, ['scripts/setup-auth.ts'], { cwd: directory, env, input: password + '\n', encoding: 'utf8', windowsHide: true });
  assert.equal(auth.status, 0, auth.stderr);
  const child = spawn(executable, ['scripts/portable.ts', '--no-browser'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    assert.equal(output.includes(password), false);
  } finally { child.kill(); await closed; }
});
