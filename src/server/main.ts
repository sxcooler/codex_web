import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { buildServer } from './app.ts';
import { Runtime } from '../codex/runtime.ts';
import { resolveCodexExecutable } from '../codex/executable.ts';
import { Projects } from '../projects.ts';
import {Diagnostics} from './diagnostics.ts';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export async function startServer(diagnosticsEnabled = false) {
  const dataDir = process.env.WEB_DATA_DIR ?? join(projectRoot, '.local', 'web');
  let config: any = {};
  try { config = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const origin = process.env.WEB_ORIGIN ?? config.origin ?? 'http://localhost:3000';
  const portText = String(process.env.PORT ?? config.port ?? 3000);
  if (!/^\d{1,5}$/.test(portText)) throw new Error('Invalid port');
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw new Error('Invalid port');

  const workRoot = await realpath(process.env.WORK_ROOT ?? config.workRoot ?? join(homedir(), 'work'));
  const executable = resolveCodexExecutable(config.codexBin);
  const diagnostics = diagnosticsEnabled ? new Diagnostics(dataDir,()=>runtime.diagnosticState()) : undefined;
  const runtime = new Runtime({ executable, cwd: workRoot,diagnostic:diagnostics?.record });
  let app;
  try {app = await buildServer({ dataDir, origin, allowedOrigins: config.allowedOrigins, runtime, projects: new Projects(workRoot), distDir: join(projectRoot, 'dist'),diagnostics });}
  catch(error){await diagnostics?.close();throw error;}
  app.addHook('onClose',async()=>{await diagnostics?.close();});
  try {
    await app.listen({ host: '127.0.0.1', port });
    process.stdout.write(`Codex Web listening at ${origin}\n`);
    if (diagnosticsEnabled) process.stdout.write('Diagnostics enabled for this run.\n');
    let closing = false;
    for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => {
      if (closing) return; closing = true;
      await app.close();
    });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg=>arg!=='--diagnostics')) {
    process.stderr.write('Usage: node src/server/main.ts [--diagnostics]\n');
    process.exitCode = 1;
  }
  else startServer(args.includes('--diagnostics')).catch(() => {
    process.stderr.write('Failed to start Codex Web. Run the authentication setup first and check WEB_ORIGIN/PORT.\n');
    process.exitCode = 1;
  });
}
