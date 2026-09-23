#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { browserLaunchOptions, launchAccountBrowser, readAccountState, saveAccountState } from './ui/account-session.mjs';

const WORK_PATH_PATTERN = /^\/(video|note)\/(\d+)\/?$/;
const PROFILE_PATH_PATTERN = /^\/user\/[^/]+\/?$/;

export function isDouyinUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "douyin.com" || hostname.endsWith(".douyin.com");
  } catch {
    return false;
  }
}

export function normalizeWorkLink(value) {
  try {
    const parsed = new URL(value, "https://www.douyin.com");
    if (!["douyin.com", "www.douyin.com"].includes(parsed.hostname.toLowerCase())) return null;
    const match = parsed.pathname.match(WORK_PATH_PATTERN);
    return match ? `https://www.douyin.com/${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

export function isProfileLink(value) {
  try {
    const parsed = new URL(value);
    return ["douyin.com", "www.douyin.com"].includes(parsed.hostname.toLowerCase())
      && PROFILE_PATH_PATTERN.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function normalizeCookies(raw) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.cookies) ? raw.cookies : null;
  if (source) {
    return source
      .filter((item) => item && item.name && item.value !== undefined)
      .map((item) => ({
        name: String(item.name),
        value: String(item.value),
        domain: item.domain || ".douyin.com",
        path: item.path || "/",
        expires: Number.isFinite(item.expires) ? item.expires : -1,
        httpOnly: Boolean(item.httpOnly),
        secure: item.secure !== false,
        sameSite: ["Strict", "Lax", "None"].includes(item.sameSite) ? item.sameSite : "Lax",
      }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, value]) => value !== null && value !== undefined && String(value) !== "")
      .map(([name, value]) => ({
        name,
        value: String(value),
        domain: ".douyin.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      }));
  }
  throw new Error("登录信息格式不受支持，请重新执行菜单 1 获取登录信息。");
}

function parseArgs(argv) {
  const options = { input: "", cookieSource: "", storageState: "", links: "", manifest: "", candidateRoot: "", limit: 20, headed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少参数值`);
      return argv[index];
    };
    if (arg === "--input") options.input = next();
    else if (arg === "--cookie-source") options.cookieSource = next();
    else if (arg === "--storage-state") options.storageState = next();
    else if (arg === "--links") options.links = next();
    else if (arg === "--manifest") options.manifest = next();
    else if (arg === "--candidate-root") options.candidateRoot = next();
    else if (arg === "--limit") options.limit = Number.parseInt(next(), 10);
    else if (arg === "--headed") options.headed = true;
    else throw new Error(`未知参数：${arg}`);
  }
  for (const required of ["input", "cookieSource", "storageState", "links", "manifest", "candidateRoot"]) {
    if (!options[required]) throw new Error(`缺少必要参数：${required}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
    throw new Error("作品数量必须是 1 到 200 的整数。");
  }
  return options;
}

async function writeJson(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(value, null, 2), "utf8");
}

async function collectProfileLinks(page, limit) {
  const works = [];
  const seen = new Set();
  let stableRounds = 0;

  for (let round = 0; round < 30 && works.length < limit && stableRounds < 4; round += 1) {
    const before = works.length;
    const rows = await page.locator('a[href*="/video/"], a[href*="/note/"]').evaluateAll(
      (elements) => elements.map((element) => ({
        href: element.getAttribute('href'),
        title: element.getAttribute('aria-label') || element.getAttribute('title') || element.querySelector('img')?.getAttribute('alt') || element.textContent || '',
      })).filter((item) => item.href),
    );
    for (const row of rows) {
      const normalized = normalizeWorkLink(row.href);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        works.push({ url: normalized, title: String(row.title).replace(/\s+/g, ' ').trim().slice(0, 160) });
      }
    }
    stableRounds = works.length === before ? stableRounds + 1 : 0;
    if (works.length >= limit) break;
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(1_500);
  }
  return works.slice(0, limit);
}

export async function prepareLinks(options) {
  if (!isDouyinUrl(options.input)) {
    throw new Error("输入不是有效的抖音链接。");
  }
  const storageState = await readAccountState(options.cookieSource, options.storageState);
  if (storageState.cookies.length === 0) throw new Error("登录信息为空，请重新执行菜单 1。");

  const directWork = normalizeWorkLink(options.input);
  let result;
  let refreshed;
  if (directWork) {
    result = { sourceUrl: options.input, finalUrl: directWork, inputType: "work", requested: 1, found: 1, links: [directWork], works: [{ url: directWork, title: '' }] };
  } else {
    const launchBrowser = options.launchBrowser || (launch => launchAccountBrowser(options.candidateRoot, launch));
    const browser = await launchBrowser(browserLaunchOptions(options.headed === true));
    try {
      const context = await browser.newContext({
        storageState,
        locale: "zh-CN",
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      await page.goto(options.input, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(5_000);
      const challenged = async () => /验证码|验证中间页|安全验证/.test(await page.title());
      if (await challenged()) {
        if (options.headed !== true) throw new Error('抖音返回验证码页面，后台列作品已停止；请点击应用内验证重试');
        const deadline = Date.now() + (options.verificationTimeoutMs ?? 120_000);
        while (await challenged() && Date.now() < deadline) await page.waitForTimeout(Math.min(1000, deadline - Date.now()));
        if (await challenged()) throw new Error('验证码未完成，本次列作品已停止，原登录信息保留');
      }
      if (new URL(options.input).hostname.toLowerCase() === "v.douyin.com" && isDouyinHome(page.url())) {
        await page.waitForURL((url) => isProfileLink(url.href) || Boolean(normalizeWorkLink(url.href)), { timeout: 15_000 }).catch(() => {});
      }
      const finalUrl = page.url();
      const redirectedWork = normalizeWorkLink(finalUrl);
      if (redirectedWork) {
        result = { sourceUrl: options.input, finalUrl, inputType: "work", requested: 1, found: 1, links: [redirectedWork], works: [{ url: redirectedWork, title: '' }] };
      } else if (isProfileLink(finalUrl)) {
        const works = await collectProfileLinks(page, options.limit);
        result = {
          sourceUrl: options.input,
          finalUrl,
          inputType: "profile",
          title: await page.title(),
          requested: options.limit,
          found: works.length,
          links: works.map((work) => work.url),
          works,
        };
      } else {
        throw new Error(invalidRedirectMessage(options.input, finalUrl));
      }
      if (options.headed === true && result.links.length && (!options.requireProfile || result.inputType === 'profile')) {
        refreshed = await context.storageState();
      }
      await context.close();
    } finally {
      await browser.close();
    }
  }

  if (result.links.length === 0) {
    throw new Error("未枚举到任何作品。登录信息可能过期，或页面触发了验证码，请更新登录信息后重试。");
  }
  if (options.requireProfile && result.inputType !== 'profile') throw new Error('该链接最终指向单条作品，不是博主主页');
  await fsp.mkdir(path.dirname(options.links), { recursive: true });
  await fsp.writeFile(options.links, `${result.links.join("\n")}\n`, "utf8");
  await writeJson(options.manifest, { ...result, preparedAt: new Date().toISOString() });
  if (refreshed) {
    if (options.onCredentials) await options.onCredentials(refreshed);
    else await saveAccountState(options, refreshed);
  } else {
    // Never replace existing credentials during background preparation.
    await fsp.mkdir(path.dirname(options.storageState), { recursive: true });
    await fsp.writeFile(options.storageState, JSON.stringify(storageState, null, 2), { flag: 'wx', mode: 0o600 })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  console.log(`已准备 ${result.links.length} 条作品链接（类型：${result.inputType}）。`);
  return result;
}

export function invalidRedirectMessage(input, finalUrl) {
  const source = new URL(input);
  const destination = new URL(finalUrl);
  if (source.hostname.toLowerCase() === "v.douyin.com" &&
      ["www.douyin.com", "douyin.com"].includes(destination.hostname.toLowerCase()) &&
      destination.pathname === "/") {
    return "分享短链接跳转到了抖音首页，可能已过期或被重定向。请从博主主页重新复制完整链接（www.douyin.com/user/...）后再试。";
  }
  return `链接跳转后不是博主主页或视频：${finalUrl}`;
}

function isDouyinHome(value) {
  try {
    const url = new URL(value);
    return ["www.douyin.com", "douyin.com"].includes(url.hostname.toLowerCase())
      && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

async function main() {
  try {
    await prepareLinks(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`链接准备失败：${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
