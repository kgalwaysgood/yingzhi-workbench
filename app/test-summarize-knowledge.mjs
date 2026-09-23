import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeKnowledge, validateSummary, fingerprint, groundSummary, writeLibrary, buildPrompt, splitTranscript, PROMPT_VERSION } from './summarize-knowledge.mjs';

const source = { video_id: '123', title: '设备管理', transcript: '自动化改造后应关注设备绩效，并建立专业设备维保团队。企业需要持续记录停机原因和维修过程。' };
const valid = { video_id: '123', title: '自动化之后的设备管理', topic: '设备管理', overview: '原视频强调设备绩效与维保团队需要同时建设。', knowledge_value: 'high',
  points: [{ claim: '自动化后关注设备绩效', quote: '自动化改造后应关注设备绩效' }],
  suggested_actions: ['盘点维保人员能力'], limitations: ['未给出具体绩效数值'], transcript_issues: [] };

test('detailed-note prompt preserves steps, examples and boundaries instead of a fixed short summary', () => {
  const prompt = buildPrompt([source]);
  assert.match(PROMPT_VERSION, /v3/);
  for (const marker of ['不限制为3-5点', '步骤顺序', '例子中的对象与数量', '标题与文字稿不一致', '视频画面']) assert.ok(prompt.includes(marker));
});

test('long transcripts are split without omitting or duplicating source text', () => {
  const transcript = `${'第一段的设备问题。'.repeat(180)}\n${'第二段的处理步骤。'.repeat(180)}`;
  const parts = splitTranscript(transcript);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), transcript);
  assert.ok(parts.every(part => part.length <= 2800));
});

test('only user-selected videos are summarized', async t => {
  const f = await fixture(t);
  const another = path.join(f.output, 'another.json');
  await fs.writeFile(another, JSON.stringify({ ...source, video_id: '456' }));
  await fs.writeFile(f.summary, JSON.stringify({ results: [
    { videoId: '123', status: 'completed', jsonPath: f.item },
    { videoId: '456', status: 'completed', jsonPath: another },
  ] }));
  const requested = [];
  await summarizeKnowledge(f.summary, { selectedIds: ['456'], generate: async prompt => {
    requested.push(prompt);
    return { items: [{ ...valid, video_id: '456' }] };
  } });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /"video_id":"456"/);
  assert.ok(!(await fs.readdir(path.join(f.output, 'knowledge', 'summaries'))).includes('123.json'));
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'data');
  await fs.mkdir(output);
  const item = path.join(output, 'source.json');
  const summary = path.join(output, 'download-summary.json');
  await fs.writeFile(item, JSON.stringify(source));
  await fs.writeFile(summary, JSON.stringify({ runId: 'test', results: [{ videoId: '123', status: 'completed', jsonPath: item, url: 'https://www.douyin.com/video/123' }] }));
  return { root, output, item, summary };
}

test('rejects invented citations and wrong video identity', () => {
  assert.throws(() => validateSummary({ ...valid, video_id: '999' }, source), /ID/);
  assert.throws(() => validateSummary({ ...valid, points: [{ claim: '成本下降', quote: '成本可以下降百分之五十' }] }, source), /引用/);
  assert.equal(validateSummary(valid, source).video_id, '123');
});

test('grounds punctuation-adjusted quotes and removes unsupported claims', () => {
  const grounded = groundSummary({
    ...valid,
    points: [
      { claim: '可追溯观点', quote: '自动化改造后，应关注设备绩效' },
      { claim: '无依据观点', quote: '系统上线后成本下降百分之五十' },
    ],
  }, source);
  assert.equal(grounded.points.length, 1);
  assert.equal(grounded.points[0].quote, '自动化改造后应关注设备绩效');
  assert.match(grounded.transcript_issues.at(-1), /1条候选观点/);
  assert.doesNotThrow(() => validateSummary(grounded, source));
});

test('hash changes when transcript changes', () => {
  assert.notEqual(fingerprint(source), fingerprint({ ...source, transcript: source.transcript + '修正' }));
});

test('edited detailed notes invalidate an otherwise unchanged transcript cache', async t => {
  const f = await fixture(t);
  await summarizeKnowledge(f.summary, { generate: async () => ({ items: [valid] }) });
  const edited = { ...valid, overview: '补充后的完整观点，原文未变但整理版本已变。' };
  let calls = 0;
  const options = { generate: async () => { calls++; return { items: [edited] }; }, acceptCached: record => JSON.stringify(record.summary) === JSON.stringify(edited) };
  await summarizeKnowledge(f.summary, options);
  await summarizeKnowledge(f.summary, options);
  assert.equal(calls, 1);
  const actual = JSON.parse(await fs.readFile(path.join(f.output, 'knowledge', 'summaries', '123.json'), 'utf8'));
  assert.equal(actual.summary.overview, edited.overview);
});

