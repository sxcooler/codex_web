import { randomBytes, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { openAuth } from './auth.ts';
import { registerApi } from './api.ts';
import type { Runtime } from '../codex/runtime.ts';
import type { Projects } from '../projects.ts';
import { registerStatic } from './static.ts';
import { registerResponseHooks } from './response.ts';
import { createUploadService, registerUploadRoutes } from './uploads.ts';
import { createPushService, registerPushRoutes } from './push.ts';

const CSRF_COOKIE = 'codex_csrf';
const SESSION_COOKIE = 'codex_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_ROUTES = new Set(['/api/auth/session', '/api/auth/login']);

type AuthCookies = { csrf?: string; session?: string };

function configuredOrigin(origin: string): URL {
  const url = new URL(origin);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('WEB_ORIGIN must be an HTTP or HTTPS origin');
  }
  return url;
}

function parseCookies(header: string | undefined): AuthCookies {
  const cookies: AuthCookies = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== CSRF_COOKIE && name !== SESSION_COOKIE) continue;
    const field = name === CSRF_COOKIE ? 'csrf' : 'session';
    if (cookies[field] !== undefined) throw new Error('Duplicate authentication cookie');
    const value = part.slice(separator + 1).trim();
    if (!TOKEN_PATTERN.test(value)) throw new Error('Invalid authentication cookie');
    cookies[field] = value;
  }
  return cookies;
}

function tokenHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : undefined;
}

function sameToken(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function cookieValue(name: string, value: string, secure: boolean, clear = false): string {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
}

function setCookie(reply: FastifyReply, name: string, value: string, secure: boolean, clear = false): void {
  reply.header('set-cookie', cookieValue(name, value, secure, clear));
}

function matchedApiRoute(request: FastifyRequest): string | undefined {
  const route = request.routeOptions.url;
  return route?.startsWith('/api/') ? route : undefined;
}

function passwordSchema(properties: Record<string, unknown>) {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    },
  };
}

const passwordField = { type: 'string', minLength: 12, maxLength: 256 };

