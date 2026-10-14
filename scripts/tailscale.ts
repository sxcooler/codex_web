import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { configuredOrigins } from '../src/server/origins.ts';

type Terminal = { question(prompt: string): Promise<string> };
const download = 'https://tailscale.com/download';
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value: unknown) => value === undefined || value === null || (object(value) && Object.keys(value).length === 0);

function run(file: string, args: string[], interactive = false, input?: string) {
  return childProcess.spawnSync(file, args, {
    shell: false, windowsHide: true, encoding: 'utf8',
    timeout: interactive ? 600_000 : 10_000, maxBuffer: 2 * 1024 * 1024,
    stdio: interactive ? [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] : 'pipe',
    ...(input === undefined ? {} : { input }),
  });
}

const succeeded = (result: ReturnType<typeof run>) => !result.error && result.status === 0;

function findCli(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe')] : []), 'tailscale.exe']
    : ['tailscale', '/usr/bin/tailscale'];
  for (const candidate of candidates) {
    const result = run(candidate, ['--version']);
    if (succeeded(result)) return candidate;
    if (result.error?.code !== 'ENOENT') throw new Error('Tailscale CLI 检查失败；请检查权限、安装和服务状态后重试。');
  }
}

async function choose(terminal: Terminal, prompt: string): Promise<string> {
  const choice = (await terminal.question(prompt)).trim().toLowerCase();
  if (!['retry', 'install', 'up'].includes(choice)) throw new Error('Tailscale 接入已取消，Web 配置未修改。');
  return choice;
}

async function ensureCli(terminal?: Terminal): Promise<string> {
  let reason = '';
  for (;;) {
    const cli = findCli();
    if (cli) return cli;
    if (!terminal) throw new Error(`未找到 Tailscale CLI；请先手动安装 ${download} 并登录，再重试。非交互模式不会安装。`);
    const platform = process.platform;
    const choice = await choose(terminal, `${reason}未找到 Tailscale。手动下载安装并完成后输入 retry：${download}；或输入 install 明确同意系统级安装（Windows 管理员 / Linux sudo，可能要求提权）；其他输入取消：`);
    if (choice === 'retry') continue;
    if (choice !== 'install') throw new Error('Tailscale 接入已取消。');
    if (platform === 'win32') {
      const result = run('winget', ['install', '--id', 'Tailscale.Tailscale', '--exact', '--source', 'winget'], true);
      reason = succeeded(result) ? '安装命令完成；' : result.error?.code === 'ENOENT'
        ? `没有 winget；请从 ${download} 手动安装后输入 retry。` : 'winget 安装失败；请检查管理员权限，手动处理后重试，或重新明确选择 install。';
    } else if (platform === 'linux') {
      // Download first: a failed curl must never be mistaken for a successful shell install.
      const script = run('curl', ['--fail', '--show-error', '--silent', '--location', 'https://tailscale.com/install.sh']);
      reason = succeeded(script) && typeof script.stdout === 'string' && script.stdout.length > 0 && succeeded(run('sh', [], true, script.stdout))
        ? '安装命令完成；' : '官方安装脚本下载或安装失败；请检查网络与 sudo 权限，手动处理后重试，或重新明确选择 install。';
    } else throw new Error(`此平台请手动安装 Tailscale：${download}`);
  }
}

