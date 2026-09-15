import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createHash, randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountUsage} from '../src/server/account-usage.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';
import {Projects} from '../src/projects.ts';

const accountId = createHash('sha256').update('native-account-a').digest('hex');
const operation = (creditId = 'credit-1') => ({accountId, creditId, idempotencyKey: randomUUID()});
const credit = () => ({id: 'credit-1', resetType: 'codexRateLimits', status: 'available', title: '一次重置', description: '<script>untrusted</script>', grantedAt: 1_700_000_000, expiresAt: null});
const rawUsage = (): any => ({
  accountId: 'native-account-a',
  rateLimits: {limitId: 'codex', primary: {usedPercent: 29, windowDurationMins: 300, resetsAt: 1_900_000_000}},
  rateLimitsByLimitId: {codex: {limitId: 'codex', primary: {usedPercent: 29, windowDurationMins: 300, resetsAt: 1_900_000_000}}, spark: {limitId: 'spark', primary: {usedPercent: 80, windowDurationMins: 60, resetsAt: 1_900_000_000}}},
  rateLimitResetCredits: {availableCount: 2n, credits: [credit()]},
});

function fakeRuntime() {
  const runtime = Object.assign(new EventEmitter(), {
    identity: 'identity-a', resetProtocol: true, raw: rawUsage(), reads: 0,
    calls: [] as {input: {creditId: string; idempotencyKey: string}; accountId: string}[],
    accountIdentity: async () => ({identity: runtime.identity, resetProtocol: runtime.resetProtocol}),
    readAccountUsage: async (): Promise<any> => { runtime.reads++; return structuredClone(runtime.raw); },
    consumeAccountReset: async (input: {creditId: string; idempotencyKey: string}, expectedAccount: string): Promise<any> => {
      runtime.calls.push({input, accountId: expectedAccount}); return {outcome: 'reset'};
    },
    close: async () => {},
  });
  return runtime;
}

function fixture(t: TestContext) {
  const runtime = fakeRuntime(), db = new DatabaseSync(':memory:');
  const service = new AccountUsage(runtime as any, db);
  t.after(() => {service.close(); db.close();});
  return {runtime, db, service};
}

test('usage reads coalesce, cache for 30 seconds, and forced refresh waits for a genuinely fresh read', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const {runtime, service} = fixture(t);
  const first = await service.read();
  now += 29_999;
  assert.equal((await service.read()).updatedAt, first.updatedAt);
  assert.equal(runtime.reads, 1);
  now++;
  await service.read();
  assert.equal(runtime.reads, 2);
  await service.read(true);
  assert.equal(runtime.reads, 3);

  service.invalidate();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  runtime.readAccountUsage = async () => {
    runtime.reads++;
    if (runtime.reads === 4) {started.resolve(); await release.promise;}
    return rawUsage();
  };
  const reading = service.read();
  await started.promise;
  const duplicate = service.read(), forced = service.read(true);
  assert.equal(runtime.reads, 4);
  release.resolve();
  await Promise.all([reading, duplicate, forced]);
  assert.equal(runtime.reads, 5);
});

test('identity changes discard cached data and reject a snapshot spanning an account change', async t => {
  const {runtime, service} = fixture(t);
  await service.read();
  runtime.identity = 'identity-b';
  runtime.raw.accountId = 'native-account-b';
  assert.notEqual((await service.read()).accountId, accountId);
  assert.equal(runtime.reads, 2);
  runtime.emit('accountChanged');
  await service.read();
  assert.equal(runtime.reads, 3);
  runtime.readAccountUsage = async () => {runtime.identity = 'identity-c'; return rawUsage();};
  await assert.rejects(service.read(true), {code: 'ACCOUNT_CHANGED'});
});