export async function buildServer(options: { dataDir: string; origin: string; runtime?: Runtime; projects?: Projects; distDir?: string }): Promise<FastifyInstance> {
  const origin = configuredOrigin(options.origin);
  const auth = await openAuth(options.dataDir);
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024, // 12,000 Unicode characters plus JSON escaping and envelope.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  registerResponseHooks(app);
  const requestCookies = new WeakMap<FastifyRequest, AuthCookies>();
  const authenticatedTokens = new WeakMap<FastifyRequest, string>();
  // ponytail: one process-wide window shares the single administrator's quota; add per-account limits only with multi-user auth.
  let rateWindowStarted = Date.now();
  let passwordChecks = 0;
  let closeInvalidStreams = () => {};
  let pruneSubscriptions: () => Promise<unknown> = async () => {};

  function consumePasswordCheck(reply: FastifyReply): boolean {
    const now = Date.now();
    if (now - rateWindowStarted >= 60_000) {
      rateWindowStarted = now;
      passwordChecks = 0;
    }
    if (passwordChecks >= 5) {
      reply.header('retry-after', String(Math.max(1, Math.ceil((60_000 - (now - rateWindowStarted)) / 1_000))));
      reply.code(429).send({ error: 'Too many password attempts' });
      return false;
    }
    passwordChecks += 1;
    return true;
  }

  app.addHook('onClose', async () => auth.close());
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (matchedApiRoute(request)) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== origin.host) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    let cookies: AuthCookies;
    try {
      cookies = parseCookies(request.headers.cookie);
    } catch {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    requestCookies.set(request, cookies);

    if (!['GET', 'HEAD'].includes(request.method)) {
      const csrfHeader = tokenHeader(request.headers['x-csrf-token']);
      if (request.headers.origin !== origin.origin || !sameToken(cookies.csrf, csrfHeader)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
    }

    const route = matchedApiRoute(request);
    if (route && !PUBLIC_ROUTES.has(route)) {
      if (!cookies.session || !auth.authenticate(cookies.session)) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      authenticatedTokens.set(request, cookies.session);
    }
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'File too large' });
    if (error.validation || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 400) {
      return reply.code(400).send({ error: 'Invalid request' });
    }
    if (['PROJECT_ERROR', 'RUNTIME_ERROR', 'UPLOAD_ERROR', 'PUSH_ERROR', 'REPORT_ERROR'].includes(error.code ?? '') || error.code?.startsWith('RUNTIME_') || error.code?.startsWith('ACCOUNT_')) {
      return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code, partial: (error as any).partial });
    }
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }));

  app.get('/api/auth/session', async (request, reply) => {
    const cookies = requestCookies.get(request) ?? {};
    const csrfToken = cookies.csrf ?? randomBytes(32).toString('base64url');
    if (!cookies.csrf) setCookie(reply, CSRF_COOKIE, csrfToken, origin.protocol === 'https:');
    return { authenticated: auth.authenticate(cookies.session), csrfToken };
  });

  app.post(
    '/api/auth/login',
    { schema: passwordSchema({ password: passwordField }) },
    async (request, reply) => {
      if (!consumePasswordCheck(reply)) return;
      const body = request.body as { password: string };
      const checked = await auth.verifyPassword(body.password);
      if (checked.status === 'busy') {
        return reply.header('retry-after', '1').code(503).send({ error: 'Password service busy' });
      }
      if (checked.status !== 'valid') return reply.code(401).send({ error: 'Invalid credentials' });

      const session = auth.issueSession(checked.credentialFingerprint, requestCookies.get(request)?.session);
      closeInvalidStreams();
      await pruneSubscriptions().catch(() => {});
      if (!session) return reply.code(401).send({ error: 'Invalid credentials' });
      setCookie(reply, SESSION_COOKIE, session, origin.protocol === 'https:');
      return { authenticated: true };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    auth.revokeSession(authenticatedTokens.get(request)!);
    options.runtime?.emit('accountChanged');
    closeInvalidStreams();
    await pruneSubscriptions().catch(() => {});
    setCookie(reply, SESSION_COOKIE, '', origin.protocol === 'https:', true);
    return { authenticated: false };
  });

  app.post(
    '/api/auth/password',
    { schema: passwordSchema({ currentPassword: passwordField, newPassword: passwordField }) },
    async (request, reply) => {
      if (!consumePasswordCheck(reply)) return;
      const body = request.body as { currentPassword: string; newPassword: string };
      const changed = await auth.changePassword(body.currentPassword, body.newPassword);
      if (changed.status === 'busy') {
        return reply.header('retry-after', '1').code(503).send({ error: 'Password service busy' });
      }
      if (changed.status === 'conflict') return reply.code(409).send({ error: 'Password changed concurrently' });
      if (changed.status === 'invalid') return reply.code(401).send({ error: 'Invalid credentials' });
      closeInvalidStreams();
      await pruneSubscriptions().catch(() => {});
      setCookie(reply, SESSION_COOKIE, '', origin.protocol === 'https:', true);
      return { authenticated: false };
    },
  );

  app.get('/api/settings', async () => ({ origin: origin.origin, nodeVersion: process.version,
    workRoot: options.projects?.root, runtime: options.runtime ? await options.runtime.diagnostics() : undefined }));
  try {
  if (options.runtime && options.projects) {
    const uploads = await createUploadService({dataDir:options.dataDir});
    app.addHook('onClose',async()=>uploads.close());
    const access={authenticated:(request:FastifyRequest)=>auth.authenticate(authenticatedTokens.get(request)),owner:(request:FastifyRequest)=>auth.sessionId(authenticatedTokens.get(request)!)};
    // This application has one administrator; attachments survive login renewal and password changes.
    const uploadAccess={...access,owner:(_request:FastifyRequest)=>'administrator'};
    await registerUploadRoutes(app,uploads,uploadAccess);
    const push=await createPushService({dataDir:options.dataDir,origin:origin.origin,sessionValid:id=>auth.authenticateSessionId(id)});
    app.addHook('onClose',async()=>push.close());
    pruneSubscriptions=()=>push.pruneInvalid();
    registerPushRoutes(app,push,access);
    const jobs=new Set<Promise<unknown>>();let closing=false;
    const notify=(event:any)=>{if(closing)return;const job=push.notify(event).catch(()=>{});jobs.add(job);void job.finally(()=>jobs.delete(job));};
    options.runtime.on('notification',notify);
    const cleanup=setInterval(()=>{if(!closing)void uploads.cleanup().catch(()=>{});},60*60_000);cleanup.unref();
    app.addHook('preClose',async()=>{closing=true;clearInterval(cleanup);options.runtime!.off('notification',notify);await Promise.allSettled([...jobs]);});
    const api = registerApi(app, { dataDir: options.dataDir, runtime: options.runtime, projects: options.projects,
      authenticated: request => { const token = authenticatedTokens.get(request); return () => auth.authenticate(token); },
      uploads,uploadOwner:uploadAccess.owner,
    });
    closeInvalidStreams = api.closeInvalid;
  }
  if (options.distDir) registerStatic(app, options.distDir);

  return app;
  } catch(error) { await app.close(); throw error; }
}
