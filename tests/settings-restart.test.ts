import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeAuth } from '../src/server/auth.ts';
import { buildServer } from '../src/server/app.ts';
import { webRestart } from '../src/server/restart.ts';

test('Web restart requires authentication, CSRF, confirmation and an idle runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restart-api-'));
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let busy = true, scheduled = 0;
  const state = { available: true, status: 'scheduled' as const, scheduledAt: new Date(Date.now() + 90_000).toISOString() };
  try {
    await initializeAuth(dir, 'restart-test-password');
    app = await buildServer({ dataDir: dir, origin: 'http://localhost:3000', runtime: {
      async assertNativeIdle() { if (busy) throw Object.assign(Error('仍有活动会话'), { statusCode: 409, code: 'RUNTIME_THREAD_BUSY' }); },
    } as any, webRestart: { status: async () => state, schedule: async () => { scheduled++; return state; } } });
    const csrf = await app.inject({ url: '/api/auth/session', headers: { host: 'localhost:3000' } });
    const headers: any = { host: 'localhost:3000', origin: 'http://localhost:3000', 'x-csrf-token': csrf.json().csrfToken, cookie: String(csrf.headers['set-cookie']).split(';')[0] };
    const post = (payload: any, h = headers) => app!.inject({ method: 'POST', url: '/api/server/restart', headers: h, payload });
    assert.equal((await post({ confirmed: true })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password: 'restart-test-password' } });
    headers.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await post({ confirmed: true }, { ...headers, origin: 'https://other.example' })).statusCode, 403);
    for (const body of [{}, { confirmed: false }, { confirmed: true, command: 'arbitrary' }]) assert.equal((await post(body)).statusCode, 400);
    assert.equal((await post({ confirmed: true })).statusCode, 409);
    assert.equal(scheduled, 0);
    assert.equal((await app.inject({url:'/api/runtime/restart-check',headers})).statusCode,409);
    busy = false;
    assert.deepEqual((await app.inject({url:'/api/runtime/restart-check',headers})).json(),{idle:true});
    const accepted = await post({ confirmed: true });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json(), state);
    assert.equal(scheduled, 1);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('restart scheduling coalesces requests, survives reload and reports worker failure', {skip:process.platform!=='win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'web restart '));
  const data = join(root, '.local/web');
  try {
    await mkdir(data, {recursive:true}); await mkdir(join(root, 'scripts/windows'), {recursive:true});
    await writeFile(join(data, 'server-control.json'), JSON.stringify({pid:process.pid}));
    // Only replace the OS task launcher. No test may schedule or stop a real service.
    await writeFile(join(root, 'scripts/windows/restart-server.ps1'), `param([switch]$RequireIdle,[switch]$JsonOutput)
if(-not $RequireIdle -or -not $JsonOutput){throw 'Unsafe launch flags'}
$data=Join-Path $PSScriptRoot '../../.local/web'
Add-Content -LiteralPath (Join-Path $data 'calls') -Value 'launch'
Start-Sleep -Milliseconds 100
@{scheduledAt=(Get-Date).AddSeconds(90).ToUniversalTime().ToString('o');file='CodexWeb-Restart-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data 'restart-latest.json') -Encoding UTF8
`);
    const controller = webRestart(root);
    const results = await Promise.all([controller.schedule(), controller.schedule()]);
    assert.equal(results[0].status, 'scheduled'); assert.deepEqual(results[0], results[1]);
    await webRestart(root).schedule();
    assert.equal((await readFile(join(data, 'calls'), 'utf8')).trim(), 'launch');
    const result = join(data, 'CodexWeb-Restart-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.result.json');
    await writeFile(result, JSON.stringify({status:'failed'}));
    assert.equal((await controller.status()).status, 'failed');
    await writeFile(result, JSON.stringify({status:'success'}));
    assert.equal((await controller.status()).status, 'success');
    await writeFile(result, JSON.stringify({status:'ready'}));
    await writeFile(join(data, 'restart-latest.json'), JSON.stringify({scheduledAt:new Date(Date.now()-180_000).toISOString(),file:'CodexWeb-Restart-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'}));
    assert.equal((await controller.status()).status, 'unknown');
    await assert.rejects(controller.schedule(), {code:'RUNTIME_RESTART_UNAVAILABLE'});
  } finally { await rm(root, {recursive:true,force:true}); }
});
