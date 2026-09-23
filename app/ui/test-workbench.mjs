import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, normalizeCreatorInput } from './server.mjs';
import { summarizeKnowledge } from '../summarize-knowledge.mjs';

test('managed transcript edit feeds real summarizer; source stays unchanged; library survives reset', async t => {
  const original = '自动化改造后应关注设备绩效，并建立专业设备维保团队。企业需要持续记录停机原因和维修过程。';
  let root;
  let seenPrompt = '';
  const f = await fixture(t, {
    download: async () => {
      await fs.mkdir(path.join(root, 'data'), { recursive: true });
      const jsonPath = path.join(root, 'data', '123.json');
      await fs.writeFile(jsonPath, JSON.stringify({ video_id: '123', title: '设备管理', transcript: original }));
      return { results: [{ videoId: '123', status: 'completed', hasTranscript: true, jsonPath }] };
    },
    summarize: async ids => {
      const files = await fs.readdir(path.join(root, 'queue'));
      const snapshot = path.join(root, 'queue', files.find(name => /^session-.*-batch.json$/.test(name)));
      return summarizeKnowledge(snapshot, { selectedIds: ids, outputRoot: path.join(root, 'data'), generate: async prompt => {
        seenPrompt = prompt;
        return { items: [{ video_id: '123', title: '设备管理知识', topic: '设备管理', overview: '建立维修记录。', knowledge_value: 'high',
          points: [{ claim: '关注设备绩效', quote: '自动化改造后应关注设备绩效' }], suggested_actions: ['记录停机原因'], limitations: ['没有数值'], transcript_issues: [] }] };
      } });
    },
  });
  root = f.root;
  const run = async (route, body) => {
    const response = await f.post(route, body);
    assert.equal(response.status, 202);
    const result = await f.jobResult((await response.json()).jobId);
    assert.equal(result.status, 'completed', result.error);
  };
  await run('/api/list/upsert', { kind: 'works', title: '设备管理', url: 'https://www.douyin.com/video/123' });
  await run('/api/download', { urls: ['https://www.douyin.com/video/123'] });
  const edited = await f.post('/api/library/change', { id: 'transcript:123', revision: 1, action: 'edit', title: '人工校对', content: original + '人工补充：记录等待备件时间。' });
  assert.equal(edited.status, 200);
  const stale = await f.post('/api/library/change', { id: 'transcript:123', revision: 1, action: 'delete' });
  assert.equal(stale.status, 409);
  await run('/api/summarize', { videoIds: ['123'] });
  assert.match(seenPrompt, /人工补充：记录等待备件时间/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data', '123.json'), 'utf8')).transcript, original);
  assert.match(await fs.readFile(path.join(root, 'data', 'knowledge', 'summaries', '123.md'), 'utf8'), /设备管理知识/);
  assert.equal((await fs.readdir(path.join(root, 'queue'))).includes('knowledge'), false);
  await run('/api/reset', {});
  const empty = await fetch(f.url + '/api/state').then(r => r.json());
  assert.equal(empty.batch, null);
  assert.equal(empty.knowledgeItems.length, 0);
  const library = await fetch(f.url + '/api/library').then(r => r.json());
  assert.equal(library.items.length, 2);
  assert.equal((await f.post('/api/library/change', { id: 'knowledge:123', revision: 1, action: 'delete' })).status, 200);
  assert.equal((await fetch(f.url + '/api/library?deleted=1').then(r => r.json())).items.length, 1);
  assert.equal((await f.post('/api/library/change', { id: 'knowledge:123', revision: 2, action: 'restore' })).status, 200);
});

test('list add deduplicates, rename keeps identity, remove only affects the chosen stage', async t => {
  const f = await fixture(t);
  const run = async body => {
    const response = await f.post('/api/list/upsert', body);
    assert.equal(response.status, 202);
    assert.equal((await f.jobResult((await response.json()).jobId)).status, 'completed');
  };
  await run({ kind: 'creators', title: '博主', url: 'https://www.douyin.com/user/test' });
  await run({ kind: 'creators', title: '我的备注', url: 'https://www.douyin.com/user/test' });
  await run({ kind: 'works', title: '单条作品', url: 'https://www.douyin.com/video/123' });
  const state = await fetch(f.url + '/api/state').then(r => r.json());
  assert.equal(state.discovery.creators.length, 1);
  assert.equal(state.discovery.creators[0].author, '我的备注');
  const removed = await f.post('/api/list/remove', { kind: 'works', ids: ['https://www.douyin.com/video/123'] });
  await f.jobResult((await removed.json()).jobId);
  const after = await fetch(f.url + '/api/state').then(r => r.json());
  assert.equal(after.prepared.works.length, 0);
  assert.equal(after.discovery.creators.length, 1);
  assert.equal((await f.post('/api/list/upsert', { kind: 'works', title: 'bad', url: 'file:///D:/secret' })).status, 400);
  assert.equal((await f.post('/api/library/add', { title: '', content: 'empty title' })).status, 400);
  assert.equal((await f.post('/api/library/add', { title: 'note', content: 'text' }, { 'X-Workbench-Token': 'bad' })).status, 403);
});

test('large Chinese content round trips across HTTP chunks without replacement characters', async t => {
  const f = await fixture(t);
  const content = '机器文字稿'.repeat(20000);
  const added = await f.post('/api/library/add', { title: '长中文稿', content });
  assert.equal(added.status, 201);
  const row = await added.json();
  assert.equal(row.content, content);
  const edited = await f.post('/api/library/change', { id: row.id, revision: 1, action: 'edit', title: row.title, content: content + '末尾补充' });
  assert.equal((await edited.json()).content, content + '末尾补充');
});

test('two workbench instances sharing a runtime cannot run conflicting jobs', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { prepare: async () => {
    await held;
    return { inputType: 'profile', links: ['https://www.douyin.com/video/111'] };
  } });
  const other = createWorkbench({ runtimeRoot: f.root, operations: { prepare: () => { throw new Error('must not start'); } } });
  await new Promise(resolve => other.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.server.close(resolve)));
  const url = `http://127.0.0.1:${other.server.address().port}`;
  const token = (await fetch(url).then(r => r.text())).match(/name="workbench-token" content="([a-f0-9]+)"/)[1];
  const payload = { profileUrls: ['https://www.douyin.com/user/test'] };
  const first = await f.post('/api/prepare', payload);
  try {
    for (let i = 0; i < 50; i++) {
      if (await fs.access(path.join(f.root, 'queue', 'workbench-task.lock')).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const second = await fetch(url + '/api/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: JSON.stringify(payload) });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /其他工作台/);
  } finally { release(); }
  assert.equal((await f.jobResult((await first.json()).jobId)).status, 'completed');
  assert.equal(await fs.access(path.join(f.root, 'queue', 'workbench-task.lock')).then(() => true, () => false), false);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeParent = path.resolve(here, '..', 'runtime');

async function fixture(t, operations = {}) {
  await fs.mkdir(runtimeParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(runtimeParent, 'ui-test-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(`${runtimeParent}${path.sep}`)) throw new Error('测试清理路径不在工作区');
    await fs.rm(root, { recursive: true, force: true });
  });
  const { server } = createWorkbench({ runtimeRoot: root, operations });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url).then(response => response.text());
  const token = page.match(/name="workbench-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  const post = async (route, body, headers = {}) => fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token, ...headers },
    body: JSON.stringify(body),
  });
  const jobResult = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await fetch(`${url}/api/jobs/${id}`).then(response => response.json());
      if (value.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('测试任务未结束');
  };
  return { root, url, page, token, post, jobResult };
}

test('direct creator input accepts a profile and share text but not a video', () => {
  assert.equal(normalizeCreatorInput('查看TA的作品 https://www.douyin.com/user/example 复制'), 'https://www.douyin.com/user/example');
  assert.equal(normalizeCreatorInput('复制链接 https://v.douyin.com/abcde/。'), 'https://v.douyin.com/abcde/');
  assert.equal(
    normalizeCreatorInput('长按复制此条消息 https://v.douyin.com/cyXbVgkVRcw/，为什么会打开主页'),
    'https://v.douyin.com/cyXbVgkVRcw/',
  );
  assert.throws(() => normalizeCreatorInput('https://www.douyin.com/video/123'), /博主主页/);
});

test('scripts called by Windows PowerShell 5.1 use safe source encoding', async () => {
  for (const name of ['launch-ui.ps1', 'install-local-knowledge-model.ps1']) {
    const bytes = await fs.readFile(path.resolve(here, '..', name));
    const hasUtf8Bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const asciiOnly = bytes.every(byte => byte < 128);
    assert.ok(hasUtf8Bom || asciiOnly, `${name} must be UTF-8 BOM or ASCII for powershell.exe -File`);
  }
});

test('workbench stays on loopback, requires CSRF, and does not start a model on page load', async t => {
  const f = await fixture(t);
  assert.match(f.page, /直接粘贴博主链接/);
  const state = await fetch(`${f.url}/api/state`).then(response => response.json());
  assert.equal(state.ready.summaryModel, false);
  assert.equal(state.activeJob, null);
  const noToken = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noToken.status, 403);
  const foreign = await f.post('/api/login', {}, { Origin: 'https://example.com' });
  assert.equal(foreign.status, 403);
});

