import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
export function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('端口必须在 1–65535 之间。');
  return Number(value);
}
export async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createServer(); socket.once('error', () => resolve(false));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
}
const exists = async (path: string) => access(path).then(() => true, () => false);
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--no-browser')) throw new Error('仅支持 --no-browser 参数。');
  const dataDir = join(root, '.local', 'web'), configPath = join(dataDir, 'config.json');
  await mkdir(dataDir, { recursive: true });
  if (!await exists(configPath)) {
    if (!process.stdin.isTTY) throw new Error('首次使用请双击 Start.cmd，在终端完成配置。');
    process.stdout.write('Codex Remote Web · 首次配置\nNode 已包含。请先安装 Codex 并使用自己的账户登录。\n');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const workRoot = resolve((await terminal.question(`工作目录 [${join(homedir(), 'work')}]: `)).trim() || join(homedir(), 'work'));
      const defaultCodex = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      const codexBin = resolve(((await terminal.question(`Codex 可执行文件 [${defaultCodex}]: `)).trim() || defaultCodex).replace(/^"|"$/g, ''));
      if (!(await stat(codexBin).catch(() => null))?.isFile() || !codexBin.toLowerCase().endsWith('.exe')) throw new Error('找不到 Codex .exe；安装并登录后重新运行，或输入正确路径。');
      const port = parsePort((await terminal.question('本地端口 [3000]: ')).trim() || '3000');
      if (!await portAvailable(port)) throw new Error(`端口 ${port} 已占用；请重新启动并选择其他端口。`);
      await mkdir(workRoot, { recursive: true });
      await writeFile(configPath, JSON.stringify({ origin: `http://localhost:${port}`, port, workRoot, codexBin }, null, 2), { flag: 'wx', mode: 0o600 });
    } finally { terminal.close(); }
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const port = parsePort(String(config.port ?? 3000)), origin = new URL(config.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('origin 必须是 HTTP/HTTPS 站点根地址。');
  if (!(await stat(config.workRoot).catch(() => null))?.isDirectory()) throw new Error('工作目录不存在，请检查 .local/web/config.json。');
  if (!(await stat(config.codexBin).catch(() => null))?.isFile()) throw new Error('Codex 路径不存在，请检查 .local/web/config.json。');
  if (!await portAvailable(port)) throw new Error(`端口 ${port} 已占用，可能已经启动；打开 ${origin.origin}，或修改配置的 port 和 origin。`);
  if (!await exists(join(dataDir, 'auth.json'))) {
    process.stdout.write('请设置本机 Web 管理员密码（输入时不显示）。\n');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'setup-auth.ts')], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('密码初始化未完成，请重新运行 Start.cmd。');
  }
  // Portable mode uses its own configuration, never inherited developer overrides.
  for (const key of ['WEB_ORIGIN', 'PORT', 'WORK_ROOT', 'CODEX_BIN']) delete process.env[key];
  process.env.WEB_DATA_DIR = dataDir;
  await import('../src/server/main.ts');
  const { request } = await import('node:http');
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await new Promise<boolean>(resolve => {
      const req = request({ hostname: '127.0.0.1', port, path: '/api/auth/session', headers: { Host: origin.host }, timeout: 500 }, response => { response.resume(); resolve(response.statusCode === 200); });
      req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end();
    });
    if (ready) {
      process.stdout.write(`服务已启动：${origin.origin}\n保持窗口打开；Ctrl+C 停止。用户数据位于 .local/web，分享时请使用原始发布 ZIP。\n`);
      if (!process.argv.includes('--no-browser') && process.platform === 'win32') {
        const browser = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', origin.origin], { detached: true, stdio: 'ignore', windowsHide: true });
        browser.on('error', () => process.stderr.write('请手动打开上面的地址。\n')); browser.unref();
      }
      return;
    }
    if (process.exitCode) return;
    await delay(200);
  }
  throw new Error('启动未完成，请查看上面的错误信息。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : '启动失败'}\n`); process.exitCode = 1; });
}
