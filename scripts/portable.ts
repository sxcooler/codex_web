import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { managedServer, runServer, startBackground, stopServer } from './server-control.ts';
import { configuredOrigins, optionalDomain } from '../src/server/origins.ts';

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
const windows = process.platform === 'win32';
const launcher = windows ? 'Start.cmd' : 'bash Start.sh';
const executableName = windows ? 'codex.exe' : 'codex';
const installerUrl = 'https://chatgpt.com/codex/' + (windows ? 'install.ps1' : 'install.sh');
type Terminal = { question(prompt: string): Promise<string> };

async function verifiedCodex(path: string): Promise<string | undefined> {
  const executable = resolve(path.trim().replace(/^"|"$/g, ''));
  if (windows !== executable.toLowerCase().endsWith('.exe') || !(await stat(executable).catch(() => null))?.isFile()) return;
  const result = childProcess.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false });
  if (!result.error && result.status === 0 && /^codex(?:-cli)?\s+\S/m.test(result.stdout)) return executable;
}

export async function discoverPortableCodex(configured?: string): Promise<string | undefined> {
  const official = windows ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', executableName) : join(homedir(), '.local', 'bin', executableName);
  const candidates = [configured, official, process.env.CODEX_INSTALL_DIR && join(process.env.CODEX_INSTALL_DIR, executableName),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory.replace(/^"|"$/g, ''), executableName))];
  for (const candidate of new Set(candidates)) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const executable = await verifiedCodex(candidate);
    if (executable) return executable;
  }
}

