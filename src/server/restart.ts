import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const unavailable = (message: string) => Object.assign(new Error(message), { statusCode: 503, code: 'RUNTIME_RESTART_UNAVAILABLE' });
export type RestartStatus = { available: boolean; status: 'idle' | 'scheduled' | 'success' | 'failed' | 'unknown'; scheduledAt?: string; reason?: string };
export type WebRestart = { status(): Promise<RestartStatus>; schedule(): Promise<RestartStatus> };

export function webRestart(root: string): WebRestart {
  const data = join(root, '.local/web');
  const json = async (name: string) => {
    try { return JSON.parse((await readFile(join(data, name), 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  };
  let scheduling: Promise<RestartStatus> | undefined;
  const status = async (): Promise<RestartStatus> => {
    const available = process.platform === 'win32' && (await json('server-control.json'))?.pid === process.pid;
    if (!available) return { available: false, status: 'idle', reason: '当前仅支持通过项目启动脚本运行的 Windows Web 服务。' };
    const receipt = await json('restart-latest.json');
    if (!receipt) return { available, status: 'idle' };
    if (!/^CodexWeb-Restart-[a-f0-9]{32}\.json$/.test(receipt.file) || !Number.isFinite(Date.parse(receipt.scheduledAt))) throw unavailable('重启记录无法核实，请检查服务日志。');
    const result = await json(receipt.file + '.result.json');
    const state = result?.status === 'success' || result?.status === 'failed' ? result.status : Date.now() > Date.parse(receipt.scheduledAt) + 120_000 ? 'unknown' : 'scheduled';
    return { available, status: state, scheduledAt: receipt.scheduledAt };
  };
  const schedule = async () => {
    const previous = await status();
    if (!previous.available) throw unavailable(previous.reason!);
    if (previous.status === 'scheduled') return previous;
    if (previous.status === 'unknown') throw unavailable('上次重启结果待核实，请检查服务日志，勿重复安排。');
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    try {
      await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/windows/restart-server.ps1'), '-RequireIdle', '-JsonOutput'], { cwd: root, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 });
    } catch {
      // A lost launcher response can follow successful scheduling; never blindly repeat it.
      const latest = await status();
      if (latest.status === 'scheduled') return latest;
      throw unavailable('重启预检或计划任务创建失败，请检查桌面登录状态与计划任务权限。服务未确认重启，请勿重复点击。');
    }
    const latest = await status();
    if (latest.status !== 'scheduled') throw unavailable('未取得重启安排记录，请检查服务日志。');
    return latest;
  };
  return { status, schedule: () => scheduling ??= schedule().finally(() => { scheduling = undefined; }) };
}