test('usage preserves separate buckets and serializes bigint without coercing unavailable values to zero', async t => {
  const {runtime, service} = fixture(t);
  runtime.raw.rateLimitResetCredits.availableCount = 900719925474099312345n;
  runtime.raw.rateLimits.primary = {usedPercent: null, windowDurationMins: Infinity, resetsAt: -1};
  runtime.raw.rateLimitResetCredits.credits.push({...credit(), id: 'invalid-expiry', grantedAt: NaN, expiresAt: 'tomorrow'});
  const data = JSON.parse(JSON.stringify(await service.read()));
  assert.equal(data.accountId, accountId);
  assert.equal(data.rateLimitResetCredits.availableCount, '900719925474099312345');
  assert.deepEqual(data.rateLimits.primary, {usedPercent: null, windowDurationMins: null, resetsAt: null});
  assert.equal(data.rateLimitsByLimitId.codex.primary.usedPercent, 29);
  assert.equal(data.rateLimitsByLimitId.spark.primary.usedPercent, 80);
  assert.equal(data.rateLimitResetCredits.credits[0].expiresAt, null);
  assert.equal(data.rateLimitResetCredits.credits[0].description, '<script>untrusted</script>');
  assert.equal(data.rateLimitResetCredits.credits[1].grantedAt, null);
  assert.equal(Object.hasOwn(data.rateLimitResetCredits.credits[1], 'expiresAt'), false);
  for (const value of [null, -1, 1.5, NaN, Infinity, 'unknown', {}, 9007199254740992]) {
    runtime.raw.rateLimitResetCredits.availableCount = value;
    assert.equal((await service.read(true)).rateLimitResetCredits.availableCount, null);
  }
  for (const value of [NaN, Infinity, 8640000000001, 1.5, '1900000000', null]) {
    runtime.raw.rateLimits.primary.resetsAt = value;
    assert.equal((await service.read(true)).rateLimits.primary.resetsAt, null);
  }
});

test('all four native outcomes are returned, invalidate usage, and replay without another consume', async t => {
  const {runtime, service} = fixture(t);
  for (const outcome of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']) {
    const input = operation();
    runtime.consumeAccountReset = async (nativeInput, expectedAccount) => {
      runtime.calls.push({input: nativeInput, accountId: expectedAccount}); return {outcome};
    };
    assert.deepEqual(await service.reset(input), {outcome});
    const reads = runtime.reads, consumes = runtime.calls.length;
    await service.read();
    assert.equal(runtime.reads, reads + 1);
    runtime.raw.rateLimitResetCredits.credits = [];
    assert.deepEqual(await service.reset(input), {outcome});
    assert.equal(runtime.calls.length, consumes);
    assert.deepEqual(runtime.calls.at(-1), {input: {creditId: input.creditId, idempotencyKey: input.idempotencyKey}, accountId});
    runtime.raw.rateLimitResetCredits.credits = [credit()];
  }
});

test('reset requires a reliable account, validated protocol, and account matching the confirmation', async t => {
  const {runtime, service} = fixture(t);
  runtime.raw.accountId = null;
  assert.equal((await service.read()).resetSupported, false);
  await assert.rejects(service.reset(operation()));
  runtime.raw.accountId = 'native-account-a';
  runtime.resetProtocol = false;
  assert.equal((await service.read(true)).resetSupported, false);
  await assert.rejects(service.reset(operation()), {code: 'ACCOUNT_RESET_UNSUPPORTED'});
  runtime.resetProtocol = true;
  await service.read(true);
  runtime.identity = 'identity-b'; runtime.raw.accountId = 'native-account-b';
  await assert.rejects(service.reset(operation()), {code: 'ACCOUNT_CHANGED'});
  assert.equal(runtime.calls.length, 0);
});

