import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { initializeAuth, openAuth } from '../src/server/auth.ts';
import { buildServer } from '../src/server/app.ts';

const HOST = 'localhost:3000';
const ORIGIN = 'http://localhost:3000';
const OLD_PASSWORD = 'correct-password-for-test';
const NEW_PASSWORD = 'new-correct-password-for-test';

async function withAuth(
  run: (dataDir: string) => Promise<void>,
  password = OLD_PASSWORD,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-web-auth-'));
  try {
    await initializeAuth(dataDir, password);
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function setCookies(response: { headers: Record<string, string | string[] | undefined> }): string[] {
  const value = response.headers['set-cookie'];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function cookiePair(cookie: string): string {
  return cookie.split(';', 1)[0];
}

async function csrf(app: Awaited<ReturnType<typeof buildServer>>, host = HOST) {
  const response = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { host } });
  const body = response.json();
  return { response, token: body.csrfToken as string, cookie: cookiePair(setCookies(response)[0]) };
}

async function login(
  app: Awaited<ReturnType<typeof buildServer>>,
  password = OLD_PASSWORD,
  session?: { token: string; cookie: string },
) {
  const current = session ?? await csrf(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: current.cookie,
      'x-csrf-token': current.token,
    },
    payload: { password },
  });
  const authCookie = setCookies(response).map(cookiePair).find((value) => !value.startsWith('codex_csrf='));
  return { response, csrf: current, authCookie };
}

test('initialization validates passwords and never overwrites existing credentials', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-web-auth-init-'));
  try {
    await assert.rejects(initializeAuth(dataDir, 'too-short'));
    await initializeAuth(dataDir, OLD_PASSWORD);
    const original = await readFile(join(dataDir, 'auth.json'), 'utf8');
    await assert.rejects(initializeAuth(dataDir, NEW_PASSWORD));
    assert.equal(await readFile(join(dataDir, 'auth.json'), 'utf8'), original);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server refuses missing credentials and defaults business routes to authentication', async () => {
  const missing = await mkdtemp(join(tmpdir(), 'codex-web-auth-missing-'));
  try {
    await assert.rejects(buildServer({ dataDir: missing, origin: ORIGIN }));
  } finally {
    await rm(missing, { recursive: true, force: true });
  }

  await withAuth(async (dataDir) => {
    const app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      assert.equal((await app.inject({ url: '/api/settings', headers: { host: HOST } })).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/auth/session', headers: { host: 'evil.invalid' } })).statusCode, 403);
    } finally {
      await app.close();
    }
  });
});

test('matched API route metadata prevents encoded-path authentication bypasses', async () => {
  await withAuth(async (dataDir) => {
    const app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      const response = await app.inject({ url: '/%61pi/settings', headers: { host: HOST } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally {
      await app.close();
    }
  });
});

test('session bootstrap and login enforce Host, Origin, CSRF, schemas, and strict cookies', async () => {
  await withAuth(async (dataDir) => {
    const app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      const session = await csrf(app);
      assert.equal(session.response.statusCode, 200);
      assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
      assert.match(setCookies(session.response)[0], /; HttpOnly; SameSite=Strict; Path=\//);
      assert.equal(session.response.headers['cache-control'], 'no-store');

      const missingCsrf = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: ORIGIN }, payload: { password: OLD_PASSWORD },
      });
      assert.equal(missingCsrf.statusCode, 403);

      const crossSite = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: HOST, origin: 'http://evil.invalid', cookie: session.cookie, 'x-csrf-token': session.token },
        payload: { password: OLD_PASSWORD },
      });
      assert.equal(crossSite.statusCode, 403);

      const duplicateCookie = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: HOST, origin: ORIGIN, cookie: `${session.cookie}; ${session.cookie}`, 'x-csrf-token': session.token },
        payload: { password: OLD_PASSWORD },
      });
      assert.equal(duplicateCookie.statusCode, 403);

      const malformed = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: HOST, origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.token },
        payload: { password: OLD_PASSWORD, extra: true },
      });
      assert.equal(malformed.statusCode, 400);
      assert.deepEqual(malformed.json(), { error: 'Invalid request' });

      const wrong = await login(app, 'definitely-wrong-password', session);
      assert.equal(wrong.response.statusCode, 401);
      assert.deepEqual(wrong.response.json(), { error: 'Invalid credentials' });

      const authenticated = await login(app, OLD_PASSWORD, session);
      assert.equal(authenticated.response.statusCode, 200);
      assert.equal(authenticated.response.json().authenticated, true);
      assert.ok(authenticated.authCookie);
      assert.match(setCookies(authenticated.response).join('\n'), /; HttpOnly; SameSite=Strict; Path=\//);

      const settings = await app.inject({ url: '/api/settings', headers: { host: HOST, cookie: authenticated.authCookie } });
      assert.equal(settings.statusCode, 200);
      assert.deepEqual(settings.json(), { origin: ORIGIN, nodeVersion: process.version });
      assert.equal(settings.headers['cache-control'], 'no-store');
    } finally {
      await app.close();
    }
  });
});

