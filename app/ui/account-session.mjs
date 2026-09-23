import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeCookies } from '../prepare-links.mjs';

const sessionNames = new Set(['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt']);
const douyinCookie = cookie => /(^|\.)douyin\.com$/i.test(cookie.domain || '');
const liveCookie = cookie => cookie.value?.trim() && (cookie.expires === -1 || cookie.expires > Date.now() / 1000);
const fault = (message, status) => Object.assign(new Error(message), { status });

export function browserLaunchOptions(interactive = false) {
  if (interactive === true) return { headless: false };
  // Douyin omits search/profile results in Chromium headless mode. Background
  // work therefore uses a normal browser on a separate Windows desktop.
  return { headless: false, requiresHiddenDesktop: true };
}

export async function launchAccountBrowser(candidateRoot, options) {
  const { requiresHiddenDesktop = false, ...launchOptions } = options;
  if (requiresHiddenDesktop && process.env.DOUYIN_HIDDEN_DESKTOP !== '1') {
    throw new Error('后台浏览器未运行在 Windows 隔离桌面，已拒绝启动以避免弹出窗口');
  }
  const require = createRequire(path.join(path.resolve(candidateRoot), 'package.json'));
  const { chromium } = require('playwright');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DOUYIN_MODEL_API_KEY'));
  return chromium.launch({ ...launchOptions, env });
}

export async function readAccountState(cookieSource, storageState = path.resolve(path.dirname(cookieSource), '..', 'private', 'playwright-storage-state.json')) {
  try {
    const raw = JSON.parse((await fs.readFile(cookieSource, 'utf8')).replace(/^\uFEFF/, ''));
    const saved = await fs.readFile(storageState, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const flat = !Array.isArray(raw) && !Array.isArray(raw?.cookies);
    const cookies = normalizeCookies(raw).map(cookie => saved?.cookies?.find(prior =>
      prior.name === cookie.name && prior.value === cookie.value && douyinCookie(prior)
      && (flat || prior.domain === cookie.domain)) || cookie);
    return { cookies: cookies.filter(cookie => douyinCookie(cookie) && liveCookie(cookie)), origins: [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { cookies: [], origins: [] };
    throw new Error('无法读取原有登录信息，请检查登录文件；原文件未修改');
  }
}

export function validatedAccountState(state) {
  const cookies = normalizeCookies(state).filter(cookie => douyinCookie(cookie) && liveCookie(cookie));
  if (!cookies.some(cookie => sessionNames.has(cookie.name))) {
    throw fault('未检测到非空且未过期的抖音会话，请完成登录后再点击“已完成，保存登录”', 400);
  }
  return { cookies, origins: [] };
}

export async function saveAccountState({ cookieSource, storageState }, state, io = fs) {
  const valid = validatedAccountState(state);
  // Stage both files before replacing either; restore exact old bytes on a write failure.
  const files = [cookieSource, storageState].map((target, index) => ({
    target, temporary: `${target}.${randomUUID()}.tmp`, replaced: false,
    content: index === 0 ? Object.fromEntries(valid.cookies.map(cookie => [cookie.name, cookie.value])) : valid,
  }));
  try {
    for (const file of files) {
      await io.mkdir(path.dirname(file.target), { recursive: true });
      file.previous = await io.readFile(file.target).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      await io.writeFile(file.temporary, JSON.stringify(file.content, null, 2), { flag: 'wx', mode: 0o600 });
    }
    for (const file of files) {
      await io.rename(file.temporary, file.target);
      file.replaced = true;
    }
  } catch {
    let rollbackFailed = false;
    for (const file of files.filter(file => file.replaced)) {
      try {
        if (file.previous === null) await io.unlink(file.target);
        else await io.writeFile(file.target, file.previous);
      } catch { rollbackFailed = true; }
    }
    throw new Error(rollbackFailed ? '登录信息保存失败，旧凭据恢复失败，请联系维护人员检查登录文件' : '登录信息保存失败，已保留旧凭据');
  } finally {
    await Promise.all(files.map(file => io.unlink(file.temporary).catch(() => {})));
  }
}

export function createAccountSession({
  cookieSource, storageState, candidateRoot, onProgress = () => {},
  launchBrowser = options => launchAccountBrowser(candidateRoot, options), timeoutMs = 300_000,
}) {
  let phase = 'opening';
  let browser;
  let context;
  let timer;
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const finish = (reason, loggedIn = false) => {
    if (phase === 'finished' || phase === 'saving') return;
    phase = 'finished';
    clearTimeout(timer);
    settle({ loggedIn, reason });
  };
  const close = () => finish('closed');
  return {
    get waiting() { return phase === 'waiting'; },
    async confirm(action) {
      if (!['save', 'cancel'].includes(action)) throw fault('action 必须为 save 或 cancel', 400);
      if (phase !== 'waiting') throw fault('当前没有等待确认的账号验证任务', 409);
      if (action === 'cancel') { finish('cancel'); return { accepted: true }; }
      phase = 'checking';
      try {
        const state = validatedAccountState(await context.storageState());
        if (phase !== 'checking') throw fault('账号验证窗口已关闭或超时，未保存登录信息', 409);
        phase = 'saving';
        clearTimeout(timer);
        await saveAccountState({ cookieSource, storageState }, state);
        phase = 'checking';
        finish('saved', true);
        return { accepted: true };
      } catch (error) {
        if (phase === 'checking') {
          phase = 'waiting';
          throw fault(error.status === 400 ? error.message : '读取登录状态失败，未保存登录信息', error.status || 400);
        }
        if (phase === 'saving') {
          phase = 'checking';
          finish('save-failed');
          throw error;
        }
        throw fault('账号验证窗口已关闭或超时，未保存登录信息', 409);
      }
    },
    async run() {
      try {
        const initial = await readAccountState(cookieSource, storageState);
        browser = await launchBrowser({ headless: false, timeout: 30_000 });
        browser.on('disconnected', close);
        context = await browser.newContext({ storageState: initial, locale: 'zh-CN' });
        context.on('close', close);
        const page = await context.newPage();
        page.on('close', close);
        timer = setTimeout(() => finish('timeout'), timeoutMs);
        await Promise.race([page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }), done]);
        if (phase !== 'finished') {
          phase = 'waiting';
          onProgress('请在浏览器完成账号验证，然后点击应用内“已完成，保存登录”；也可取消，保留原登录信息');
        }
        return await done;
      } catch {
        if (phase === 'finished') return await done;
        throw new Error('账号验证浏览器启动或页面加载失败，原登录信息未修改');
      } finally {
        phase = 'finished';
        clearTimeout(timer);
        await browser?.close().catch(() => {});
      }
    },
  };
}
