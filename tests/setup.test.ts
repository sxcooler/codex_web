import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

test('setup explains invalid length without revealing input or creating credentials', () => {
  const root = tmpdir();
  const dir = mkdtempSync(join(root, 'codex-setup-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'src/server'), {recursive:true});
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    copyFileSync('scripts/setup-auth.ts', join(dir, 'scripts/setup-auth.ts'));
    copyFileSync('src/server/auth.ts', join(dir, 'src/server/auth.ts'));
    const result = spawnSync(process.execPath, [join(dir, 'scripts/setup-auth.ts')], {input:'short\n',encoding:'utf8',windowsHide:true});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /12.*256/);
    assert.equal(result.stderr.includes('short'), false);
    assert.equal(existsSync(join(dir, '.local/web/auth.json')), false);
  } finally {
    assert.equal(dirname(dir), root);
    rmSync(dir, {recursive:true,force:true});
  }
});