test('a new workbench session does not preload prior workflow results', async t => {
  const f = await fixture(t);
  const oldTime = new Date(Date.now() - 60_000);
  const discovery = path.join(f.root, 'data', 'discovery');
  const queue = path.join(f.root, 'queue');
  const knowledge = path.join(f.root, 'data', 'knowledge');
  await fs.mkdir(discovery, { recursive: true });
  await fs.mkdir(queue, { recursive: true });
  await fs.mkdir(knowledge, { recursive: true });
  const staleFiles = [
    [path.join(discovery, 'topic-2025-01-01.json'), JSON.stringify({ creators: [{ author: '上次博主' }] })],
    [path.join(queue, 'ui-works.json'), JSON.stringify({ works: [{ url: 'https://www.douyin.com/video/1' }] })],
    [path.join(f.root, 'data', 'download-summary.json'), JSON.stringify({ results: [{ videoId: '1' }] })],
    [path.join(knowledge, 'summary-status.json'), JSON.stringify({ status: 'OLD' })],
  ];
  for (const [file, content] of staleFiles) {
    await fs.writeFile(file, content);
    await fs.utimes(file, oldTime, oldTime);
  }

  const state = await fetch(`${f.url}/api/state`).then(response => response.json());
  assert.equal(state.discovery, null);
  assert.deepEqual(state.prepared, { works: [] });
  assert.equal(state.batch, null);
  assert.equal(state.knowledge, null);
  assert.deepEqual(state.knowledgeItems, []);
  for (const [file] of staleFiles) assert.equal((await fs.stat(file)).isFile(), true, '历史文件应继续保留在 D 盘');
});

