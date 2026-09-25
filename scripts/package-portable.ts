import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {runtimeFingerprint,environmentFile} from './portable-manifest.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const nodeVersion = '24.20.0';
const windows = process.platform === 'win32';
const platform = windows ? 'win-x64' : 'linux-x64';
const executable = windows ? 'node.exe' : 'node';
// Official v24.20.0 SHASUMS256.txt; Linux binary hash is derived from the verified archive.
const linuxArchiveHash = '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2';
const nodeHash = windows ? '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5' : '89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7';
export const runtimeFiles = ['src/server', 'src/codex', 'src/projects.ts', 'scripts/setup-auth.ts', 'scripts/portable.ts', 'scripts/server-control.ts', 'scripts/update-portable.ts','scripts/portable-manifest.ts', 'scripts/windows', 'scripts/linux', 'dist'];
export function sourceAllowed(path: string): boolean {
  return !path.toLowerCase().split('/').some(part => ['.git', '.local', '.worktrees', '.superpowers', '.codebase-memory', 'node_modules', 'dist', 'releases', 'output', 'test-results', 'playwright-report'].includes(part))
    && !/(^|\/)\.env(?!\.example$)|\.(?:sqlite(?:-wal|-shm)?|db|log|pem|key|pfx)$/i.test(path)
    && !/^(auth|vapid|credentials)\.json$/i.test(basename(path));
}
export const runtimeAllowed = (path: string) => sourceAllowed(path === 'dist' ? '' : path.replace(/^dist\//, ''));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function download(url: string) {
  const options = { windowsHide: true, timeout: 60_000, maxBuffer: 200 * 1024 * 1024 };
  if (!windows) return execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '55', url], options);
  return execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $response=Invoke-WebRequest -Uri '${url.replaceAll("'", "''")}' -TimeoutSec 45; $response.RawContentStream.CopyTo([Console]::OpenStandardOutput())`], options);
}
function npm(command: string, cwd: string) {
  execFileSync(windows ? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe' : 'npm', windows ? ['/d', '/s', '/c', `npm.cmd ${command}`] : command.split(' '), { cwd, stdio: 'inherit', windowsHide: true });
}
async function copy(source: string, target: string, allowed = (_path: string) => true) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Package input must not be a symbolic link');
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter: async path => { if (!allowed(path)) return false; if ((await lstat(path)).isSymbolicLink()) throw new Error('Symbolic link in package input'); return true; } });
}
function zip(source: string, target: string) {
  if (!windows) { execFileSync('python3', ['-m', 'zipfile', '-c', target, basename(source)], { cwd: dirname(source), stdio: 'inherit' }); return; }
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(source)},${quote(target)},[IO.Compression.CompressionLevel]::Optimal,$true)`], { stdio: 'inherit', windowsHide: true });
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
  if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') throw new Error('Build on Windows x64 or Linux x64; cross-compilation is not supported.');
  if (!windows && !(process.report.getReport() as any).header.glibcVersionRuntime) throw new Error('Linux portable packages require glibc (not musl/Alpine).');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--node-binary')) throw new Error('Usage: npm run package:portable -- [--node-binary PATH]');
  if ((await readFile(join(repo, '.node-version'), 'utf8')).trim() !== nodeVersion) throw new Error('Update the pinned Node version and checksum together.');
  const cache = join(repo, '.local', 'portable-runtime'); await mkdir(cache, { recursive: true });
  const binaryPath = args[1] ? resolve(args[1]) : join(cache, executable);
  let binary: Buffer;
  try { binary = await readFile(binaryPath); } catch (error: any) {
    if (args[1] || error.code !== 'ENOENT') throw error;
    if (windows) binary = await download(`https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`);
    else {
      const archive = await download(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`);
      if (hash(archive) !== linuxArchiveHash) throw new Error('Downloaded Node archive checksum mismatch');
      const archivePath = join(cache, 'node-linux-x64.tar.xz'); await writeFile(archivePath, archive);
      binary = execFileSync('tar', ['-xJOf', archivePath, `node-v${nodeVersion}-linux-x64/bin/node`], { maxBuffer: 200 * 1024 * 1024 });
    }
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
  const name = `codex-web-${pkg.version}`;
  const stage = await mkdtemp(join(repo, '.local', 'package-'));
  try {
    const portable = join(stage, `${name}-${platform}`), source = join(stage, `${name}-source`);
    await mkdir(portable); await mkdir(source);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const path of tracked) if (runtimeFiles.some(base => base !== 'dist' && (path === base || path.startsWith(base + '/'))) && runtimeAllowed(path)) await copy(join(repo, path), join(portable, path));
    await copy(join(repo, 'dist'), join(portable, 'dist'), input => runtimeAllowed(relative(repo, input).split(sep).join('/')));
    for (const path of ['package.json', 'package-lock.json']) await copy(join(repo, path), join(portable, path), input => runtimeAllowed(relative(repo, input).split(sep).join('/')));
    npm('ci --omit=dev --no-bin-links --no-audit --no-fund', portable);
    // Runtime imports packages directly; npm's executable links are not needed.
    await rm(join(portable, 'node_modules', '.bin'), { recursive: true, force: true });
    await rm(join(portable,'node_modules','.package-lock.json'),{force:true});
    await mkdir(join(portable, 'runtime'));
    await writeFile(join(portable, 'runtime', executable), binary); await writeFile(join(portable, 'runtime', 'NODE-LICENSE.txt'), license);
    if (windows) {
      for (const [name, arg] of [['Start',''],['Stop','--stop'],['Status','--status']]) await writeFile(join(portable, name + '.cmd'), `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\portable.ts" ${arg} %*\r\nset "codexExit=%errorlevel%"\r\n${name==='Start'?'if not "%codexExit%"=="0" pause':'pause'}\r\nexit /b %codexExit%\r\n`);
    }
    else {
      await chmod(join(portable, 'runtime', executable), 0o755);
      for (const [name,arg] of [['Start',''],['Stop','--stop'],['Status','--status']]) await writeFile(join(portable, name + '.sh'), `#!/usr/bin/env bash\nset -euo pipefail\ncd -- "$(dirname -- "\${BASH_SOURCE[0]}\")"\nexec ./runtime/node ./scripts/portable.ts ${arg} "$@"\n`, { mode: 0o755 });
    }
    if(windows)await writeFile(join(portable,'Update.cmd'),'@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\update-portable.ts" %*\r\nexit /b %errorlevel%\r\n');
    else await writeFile(join(portable,'Update.sh'),'#!/usr/bin/env bash\nset -euo pipefail\ncd -- "$(dirname -- "${BASH_SOURCE[0]}")"\nexec ./runtime/node ./scripts/update-portable.ts "$@"\n',{mode:0o755});
    for (const path of tracked) if ((['README.md', 'README_EN.md'].includes(path) || path.startsWith('docs/')) && sourceAllowed(path)) await copy(join(repo, path), join(portable, path));
    await writeFile(join(portable, 'THIRD-PARTY-NOTICES.txt'), 'Node.js: runtime/NODE-LICENSE.txt\nDependency licenses and notices are retained in node_modules.\nCodex CLI is not included; use your own installation and account.\n');
    execFileSync(join(portable, 'runtime', executable), ['--input-type=module', '-e', "await import('./src/server/app.ts'); const {default: sharp} = await import('sharp'); await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer(); console.log('Packaged backend and native image processing OK')"], { cwd: portable, stdio: 'inherit', windowsHide: true });

    for (const path of tracked) if (sourceAllowed(path)) await copy(join(repo, path), join(source, path));
    const entries = await manifest(portable);
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const releaseManifest={schemaVersion:2,platform:`${process.platform}-x64`,sourceCommit,nodeVersion,nodeSha256:nodeHash,files:entries};
    await writeFile(join(portable,'manifest.json'),JSON.stringify({...releaseManifest,runtimeFingerprint:runtimeFingerprint(releaseManifest)},null,2));
    const update=join(stage,`${name}-${platform}-update`);await mkdir(update);
    for(const entry of entries)if(!environmentFile(entry.path))await copy(join(portable,entry.path),join(update,entry.path));
    await copy(join(portable,'manifest.json'),join(update,'manifest.json'));
    const archives = [`${name}-${platform}.${windows ? 'zip' : 'tar.gz'}`, `${name}-source.zip`,`${name}-${platform}-update.zip`];
    if (windows) zip(portable, join(stage, archives[0]));
    else execFileSync('tar', ['--owner=0', '--group=0', '-czf', join(stage, archives[0]), '-C', stage, basename(portable)], { stdio: 'inherit' });
    zip(source, join(stage, archives[1]));
    zip(update,join(stage,archives[2]));
    for (const archive of archives) await rename(join(stage, archive), join(output, archive));
    const sums = await Promise.all(archives.map(async path => `${hash(await readFile(join(output, path)))}  ${path}`));
    await writeFile(join(output, `${name}-${platform}-SHA256SUMS.txt`), sums.join('\n') + '\n');
    process.stdout.write(`Release artifacts:\n${archives.map(path => join(output, path)).join('\n')}\n`);
  } finally {
    if (dirname(stage) !== join(repo, '.local') || !basename(stage).startsWith('package-')) throw new Error('Unsafe build cleanup target');
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
