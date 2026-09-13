import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import { initializeAuth } from '../src/server/auth.ts';

function readHiddenPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let password = '';
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    process.stderr.write('New administrator password (12–256 characters, input hidden): ');

    const finish = (error?: Error) => {
      input.off('keypress', onKeypress);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(password);
    };
    const onKeypress = (text: string, key: { ctrl?: boolean; meta?: boolean; name?: string }) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        password = Array.from(password).slice(0, -1).join('');
      } else if (text && !key.ctrl && !key.meta && password.length <= 1_024) {
        password += text;
      }
    };
    input.on('keypress', onKeypress);
  });
}

async function readPipedPassword(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let password = '';
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 1_024) throw new Error('Password input is too long');
  }
  return password.replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Password arguments are forbidden');
  const password = process.stdin.isTTY ? await readHiddenPassword() : await readPipedPassword();
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  await initializeAuth(join(projectRoot, '.local', 'web'), password);
  process.stdout.write('Authentication initialized.\n');
}

main().catch((error) => {
  const known: Record<string,string> = {
    'Authentication is already initialized': 'Authentication is already initialized; use Settings to change the password.',
    'Password must contain 12 to 256 characters': 'Password must contain 12 to 256 characters. Please run setup again.',
    'Password input is too long': 'Password input is too long; use 12 to 256 characters.',
    'Password arguments are forbidden': 'Enter the password at the hidden prompt; command-line password arguments are forbidden.',
    'Cancelled': 'Authentication setup cancelled.',
  };
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = (error instanceof Error && known[error.message]) ||
    (code === 'EACCES' || code === 'EPERM' ? 'Cannot write authentication configuration. Check permissions for .local/web.' :
      'Authentication setup failed. Check terminal input and available disk space; no password is printed.');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