test('creator selection lists works; download and summarization accept only selected prepared items', async t => {
  const work = 'https://www.douyin.com/video/123456';
  const calls = [];
  const f = await fixture(t, {
    prepare: async () => ({ inputType: 'profile', links: [work], works: [{ url: work, title: '订单到交付' }] }),
    download: async urls => { calls.push(['download', urls]); return { results: [
      { videoId: '123456', status: 'completed', hasTranscript: true },
    ] }; },
    summarize: async ids => { calls.push(['summarize', ids]); return { requested: 1 }; },
  });
  const selected = await f.post('/api/prepare', { profileUrls: ['https://www.douyin.com/user/tester'], limit: 5 });
  assert.equal(selected.status, 202);
  assert.equal((await f.jobResult((await selected.json()).jobId)).status, 'completed');
  assert.deepEqual(calls, [], '列作品不应自动下载或总结');
  const prepared = await fetch(`${f.url}/api/state`).then(response => response.json());
  assert.equal(prepared.prepared.works[0].title, '订单到交付');

  const wrongDownload = await f.post('/api/download', { urls: ['https://www.douyin.com/video/999'] });
  assert.equal(wrongDownload.status, 400);
  const download = await f.post('/api/download', { urls: [work] });
  assert.equal((await f.jobResult((await download.json()).jobId)).status, 'completed');
  assert.deepEqual(calls[0], ['download', [work]]);

  const data = path.join(f.root, 'data');
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, 'download-summary.json'), JSON.stringify({ results: [
    { videoId: '123456', status: 'completed', hasTranscript: true },
    { videoId: '222', status: 'transcription_failed', hasTranscript: false },
  ] }));
  assert.equal((await f.post('/api/summarize', { videoIds: ['222'] })).status, 400);
  const summary = await f.post('/api/summarize', { videoIds: ['123456'] });
  assert.equal((await f.jobResult((await summary.json()).jobId)).status, 'completed');
  assert.deepEqual(calls[1], ['summarize', ['123456']]);
});

