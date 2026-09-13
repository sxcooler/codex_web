import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Run with Node after changing the logo/padding; bump revision for immutable asset URLs.
const revision = 1;
const scale = 0.8; // Original glyph fills 75% of its SVG; mobile glyph fills 60%.
const publicRoot = new URL('../public/', import.meta.url);
const source = await readFile(new URL('icon.svg', publicRoot), 'utf8');
const inset = 192 * (1 - scale) / 2;
const mobile = source.replace(' rx="40"', '').replace('<g ', `<g transform="translate(${inset} ${inset}) scale(${scale})" `);
await mkdir(new URL('assets/', publicRoot), { recursive: true });
for (const size of [180, 192, 512]) {
  await sharp(Buffer.from(mobile)).resize(size, size).png().toFile(fileURLToPath(new URL(`assets/icon-mobile-v${revision}-${size}.png`, publicRoot)));
}
