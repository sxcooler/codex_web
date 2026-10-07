import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultCodexExecutable, resolveCodexExecutable, assertCodexVersion } from '../src/codex/executable.ts';
import { pathKey, validateFolder } from '../src/projects.ts';

test('CLI resolution keeps explicit configuration and platform defaults', t => {
  const previous = process.env.CODEX_BIN;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; });
  delete process.env.CODEX_BIN;
  assert.equal(defaultCodexExecutable('linux'), 'codex');
  assert.equal(defaultCodexExecutable('win32'), join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  assert.equal(resolveCodexExecutable('/some directory/codex'), '/some directory/codex');
  process.env.CODEX_BIN = '/explicit/codex';
  assert.equal(resolveCodexExecutable('/configured/codex'), '/explicit/codex');
});

test('CLI minimum accepts stable 0.160.1 or newer and safely rejects old prerelease or unknown versions', () => {
  for(const output of ['codex-cli 0.160.1\n','codex 0.160.1','codex-cli 0.160.2','codex-cli 0.161.0','codex-cli 1.0.0','codex-cli 0.160.1+build.2'])assert.doesNotThrow(()=>assertCodexVersion(output));
  for(const output of ['codex-cli 0.159.2','codex-cli 0.160.0','codex-cli 0.160.1-alpha.1','codex-cli 0.161.0-beta','codex-cli 00.160.1','codex-cli 9007199254740992.0.0','codex-cli private-stdout','codex-cli 0.160.1\nprivate-stdout','v0.160.1',''])assert.throws(()=>assertCodexVersion(output),(error:any)=>error.code==='CODEX_CLI_VERSION_REQUIRED'&&error.message.includes('Codex CLI >= 0.160.1')&&!error.message.includes('private-stdout'));
});

test('path identity and folder rules respect the host platform', () => {
  assert.equal(pathKey('C:\\Work\\Repo', 'win32'), 'c:\\work\\repo');
  assert.notEqual(pathKey('/work/Repo', 'linux'), pathKey('/work/repo', 'linux'));
  for (const name of ['CON', 'nul.txt', 'COM¹', 'foo.', 'foo ', 'x:y', 'a?b']) {
    assert.throws(() => validateFolder(name, 'win32'));
    assert.equal(validateFolder(name, 'linux'), name);
  }
  for (const platform of ['linux', 'win32']) for (const name of ['', '..', '.hidden', '../x', 'a/b', 'a\\b', 'x\0y']) {
    assert.throws(() => validateFolder(name, platform));
  }
});
