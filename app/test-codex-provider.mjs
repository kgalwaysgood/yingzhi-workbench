import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveCodexExecutable } from './codex-summary-provider.mjs';

test('Explorer environment finds installed executable without PATH or override', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resolver-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'OpenAI', 'Codex', 'bin', 'installed-version', 'codex.exe');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'fixture');
  assert.equal(await resolveCodexExecutable({ LOCALAPPDATA: root, PATH: '' }), file);
});

test('invalid explicit executable is rejected instead of silently ignored', async () => {
  await assert.rejects(resolveCodexExecutable({ DOUYIN_CODEX_EXE: 'codex.exe' }), /绝对/);
});
