import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from './library.mjs';

const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'library-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(parent + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, library: new Library(root) };
}

test('CRUD persists across restart, supports search, soft delete, restore and history', async t => {
  const { root, library } = await fixture(t);
  const row = await library.add({ title: '订单', content: 'ERP 到 MES' });
  const edited = await library.change(row.id, 1, 'edit', { title: '订单流转', content: '生产计划', reviewStatus: 'reviewed' });
  assert.equal(edited.revision, 2);
  assert.equal(edited.history[0].content, 'ERP 到 MES');
  const reopened = new Library(root);
  assert.equal((await reopened.list({ query: '生产' })).length, 1);
  assert.equal((await reopened.list({ query: '不存在' })).length, 0);
  const removed = await reopened.change(row.id, 2, 'delete');
  assert.equal((await reopened.list()).length, 0);
  assert.equal((await reopened.list({ deleted: true })).length, 1);
  await assert.rejects(reopened.get(row.id), /回收站/);
  const restored = await reopened.change(row.id, removed.revision, 'restore');
  assert.equal(restored.content, '生产计划');
  assert.equal(restored.reviewStatus, 'reviewed');
});

test('empty, oversized and invalid status edits leave the stored record unchanged', async t => {
  const { library } = await fixture(t);
  const row = await library.add({ title: '原标题', content: '原内容' });
  for (const patch of [{ title: '', content: '有效' }, { title: '有效', content: '' },
    { title: 'a'.repeat(201), content: '有效' }, { title: '有效', content: 'a'.repeat(200001) },
    { title: '有效', content: '有效', reviewStatus: 'approved-by-AI' }]) {
    await assert.rejects(library.change(row.id, 1, 'edit', patch));
  }
  assert.deepEqual(await library.get(row.id), row);
});

test('stale revision and concurrent edits never silently overwrite data', async t => {
  const { library } = await fixture(t);
  const row = await library.add({ title: 'note', content: 'original' });
  const attempts = await Promise.allSettled([
    library.change(row.id, 1, 'edit', { title: 'A', content: 'first' }),
    library.change(row.id, 1, 'edit', { title: 'B', content: 'second' }),
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts[1].reason.status, 409);
  assert.equal((await library.get(row.id)).content, 'first');
});

test('other process lock blocks write; no existing content is changed', async t => {
  const { library } = await fixture(t);
  const row = await library.add({ title: 'note', content: 'original' });
  await fs.writeFile(`${library.file}.lock`, 'test-lock');
  await assert.rejects(library.change(row.id, 1, 'delete'), /其他窗口/);
  assert.equal((await library.get(row.id)).deletedAt, null);
  await fs.unlink(`${library.file}.lock`);
  assert.ok((await library.change(row.id, 1, 'delete')).deletedAt);
});

test('corrupt or unwritable store fails closed without replacing prior content', async t => {
  const { library } = await fixture(t);
  await library.add({ title: 'note', content: 'original' });
  await fs.writeFile(library.file, 'broken-json');
  await assert.rejects(library.add({ title: 'new', content: 'text' }), /保护原文件/);
  assert.equal(await fs.readFile(library.file, 'utf8'), 'broken-json');
});

test('repeat import does not overwrite edited transcript or resurrect recycled records', async t => {
  const { library } = await fixture(t);
  const input = { kind: 'transcript', sourceId: '123', title: 'source', content: 'machine' };
  const row = await library.add(input, true);
  const edited = await library.change(row.id, 1, 'edit', { title: 'corrected', content: 'human correction' });
  assert.equal((await library.add(input, true)).content, 'human correction');
  await library.change(row.id, edited.revision, 'delete');
  assert.ok((await library.add(input, true)).deletedAt);
});

test('changing source invalidates reviewed knowledge without losing its edited content', async t => {
  const { library } = await fixture(t);
  const transcript = await library.add({ kind: 'transcript', sourceId: '123', title: 'source', content: 'machine' }, true);
  const knowledge = await library.add({ kind: 'knowledge', sourceId: '123', title: 'summary', content: 'draft', reviewStatus: 'reviewed' }, true);
  await library.change(transcript.id, 1, 'edit', { title: 'source', content: 'corrected' });
  const result = await library.get(knowledge.id);
  assert.equal(result.sourceChanged, true);
  assert.equal(result.reviewStatus, 'pending');
  assert.equal(result.content, 'draft');
  assert.equal(result.revision, 2);
  await library.add({ kind: 'knowledge', sourceId: '123', title: 'new', content: 'new generated' }, true);
  assert.equal((await library.get(knowledge.id)).latestGenerated.content, 'new generated');
  const accepted = await library.change(knowledge.id, 2, 'edit', { title: 'new', content: 'new generated' });
  assert.equal(accepted.sourceChanged, false);
});

test('restoring active or editing deleted entry is rejected', async t => {
  const { library } = await fixture(t);
  const row = await library.add({ title: 'note', content: 'text' });
  await assert.rejects(library.change(row.id, 1, 'restore'), /不在回收站/);
  await library.change(row.id, 1, 'delete');
  await assert.rejects(library.change(row.id, 2, 'edit', { title: 'bad', content: 'bad' }), /先从回收站/);
});