function openBrowser(url: string) {
  try {
    const browser = childProcess.spawn(windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe') : 'xdg-open', windows ? ['url.dll,FileProtocolHandler', url] : [url], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    browser.on('error', () => process.stdout.write(`请手动打开：${url}\n`)); browser.unref();
  } catch { process.stdout.write(`请手动打开：${url}\n`); }
}

async function chooseCodex(terminal: Terminal): Promise<string> {
  while (true) {
    process.stdout.write(`未找到可用的 Codex CLI。官方安装说明：${installPage}\n1. 打开官方安装页面，手动安装（默认）\n2. 同意下载并运行 Codex 官方安装脚本\n3. 指定已安装的 Codex 可执行文件\n0. 退出\n选项 2 会联网下载并执行 ${installerUrl}，在当前用户下安装，安装器可能更新用户 PATH。\n`);
    let choice = (await terminal.question('请选择 [1]: ')).trim() || '1';
    if (choice === '1') {
      openBrowser(installPage);
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
      const executable = await verifiedCodex(await terminal.question('Codex 可执行文件完整路径: '));
      if (executable) return executable;
      process.stdout.write('该路径不是当前平台可运行的 Codex CLI，请重新选择。\n');
    } else if (choice === '2') {
      const env = { ...process.env };
      delete env.CODEX_NON_INTERACTIVE;
      try {
        const result = childProcess.spawnSync(windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'bash',
          windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'; Invoke-RestMethod -Uri '${installerUrl}' | Invoke-Expression`] : ['-c', `set -o pipefail; curl --fail --silent --show-error --location '${installerUrl}' | sh`],
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
    if (!terminal && !process.stdin.isTTY) throw new Error(`请运行 ${launcher}，在交互终端完成配置或修复 Codex CLI 路径；不会自动安装。`);
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
    for (;;) {
      try {
        const domain = optionalDomain(await terminal!.question('额外绑定域名（可选，回车跳过；裸域名默认 HTTPS）: '));
        if (domain) {
          config.allowedOrigins = configuredOrigins(config.origin,[domain]).slice(1).map(url=>url.origin);
          process.stdout.write(`将允许额外地址 ${domain}；仍需自行配置 DNS 和 HTTPS 代理，转发到本地端口 ${port}。\n`);
        }
        break;
      } catch { process.stdout.write('请输入域名或完整 HTTP/HTTPS 站点地址，不含路径、通配符或账号密码。\n'); }
    }
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

export async function launchPreference(config: { background?: boolean }, terminal?: Terminal, force = false): Promise<boolean> {
  if (typeof config.background === 'boolean' && !force) return config.background;
  if (!terminal) return false; // An unattended upgrade must not silently change foreground behavior.
  for (;;) {
    const choice = (await terminal.question('以后启动后是否自动转入后台？[Y/n]（登录自启另行设置）: ')).trim().toLowerCase();
    if (choice === '' || choice === 'y' || choice === 'yes') return true;
    if (choice === 'n' || choice === 'no') return false;
    process.stdout.write('请输入 Y 或 N。\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--no-browser', '--foreground', '--background', '--configure-startup', '--stop', '--status', '--diagnostics'].includes(arg)) || (args.includes('--foreground') && args.includes('--background')) || (args.includes('--stop') && args.includes('--status'))) throw new Error('支持 --no-browser / --foreground / --background / --configure-startup / --stop / --status / --diagnostics。');
  if (args.includes('--stop')) return stopServer();
  if (args.includes('--status')) { const state = await managedServer(); process.stdout.write(state ? `运行中：${state.origin}（diagnostics: ${state.diagnosticsEnabled?'on':'off'}）\n` : '没有由此入口管理的运行实例。\n'); return; }
  if (args.includes('--configure-startup') && !process.stdin.isTTY) throw new Error('请在交互终端修改启动偏好。');
  const dataDir = join(root, '.local', 'web');
  const config = await loadPortableConfig(dataDir);
  const port = parsePort(String(config.port ?? 3000)), [origin] = configuredOrigins(config.origin,config.allowedOrigins);
  if (!(await stat(config.workRoot).catch(() => null))?.isDirectory()) throw new Error('工作目录不存在，请检查 .local/web/config.json。');
  if (!(await stat(config.codexBin).catch(() => null))?.isFile()) throw new Error('Codex 路径不存在，请检查 .local/web/config.json。');
  const existing = await managedServer();
  if (existing && args.includes('--diagnostics') && !existing.diagnosticsEnabled) throw new Error('服务正在运行但未开启诊断；请停止后带 --diagnostics 重新启动。');
  if (!existing && !await portAvailable(port)) throw new Error(`端口 ${port} 已占用，可能已经启动；打开 ${origin.origin}，或修改配置的 port 和 origin。`);
  if (!await exists(join(dataDir, 'auth.json'))) {
    process.stdout.write('请设置本机 Web 管理员密码（输入时不显示）。\n');
    const result = childProcess.spawnSync(process.execPath, [join(root, 'scripts', 'setup-auth.ts')], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`密码初始化未完成，请重新运行 ${launcher}。`);
  }
  if ((typeof config.background !== 'boolean' || args.includes('--configure-startup')) && process.stdin.isTTY && !args.includes('--foreground') && !args.includes('--background')) {
    const terminal: Terminal = { async question(prompt) { const reader = createInterface({input:process.stdin,output:process.stdout}); try { return await reader.question(prompt); } finally { reader.close(); } } };
    config.background = await launchPreference(config, terminal, args.includes('--configure-startup'));
    await writeFile(join(dataDir,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
  }
  const background = args.includes('--background') || (!args.includes('--foreground') && await launchPreference(config));
  if (!existing) {
    if (background) await startBackground(true,args.includes('--diagnostics'));
    else await runServer(true,args.includes('--diagnostics'));
  }
  const url = existing?.origin ?? origin.origin;
  process.stdout.write(existing ? `服务已在运行：${url}\n` : `服务已启动：${url}\n${background?'启动窗口可以关闭；使用 Stop 入口停止。':'保持窗口打开；Ctrl+C 停止。'}\n`);
  if (!args.includes('--no-browser')) openBrowser(url);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : '启动失败'}\n`); process.exitCode = 1; });
}
