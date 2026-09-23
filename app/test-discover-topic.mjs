import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeterministicSearchPlan, collectSearchMetadata, discoverTopic, enrichSearchResults, groupCreators, isChallengeTitle, mergeResolvedWorkAuthor, normalizeSearchResults, rankCreatorsDeterministically, resolveMissingWorkAuthors, validateKeywords, validateRanking } from './discover-topic.mjs';

const toolRoot = path.dirname(fileURLToPath(import.meta.url));

test('limits model search terms and removes duplicates', () => {
  assert.deepEqual(validateKeywords({ keywords: ['ERP订单', 'ERP订单', 'MES工单', 'WMS入库'], facets: ['订单', '交付'] }), {
    keywords: ['ERP订单', 'MES工单', 'WMS入库'], facets: ['订单', '交付'],
  });
  assert.throws(() => validateKeywords({ keywords: [], facets: [] }), /无效/);
});

test('builds fast rule-based search terms without loading a model', () => {
  const plan = buildDeterministicSearchPlan('学习ERP订单到MES生产和客户交付数据流');
  assert.ok(plan.keywords.includes('ERP订单'));
  assert.ok(plan.keywords.includes('MES生产工单'));
  assert.ok(plan.facets.includes('销售订单'));
  assert.ok(plan.facets.includes('发货交付'));
  assert.ok(plan.keywords.length <= 4);
});

test('recognizes a verification interstitial even when the page body is blank', () => {
  assert.equal(isChallengeTitle('验证码中间页'), true);
  assert.equal(isChallengeTitle('发现更多精彩视频 - 抖音搜索'), false);
});

test('keeps only canonical Douyin links and does not invent profile URLs', () => {
  const rows = normalizeSearchResults([
    { workUrl: '/video/1234567890?x=1', profileUrl: '/user/creator1', title: 'ERP订单流转', author: '老师' },
    { workUrl: '/video/1234567890', profileUrl: '/user/creator1', title: '重复', author: '老师' },
    { workUrl: 'https://evil.test/video/123', profileUrl: 'https://evil.test/user/1' },
  ], 'ERP订单');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profileUrl, 'https://www.douyin.com/user/creator1');
  assert.equal(rows[0].workUrl, 'https://www.douyin.com/video/1234567890');
  assert.equal(normalizeSearchResults([{ workUrl: '/video/2', profileUrl: 'https://evil.test/user/1' }], 'x')[0].profileUrl, '');
});

test('enriches a search work only from observed Douyin author metadata', () => {
  const metadata = collectSearchMetadata({ data: [{ aweme_info: {
    aweme_id: '1234567890', desc: 'MES落地案例', author: { nickname: '众德数字化', sec_uid: 'MS4wLjAB-test' },
  } }] });
  const [result] = enrichSearchResults(normalizeSearchResults([
    { workUrl: '/video/1234567890', title: '搜索卡片标题' },
  ], 'MES落地'), metadata);
  assert.equal(result.author, '众德数字化');
  assert.equal(result.profileUrl, 'https://www.douyin.com/user/MS4wLjAB-test');
  assert.equal(result.title, 'MES落地案例');
});

test('does not offer creators without a verified profile URL', () => {
  const creators = groupCreators(normalizeSearchResults([
    { workUrl: '/video/1234567890', title: 'MES落地案例' },
  ], 'MES落地'));
  assert.deepEqual(rankCreatorsDeterministically(creators, ['MES落地']), []);
});

test('detail metadata turns an unselectable work into a verified creator work', () => {
  const work = { workUrl: 'https://www.douyin.com/video/123', profileUrl: '', author: '', title: '旧标题', keyword: 'MES' };
  const merged = mergeResolvedWorkAuthor(work, {
    title: 'MES落地', author: { nickname: '众德数字化', url: 'https://www.douyin.com/user/MS4wLjAB-test' },
  });
  assert.equal(merged.author, '众德数字化');
  assert.equal(merged.profileUrl, 'https://www.douyin.com/user/MS4wLjAB-test');
});

