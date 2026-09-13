import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const executable = process.env.CODEX_BIN ?? resolve(homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (version !== 'codex-cli 0.153.4') throw new Error(`需要先审阅新版本协议：${version}（基线 0.153.4）`);
mkdirSync('.local', { recursive: true });
execFileSync(executable, ['app-server', 'generate-ts', '--out', '.local/protocol'], { stdio: 'inherit', windowsHide: true });
writeFileSync('.local/protocol-version.json', JSON.stringify({ version, executable, generatedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`${version} 协议已生成到 .local/protocol`);
