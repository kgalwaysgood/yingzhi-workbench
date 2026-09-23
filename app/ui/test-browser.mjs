import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(here, '..');
const testRoot = path.join(toolRoot, 'runtime');
const vendorPackage = path.resolve(toolRoot, '..', 'vendor', 'video-batch-download', 'package.json');
const transcriptionMarker = path.resolve(toolRoot, '..', 'vendor', 'douyin-downloader-1', '.venv', 'Scripts', 'python.exe');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(testRoot, 'playwright');
const require = createRequire(vendorPackage);
const { chromium } = require('playwright');
const workUrl = 'https://www.douyin.com/video/123456';

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), 'utf8');
}

test('separate screens complete both entry routes and the manual knowledge gates', { timeout: 90000 }, async t => {
  await fs.mkdir(testRoot, { recursive: true });
  const runtime = await fs.mkdtemp(path.join(testRoot, 'ui-browser-test-'));
  let browser;
  let server;
  let createdTranscriptionMarker = false;
  t.after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (createdTranscriptionMarker) {
      await fs.rm(path.resolve(transcriptionMarker, '..', '..'), { recursive: true, force: true });
    }
    if (!path.resolve(runtime).startsWith(`${testRoot}${path.sep}`)) throw new Error('test cleanup escaped the workspace');
    await fs.rm(runtime, { recursive: true, force: true });
  });
  await writeJson(path.join(runtime, 'config', 'cookies.json'), { sessionid: 'browser-test-only' });
  await fs.mkdir(path.join(runtime, 'tmp'), { recursive: true });
  process.env.TEMP = path.join(runtime, 'tmp');
  process.env.TMP = path.join(runtime, 'tmp');
  await fs.mkdir(path.join(runtime, 'models', 'knowledge'), { recursive: true });
  await fs.mkdir(path.join(runtime, 'bin', 'llama-cpp'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'models', 'knowledge', 'Qwen3-4B-Q4_K_M.gguf'), 'test marker');
  await fs.writeFile(path.join(runtime, 'bin', 'llama-cpp', 'llama-server.exe'), 'test marker');
  try {
    await fs.access(transcriptionMarker);
  } catch {
    await fs.mkdir(path.dirname(transcriptionMarker), { recursive: true });
    await fs.writeFile(transcriptionMarker, 'test marker');
    createdTranscriptionMarker = true;
  }

  const operations = {
    discover: async () => {
      const report = { creators: [{ author: '示例博主', profileUrl: 'https://www.douyin.com/user/creator', reason: '示例作品', works: [{ title: '订单流转' }], coveredFacets: ['订单'] }] };
      await writeJson(path.join(runtime, 'data', 'discovery', 'topic-20990101.json'), report);
      return { report };
    },
    prepare: async () => ({ inputType: 'profile', links: [workUrl], works: [{ url: workUrl, title: '订单到交付' }] }),
    download: async urls => {
      assert.deepEqual(urls, [workUrl]);
      const jsonPath = path.join(runtime, 'data', 'item.json');
      await writeJson(jsonPath, { title: '订单到交付', transcript: '销售订单进入计划，计划生成生产工单。' });
      const batch = { runId: 'browser-test', results: [{ videoId: '123456', url: workUrl, jsonPath, title: '订单到交付', status: 'completed', hasTranscript: true }] };
      await writeJson(path.join(runtime, 'data', 'download-summary.json'), batch);
      return batch;
    },
    summarize: async ids => {
      assert.deepEqual(ids, ['123456']);
      const base = path.join(runtime, 'data', 'knowledge', 'summaries');
      await writeJson(path.join(base, 'catalog.json'), { '123456': { status: 'completed' } });
      await writeJson(path.join(base, '123456.json'), {
        video_id: '123456', source_url: workUrl, transcript: '销售订单进入计划，计划生成生产工单。', reviewStatus: 'pending',
        summary: { title: '订单到交付', overview: '订单经计划进入生产。', topic: '生产流程', points: [{ claim: '计划生成工单', quote: '计划生成生产工单' }], limitations: ['请人工复核'] },
      });
      await fs.writeFile(path.join(base, '123456.md'), '# 订单到交付\n\n来源：https://www.douyin.com/video/123456', 'utf8');
      return { completed: 1 };
    },
  };
  ({ server } = createWorkbench({ runtimeRoot: runtime, operations }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.querySelector('#prepareManualButton').disabled === false);
  assert.equal(await page.locator('.screen:visible').count(), 1);
  await page.locator('#profileInput').fill('https://www.douyin.com/user/creator');
  await page.locator('#prepareManualButton').click();
  await page.waitForURL(/#\/works$/);
  assert.equal(await page.locator('.screen:visible').count(), 1);
  assert.equal(await page.locator('#worksList .item-row').count(), 1);
  assert.equal(await page.locator('#downloadButton').isDisabled(), true);
  await page.locator('#worksList input[type="checkbox"]').check();
  await page.locator('#downloadButton').click();
  await page.waitForURL(/#\/transcripts$/);
  await page.locator('#transcriptList button').first().click();
  await page.waitForFunction(() => document.querySelector('#inspectorContent').textContent.includes('销售订单进入计划'));
  assert.match(await page.locator('#inspectorContent').innerText(), /销售订单进入计划/);
  await page.locator('#transcriptList input[type="checkbox"]').check();
  await page.locator('#summarizeButton').click();
  await page.waitForURL(/#\/knowledge$/);
  await page.locator('#knowledgeList button').click();
  await page.waitForFunction(() => document.querySelector('#inspectorContent').textContent.includes('计划生成生产工单'));
  assert.match(await page.locator('#inspectorContent').innerText(), /计划生成生产工单/);
  assert.equal(await page.locator('.screen:visible').count(), 1);

  await page.locator('[data-route="source"]').click();
  await page.locator('#topicInput').fill('ERP订单到客户交付的数据流');
  await page.locator('#discoverForm button').click();
  await page.waitForURL(/#\/creators$/);
  assert.equal(await page.locator('#creatorList .creator-card').count(), 1);
  await page.locator('#creatorList input[type="checkbox"]').check();
  await page.locator('#prepareButton').click();
  await page.waitForURL(/#\/works$/);
  assert.match(await page.locator('#worksBackButton').innerText(), /博主选择/);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${baseUrl}/#/source`);
  await mobile.waitForFunction(() => document.querySelector('#profileInput').disabled === false);
  assert.equal(await mobile.locator('.screen:visible').count(), 1);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
});