test('new operations reject absent, expired, unknown, redeeming, and invalidly dated credits', async t => {
  const {runtime, service} = fixture(t);
  const expiresNow = Math.floor(Date.now() / 1000);
  for (const detail of [null, {...credit(), expiresAt: expiresNow}, {...credit(), resetType: 'unknown'}, {...credit(), status: 'redeeming'}, {...credit(), status: 'redeemed'}, {...credit(), expiresAt: 'never'}, {...credit(), expiresAt: undefined}, {...credit(), expiresAt: -1}]) {
    runtime.raw.rateLimitResetCredits.credits = detail ? [detail] : [];
    await assert.rejects(service.reset(operation()), {code: 'ACCOUNT_CREDIT_UNAVAILABLE'});
  }
  runtime.raw.rateLimitResetCredits.credits = [credit()];
  for (const count of [0n, null]) {
    runtime.raw.rateLimitResetCredits.availableCount = count;
    await assert.rejects(service.reset(operation()), {code: 'ACCOUNT_CREDIT_UNAVAILABLE'});
  }
  assert.equal(runtime.calls.length, 0);
});

test('invalid reset parameters never consume; opaque credit IDs cannot alter the operation ledger', async t => {
  const {runtime, service, db} = fixture(t);
  for (const input of [null, {}, {...operation(), accountId: '../account'}, {...operation(), idempotencyKey: 'not-a-uuid'}, {...operation(), creditId: ''}, {...operation(), creditId: '  '}, {...operation(), creditId: 'x'.repeat(513)}, {...operation(), creditId: 'credit\n1'}, {...operation(), creditId: {id: 'credit-1'}}]) {
    await assert.rejects(service.reset(input as any), {code: 'ACCOUNT_INVALID_INPUT'});
  }
  assert.equal(runtime.calls.length, 0);
  const input = operation("'; DROP TABLE account_reset_operations; --");
  runtime.raw.rateLimitResetCredits.credits[0].id = input.creditId;
  await service.reset(input);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_reset_operations').get()!.count, 1);
  assert.equal(runtime.calls[0].input.creditId, input.creditId);
});

test('concurrent retries share one consume, while another operation on the same account is busy', async t => {
  const {runtime, service} = fixture(t);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  runtime.consumeAccountReset = async (input, expectedAccount) => {
    runtime.calls.push({input, accountId: expectedAccount}); started.resolve(); await release.promise; return {outcome: 'reset'};
  };
  const input = operation(), first = service.reset(input);
  await started.promise;
  const retry = service.reset({...input});
  await assert.rejects(service.reset(operation()), {code: 'ACCOUNT_RESET_BUSY'});
  release.resolve();
  assert.deepEqual(await Promise.all([first, retry]), [{outcome: 'reset'}, {outcome: 'reset'}]);
  assert.equal(runtime.calls.length, 1);
});

test('unknown outcome survives restart, blocks new keys, and retries the original tuple despite missing credit', async t => {
  const {runtime, service, db} = fixture(t);
  runtime.consumeAccountReset = async (input, expectedAccount) => {
    runtime.calls.push({input, accountId: expectedAccount}); throw new Error('transport lost');
  };
  const input = operation();
  await assert.rejects(service.reset(input), {code: 'ACCOUNT_RESET_UNKNOWN'});
  assert.deepEqual({...((await service.read()).pendingReset)}, input);
  service.close();
  const restarted = new AccountUsage(runtime as any, db);
  t.after(() => restarted.close());
  await assert.rejects(restarted.reset(operation()), {code: 'ACCOUNT_RESET_BUSY'});
  await assert.rejects(restarted.reset({...input, creditId: 'other-credit'}), {code: 'ACCOUNT_RESET_CONFLICT'});
  assert.equal(runtime.calls.length, 1);
  runtime.raw.rateLimitResetCredits = {availableCount: 0n, credits: []};
  runtime.consumeAccountReset = async (nativeInput, expectedAccount) => {
    runtime.calls.push({input: nativeInput, accountId: expectedAccount}); return {outcome: 'unrecognized'};
  };
  await assert.rejects(restarted.reset(input), {code: 'ACCOUNT_RESET_UNKNOWN'});
  runtime.raw.rateLimitResetCredits.credits = [{...credit(), status: 'redeemed'}];
  runtime.consumeAccountReset = async (nativeInput, expectedAccount) => {
    runtime.calls.push({input: nativeInput, accountId: expectedAccount}); return {outcome: 'alreadyRedeemed'};
  };
  assert.deepEqual(await restarted.reset(input), {outcome: 'alreadyRedeemed'});
  assert.equal((await restarted.read()).pendingReset, null);
  assert.equal(runtime.calls.length, 3);
  for (const call of runtime.calls) assert.deepEqual(call, {input: {creditId: input.creditId, idempotencyKey: input.idempotencyKey}, accountId});
  assert.deepEqual(await restarted.reset(input), {outcome: 'alreadyRedeemed'});
  assert.equal(runtime.calls.length, 3);
});

