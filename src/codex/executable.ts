import { homedir } from 'node:os';
import { join } from 'node:path';

export const minimumCodexVersion = '0.160.1';
export const codexUpgradeMessage = `需要 Codex CLI >= ${minimumCodexVersion}；请独立升级 Codex CLI，并用 codex --version 核对后再启动或更新 Codex Web。应用更新不会升级 CLI。`;
export function assertCodexVersion(output: string): void {
  const match = /^codex(?:-cli)?[ \t]+(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(output.trim());
  const version = match?.slice(1, 4).map(Number) ?? [];
  const [major, minor, patch] = version, [requiredMajor, requiredMinor, requiredPatch] = minimumCodexVersion.split('.').map(Number);
  if (version.length !== 3 || !version.every(Number.isSafeInteger) || !(major > requiredMajor || major === requiredMajor && (minor > requiredMinor || minor === requiredMinor && patch >= requiredPatch))) {
    throw Object.assign(new Error(codexUpgradeMessage), {code: 'CODEX_CLI_VERSION_REQUIRED'});
  }
}

export function defaultCodexExecutable(platform: string = process.platform): string {
  return platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : 'codex';
}

export function resolveCodexExecutable(configured?: string): string {
  return process.env.CODEX_BIN ?? configured ?? defaultCodexExecutable();
}
