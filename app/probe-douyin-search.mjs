#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeCookies } from './prepare-links.mjs';

const [cookieSource, candidateRoot, keyword = 'MES'] = process.argv.slice(2);
if (!cookieSource || !candidateRoot) throw new Error('用法：node probe-douyin-search.mjs <cookies.json> <candidate-root> [keyword]');
const raw = JSON.parse((await fs.readFile(cookieSource, 'utf8')).replace(/^\uFEFF/, ''));
const require = createRequire(path.join(path.resolve(candidateRoot), 'package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: { cookies: normalizeCookies(raw), origins: [] }, locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto(`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('body').waitFor();
  await page.waitForTimeout(5000);
  const details = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    body: document.body.innerText.slice(0, 700),
    links: [...document.querySelectorAll('a[href]')].map(item => item.getAttribute('href')).filter(Boolean).slice(0, 25),
  }));
  console.log(JSON.stringify(details, null, 2));
  await context.close();
} finally {
  await browser.close();
}
