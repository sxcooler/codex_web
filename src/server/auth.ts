import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const AUTH_FILE = 'auth.json';
const DATABASE_FILE = 'sessions.sqlite';
const SCRYPT_OPTIONS = { N: 65_536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 } as const;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const MAX_SESSIONS = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type AuthConfig = {
  version: 1;
  salt: string;
  passwordHash: string;
};

type Credentials = {
  config: AuthConfig;
  salt: Buffer;
  passwordHash: Buffer;
  fingerprint: Buffer;
  fingerprintHex: string;
};

export type PasswordCheck =
  | { status: 'valid'; credentialFingerprint: string }
  | { status: 'invalid' | 'busy' | 'changed' };

export type PasswordChange = { status: 'changed' | 'invalid' | 'busy' | 'conflict' };

function passwordLength(password: string): number {
  return Array.from(password).length;
}

function validatePassword(password: string): void {
  const length = passwordLength(password);
  if (length < 12 || length > 256) {
    throw new Error('Password must contain 12 to 256 characters');
  }
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function credentialsFromConfig(value: unknown): Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Authentication configuration is invalid');
  }
  const candidate = value as Partial<AuthConfig>;
  if (candidate.version !== 1 || typeof candidate.salt !== 'string' || typeof candidate.passwordHash !== 'string') {
    throw new Error('Authentication configuration is invalid');
  }

  const salt = Buffer.from(candidate.salt, 'base64url');
  const passwordHash = Buffer.from(candidate.passwordHash, 'base64url');
  if (salt.length !== 16 || passwordHash.length !== 32) {
    throw new Error('Authentication configuration is invalid');
  }

  const fingerprint = createHash('sha256').update(salt).update(passwordHash).digest();
  return {
    config: { version: 1, salt: candidate.salt, passwordHash: candidate.passwordHash },
    salt,
    passwordHash,
    fingerprint,
    fingerprintHex: fingerprint.toString('hex'),
  };
}

async function createCredentials(password: string): Promise<Credentials> {
  validatePassword(password);
  const salt = randomBytes(16);
  const passwordHash = await derivePassword(password, salt);
  return credentialsFromConfig({
    version: 1,
    salt: salt.toString('base64url'),
    passwordHash: passwordHash.toString('base64url'),
  });
}

function serializedConfig(credentials: Credentials): string {
  return `${JSON.stringify(credentials.config)}\n`;
}

