import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveCodexExecutable } from '../src/codex/executable.ts';

const executable = resolveCodexExecutable();
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
mkdirSync('.local', { recursive: true });
execFileSync(executable, ['app-server', 'generate-ts', '--out', '.local/protocol'], { stdio: 'inherit', windowsHide: true });
writeFileSync('.local/protocol-version.json', JSON.stringify({ version, executable, generatedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`${version} 协议已生成到 .local/protocol`);
