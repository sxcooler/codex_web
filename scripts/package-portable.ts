import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const nodeVersion = '24.20.0';
// Official v24.20.0 SHASUMS256.txt, win-x64/node.exe.
const nodeHash = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
export const runtimeFiles = ['src/server', 'src/codex', 'src/projects.ts', 'scripts/setup-auth.ts', 'scripts/portable.ts', 'dist'];
export function sourceAllowed(path: string): boolean {
  return !path.toLowerCase().split('/').some(part => ['.git', '.local', '.worktrees', '.superpowers', '.codebase-memory', 'node_modules', 'dist', 'releases', 'output', 'test-results', 'playwright-report'].includes(part))
    && !/(^|\/)\.env(?!\.example$)|\.(?:sqlite(?:-wal|-shm)?|db|log|pem|key|pfx)$/i.test(path)
    && !/^(auth|vapid|credentials)\.json$/i.test(basename(path));
}
export const runtimeAllowed = (path: string) => sourceAllowed(path === 'dist' ? '' : path.replace(/^dist\//, ''));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function download(url: string) {
  // Use the Windows downloader so packaging also works with system proxy settings.
  return execFileSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $response=Invoke-WebRequest -UseBasicParsing -Uri '${url.replaceAll("'", "''")}' -TimeoutSec 45; $response.RawContentStream.CopyTo([Console]::OpenStandardOutput())`], { windowsHide: true, timeout: 60_000, maxBuffer: 200 * 1024 * 1024 });
}
function npm(command: string, cwd: string) {
  execFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `npm.cmd ${command}`], { cwd, stdio: 'inherit', windowsHide: true });
}
async function copy(source: string, target: string, allowed = (_path: string) => true) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Package input must not be a symbolic link');
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter: async path => { if (!allowed(path)) return false; if ((await lstat(path)).isSymbolicLink()) throw new Error('Symbolic link in package input'); return true; } });
}
function zip(source: string, target: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(source)},${quote(target)},[IO.Compression.CompressionLevel]::Optimal,$true)`], { stdio: 'inherit', windowsHide: true });
}
async function manifest(directory: string, prefix = ''): Promise<Array<{ path: string; size: number; sha256: string }>> {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Unexpected package symlink');
    if (entry.isDirectory()) files.push(...await manifest(directory, path));
    else { const bytes = await readFile(join(directory, path)); files.push({ path, size: bytes.length, sha256: hash(bytes) }); }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this Windows x64 package on Windows x64.');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--node-binary')) throw new Error('Usage: npm run package:portable -- [--node-binary PATH]');
  if ((await readFile(join(repo, '.node-version'), 'utf8')).trim() !== nodeVersion) throw new Error('Update the pinned Node version and checksum together.');
  const cache = join(repo, '.local', 'portable-runtime'); await mkdir(cache, { recursive: true });
  const binaryPath = args[1] ? resolve(args[1]) : join(cache, 'node.exe');
  let binary: Buffer;
  try { binary = await readFile(binaryPath); } catch (error: any) {
    if (args[1] || error.code !== 'ENOENT') throw error;
    binary = await download(`https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`);
    if (hash(binary) !== nodeHash) throw new Error('Downloaded Node checksum mismatch');
    await writeFile(binaryPath, binary);
  }
  if (hash(binary) !== nodeHash) throw new Error('Node runtime checksum mismatch');
  const licensePath = join(cache, 'NODE-LICENSE.txt');
  let license: Buffer;
  try { license = await readFile(licensePath); } catch { license = await download(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`); await writeFile(licensePath, license); }
  npm('run build', repo);
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  if (!/^[0-9A-Za-z._-]+$/.test(pkg.version)) throw new Error('Unsafe package version');
  const output = join(repo, 'releases'); await mkdir(output, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15), name = `codex-web-${pkg.version}-${stamp}`;
  const stage = await mkdtemp(join(repo, '.local', 'package-'));
  try {
    const portable = join(stage, `${name}-win-x64`), source = join(stage, `${name}-source`);
    await mkdir(portable); await mkdir(source);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const path of tracked) if (runtimeFiles.some(base => base !== 'dist' && (path === base || path.startsWith(base + '/'))) && runtimeAllowed(path)) await copy(join(repo, path), join(portable, path));
    await copy(join(repo, 'dist'), join(portable, 'dist'), input => runtimeAllowed(relative(repo, input).split(sep).join('/')));
    for (const path of ['package.json', 'package-lock.json']) await copy(join(repo, path), join(portable, path), input => runtimeAllowed(relative(repo, input).split(sep).join('/')));
    npm('ci --omit=dev --no-audit --no-fund', portable);
    await mkdir(join(portable, 'runtime'));
    await writeFile(join(portable, 'runtime', 'node.exe'), binary); await writeFile(join(portable, 'runtime', 'NODE-LICENSE.txt'), license);
    await writeFile(join(portable, 'Start.cmd'), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\portable.ts" %*\r\nif errorlevel 1 pause\r\n');
    await copy(join(repo, 'docs', 'portable.md'), join(portable, 'README.md'));
    await copy(join(repo, 'docs', 'privacy-review.md'), join(portable, 'privacy-review.md'));
    await writeFile(join(portable, 'THIRD-PARTY-NOTICES.txt'), 'Node.js: runtime/NODE-LICENSE.txt\nDependency licenses and notices are retained in node_modules.\nCodex CLI is not included; use your own installation and account.\n');
    execFileSync(join(portable, 'runtime', 'node.exe'), ['--input-type=module', '-e', "await import('./src/server/app.ts'); console.log('Packaged backend imports OK')"], { cwd: portable, stdio: 'inherit', windowsHide: true });

    for (const path of tracked) if (sourceAllowed(path)) await copy(join(repo, path), join(source, path));
    const entries = await manifest(portable);
    await writeFile(join(portable, 'manifest.json'), JSON.stringify({ platform: 'win32-x64', nodeVersion, nodeSha256: nodeHash, files: entries }, null, 2));
    const archives = [`${name}-win-x64.zip`, `${name}-source.zip`];
    zip(portable, join(output, archives[0])); zip(source, join(output, archives[1]));
    const sums = await Promise.all(archives.map(async path => `${hash(await readFile(join(output, path)))}  ${path}`));
    await writeFile(join(output, `${name}-SHA256SUMS.txt`), sums.join('\n') + '\n');
    process.stdout.write(`Release artifacts:\n${archives.map(path => join(output, path)).join('\n')}\n`);
  } finally {
    if (dirname(stage) !== join(repo, '.local') || !basename(stage).startsWith('package-')) throw new Error('Unsafe build cleanup target');
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