async function readCredentials(dataDir: string): Promise<Credentials> {
  try {
    return credentialsFromConfig(JSON.parse(await readFile(join(dataDir, AUTH_FILE), 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication configuration is invalid') throw error;
    throw new Error('Authentication is not initialized');
  }
}

async function replaceCredentials(dataDir: string, credentials: Credentials): Promise<void> {
  const temporary = join(dataDir, `${AUTH_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serializedConfig(credentials), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, join(dataDir, AUTH_FILE));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function initializeAuth(dataDir: string, password: string): Promise<void> {
  const credentials = await createCredentials(password);
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, AUTH_FILE);
  let handle;
  let created = false;
  try {
    handle = await open(path, 'wx', 0o600);
    created = true;
    await handle.writeFile(serializedConfig(credentials), 'utf8');
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) await unlink(path).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Authentication is already initialized');
    throw error;
  } finally {
    await handle?.close();
  }
}

function sessionHash(token: string, credentials: Credentials): string {
  return createHash('sha256')
    .update(Buffer.from(token, 'base64url'))
    .update(credentials.fingerprint)
    .digest('hex');
}

export class AuthStore {
  readonly #dataDir: string;
  readonly #database: DatabaseSync;
  #credentials: Credentials;
  #activeHashes = 0;
  #changingPassword = false;

  constructor(dataDir: string, database: DatabaseSync, credentials: Credentials) {
    this.#dataDir = dataDir;
    this.#database = database;
    this.#credentials = credentials;
  }

  async #deriveLimited(password: string, salt: Buffer): Promise<Buffer | undefined> {
    if (this.#activeHashes >= 2) return undefined;
    this.#activeHashes += 1;
    try {
      return await derivePassword(password, salt);
    } finally {
      this.#activeHashes -= 1;
    }
  }

  async verifyPassword(password: string): Promise<PasswordCheck> {
    validatePassword(password);
    if (this.#changingPassword) return { status: 'changed' };
    const credentials = this.#credentials;
    const derived = await this.#deriveLimited(password, credentials.salt);
    if (!derived) return { status: 'busy' };
    if (!timingSafeEqual(derived, credentials.passwordHash)) return { status: 'invalid' };
    if (this.#changingPassword || credentials.fingerprintHex !== this.#credentials.fingerprintHex) {
      return { status: 'changed' };
    }
    return { status: 'valid', credentialFingerprint: credentials.fingerprintHex };
  }

  authenticate(token: string | undefined): boolean {
    if (!token || !TOKEN_PATTERN.test(token)) return false;
    const tokenHash = sessionHash(token, this.#credentials);
    return this.authenticateSessionId(tokenHash);
  }

  sessionId(token: string): string {
    if (!TOKEN_PATTERN.test(token)) throw new Error('Invalid session token');
    return sessionHash(token, this.#credentials);
  }

  authenticateSessionId(tokenHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return false;
    const row = this.#database.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { expires_at: number }
      | undefined;
    if (!row) return false;
    if (row.expires_at <= Date.now()) {
      this.#database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return false;
    }
    return true;
  }

  issueSession(credentialFingerprint: string, replacedToken?: string): string | undefined {
    if (this.#changingPassword || credentialFingerprint !== this.#credentials.fingerprintHex) return undefined;
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const tokenHash = sessionHash(token, this.#credentials);

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      if (replacedToken && TOKEN_PATTERN.test(replacedToken)) {
        this.#database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(replacedToken, this.#credentials));
      }
      const count = (this.#database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
      if (count >= MAX_SESSIONS) {
        this.#database.prepare(
          'DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions ORDER BY created_at, rowid LIMIT ?)',
        ).run(count - MAX_SESSIONS + 1);
      }
      this.#database.prepare(
        'INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)',
      ).run(tokenHash, now + SESSION_LIFETIME_MS, now);
      this.#database.exec('COMMIT');
      return token;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  revokeSession(token: string): void {
    if (!TOKEN_PATTERN.test(token)) return;
    this.#database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(token, this.#credentials));
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<PasswordChange> {
    validatePassword(currentPassword);
    validatePassword(newPassword);
    if (this.#changingPassword) return { status: 'conflict' };
    this.#changingPassword = true;
    const previous = this.#credentials;
    try {
      const currentHash = await this.#deriveLimited(currentPassword, previous.salt);
      if (!currentHash) return { status: 'busy' };
      if (!timingSafeEqual(currentHash, previous.passwordHash)) return { status: 'invalid' };

      const salt = randomBytes(16);
      const newHash = await this.#deriveLimited(newPassword, salt);
      if (!newHash) return { status: 'busy' };
      if (previous.fingerprintHex !== this.#credentials.fingerprintHex) return { status: 'conflict' };
      const next = credentialsFromConfig({
        version: 1,
        salt: salt.toString('base64url'),
        passwordHash: newHash.toString('base64url'),
      });
      await replaceCredentials(this.#dataDir, next);
      this.#credentials = next;
      this.#database.exec('DELETE FROM sessions');
      return { status: 'changed' };
    } finally {
      this.#changingPassword = false;
    }
  }

  close(): void {
    this.#database.close();
  }
}

export async function openAuth(dataDir: string): Promise<AuthStore> {
  const credentials = await readCredentials(dataDir);
  await mkdir(dataDir, { recursive: true });
  const databasePath = join(dataDir, DATABASE_FILE);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    await chmod(databasePath, 0o600);
    return new AuthStore(dataDir, database, credentials);
  } catch (error) {
    database.close();
    throw error;
  }
}
