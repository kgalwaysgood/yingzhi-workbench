#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { stopLocalModel } from './local-model-provider.mjs';
import { normalizeWorkLink } from './prepare-links.mjs';
import { browserLaunchOptions, launchAccountBrowser, readAccountState, saveAccountState } from './ui/account-session.mjs';

const keywordSchema = {
  type: 'object',
  properties: {
    keywords: { type: 'array', items: { type: 'string' } },
    facets: { type: 'array', items: { type: 'string' } },
  },
  required: ['keywords', 'facets'],
  additionalProperties: false,
};

export function validateKeywords(value) {
  if (!Array.isArray(value?.keywords) || !Array.isArray(value?.facets)) throw new Error('模型未返回搜索词和业务环节');
  const keywords = [...new Set(value.keywords.map(item => String(item).trim()))].filter(item => item.length >= 2 && item.length <= 40).slice(0, 4);
  const facets = [...new Set(value.facets.map(item => String(item).trim()))].filter(item => item.length >= 2 && item.length <= 30).slice(0, 8);
  if (!keywords.length || !facets.length) throw new Error('模型生成的搜索词或业务环节无效');
  return { keywords, facets };
}

const SEARCH_RULES = [
  { match: /MES/i, keywords: ['MES生产工单', 'MES实施', 'MES现场报工'], facets: ['生产计划', '工单执行', '现场报工', '异常闭环'] },
  { match: /ERP/i, keywords: ['ERP订单', 'ERP MRP', 'ERP MES集成'], facets: ['销售订单', '物料需求', '系统集成'] },
  { match: /WMS/i, keywords: ['WMS入库', 'WMS出库'], facets: ['完工入库', '发货出库'] },
  { match: /订单/, keywords: ['订单流转'], facets: ['订单接收', '订单履约'] },
  { match: /交付|发货/, keywords: ['生产交付'], facets: ['发货交付', '质量检验'] },
  { match: /设备|维修|故障/, keywords: ['设备维修', '故障闭环'], facets: ['故障报修', '维修处理', '验收闭环'] },
];

export function buildDeterministicSearchPlan(topic) {
  const normalized = String(topic || '').replace(/[，。；、！？,.!?;:\s]+/g, ' ').trim();
  const compact = normalized.replace(/^(我想|想要|请帮我|学习|了解)+/u, '').trim() || normalized;
  const keywords = [];
  const secondaryKeywords = [];
  const facets = [];
  const secondaryFacets = [];
  for (const rule of SEARCH_RULES) {
    if (!rule.match.test(normalized)) continue;
    keywords.push(rule.keywords[0]);
    secondaryKeywords.push(...rule.keywords.slice(1));
    facets.push(rule.facets[0]);
    secondaryFacets.push(...rule.facets.slice(1));
  }
  if (!keywords.length && compact.length >= 2) keywords.push(compact.slice(0, 30));
  keywords.push(...secondaryKeywords);
  facets.push(...secondaryFacets);
  if (!facets.length) facets.push('业务流程', '实施方法', '异常处理', '落地案例');
  return validateKeywords({ keywords, facets });
}

