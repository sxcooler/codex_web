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
  let busy = true, scheduled = 0;const selections:any[]=[],scopes:any[]=[];
  const inspection=()=>({checkedAt:new Date().toISOString(),complete:true,sessions:busy?[{threadId:'fixture-active',turnId:'fixture-turn',name:'Fixture active',kind:'running',category:'session'}]:[],blockers:[],issues:[],canRestart:!busy,canForce:busy,version:'a'.repeat(64)});
  const state = { available: true, status: 'scheduled' as const, scheduledAt: new Date(Date.now() + 90_000).toISOString() };
  try {
    await initializeAuth(dir, 'restart-test-password');
    app = await buildServer({ dataDir: dir, origin: 'http://localhost:3000', runtime: {
      async assertNativeIdle() { if (busy) throw Object.assign(Error('仍有活动会话'), { statusCode: 409, code: 'RUNTIME_THREAD_BUSY' }); },
      async inspectRestart(){return inspection();},
      async authorizeRestart(selection:any){selections.push(selection);if(busy&&selection.mode!=='force')throw Object.assign(Error('仍有活动会话'),{statusCode:409,code:'RUNTIME_THREAD_BUSY'});if(selection.mode==='force'&&!selection.version)throw Object.assign(Error('Missing version'),{statusCode:400,code:'RUNTIME_INVALID_INPUT'});return selection.mode==='force'?{epoch:'fixture-epoch',sessions:[{threadId:'fixture-active',turnId:'fixture-turn'}]}:undefined;},
    } as any, webRestart: { status: async () => state, schedule: async scope => { scheduled++;scopes.push(scope);return state; } } });
    const csrf = await app.inject({ url: '/api/auth/session', headers: { host: 'localhost:3000' } });
    const headers: any = { host: 'localhost:3000', origin: 'http://localhost:3000', 'x-csrf-token': csrf.json().csrfToken, cookie: String(csrf.headers['set-cookie']).split(';')[0] };
    const post = (payload: any, h = headers) => app!.inject({ method: 'POST', url: '/api/server/restart', headers: h, payload });
    assert.equal((await post({ confirmed: true })).statusCode, 401);
    assert.equal((await app.inject({url:'/api/server/restart',headers:{host:'localhost:3000'}})).statusCode,401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password: 'restart-test-password' } });
    headers.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await post({ confirmed: true }, { ...headers, origin: 'https://other.example' })).statusCode, 403);
    for (const body of [{}, { confirmed: false }, { confirmed: true, command: 'arbitrary' }]) assert.equal((await post(body)).statusCode, 400);
    assert.equal((await post({ confirmed: true })).statusCode, 409);
    assert.equal(scheduled, 0);
    const active=await app.inject({url:'/api/runtime/restart-check',headers});assert.equal(active.statusCode,200);assert.equal(active.json().sessions[0].threadId,'fixture-active');
    assert.equal((await post({confirmed:true,mode:'force'})).statusCode,400);
    const forced=await post({confirmed:true,mode:'force',version:'a'.repeat(64)});assert.equal(forced.statusCode,200,forced.body);
    assert.deepEqual(scopes[0],{epoch:'fixture-epoch',sessions:[{threadId:'fixture-active',turnId:'fixture-turn'}]});
    assert.equal(selections.at(-1).mode,'force');
    busy = false;
    assert.equal((await app.inject({url:'/api/runtime/restart-check',headers})).json().canRestart,true);
    const accepted = await post({ confirmed: true });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json(), state);
    assert.equal(scheduled, 2);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

for(const forced of [false,true])test(`restart scheduling coalesces requests, survives reload and reports worker failure (force=${forced})`, {skip:process.platform!=='win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'web restart '));
  const data = join(root, '.local/web');
  try {
    await mkdir(data, {recursive:true}); await mkdir(join(root, 'scripts/windows'), {recursive:true});
    await writeFile(join(data, 'server-control.json'), JSON.stringify({pid:process.pid}));
    // Only replace the OS task launcher. No test may schedule or stop a real service.
    await writeFile(join(root, 'scripts/windows/restart-server.ps1'), `param([switch]$RequireIdle,[switch]$JsonOutput,[string]$ForceScopeFile)
if(-not $RequireIdle -or -not $JsonOutput){throw 'Unsafe launch flags'}
$data=Join-Path $PSScriptRoot '../../.local/web'
if($ForceScopeFile){$scope=Get-Content -LiteralPath $ForceScopeFile -Raw | ConvertFrom-Json;if($scope.epoch -ne 'approved-native' -or $scope.sessions[0].turnId -ne 'approved-turn'){throw 'Wrong scope'};$scope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $data 'scope-observed.json') -Encoding UTF8}
Add-Content -LiteralPath (Join-Path $data 'calls') -Value 'launch'
Start-Sleep -Milliseconds 100
@{scheduledAt=(Get-Date).AddSeconds(90).ToUniversalTime().ToString('o');file='CodexWeb-Restart-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data 'restart-latest.json') -Encoding UTF8
`);
    const controller = webRestart(root);
    const scope=forced?{epoch:'approved-native',sessions:[{threadId:'approved-task',turnId:'approved-turn'}]}:undefined;
    const results = await Promise.all([controller.schedule(scope), controller.schedule(scope)]);
    assert.equal(results[0].status, 'scheduled'); assert.deepEqual(results[0], results[1]);
    await webRestart(root).schedule();
    assert.equal((await readFile(join(data, 'calls'), 'utf8')).trim(), 'launch');
    if(forced)assert.deepEqual(JSON.parse((await readFile(join(data,'scope-observed.json'),'utf8')).replace(/^\uFEFF/,'')),scope);
    const result = join(data, 'CodexWeb-Restart-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.result.json');
    const finishedAt = '2026-10-15T03:00:00.000Z';
    await writeFile(result, JSON.stringify({status:'failed',time:finishedAt,message:'Shutdown was refused; no process was stopped.'}));
    const failed = await controller.status();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.finishedAt, finishedAt);
    assert.equal(failed.reason, 'Shutdown was refused; no process was stopped.');
    await writeFile(result, JSON.stringify({status:'failed',time:'invalid',message:{unsafe:'not text'}}));
    const malformed = await controller.status();
    assert.equal(malformed.status, 'failed');
    assert.equal(malformed.finishedAt, undefined);
    assert.equal(malformed.reason, undefined);
    await writeFile(result, JSON.stringify({status:'failed',time:finishedAt,message:'  '+ 'x'.repeat(2500)+'  '}));
    assert.equal((await controller.status()).reason?.length,2000);
    await writeFile(result, JSON.stringify({status:'success'}));
    assert.equal((await controller.status()).status, 'success');
    await writeFile(result, JSON.stringify({status:'ready'}));
    await writeFile(join(data, 'restart-latest.json'), JSON.stringify({scheduledAt:new Date(Date.now()-180_000).toISOString(),file:'CodexWeb-Restart-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'}));
    assert.equal((await controller.status()).status, 'unknown');
    await assert.rejects(controller.schedule(), {code:'RUNTIME_RESTART_UNAVAILABLE'});
  } finally { await rm(root, {recursive:true,force:true}); }
});