test('detail fallback stops after enough verified creators and excludes failed guesses', async () => {
  const works = Array.from({ length: 5 }, (_, index) => ({
    workUrl: `https://www.douyin.com/video/${index + 1}`, profileUrl: '', author: '', title: '', keyword: 'MES',
  }));
  const calls = [];
  const resolved = await resolveMissingWorkAuthors(works, {
    targetCreators: 2, concurrency: 1,
    parseWork: async work => {
      calls.push(work.workUrl);
      if (work.workUrl.endsWith('/1')) throw new Error('unavailable');
      const id = work.workUrl.split('/').at(-1);
      return { author: { nickname: `作者${id}`, url: `https://www.douyin.com/user/author-${id}` } };
    },
  });
  assert.equal(resolved.verifiedCreators, 2);
  assert.equal(resolved.failures, 1);
  assert.equal(calls.length, 3);
  assert.equal(resolved.works[0].profileUrl, '');
});

test('ranking accepts only observed creator IDs', () => {
  const creators = groupCreators(normalizeSearchResults([{ workUrl: '/video/1234567890', profileUrl: '/user/a', title: 'MES工单', author: 'A' }], 'MES'));
  const ranking = validateRanking({ creators: [{ id: 999, reason: 'hallucinated', covered_facets: [] }, { id: 1, reason: '工单相关', covered_facets: ['MES工单'] }] }, creators);
  assert.equal(ranking.length, 1);
  assert.equal(ranking[0].author, 'A');
});

test('deterministic ranking prefers broader search evidence and never invents creators', () => {
  const creators = groupCreators([
    ...normalizeSearchResults([{ workUrl: '/video/1', profileUrl: '/user/a', title: 'MES实施', author: 'A' }], 'MES实施'),
    ...normalizeSearchResults([{ workUrl: '/video/2', profileUrl: '/user/a', title: 'MES集成', author: 'A' }], 'MES集成'),
    ...normalizeSearchResults([{ workUrl: '/video/3', profileUrl: '/user/b', title: 'MES实施', author: 'B' }], 'MES实施'),
  ]);
  const ranking = rankCreatorsDeterministically(creators, ['MES实施', 'MES集成']);
  assert.equal(ranking[0].author, 'A');
  assert.deepEqual(ranking[0].coveredFacets, ['MES实施', 'MES集成']);
  assert.equal(ranking.some(item => item.author === '未观察作者'), false);
});

test('writes a candidate report without downloading videos or storing keys', async () => {
  await fs.mkdir(path.join(toolRoot, 'runtime'), { recursive: true });
  const root = await fs.mkdtemp(path.join(toolRoot, 'runtime', 'topic-test-'));
  try {
    let calls = 0;
    const progress = [];
    const { report, markdownPath, jsonPath } = await discoverTopic('学习ERP订单到客户交付完整数据流', {
      cookieSource: 'not-used', candidateRoot: 'not-used', outputRoot: root,
      onProgress: message => progress.push(message),
      generate: async () => {
        calls += 1;
        return { keywords: ['ERP订单 MES工单'], facets: ['ERP订单', 'MES工单'] };
      },
      search: async () => ({ works: normalizeSearchResults([{ workUrl: '/video/1234567890', profileUrl: '/user/a', title: 'MES工单流转', author: 'A' }], 'ERP订单 MES工单'), warnings: [] }),
    });
    assert.equal(report.creators.length, 1);
    assert.equal(calls, 1, '主题发现只应调用一次本地模型');
    assert.match(progress[0], /阶段 1\/4/);
    assert.match(progress.at(-1), /阶段 4\/4 已完成/);
    assert.match(await fs.readFile(markdownPath, 'utf8'), /候选清单，尚未逐条观看或核实/);
    assert.doesNotMatch(await fs.readFile(jsonPath, 'utf8'), /API Key/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