export function normalizeSearchResults(rows, keyword) {
  const results = new Map();
  for (const row of rows) {
    const workUrl = normalizeWorkLink(row.workUrl);
    if (!workUrl) continue;
    let profileUrl = '';
    try {
      const candidate = new URL(row.profileUrl || '', 'https://www.douyin.com');
      if (['douyin.com', 'www.douyin.com'].includes(candidate.hostname) && /^\/user\/[^/]+\/?$/.test(candidate.pathname)) {
        profileUrl = `https://www.douyin.com${candidate.pathname}`;
      }
    } catch { /* A missing author link is recorded, not guessed. */ }
    const title = String(row.title || row.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const author = String(row.author || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!results.has(workUrl)) results.set(workUrl, { workUrl, profileUrl, title, author, keyword });
  }
  return [...results.values()];
}

export function collectSearchMetadata(value, target = new Map()) {
  const stack = [value];
  const visited = new Set();
  let inspected = 0;
  while (stack.length && inspected < 50_000) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    const item = current.aweme_info && typeof current.aweme_info === 'object' ? current.aweme_info : current;
    const workId = String(item.aweme_id || item.awemeId || '').trim();
    const author = item.author && typeof item.author === 'object' ? item.author : null;
    const secUid = String(author?.sec_uid || author?.secUid || '').trim();
    if (/^\d+$/.test(workId) && secUid) {
      target.set(workId, {
        author: String(author.nickname || author.unique_id || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        profileUrl: `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
        title: String(item.desc || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    }
    for (const nested of Array.isArray(current) ? current : Object.values(current)) {
      if (nested && typeof nested === 'object') stack.push(nested);
    }
  }
  return target;
}

export function enrichSearchResults(results, metadata) {
  return results.map(result => {
    const workId = result.workUrl.match(/\/(?:video|note)\/(\d+)$/)?.[1];
    const detail = workId ? metadata.get(workId) : null;
    if (!detail) return result;
    return {
      ...result,
      author: detail.author || result.author,
      profileUrl: detail.profileUrl || result.profileUrl,
      title: detail.title || result.title,
    };
  });
}

export function mergeResolvedWorkAuthor(work, parsed) {
  const author = parsed?.author;
  let profileUrl = '';
  try {
    const candidate = new URL(author?.url || '');
    if (['douyin.com', 'www.douyin.com'].includes(candidate.hostname.toLowerCase())
        && /^\/user\/[^/]+\/?$/.test(candidate.pathname)) {
      profileUrl = `https://www.douyin.com${candidate.pathname}`;
    }
  } catch { /* Only verified Douyin profile URLs are accepted. */ }
  if (!profileUrl) return work;
  return {
    ...work,
    profileUrl,
    author: String(author?.nickname || work.author || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    title: String(parsed?.description || parsed?.title || work.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  };
}

export async function resolveMissingWorkAuthors(works, {
  parseWork,
  onProgress = () => {},
  targetCreators = 10,
  concurrency = 3,
}) {
  const resolved = [...works];
  const unresolvedIndexes = resolved.map((item, index) => item.profileUrl ? -1 : index).filter(index => index >= 0);
  const profiles = new Set(resolved.map(item => item.profileUrl).filter(Boolean));
  let failures = 0;
  for (let cursor = 0; cursor < unresolvedIndexes.length && profiles.size < targetCreators; cursor += concurrency) {
    const indexes = unresolvedIndexes.slice(cursor, cursor + concurrency);
    onProgress(`阶段 2/4：正在从作品详情核对博主身份 ${cursor + 1}-${Math.min(cursor + indexes.length, unresolvedIndexes.length)}/${unresolvedIndexes.length}`);
    const batch = await Promise.all(indexes.map(async index => {
      try { return { index, parsed: await parseWork(resolved[index]) }; }
      catch { failures += 1; return { index, parsed: null }; }
    }));
    for (const { index, parsed } of batch) {
      resolved[index] = mergeResolvedWorkAuthor(resolved[index], parsed);
      if (resolved[index].profileUrl) profiles.add(resolved[index].profileUrl);
    }
  }
  return { works: resolved, failures, verifiedCreators: profiles.size };
}

export async function resolveWorkAuthorsFromDetails(works, { candidateRoot, storageState, onProgress = () => {} }) {
  if (!works.some(item => !item.profileUrl)) return { works, failures: 0, verifiedCreators: new Set(works.map(item => item.profileUrl)).size };
  const browserModule = pathToFileURL(path.join(path.resolve(candidateRoot), 'scripts', 'utils', 'browser-manager.js')).href;
  const parserModule = pathToFileURL(path.join(path.resolve(candidateRoot), 'scripts', 'platforms', 'douyin.js')).href;
  const [{ BrowserManager }, { DouyinParser }] = await Promise.all([import(browserModule), import(parserModule)]);
  const browserManager = new BrowserManager(false);
  try {
    return await resolveMissingWorkAuthors(works, {
      onProgress,
      parseWork: work => new DouyinParser().parse(browserManager, work.workUrl, {
        storageState,
        pageTimeoutMs: 45_000,
        mediaWaitMs: 8_000,
      }),
    });
  } finally {
    await browserManager.close();
  }
}

export function groupCreators(works) {
  const grouped = new Map();
  for (const work of works) {
    const key = work.profileUrl || `unknown:${work.author || work.workUrl}`;
    const group = grouped.get(key) || { id: grouped.size + 1, author: work.author || '作者待核对', profileUrl: work.profileUrl, works: [] };
    if (!group.works.some(item => item.workUrl === work.workUrl)) group.works.push(work);
    grouped.set(key, group);
  }
  return [...grouped.values()];
}

export function validateRanking(value, creators) {
  if (!Array.isArray(value?.creators)) throw new Error('模型未返回候选博主清单');
  const byId = new Map(creators.map(item => [item.id, item]));
  const seen = new Set();
  return value.creators.map(item => {
    const original = byId.get(item.id);
    if (!original || seen.has(item.id)) return null;
    seen.add(item.id);
    return {
      ...original,
      reason: String(item.reason || '').trim().slice(0, 300),
      coveredFacets: Array.isArray(item.covered_facets) ? item.covered_facets.map(text => String(text).trim()).filter(Boolean).slice(0, 8) : [],
    };
  }).filter(Boolean);
}

export function rankCreatorsDeterministically(creators, facets, limit = 10) {
  const selectable = creators.filter(item => item.profileUrl);
  return selectable.map(creator => {
    const keywords = [...new Set(creator.works.map(item => item.keyword).filter(Boolean))];
    const evidence = creator.works.map(item => `${item.title || ''} ${item.keyword || ''}`).join(' ');
    const coveredFacets = facets.filter(facet => evidence.includes(facet));
    const score = keywords.length * 100 + creator.works.length * 10 + coveredFacets.length * 5 + (creator.profileUrl ? 1 : 0);
    return {
      ...creator,
      reason: `命中 ${keywords.length} 个搜索词、${creator.works.length} 条候选作品；按可核对的搜索结果确定性排序`,
      coveredFacets,
      score,
    };
  }).sort((left, right) => right.score - left.score || left.id - right.id)
    .slice(0, limit)
    .map(({ score: _score, ...creator }) => creator);
}

function makeSearchUrl(keyword) {
  return `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
}

export function isChallengeTitle(title) {
  return /验证码|验证中间页|安全验证/.test(String(title));
}

export async function searchDouyinKeywords(keywords, {
  cookieSource,
  candidateRoot,
  limit = 10,
  headed = false,
  onProgress = () => {},
  verificationTimeoutMs = 120_000,
  storageState,
  launchBrowser = options => launchAccountBrowser(candidateRoot, options),
  resolveAuthors = resolveWorkAuthorsFromDetails,
  onCredentials = () => {},
}) {
  const { cookies } = await readAccountState(cookieSource, storageState);
  if (!cookies.length) throw new Error('抖音登录信息为空，请先执行菜单 1');
  const browser = await launchBrowser(browserLaunchOptions(headed === true));
  try {
    const context = await browser.newContext({ storageState: { cookies, origins: [] }, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const works = [];
    const warnings = [];
    const searchMetadata = new Map();
    const pendingMetadata = new Set();
    page.on('response', response => {
      const responseUrl = response.url();
      const contentType = response.headers()['content-type'] || '';
      if (!/\/search\//.test(responseUrl) || !/json/i.test(contentType) || !response.ok()) return;
      const pending = response.json()
        .then(value => collectSearchMetadata(value, searchMetadata))
        .catch(() => {})
        .finally(() => pendingMetadata.delete(pending));
      pendingMetadata.add(pending);
    });
    for (const [index, keyword] of keywords.entries()) {
      const searchMessage = `第 ${index + 1}/${keywords.length} 个搜索词：${keyword}`;
      onProgress(`阶段 2/4：正在打开抖音搜索，${searchMessage}`);
      console.log(`[主题发现] 搜索：${keyword}`);
      await page.goto(makeSearchUrl(keyword), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (isChallengeTitle(await page.title())) {
        if (headed !== true) throw new Error('抖音返回验证码页面，后台搜索已停止；请点击应用内验证重试，本次才会打开可见浏览器');
        console.log('[主题发现] 抖音要求验证，请在打开的浏览器中由本人完成，最多等待 2 分钟。');
        const deadline = Date.now() + verificationTimeoutMs;
        let remaining = verificationTimeoutMs;
        while (remaining > 0 && isChallengeTitle(await page.title())) {
          onProgress(`需要本人操作：请在弹出的抖音浏览器完成验证码，剩余约 ${Math.ceil(remaining / 1000)} 秒`);
          const slice = Math.min(15_000, remaining);
          await page.locator('a[href*="/video/"], a[href*="/note/"]').first()
            .waitFor({ state: 'attached', timeout: slice }).catch(() => {});
          remaining = deadline - Date.now();
        }
      }
      await page.locator('a[href*="/video/"], a[href*="/note/"]').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
      if (isChallengeTitle(await page.title())) {
        throw new Error('弹出的抖音浏览器仍停在验证码页面，2分钟内未完成验证，本次搜索已停止；请先在抖音完成人工验证，再点击“搜索候选博主”重试');
      }
      const body = (await page.locator('body').innerText()).slice(0, 2000);
      if (/登录后即可搜索|请先登录|扫码登录/.test(body)) throw new Error('抖音登录信息已失效或未在此浏览器生效，请先执行菜单 1');
      if (/验证码|安全验证|请完成验证/.test(body) && !(await page.locator('a[href*="/video/"]').count())) {
        throw new Error('抖音要求人工验证；已停止采集，请在本人浏览器完成验证后重试');
      }
      const rows = await page.locator('a[href*="/video/"], a[href*="/note/"]').evaluateAll((anchors, max) => anchors.slice(0, max * 4).map(anchor => {
        let card = anchor;
        for (let depth = 0; depth < 5 && card.parentElement; depth += 1) {
          const parent = card.parentElement;
          if (parent.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').length > 2) break;
          card = parent;
          if (card.querySelector('a[href*="/user/"]')) break;
        }
        const profile = card.querySelector('a[href*="/user/"]');
        return {
          workUrl: anchor.getAttribute('href'),
          profileUrl: profile?.getAttribute('href') || '',
          author: profile?.textContent || '',
          title: anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.querySelector('img')?.getAttribute('alt') || '',
          text: card.textContent || '',
        };
      }), limit);
      await Promise.allSettled([...pendingMetadata]);
      const found = enrichSearchResults(normalizeSearchResults(rows, keyword), searchMetadata).slice(0, limit);
      if (!found.length) warnings.push(`“${keyword}”未获取到作品；可能是结果为空、页面变更或搜索受限。`);
      onProgress(found.length
        ? `阶段 2/4：${searchMessage}，取得 ${found.length} 条候选作品`
        : `阶段 2/4：${searchMessage}，没有取得可核对作品`);
      works.push(...found);
    }
    const refreshed = headed === true ? await context.storageState() : null;
    await context.close();
    await browser.close();
    const uniqueWorks = [...new Map(works.map(item => [item.workUrl, item])).values()];
    const resolved = await resolveAuthors(uniqueWorks, {
      candidateRoot,
      storageState: refreshed || { cookies, origins: [] },
      onProgress,
    });
    if (resolved.failures) warnings.push(`${resolved.failures} 条作品未能核对博主身份，已排除不可选择项。`);
    onProgress(`阶段 2/4：已核对 ${resolved.verifiedCreators} 名具有真实主页的候选博主`);
    if (refreshed && resolved.works.some(work => work.profileUrl)) await onCredentials(refreshed);
    return { works: resolved.works, warnings };
  } finally {
    await browser.close();
  }
}

function renderReport(report) {
  const lines = [
    `# 抖音主题发现：${report.topic}`, '',
    `- 生成时间：${report.createdAt}`, `- 搜索词：${report.keywords.join('、')}`,
    `- 业务环节：${report.facets.join('、')}`,
    '- 状态：候选清单，尚未逐条观看或核实；模型仅依据搜索元数据初筛。',
    '- 下一步：人工核对博主主页和代表作品，确认后将主页链接交给菜单 2。', '',
  ];
  if (report.warnings.length) lines.push('## 采集限制', '', ...report.warnings.map(item => `- ${item}`), '');
  lines.push('## 候选博主', '');
  for (const [index, creator] of report.creators.entries()) {
    lines.push(`### ${index + 1}. ${creator.author}`, '',
      `- 主页：${creator.profileUrl || '未从搜索页取得，需人工核对'}`,
      `- 初筛理由：${creator.reason || '搜索结果相关，待人工核对'}`,
      `- 覆盖环节：${creator.coveredFacets.join('、') || '待核对'}`,
      `- 搜索命中作品：${creator.works.length}`, '',
      ...creator.works.map(work => `- [${work.title || '标题待核对'}](${work.workUrl})（搜索词：${work.keyword}）`), '');
  }
  return `${lines.join('\n')}\n`;
}

export async function discoverTopic(topic, {
  cookieSource,
  candidateRoot,
  outputRoot,
  limit = 10,
  headed = false,
  storageState = path.resolve(path.dirname(cookieSource), '..', 'private', 'playwright-storage-state.json'),
  generate,
  search = searchDouyinKeywords,
  onProgress = () => {},
}) {
  if (typeof topic !== 'string' || topic.trim().length < 4 || topic.length > 160) throw new Error('请用 4 到 160 字描述想学习的业务主题');
  try {
    onProgress('阶段 1/4：正在生成搜索方案');
    const plan = generate
      ? validateKeywords(await generate(
        `请为学习目标生成最多4个能在抖音搜索到具体视频的短关键词，以及最多8个应覆盖的业务环节。关键词要覆盖不同节点，不要只重复整句话。学习目标：${topic}`,
        keywordSchema,
        384,
        true,
      ))
      : buildDeterministicSearchPlan(topic);
    onProgress(`阶段 1/4 已完成：准备搜索 ${plan.keywords.length} 个关键词（${plan.keywords.join('、')}）`);
    let refreshed;
    const { works, warnings } = await search(plan.keywords, {
      cookieSource, storageState, candidateRoot, limit, headed: headed === true, onProgress,
      onCredentials: value => { refreshed = value; },
    });
    if (!works.length) throw new Error(`未取得可核对的抖音作品，未生成博主推荐。${warnings.join(' ')}`);
    const creators = groupCreators(works);
    onProgress(`阶段 3/4：正在按搜索命中和证据完整度给 ${creators.length} 名候选博主评分`);
    const ranking = rankCreatorsDeterministically(creators, plan.facets, 10);
    if (!ranking.length) throw new Error('搜索结果没有取得可验证的博主主页，因此未生成不可选择的候选项；请完成抖音验证后重试，或直接粘贴博主主页链接');
    onProgress('阶段 4/4：正在保存候选博主清单和可追溯报告');
    const report = {
      topic: topic.trim(), createdAt: new Date().toISOString(),
      provider: generate ? 'injected-keywords+deterministic-ranking' : 'rule-keywords+deterministic-ranking',
      keywords: plan.keywords, facets: plan.facets, warnings, creators: ranking,
    };
    const directory = path.join(outputRoot, 'discovery');
    await fs.mkdir(directory, { recursive: true });
    const name = `topic-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const jsonPath = path.join(directory, `${name}.json`);
    const markdownPath = path.join(directory, `${name}.md`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await fs.writeFile(markdownPath, renderReport(report), 'utf8');
    if (headed === true && refreshed) await saveAccountState({ cookieSource, storageState }, refreshed);
    onProgress(`阶段 4/4 已完成：取得 ${ranking.length} 名候选博主、${works.length} 条候选作品`);
    console.log(`候选博主 ${ranking.length} 名，作品 ${works.length} 条。\n报告：${markdownPath}`);
    return { report, jsonPath, markdownPath };
  } finally {
    // Topic discovery is rule-first; the local model remains reserved for knowledge summarization.
  }
}

function parseArgs(argv) {
  const options = { topic: '', cookieSource: '', candidateRoot: '', outputRoot: '', limit: 10, headed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--headed') { options.headed = true; continue; }
    if (!['--topic', '--cookie-source', '--candidate-root', '--output-root', '--limit'].includes(flag) || index + 1 >= argv.length) {
      throw new Error(`参数无效：${flag}`);
    }
    const value = argv[++index];
    if (flag === '--topic') options.topic = value;
    if (flag === '--cookie-source') options.cookieSource = value;
    if (flag === '--candidate-root') options.candidateRoot = value;
    if (flag === '--output-root') options.outputRoot = value;
    if (flag === '--limit') options.limit = Number(value);
  }
  if (!options.cookieSource || !options.candidateRoot || !options.outputRoot) throw new Error('缺少运行路径参数');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) throw new Error('每个搜索词只能检查 1 到 20 条');
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await discoverTopic(options.topic, options);
  } catch (error) {
    console.error(`主题发现未完成：${error.message}`);
    process.exitCode = 2;
  } finally {
    await stopLocalModel();
  }
}