async function readDns(cli: string, terminal?: Terminal): Promise<string> {
  let reason = '';
  for (;;) {
    const result = run(cli, ['status', '--json']);
    let status: unknown;
    if (result.error) throw new Error('Tailscale status 命令失败或超时，请检查本机服务。');
    try { status = JSON.parse(String(result.stdout)); } catch { throw new Error('Tailscale status 返回无效 JSON，请检查本机服务。'); }
    if (!object(status) || typeof status.BackendState !== 'string' || !['NoState', 'InUseOtherUser', 'NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'Starting', 'Running'].includes(status.BackendState)) throw new Error('Tailscale 状态 JSON 无效。');
    if (status.BackendState === 'Running') {
      if (!succeeded(result)) throw new Error('Tailscale status 命令失败，请检查本机服务。');
      const raw = object(status.Self) ? status.Self.DNSName : undefined;
      const dns = typeof raw === 'string' ? raw.replace(/\.$/, '').toLowerCase() : '';
      if (dns.length > 253 || !dns.endsWith('.ts.net') || !dns.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Tailscale DNSName 无效；需要合法的 ts.net MagicDNS 主机名。');
      return dns;
    }
    if (status.BackendState === 'InUseOtherUser') throw new Error('Tailscale 正由其他用户使用；请手动处理，本工具不会切换账号。');
    if (!terminal) throw new Error('Tailscale 尚未运行或登录；请手动登录并运行 tailscale up 后重试。');
    const canUp = ['NeedsLogin', 'Stopped'].includes(status.BackendState);
    const choice = await choose(terminal, `${reason}Tailscale 状态 ${status.BackendState}。请手动登录/启动后输入 retry${canUp ? '；或输入 up 明确同意调用 tailscale up（可能要求登录和管理员 / sudo 权限）' : ''}；其他输入取消：`);
    if (choice === 'retry') continue;
    if (choice !== 'up' || !canUp) throw new Error('Tailscale 接入已取消。');
    reason = succeeded(run(cli, ['up'], true)) ? '' : 'tailscale up 失败；Linux 可在独立终端运行 sudo tailscale up，或请管理员配置 operator 权限；Windows 请检查管理员权限。手动处理后 retry，或重新明确选择 up。';
  }
}

function privateMapping(config: unknown, dns: string, port: number): 'empty' | 'same' {
  const conflict = () => { throw new Error('已有或未知 Tailscale Serve/Funnel 映射；为保护现有服务，请手动检查，本工具不会覆盖或 reset。'); };
  if (!object(config) || Object.keys(config).some(key => !['TCP', 'Web', 'AllowFunnel', 'Foreground'].includes(key)) || !empty(config.Foreground)) return conflict();
  const address = `${dns}:443`;
  if (!empty(config.AllowFunnel) && (!object(config.AllowFunnel) || Object.keys(config.AllowFunnel).length !== 1 || config.AllowFunnel[address] !== false)) return conflict();
  if (empty(config.TCP) && empty(config.Web) && empty(config.AllowFunnel)) return 'empty';
  if (!object(config.TCP) || Object.keys(config.TCP).length !== 1 || !object(config.TCP['443'])) return conflict();
  const tcp = config.TCP['443'];
  if (tcp.HTTPS !== true || Object.keys(tcp).some(key => !['HTTPS', 'HTTP', 'TCPForward', 'TerminateTLS'].includes(key)) || (tcp.HTTP !== undefined && tcp.HTTP !== false) || (tcp.TCPForward !== undefined && tcp.TCPForward !== '') || (tcp.TerminateTLS !== undefined && tcp.TerminateTLS !== '')) return conflict();
  if (!object(config.Web) || Object.keys(config.Web).length !== 1 || !object(config.Web[address])) return conflict();
  const web = config.Web[address];
  if (Object.keys(web).length !== 1 || !object(web.Handlers) || Object.keys(web.Handlers).length !== 1 || !object(web.Handlers['/'])) return conflict();
  const handler = web.Handlers['/'];
  if (Object.keys(handler).length !== 1 || handler.Proxy !== `http://127.0.0.1:${port}`) return conflict();
  return 'same';
}

function readServe(cli: string): unknown {
  const result = run(cli, ['serve', 'status', '--json']);
  if (!succeeded(result)) throw new Error('读取 Tailscale Serve 配置失败或超时。');
  try { return JSON.parse(String(result.stdout)); } catch { throw new Error('Tailscale Serve 返回无效 JSON。'); }
}

export async function configureTailscale(dataDir: string, port: number, terminal?: Terminal): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Web 端口必须为 1–65535 的整数。');
  const file = join(dataDir, 'config.json');
  let config: unknown;
  try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') config = {}; else throw new Error('无法读取 Web 配置或配置 JSON 无效。'); }
  if (!object(config)) throw new Error('Web 配置必须是 JSON object。');
  const previous = config.origin === undefined ? `http://localhost:${port}` : config.origin;
  configuredOrigins(previous, config.allowedOrigins);
  const cli = await ensureCli(terminal);
  const dns = await readDns(cli, terminal);
  const origin = `https://${dns}`;
  const allowedOrigins = [...new Set([...(config.allowedOrigins ?? []), previous, `http://localhost:${port}`])].filter(value => value !== origin);
  configuredOrigins(origin, allowedOrigins);
  const state = privateMapping(readServe(cli), dns, port);
  const temporary = `${file}.tailscale-${randomUUID()}`;
  let mapped = state === 'same';
  try {
    try {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify({ ...config, origin, allowedOrigins, port }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    catch { throw new Error('无法暂存 Web 配置；请检查目录权限和磁盘空间，原配置未修改。'); }
    if (state === 'empty') {
      const result = run(cli, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
      if (!succeeded(result)) throw new Error('Tailscale Serve 命令失败或超时；Web 配置未修改。若尚未启用 HTTPS，请在 Tailscale 管理页面 https://login.tailscale.com/admin/dns 启用 HTTPS 证书后重试；也请检查权限与 Serve 状态。');
      mapped = true;
      if (privateMapping(readServe(cli), dns, port) !== 'same') throw new Error('Tailscale Serve 未确认目标私有映射；Web 配置未修改，请手动检查 Serve 状态。');
    }
    try { await fs.rename(temporary, file); }
    catch { throw new Error(`Tailscale 映射已保留，但 Web 配置落盘失败；原配置未修改。修复目录权限后重试同一端口 ${port}，本工具不会 reset 其他映射。`); }
    return origin;
  } catch (error) {
    if (mapped && state === 'empty') throw new Error(`${error instanceof Error ? error.message : 'Tailscale 配置失败'} 已建立的 Serve 映射可能仍存在，请检查后重试；本工具不会自动 reset。`);
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usage = () => { throw new Error('用法：node scripts/tailscale.ts [--port N] [--interactive]；参数不得重复。'); };
  let port: number | undefined, interactive = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--interactive' && !interactive) interactive = true;
    else if (args[index] === '--port' && port === undefined && /^\d+$/.test(args[index + 1] ?? '')) port = Number(args[++index]);
    else usage();
  }
  if (interactive && !process.stdin.isTTY) throw new Error('--interactive 需要交互式终端；请手动安装并登录后使用非交互模式。');
  const terminal = interactive ? { async question(prompt: string) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { return await reader.question(prompt); } finally { reader.close(); }
  } } : undefined;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = join(root, '.local', 'web');
  if (port === undefined) {
    let config: unknown;
    try { config = JSON.parse(await fs.readFile(join(dataDir, 'config.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') config = {}; else throw new Error('无法读取 Web 配置或配置 JSON 无效。'); }
    if (!object(config)) throw new Error('Web 配置必须是 JSON object。');
    const value = config.port === undefined ? 3000 : config.port;
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) throw new Error('Web 配置中的 port 必须为有效端口。');
    port = Number(value);
  }
  const origin = await configureTailscale(dataDir, port, terminal);
  process.stdout.write(`已配置私有 HTTPS：${origin}。重启 Web 服务后使用此地址。\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Tailscale 配置失败'}\n`);
  process.exitCode = 1;
});
