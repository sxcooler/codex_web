import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { parsePort, portAvailable } from '../scripts/portable.ts';
import { runtimeAllowed, runtimeFiles, sourceAllowed } from '../scripts/package-portable.ts';

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
  for (const path of ['src/server/debug.log', 'src/codex/.env', 'dist/.local/auth.json']) assert.equal(runtimeAllowed(path), false, path);
  assert.equal(runtimeAllowed('dist/assets/index.js'), true);
  assert.ok(!runtimeFiles.some(path => path.startsWith('.')));
});