test('creates summaries and library; repeated run makes no AI call; changed source refreshes', async t => {
  const f = await fixture(t);
  let calls = 0;
  const generate = async () => { calls++; return { items: [valid] }; };
  await summarizeKnowledge(f.summary, { generate });
  await summarizeKnowledge(f.summary, { generate });
  assert.equal(calls, 1);
  assert.match(await fs.readFile(path.join(f.output, 'knowledge', 'index.html'), 'utf8'), /自动化之后的设备管理/);
  await fs.writeFile(f.item, JSON.stringify({ ...source, transcript: source.transcript + '新增文字。' }));
  await summarizeKnowledge(f.summary, { generate });
  assert.equal(calls, 2);
});

test('failure preserves transcript, reports partial, releases lock, and can resume', async t => {
  const f = await fixture(t);
  await assert.rejects(summarizeKnowledge(f.summary, { generate: async () => { throw new Error('Codex 总结失败: offline'); } }), /未闭环/);
  assert.equal(JSON.parse(await fs.readFile(f.item, 'utf8')).transcript, source.transcript);
  const status = JSON.parse(await fs.readFile(path.join(f.output, 'knowledge', 'summary-status.json'), 'utf8'));
  assert.equal(status.status, 'PARTIAL');
  assert.equal(status.pending.length, 1);
  await summarizeKnowledge(f.summary, { generate: async () => ({ items: [valid] }) });
});

test('library escapes source text as HTML', async t => {
  const f = await fixture(t);
  const record = { summary: { ...valid, title: '<img src=x onerror=alert(1)>' }, sourceHash: fingerprint(source), author: '<script>bad()</script>', transcript: source.transcript, source_url: 'https://www.douyin.com/video/123', markdownPath: path.join(f.output, 'knowledge', '123.md') };
  await writeLibrary(f.output, [record]);
  const html = await fs.readFile(path.join(f.output, 'knowledge', 'index.html'), 'utf8');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

test('concurrent summarizer cannot overwrite active run', async t => {
  const f = await fixture(t);
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = summarizeKnowledge(f.summary, { generate: async () => { started(); await new Promise(resolve => { release = resolve; }); return { items: [valid] }; } });
  await ready;
  await assert.rejects(summarizeKnowledge(f.summary), /已在运行/);
  release();
  await first;
});

test('source change and failure remain visible across unrelated batches; resume recovers them', async t => {
  const f = await fixture(t);
  await summarizeKnowledge(f.summary, { generate: async () => ({ items: [valid] }) });
  await fs.writeFile(f.item, JSON.stringify({ ...source, transcript: source.transcript + '改变事实。' }));
  await assert.rejects(summarizeKnowledge(f.summary, { generate: async () => { throw new Error('offline'); } }), /未闭环/);
  const itemB = path.join(f.output, 'b.json');
  await fs.writeFile(itemB, JSON.stringify({ ...source, video_id: '456', title: '其他作品' }));
  await fs.writeFile(f.summary, JSON.stringify({ results: [{ videoId: '456', status: 'completed', jsonPath: itemB }] }));
  const generate = async prompt => ({ items: [{ ...valid, video_id: prompt.includes('"video_id":"456"') ? '456' : '123' }] });
  await assert.rejects(summarizeKnowledge(f.summary, { generate }), /未闭环/);
  const status = JSON.parse(await fs.readFile(path.join(f.output, 'knowledge', 'summary-status.json'), 'utf8'));
  assert.equal(status.pending[0].video_id, '123');
  assert.equal(status.libraryTotal, 1);
  const recovered = await summarizeKnowledge(f.summary, { generate, resumePending: true });
  assert.equal(recovered.libraryTotal, 2);
  assert.equal(recovered.pending.length, 0);
});

test('abandoned lock is recovered and empty batch never reports success', async t => {
  const f = await fixture(t);
  const cache = path.join(f.output, 'knowledge', 'summaries');
  await fs.mkdir(cache, { recursive: true });
  const lock = path.join(cache, 'summary.lock');
  await fs.writeFile(lock, 'abandoned');
  const old = new Date(Date.now() - 120000);
  await fs.utimes(lock, old, old);
  await summarizeKnowledge(f.summary, { generate: async () => ({ items: [valid] }) });
  await fs.writeFile(f.summary, JSON.stringify({ results: [] }));
  await assert.rejects(summarizeKnowledge(f.summary), /没有可处理/);
});

test('pre-catalog summaries recover source mappings across a different batch', async t => {
  const f = await fixture(t);
  await summarizeKnowledge(f.summary, { generate: async () => ({ items: [valid] }) });
  await fs.unlink(path.join(f.output, 'knowledge', 'summaries', 'catalog.json'));
  const itemB = path.join(f.output, 'b.json');
  await fs.writeFile(itemB, JSON.stringify({ ...source, video_id: '456' }));
  await fs.writeFile(f.summary, JSON.stringify({ results: [{ videoId: '456', status: 'completed', jsonPath: itemB }] }));
  const generate = async () => ({ items: [{ ...valid, video_id: '456' }] });
  await assert.rejects(summarizeKnowledge(f.summary, { generate }), /未闭环/);
  const recovered = await summarizeKnowledge(f.summary, { generate, resumePending: true });
  assert.equal(recovered.libraryTotal, 2);
  assert.equal(recovered.pending.length, 0);
});