test('an entire prepared batch of eighty works can be downloaded and summarized', async t => {
  const works = Array.from({ length: 80 }, (_, index) => ({
    url: `https://www.douyin.com/video/${900000 + index}`,
    title: `批量作品 ${index + 1}`,
  }));
  const calls = [];
  const f = await fixture(t, {
    prepare: async () => ({ inputType: 'profile', links: works.map(item => item.url), works }),
    download: async urls => { calls.push(['download', urls]); return { results: urls.map(url => ({
      videoId: url.split('/').at(-1), status: 'completed', hasTranscript: true,
    })) }; },
    summarize: async ids => { calls.push(['summarize', ids]); return { requested: ids.length }; },
  });
  const prepared = await f.post('/api/prepare', { profileUrls: ['https://www.douyin.com/user/batch'], limit: 100 });
  assert.equal((await f.jobResult((await prepared.json()).jobId)).status, 'completed');

  const download = await f.post('/api/download', { urls: works.map(item => item.url) });
  assert.equal(download.status, 202);
  assert.equal((await f.jobResult((await download.json()).jobId)).status, 'completed');
  assert.equal(calls[0][1].length, 80);

  await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'data', 'download-summary.json'), JSON.stringify({
    results: works.map(item => ({ videoId: item.url.split('/').at(-1), status: 'completed', hasTranscript: true })),
  }));
  const summary = await f.post('/api/summarize', { videoIds: works.map(item => item.url.split('/').at(-1)) });
  assert.equal(summary.status, 202);
  assert.equal((await f.jobResult((await summary.json()).jobId)).status, 'completed');
  assert.equal(calls[1][1].length, 80);
});

test('clear discovery deletes candidate reports and leaves unrelated knowledge files intact', async t => {
  const f = await fixture(t);
  const discovery = path.join(f.root, 'data', 'discovery');
  await fs.mkdir(discovery, { recursive: true });
  await fs.writeFile(path.join(discovery, 'topic-2026-01-01.json'), JSON.stringify({ creators: [{ author: '旧候选' }] }));
  await fs.writeFile(path.join(discovery, 'topic-2026-01-01.md'), '# 旧候选');
  await fs.writeFile(path.join(discovery, 'keep.txt'), '保留');

  const response = await f.post('/api/clear-discovery', {});
  assert.equal(response.status, 202);
  const job = await f.jobResult((await response.json()).jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.deleted, 2);
  const state = await fetch(`${f.url}/api/state`).then(reply => reply.json());
  assert.equal(state.discovery, null);
  assert.deepEqual(await fs.readdir(discovery), ['keep.txt']);
});

test('pasted creator share text follows the same manual selection path', async t => {
  const profile = 'https://v.douyin.com/creator123/';
  const f = await fixture(t, {
    prepare: async input => {
      assert.equal(input, profile);
      return { inputType: 'profile', links: ['https://www.douyin.com/video/123456'], works: [{ url: 'https://www.douyin.com/video/123456', title: '订单流转' }] };
    },
  });
  const response = await f.post('/api/prepare', { profileUrls: [`打开主页 ${profile} 复制此链接`], limit: 20 });
  assert.equal((await f.jobResult((await response.json()).jobId)).status, 'completed');
  const state = await fetch(`${f.url}/api/state`).then(reply => reply.json());
  assert.equal(state.prepared.works[0].title, '订单流转');
  assert.equal(state.batch, null, '列作品后不应产生下载批次');
});

