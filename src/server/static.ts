import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export function registerStatic(app: FastifyInstance, directory: string) {
  const types: Record<string, string> = { js:'text/javascript', css:'text/css', svg:'image/svg+xml', png:'image/png', webmanifest:'application/manifest+json', html:'text/html', woff2:'font/woff2' };
  app.get('/*', async (request, reply) => {
    const path = (request.params as any)['*'] as string;
    let file: string;
    if (['','settings'].includes(path) || /^sessions\/[a-zA-Z0-9-]+$/.test(path)) file='index.html';
    else if (/^assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2|png|svg)$/.test(path) || ['manifest.webmanifest','sw.js','icon.svg'].includes(path)) file=path;
    else return reply.code(404).send({error:'Not found'});
    try {
      const bytes = await readFile(join(directory,file));
      reply.header('cache-control',file.startsWith('assets/')?'public, max-age=31536000, immutable':'no-cache');
      return reply.type(types[file.split('.').pop()!] ?? 'application/octet-stream').send(bytes);
    } catch { return reply.code(404).send({error:'Web build missing. Run npm.cmd run build.'}); }
  });
}
