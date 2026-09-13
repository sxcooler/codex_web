import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultCodexExecutable, resolveCodexExecutable } from '../src/codex/executable.ts';
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
