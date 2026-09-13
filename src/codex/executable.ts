import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultCodexExecutable(platform: string = process.platform): string {
  return platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : 'codex';
}

export function resolveCodexExecutable(configured?: string): string {
  return process.env.CODEX_BIN ?? configured ?? defaultCodexExecutable();
}