test('single-video redirect is not presented as a creator list', async t => {
  const f = await fixture(t, { prepare: async () => ({ inputType: 'work', links: ['https://www.douyin.com/video/123'] }) });
  const reply = await f.post('/api/prepare', { profileUrls: ['https://v.douyin.com/something/'] });
  const job = await f.jobResult((await reply.json()).jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /不是博主主页/);
});

test('topic discovery streams its current phase into the job log', async t => {
  const f = await fixture(t, {
    discover: async (_topic, log) => {
      log('阶段 1/4：正在生成搜索词');
      log('需要本人操作：请完成验证码');
      return { report: { creators: [] } };
    },
  });
  const reply = await f.post('/api/discover', { topic: 'MES实施规划' });
  const job = await f.jobResult((await reply.json()).jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.progress, 100);
  assert.equal(job.message, '本步骤已完成');
  assert.deepEqual(job.logs, ['阶段 1/4：正在生成搜索词', '需要本人操作：请完成验证码']);
});

test('all nine visible creators can be prepared, with duplicate works removed', async t => {
  const f = await fixture(t, { prepare: async () => ({ inputType: 'profile', links: ['https://www.douyin.com/video/321'] }) });
  const response = await f.post('/api/prepare', {
    profileUrls: Array.from({ length: 9 }, (_, n) => `https://www.douyin.com/user/creator${n}`), limit: 20,
  });
  assert.equal(response.status, 202);
  assert.equal((await f.jobResult((await response.json()).jobId)).status, 'completed');
  const state = await fetch(`${f.url}/api/state`).then(r => r.json());
  assert.equal(state.prepared.profiles.length, 9);
  assert.equal(state.prepared.works.length, 1);
});

test('new session cannot submit hidden historical work through the API', async t => {
  const f = await fixture(t, { download: async () => { throw new Error('MUST NOT RUN'); } });
  await fs.mkdir(path.join(f.root, 'queue'), { recursive: true });
  const url = 'https://www.douyin.com/video/123';
  await fs.writeFile(path.join(f.root, 'queue', 'ui-works.json'), JSON.stringify({ works: [{ url }] }));
  assert.equal((await f.post('/api/download', { urls: [url] })).status, 400);
});

test('new creator selection removes previous downstream results without deleting files', async t => {
  const f = await fixture(t, { prepare: async () => ({ inputType: 'profile', links: ['https://www.douyin.com/video/321'] }) });
  await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
  const file = path.join(f.root, 'data', 'download-summary.json');
  await fs.writeFile(file, JSON.stringify({ results: [{ videoId: '111', status: 'completed', hasTranscript: true }] }));
  const response = await f.post('/api/prepare', { profileUrls: ['https://www.douyin.com/user/new'] });
  await f.jobResult((await response.json()).jobId);
  const state = await fetch(`${f.url}/api/state`).then(r => r.json());
  assert.equal(state.batch, null);
  assert.deepEqual(state.knowledgeItems, []);
  assert.equal((await fs.stat(file)).isFile(), true);
});

test('partial download exposes completed transcripts, retry recovers, reset empties every stage', async t => {
  const urls = ['https://www.douyin.com/video/111', 'https://www.douyin.com/video/222'];
  let attempt = 0;
  const f = await fixture(t, {
    prepare: async () => ({ inputType: 'profile', links: urls }),
    download: async () => {
      attempt++;
      const batch = { results: [
        { videoId: '111', status: 'completed', hasTranscript: true },
        { videoId: '222', status: attempt === 1 ? 'transcription_failed' : 'completed', hasTranscript: attempt > 1 },
      ] };
      if (attempt === 1) { const error = new Error('转写超时'); error.batch = batch; throw error; }
      return batch;
    },
  });
  const run = async (route, body) => {
    const response = await f.post(route, body);
    assert.equal(response.status, 202);
    return f.jobResult((await response.json()).jobId);
  };
  await run('/api/prepare', { profileUrls: ['https://www.douyin.com/user/partial'] });
  assert.equal((await run('/api/download', { urls })).status, 'failed');
  let state = await fetch(`${f.url}/api/state`).then(r => r.json());
  assert.equal(state.batch.results.filter(r => r.hasTranscript).length, 1);
  assert.equal((await f.post('/api/summarize', { videoIds: ['222'] })).status, 400);
  assert.equal((await run('/api/download', { urls })).status, 'completed');
  state = await fetch(`${f.url}/api/state`).then(r => r.json());
  assert.equal(state.batch.results.filter(r => r.hasTranscript).length, 2);
  await run('/api/reset', {});
  state = await fetch(`${f.url}/api/state`).then(r => r.json());
  assert.equal(state.discovery, null);
  assert.deepEqual(state.prepared, { works: [] });
  assert.equal(state.batch, null);
  assert.deepEqual(state.knowledgeItems, []);
  assert.equal((await f.post('/api/download', { urls })).status, 400);
});

