import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import childProcess from 'node:child_process';
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
const installPage = 'https://learn.chatgpt.com/docs/codex/cli';
const installerUrl = 'https://chatgpt.com/codex/install.ps1';
type Terminal = { question(prompt: string): Promise<string> };

async function verifiedCodex(path: string): Promise<string | undefined> {
  const executable = resolve(path.trim().replace(/^"|"$/g, ''));
  if (!executable.toLowerCase().endsWith('.exe') || !(await stat(executable).catch(() => null))?.isFile()) return;
  const result = childProcess.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false });
  if (!result.error && result.status === 0 && /^codex(?:-cli)?\s+\S/m.test(result.stdout)) return executable;
}

export async function discoverPortableCodex(configured?: string): Promise<string | undefined> {
  const official = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const candidates = [configured, official, process.env.CODEX_INSTALL_DIR && join(process.env.CODEX_INSTALL_DIR, 'codex.exe'),
    ...(process.env.PATH ?? '').split(';').filter(Boolean).map(directory => join(directory.replace(/^"|"$/g, ''), 'codex.exe'))];
  for (const candidate of new Set(candidates)) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const executable = await verifiedCodex(candidate);
    if (executable) return executable;
  }
}

function openInstallPage() {
  try {
    const browser = childProcess.spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', installPage], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    browser.on('error', () => process.stdout.write(`请手动打开：${installPage}\n`)); browser.unref();
  } catch { process.stdout.write(`请手动打开：${installPage}\n`); }
}

async function chooseCodex(terminal: Terminal): Promise<string> {
  while (true) {
    process.stdout.write(`未找到可用的 Codex CLI。官方安装说明：${installPage}\n1. 打开官方安装页面，手动安装（默认）\n2. 同意下载并运行 Codex 官方安装脚本\n3. 指定已安装的 Codex 可执行文件\n0. 退出\n选项 2 会联网下载并执行 ${installerUrl}，在当前用户下安装，安装器可能更新用户 PATH。\n`);
    let choice = (await terminal.question('请选择 [1]: ')).trim() || '1';
    if (choice === '1') {
      openInstallPage();
      choice = (await terminal.question('手动安装完成后：回车重新检测 / 3 指定路径 / 0 退出: ')).trim();
      if (!choice) {
        const executable = await discoverPortableCodex();
        if (executable) return executable;
        continue;
      }
      // The manual-install submenu cannot grant consent to run the installer.
      if (choice !== '0' && choice !== '3') continue;
    }
    if (choice === '0') throw new Error('已退出配置；已有配置保持不变。');
    if (choice === '3') {
      const executable = await verifiedCodex(await terminal.question('Codex .exe 完整路径: '));
      if (executable) return executable;
      process.stdout.write('该路径不是可运行的 Codex .exe，请重新选择。\n');
    } else if (choice === '2') {
      const env = { ...process.env };
      delete env.CODEX_NON_INTERACTIVE;
      try {
        const result = childProcess.spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'; Invoke-RestMethod -Uri '${installerUrl}' | Invoke-Expression`],
          { stdio: 'inherit', windowsHide: true, shell: false, env });
        if (result.error || result.status !== 0) throw new Error('安装器失败或已取消。');
        const executable = await discoverPortableCodex();
        if (executable) {
          process.stdout.write('Codex CLI 已安装并通过版本验证。账户登录需另行通过 Codex 官方流程完成。\n');
          return executable;
        }
        process.stdout.write('安装器已结束，但尚未找到可用 CLI；可重新检测或指定路径。\n');
      } catch (error) { process.stdout.write(`${error instanceof Error ? error.message : '安装失败'} 已保留本次输入，请重新选择。\n`); }
    }
  }
}

export async function loadPortableConfig(dataDir: string, terminal?: Terminal) {
  const configPath = join(dataDir, 'config.json');
  await mkdir(dataDir, { recursive: true });
  const saved = await exists(configPath) ? JSON.parse(await readFile(configPath, 'utf8')) : undefined;
  const detected = await discoverPortableCodex(saved?.codexBin);
  if (!saved || !detected) {
    if (!terminal && !process.stdin.isTTY) throw new Error('请双击 Start.cmd，在交互终端完成配置或修复 Codex CLI 路径；不会自动安装。');
    // Release stdin and raw mode before an interactive child installer runs.
    terminal ??= { async question(prompt) {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { return await reader.question(prompt); } finally { reader.close(); }
    } };
  }
  let config = saved;
  if (!config) {
    process.stdout.write('Codex Web · 首次配置\nNode 已包含。CLI 安装与账户登录分别完成。\n');
    const workRoot = resolve((await terminal!.question(`工作目录 [${join(homedir(), 'work')}]: `)).trim() || join(homedir(), 'work'));
    const port = parsePort((await terminal!.question('本地端口 [3000]: ')).trim() || '3000');
    config = { origin: `http://localhost:${port}`, port, workRoot };
  }
  const codexBin = detected ?? await chooseCodex(terminal!);
  if (!saved) {
    if (!await portAvailable(config.port)) throw new Error(`端口 ${config.port} 已占用；请重新启动并选择其他端口。`);
    await mkdir(config.workRoot, { recursive: true });
  }
  if (config.codexBin !== codexBin) {
    config.codexBin = codexBin;
    await writeFile(configPath, JSON.stringify(config, null, 2), { flag: saved ? 'w' : 'wx', mode: 0o600 });
  }
  return config;
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--no-browser')) throw new Error('仅支持 --no-browser 参数。');
  const dataDir = join(root, '.local', 'web');
  const config = await loadPortableConfig(dataDir);
  const port = parsePort(String(config.port ?? 3000)), origin = new URL(config.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('origin 必须是 HTTP/HTTPS 站点根地址。');
  if (!(await stat(config.workRoot).catch(() => null))?.isDirectory()) throw new Error('工作目录不存在，请检查 .local/web/config.json。');
  if (!(await stat(config.codexBin).catch(() => null))?.isFile()) throw new Error('Codex 路径不存在，请检查 .local/web/config.json。');
  if (!await portAvailable(port)) throw new Error(`端口 ${port} 已占用，可能已经启动；打开 ${origin.origin}，或修改配置的 port 和 origin。`);
  if (!await exists(join(dataDir, 'auth.json'))) {
    process.stdout.write('请设置本机 Web 管理员密码（输入时不显示）。\n');
    const result = childProcess.spawnSync(process.execPath, [join(root, 'scripts', 'setup-auth.ts')], { stdio: 'inherit', windowsHide: true });
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
        const browser = childProcess.spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', origin.origin], { detached: true, stdio: 'ignore', windowsHide: true });
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