test('non-string passwords are rejected without consuming password verification quota', async () => {
  await withAuth(async (dataDir) => {
    const app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      const session = await csrf(app);
      for (const password of [123456789012, [OLD_PASSWORD]]) {
        const malformed = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { host: HOST, origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.token },
          payload: { password },
        });
        assert.equal(malformed.statusCode, 400);
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const checked = await login(app, 'wrong-password-value', session);
        assert.equal(checked.response.statusCode, 401);
      }
    } finally {
      await app.close();
    }
  });
});

test('session tokens are hashed at rest and expired sessions are rejected', async () => {
  await withAuth(async (dataDir) => {
    const app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      const authenticated = await login(app);
      assert.equal(authenticated.response.statusCode, 200);
      assert.ok(authenticated.authCookie);
      const plainToken = authenticated.authCookie.split('=', 2)[1];

      const databaseBytes = await readFile(join(dataDir, 'sessions.sqlite'));
      assert.equal(databaseBytes.includes(Buffer.from(plainToken)), false);

      const database = new DatabaseSync(join(dataDir, 'sessions.sqlite'));
      const stored = database.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
      assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
      assert.notEqual(stored.token_hash, plainToken);
      database.exec('UPDATE sessions SET expires_at = 0');
      database.close();

      const expired = await app.inject({ url: '/api/settings', headers: { host: HOST, cookie: authenticated.authCookie } });
      assert.equal(expired.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

test('password replacement invalidates every session and persists across restart', async () => {
  await withAuth(async (dataDir) => {
    let app = await buildServer({ dataDir, origin: ORIGIN });
    const first = await login(app);
    const second = await login(app);
    assert.ok(first.authCookie);
    assert.ok(second.authCookie);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `${first.authCookie}; ${first.csrf.cookie}`,
        'x-csrf-token': first.csrf.token,
      },
      payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/settings', headers: { host: HOST, cookie: first.authCookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/settings', headers: { host: HOST, cookie: second.authCookie } })).statusCode, 401);
    await app.close();

    app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      assert.equal((await login(app, OLD_PASSWORD)).response.statusCode, 401);
      assert.equal((await login(app, NEW_PASSWORD)).response.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test('a login racing password replacement cannot leave an old-password session alive', async () => {
  await withAuth(async (dataDir) => {
    const app = await buildServer({ dataDir, origin: ORIGIN });
    try {
      const owner = await login(app);
      assert.ok(owner.authCookie);
      const contender = await csrf(app);

      const changing = app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: `${owner.authCookie}; ${owner.csrf.cookie}`,
          'x-csrf-token': owner.csrf.token,
        },
        payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      });
      const racing = login(app, OLD_PASSWORD, contender);
      const [changed, racedLogin] = await Promise.all([changing, racing]);
      assert.equal(changed.statusCode, 200);

      if (racedLogin.authCookie) {
        const useRacedSession = await app.inject({
          url: '/api/settings', headers: { host: HOST, cookie: racedLogin.authCookie },
        });
        assert.equal(useRacedSession.statusCode, 401);
      } else {
        assert.notEqual(racedLogin.response.statusCode, 200);
      }
    } finally {
      await app.close();
    }
  });
});

test('HTTPS cookies are Secure and password verification is globally rate limited', async () => {
  await withAuth(async (dataDir) => {
    const origin = 'https://home-pc.example.test';
    const host = 'home-pc.example.test';
    const app = await buildServer({ dataDir, origin });
    try {
      const session = await csrf(app, host);
      assert.match(setCookies(session.response)[0], /; Secure(?:;|$)/);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { host, origin, cookie: session.cookie, 'x-csrf-token': session.token },
          payload: { password: 'wrong-password-value' },
        });
        assert.equal(response.statusCode, 401);
      }
      const limited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host, origin, cookie: session.cookie, 'x-csrf-token': session.token },
        payload: { password: 'wrong-password-value' },
      });
      assert.equal(limited.statusCode, 429);
      assert.match(String(limited.headers['retry-after']), /^\d+$/);
    } finally {
      await app.close();
    }
  });
});

test('session storage keeps at most 32 active sessions', async () => {
  await withAuth(async (dataDir) => {
    const auth = await openAuth(dataDir);
    try {
      const checked = await auth.verifyPassword(OLD_PASSWORD);
      assert.equal(checked.status, 'valid');
      if (checked.status !== 'valid') return;

      const sessions = Array.from({ length: 33 }, () => auth.issueSession(checked.credentialFingerprint)!);
      assert.equal(auth.authenticate(sessions[0]), false);
      assert.equal(auth.authenticate(sessions[1]), true);
      assert.equal(auth.authenticate(sessions[32]), true);

      const database = new DatabaseSync(join(dataDir, 'sessions.sqlite'));
      const count = database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      database.close();
      assert.equal(count.count, 32);
    } finally {
      auth.close();
    }
  });
});

test('password hashing admits two concurrent operations and rejects extra work', async () => {
  await withAuth(async (dataDir) => {
    const auth = await openAuth(dataDir);
    try {
      const results = await Promise.all([
        auth.verifyPassword(OLD_PASSWORD),
        auth.verifyPassword(OLD_PASSWORD),
        auth.verifyPassword(OLD_PASSWORD),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), ['busy', 'valid', 'valid']);
      assert.equal((await auth.verifyPassword(OLD_PASSWORD)).status, 'valid');
    } finally {
      auth.close();
    }
  });
});