test('running job rejects duplicate submit, clear and reset without corrupting results', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { prepare: async () => { await hold; return { inputType: 'profile', links: ['https://www.douyin.com/video/111'] }; } });
  const request = { profileUrls: ['https://www.douyin.com/user/busy'] };
  const response = await f.post('/api/prepare', request);
  try {
    for (const [route, body] of [['/api/prepare', request], ['/api/reset', {}], ['/api/clear-discovery', {}]]) {
      assert.equal((await f.post(route, body)).status, 409);
    }
  } finally { release(); }
  assert.equal((await f.jobResult((await response.json()).jobId)).status, 'completed');
});

test('empty results and invalid quantities fail without starting downstream work', async t => {
  const f = await fixture(t, { prepare: async () => ({ inputType: 'profile', links: [] }) });
  for (const limit of [0, 101, -1, 1.5, 'bad']) {
    assert.equal((await f.post('/api/prepare', { profileUrls: ['https://www.douyin.com/user/boundary'], limit })).status, 400);
  }
  for (const body of [null, [], 'bad']) assert.equal((await f.post('/api/download', body)).status, 400);
  for (const urls of [null, {}, 'bad', []]) assert.equal((await f.post('/api/download', { urls })).status, 400);
  const reply = await f.post('/api/prepare', { profileUrls: ['https://www.douyin.com/user/empty'], limit: 100 });
  assert.equal((await f.jobResult((await reply.json()).jobId)).status, 'failed');
});

test('failed summary keeps completed selected knowledge visible and never lists unrelated history', async t => {
  let f;
  f = await fixture(t, {
    prepare: async () => ({ inputType: 'profile', links: ['https://www.douyin.com/video/111', 'https://www.douyin.com/video/222'] }),
    download: async () => ({ results: ['111', '222'].map(videoId => ({ videoId, status: 'completed', hasTranscript: true })) }),
    summarize: async () => {
      const folder = path.join(f.root, 'data', 'knowledge', 'summaries');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'catalog.json'), JSON.stringify({ '111': { status: 'completed' }, '222': { status: 'failed' }, '999': { status: 'completed' } }));
      for (const id of ['111', '999']) await fs.writeFile(path.join(folder, `${id}.json`), JSON.stringify({ summary: { title: id } }));
      await fs.writeFile(path.join(folder, '111.md'), '# 成功稿件\n\n部分失败时仍可编辑。');
      throw new Error('1 条所选知识总结未闭环');
    },
  });
  for (const [route, body] of [
    ['/api/prepare', { profileUrls: ['https://www.douyin.com/user/summary'] }],
    ['/api/download', { urls: ['https://www.douyin.com/video/111', 'https://www.douyin.com/video/222'] }],
    ['/api/summarize', { videoIds: ['111', '222'] }],
  ]) { const reply = await f.post(route, body); await f.jobResult((await reply.json()).jobId); }
  const state = await fetch(`${f.url}/api/state`).then(r => r.json());
  assert.deepEqual(state.knowledgeItems.map(r => r.videoId), ['111']);
  const saved = await fetch(`${f.url}/api/library/knowledge%3A111`);
  assert.equal(saved.status, 200);
  assert.match((await saved.json()).content, /成功稿件/);
});
