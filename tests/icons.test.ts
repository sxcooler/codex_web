import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { registerStatic } from '../src/server/static.ts';

test('mobile icons are served as PNG and keep the glyph inside the mask safe zone', async () => {
  const root = new URL('../public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const touch = html.match(/rel="apple-touch-icon"[^>]+href="([^"]+)"/)![1];
  const app = Fastify(); registerStatic(app, fileURLToPath(root));
  try {
    assert.ok(manifest.icons.some((icon: any) => icon.purpose === 'maskable'));
    for (const src of new Set<string>([touch, ...manifest.icons.map((icon: any) => icon.src)])) {
      const response = await app.inject(src);
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type']!, /image\/png/);
      const { data, info } = await sharp(response.rawPayload).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const size = Number(src.match(/-(\d+)\.png$/)![1]);
      assert.equal(info.width, size); assert.equal(info.height, size);
      let foreground = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        assert.equal(data[offset + 3], 255);
        if (data[offset + 1] > data[offset] + 30) {
          foreground++;
          assert.ok(Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size * 0.4);
          assert.ok(x >= size * 0.19 && x < size * 0.81);
        }
      }
      assert.ok(foreground > size * size * 0.04, 'Icon must contain a visible glyph');
    }
  } finally { await app.close(); }
});