test('account usage API enforces authentication, CSRF, strict inputs, and returns JSON-safe usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-usage-api-')), runtime = fakeRuntime();
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await mkdir(join(dir, 'work'));
    await initializeAuth(join(dir, 'data'), 'account-usage-test-password');
    app = await buildServer({dataDir: join(dir, 'data'), origin: 'http://localhost:3000', projects: new Projects(join(dir, 'work')), runtime: runtime as any});
    const url = '/api/account/usage', resetUrl = url + '/reset';
    assert.equal((await app.inject({url, headers: {host: 'localhost:3000'}})).statusCode, 401);
    const session = await app.inject({url: '/api/auth/session', headers: {host: 'localhost:3000'}});
    const headers = {host: 'localhost:3000', origin: 'http://localhost:3000', 'x-csrf-token': session.json().csrfToken, cookie: String(session.headers['set-cookie']).split(';')[0]};
    assert.equal((await app.inject({method: 'POST', url: resetUrl, headers, payload: operation()})).statusCode, 401);
    const login = await app.inject({method: 'POST', url: '/api/auth/login', headers, payload: {password: 'account-usage-test-password'}});
    assert.equal(login.statusCode, 200, login.body);
    headers.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
    for (const change of [{'x-csrf-token': ''}, {origin: 'https://evil.example'}]) {
      assert.equal((await app.inject({method: 'POST', url: resetUrl, headers: {...headers, ...change}, payload: operation()})).statusCode, 403);
    }
    for (const query of ['?refresh=maybe', '?refresh=true&refresh=false', '?unexpected=1']) {
      assert.equal((await app.inject({url: url + query, headers})).statusCode, 400, query);
    }
    for (const payload of [{}, {...operation(), force: true}, {...operation(), idempotencyKey: 123}, {...operation(), creditId: []}]) {
      assert.equal((await app.inject({method: 'POST', url: resetUrl, headers, payload})).statusCode, 400);
    }
    assert.equal((await app.inject({method: 'POST', url: resetUrl + '?force=true', headers, payload: operation()})).statusCode, 400);
    assert.equal(runtime.calls.length, 0);
    const usage = await app.inject({url, headers});
    assert.equal(usage.statusCode, 200, usage.body);
    assert.equal(usage.headers['cache-control'], 'no-store');
    assert.equal(usage.json().rateLimitResetCredits.availableCount, '2');
    assert.equal(usage.json().accountId, accountId);
    const reads = runtime.reads;
    assert.equal((await app.inject({url: url + '?refresh=true', headers})).statusCode, 200);
    assert.equal(runtime.reads, reads + 1);
    const changed = await app.inject({method: 'POST', url: resetUrl, headers, payload: {...operation(), accountId: 'b'.repeat(64)}});
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().code, 'ACCOUNT_CHANGED');
    const reset = await app.inject({method: 'POST', url: resetUrl, headers, payload: operation()});
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.json().outcome, 'reset');
    assert.equal(runtime.calls.length, 1);
    runtime.consumeAccountReset = async () => {throw new Error('private native failure');};
    const unknown = await app.inject({method: 'POST', url: resetUrl, headers, payload: operation()});
    assert.equal(unknown.statusCode, 504, unknown.body);
    assert.equal(unknown.json().code, 'ACCOUNT_RESET_UNKNOWN');
    assert.doesNotMatch(unknown.body, /private native failure/);
  } finally {
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
});
