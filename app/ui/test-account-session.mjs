import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWorkbench } from './server.mjs';
import { browserLaunchOptions, readAccountState, saveAccountState, validatedAccountState } from './account-session.mjs';
import { discoverTopic, searchDouyinKeywords } from '../discover-topic.mjs';
import { prepareLinks } from '../prepare-links.mjs';

const work = 'https://www.douyin.com/video/123';
const profile = 'https://www.douyin.com/user/test';
const temporaryRoot = path.resolve(os.tmpdir());
const cookie = (value = 'test-only-session', extra = {}) => ({ name: 'sessionid', value, domain: '.douyin.com', path: '/', expires: -1, ...extra });
const state = value => ({ cookies: [cookie(value)], origins: [] });

function fakeBrowser({ title = 'Douyin', rows = [{ href: work, workUrl: work, profileUrl: profile, title: 'test' }], storage = state('refreshed-test-only'), goto, snapshot } = {}) {
  const calls = [];
  const page = new EventEmitter();
  page.goto = goto || (async url => { calls.push(['goto', url]); });
  page.title = async () => title;
  page.url = () => profile;
  page.waitForTimeout = async () => {};
  page.mouse = { wheel: async () => {} };
  page.locator = () => ({
    first: () => ({ waitFor: async () => {} }), innerText: async () => '', count: async () => rows.length,
    evaluateAll: async () => rows,
  });
  const context = new EventEmitter();
  context.newPage = async () => page;
  context.storageState = snapshot || (async () => structuredClone(storage));
  context.close = async () => { context.emit('close'); };
  const browser = new EventEmitter();
  browser.newContext = async options => { calls.push(['context', options]); return context; };
  browser.close = async () => { calls.push(['close']); browser.emit('disconnected'); };
  const launchBrowser = async options => { calls.push(['launch', options]); return browser; };
  return { browser, context, page, calls, launchBrowser, storage };
}

async function files(t) {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'douyin-account-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${temporaryRoot}${path.sep}douyin-account-test-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  const paths = { root, cookieSource: path.join(root, 'config', 'cookies.json'), storageState: path.join(root, 'private', 'playwright-storage-state.json') };
  await saveAccountState(paths, state('old-test-only'));
  const before = await credentials(paths);
  return { ...paths, before, candidateRoot: 'not-used', links: path.join(root, 'links.txt'), manifest: path.join(root, 'manifest.json') };
}

async function credentials(paths) {
  return Promise.all([paths.cookieSource, paths.storageState].map(file => fs.readFile(file, 'utf8')));
}

async function poll(read, accept) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('test state did not settle');
}

async function api(t, options = {}) {
  const f = await files(t);
  const originalEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const { server } = createWorkbench({ runtimeRoot: f.root, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const token = (await fetch(url).then(r => r.text())).match(/name="workbench-token" content="([a-f0-9]+)"/)[1];
  const get = route => fetch(url + route).then(r => r.json());
  const post = (route, body = {}, headers = {}) => fetch(url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token, ...headers }, body: JSON.stringify(body),
  });
  const start = async (route, body = {}) => {
    const response = await post(route, body);
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    return (await response.json()).jobId;
  };
  const job = id => get(`/api/jobs/${id}`);
  const finished = async id => {
    const result = await poll(() => job(id), value => value.status !== 'running');
    await poll(() => get('/api/state'), value => value.activeJob === null);
    assert.equal(await fs.access(path.join(f.root, 'queue', 'workbench-task.lock')).then(() => true, () => false), false);
    return result;
  };
  return { ...f, get, post, start, job, finished, waiting: id => poll(() => job(id), value => value.awaitingConfirmation === true) };
}

test('API discover/prepare/download pass only strict per-request interactive true and never retain it', async t => {
  const seen = [];
  const f = await api(t, { operations: {
    discover: async (_topic, _log, options) => { seen.push(['discover', options]); return { report: { creators: [] } }; },
    prepare: async (_profile, _index, _limit, options) => { seen.push(['prepare', options]); return { inputType: 'profile', links: [work] }; },
    download: async (_urls, _log, options) => { seen.push(['download', options]); return { results: [{ videoId: '123', status: 'completed' }] }; },
  } });
  for (const flag of [undefined, true, undefined, false, 'true', 1, {}, null]) {
    const extra = flag === undefined ? {} : { interactive: flag };
    for (const [kind, body] of [['discover', { topic: 'MES topic' }], ['prepare', { profileUrls: [profile] }], ['download', { urls: [work] }]]) {
      const result = await f.finished(await f.start(`/api/${kind}`, { ...body, ...extra }));
      assert.equal(result.status, 'completed', result.error);
      assert.deepEqual(seen.at(-1), [kind, { interactive: flag === true }]);
    }
  }
  assert.equal(seen.length, 24);
});

test('default discover and prepare run through the Windows isolated-desktop worker and clean temporary control files', async t => {
  const specs = [];
  let f;
  f = await api(t, { runProcess: async (executable, args, options) => {
    assert.equal(executable, 'powershell.exe');
    assert.match(args[args.indexOf('-File') + 1], /run-hidden-desktop\.ps1$/);
    assert.equal(options.env.DOUYIN_HIDDEN_DESKTOP, '1');
    const specFile = args[args.indexOf('-Spec') + 1];
    const spec = JSON.parse(await fs.readFile(specFile, 'utf8'));
    specs.push(spec);
    await fs.writeFile(spec.logFile, `${spec.kind} completed\n`, 'utf8');
    const result = spec.kind === 'discover'
      ? { report: { creators: [{ author: 'test', profileUrl: profile, works: [{ workUrl: work }] }] } }
      : { inputType: 'profile', links: [work], works: [{ url: work, title: 'test' }] };
    await fs.writeFile(spec.resultFile, JSON.stringify({ ok: true, result }), 'utf8');
  } });
  assert.equal((await f.finished(await f.start('/api/discover', { topic: 'MES topic' }))).status, 'completed');
  assert.equal((await f.finished(await f.start('/api/prepare', { profileUrls: [profile], limit: 20 }))).status, 'completed');
  assert.deepEqual(specs.map(spec => spec.kind), ['discover', 'prepare']);
  assert.ok(specs.every(spec => spec.cookieSource === f.cookieSource && spec.storageState === f.storageState));
  const leftovers = (await fs.readdir(path.join(f.root, 'queue'))).filter(name => name.startsWith('background-'));
  assert.deepEqual(leftovers, []);
});

test('default download subprocess gets --headed only on explicit true', async t => {
  const calls = [];
  let f;
  f = await api(t, { runProcess: async (_executable, args) => {
    calls.push(args);
    await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'data', 'download-summary.json'), JSON.stringify({ sequence: calls.length, results: [{ videoId: '123', status: 'completed' }] }));
  } });
  await f.finished(await f.start('/api/list/upsert', { kind: 'works', title: 'test', url: work }));
  for (const interactive of [undefined, true, 'true', false, undefined]) {
    assert.equal((await f.finished(await f.start('/api/download', { urls: [work], interactive }))).status, 'completed');
    assert.equal(calls.at(-1).includes('--headed'), interactive === true);
  }
});

test('login opens once with old credentials; save is explicit and session secrets never reach API', async t => {
  const fake = fakeBrowser();
  const f = await api(t, { loginOptions: { launchBrowser: fake.launchBrowser } });
  const id = await f.start('/api/login');
  const job = await f.waiting(id);
  assert.equal(job.kind, 'login');
  assert.equal(job.status, 'running');
  assert.match(job.message, /已完成，保存登录/);
  assert.deepEqual(await credentials(f), f.before);
  assert.equal(fake.calls.filter(([kind]) => kind === 'launch').length, 1);
  assert.equal(fake.calls.find(([kind]) => kind === 'launch')[1].headless, false);
  assert.equal(fake.calls.find(([kind]) => kind === 'context')[1].storageState.cookies[0].value, 'old-test-only');
  assert.equal(fake.calls.find(([kind]) => kind === 'goto')[1], 'https://www.douyin.com/');
  assert.equal((await f.post('/api/login', {})).status, 409);
  assert.equal((await f.post('/api/login/confirm', { action: 'save' }, { 'X-Workbench-Token': 'wrong' })).status, 403);
  assert.equal((await f.post('/api/login/confirm', { action: 'save' }, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await f.post('/api/login/confirm', { action: 'unexpected' })).status, 400);
  assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 200);
  const result = await f.finished(id);
  assert.deepEqual(result.result, { loggedIn: true, reason: 'saved' });
  assert.equal(result.awaitingConfirmation, false);
  assert.doesNotMatch(JSON.stringify(result), /refreshed-test-only|old-test-only/);
  assert.equal(JSON.parse((await credentials(f))[0]).sessionid, 'refreshed-test-only');
  assert.equal(JSON.parse((await credentials(f))[1]).cookies[0].value, 'refreshed-test-only');
  assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 409);
});

for (const reason of ['cancel', 'closed', 'disconnected', 'timeout']) {
  test(`login ${reason} preserves credentials and library and releases task lock`, async t => {
    const fake = fakeBrowser();
    const f = await api(t, { loginOptions: { launchBrowser: fake.launchBrowser, timeoutMs: reason === 'timeout' ? 200 : 5000 } });
    await f.post('/api/library/add', { title: 'retained', content: 'keep data' });
    const id = await f.start('/api/login');
    await f.waiting(id);
    if (reason === 'cancel') assert.equal((await f.post('/api/login/confirm', { action: 'cancel' })).status, 200);
    if (reason === 'closed') fake.page.emit('close');
    if (reason === 'disconnected') fake.browser.emit('disconnected');
    const result = await f.finished(id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { loggedIn: false, reason: reason === 'disconnected' ? 'closed' : reason });
    assert.match(result.message, /未保存.*保留/);
    assert.deepEqual(await credentials(f), f.before);
    const retained = (await f.get('/api/library')).items[0];
    assert.equal((await f.get(`/api/library/${encodeURIComponent(retained.id)}`)).content, 'keep data');
    assert.equal((await f.post('/api/login/confirm', { action: 'cancel' })).status, 409);
    assert.ok(fake.calls.some(([kind]) => kind === 'close'));
  });
}

test('empty, expired and foreign session cookies cannot be saved; valid session can retry', async t => {
  const fake = fakeBrowser();
  const f = await api(t, { loginOptions: { launchBrowser: fake.launchBrowser } });
  const id = await f.start('/api/login');
  await f.waiting(id);
  for (const candidate of [cookie(''), cookie('expired', { expires: 1 }), cookie('foreign', { domain: 'notdouyin.com' }), cookie('token', { name: 'msToken' })]) {
    fake.storage.cookies = [candidate];
    const response = await f.post('/api/login/confirm', { action: 'save' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /会话/);
    assert.equal((await f.job(id)).awaitingConfirmation, true);
    assert.deepEqual(await credentials(f), f.before);
  }
  fake.storage.cookies = [cookie('valid-test-only', { name: 'sid_guard' })];
  assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 200);
  assert.equal((await f.finished(id)).result.loggedIn, true);
});

test('confirm is rejected before readiness and while a save is checking', async t => {
  let open;
  let snapshot;
  const opening = new Promise(resolve => { open = resolve; });
  const reading = new Promise(resolve => { snapshot = resolve; });
  const fake = fakeBrowser({ goto: () => opening, snapshot: () => reading });
  const f = await api(t, { loginOptions: { launchBrowser: fake.launchBrowser } });
  assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 409);
  assert.equal((await f.post('/api/login/confirm', {})).status, 400);
  const id = await f.start('/api/login');
  assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 409);
  open();
  await f.waiting(id);
  const saving = f.post('/api/login/confirm', { action: 'save' });
  await poll(() => f.job(id), value => value.awaitingConfirmation === false);
  assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 409);
  fake.page.emit('close');
  snapshot(state('must-not-save'));
  assert.equal((await saving).status, 409);
  assert.equal((await f.finished(id)).result.reason, 'closed');
  assert.deepEqual(await credentials(f), f.before);
});

test('login launch failure is sanitized and releases the lock', async t => {
  const f = await api(t, { loginOptions: { launchBrowser: async () => { throw new Error('secret-cookie-value'); } } });
  const result = await f.finished(await f.start('/api/login'));
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /secret-cookie-value/);
  assert.deepEqual(await credentials(f), f.before);
});

test('credential pair rollback restores exact previous bytes if second replacement fails', async t => {
  const f = await files(t);
  const io = { ...fs, rename: async (from, to) => {
    if (to === f.storageState) throw new Error('injected write failure');
    return fs.rename(from, to);
  } };
  await assert.rejects(saveAccountState(f, state('new'), io), /保留旧凭据/);
  assert.deepEqual(await credentials(f), f.before);
  assert.deepEqual(await fs.readdir(path.dirname(f.cookieSource)), ['cookies.json']);
  assert.deepEqual(await fs.readdir(path.dirname(f.storageState)), ['playwright-storage-state.json']);
});

test('saved expiry metadata is reused and expired credentials are not revived by the flat config', async t => {
  const f = await files(t);
  const stored = state('old-test-only');
  stored.cookies[0].expires = 1;
  stored.cookies[0].domain = 'www.douyin.com';
  await fs.writeFile(f.storageState, JSON.stringify(stored));
  assert.deepEqual((await readAccountState(f.cookieSource, f.storageState)).cookies, []);
  assert.throws(() => validatedAccountState(stored), /会话/);
});

test('confirm cannot control another task or another workbench session', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await api(t, { operations: { discover: async () => { await held; return { report: { creators: [] } }; } } });
  const id = await f.start('/api/discover', { topic: 'MES topic' });
  try {
    assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 409);
    assert.equal((await f.post('/api/login/confirm', { action: 'cancel' })).status, 409);
  } finally { release(); }
  await f.finished(id);
  const fake = fakeBrowser();
  const owner = await api(t, { loginOptions: { launchBrowser: fake.launchBrowser } });
  const loginId = await owner.start('/api/login');
  await owner.waiting(loginId);
  try {
    assert.equal((await f.post('/api/login/confirm', { action: 'save' })).status, 409);
    assert.equal((await owner.job(loginId)).awaitingConfirmation, true);
  } finally { await owner.post('/api/login/confirm', { action: 'cancel' }); }
  await owner.finished(loginId);
});

test('challenge failure at API boundary is not automatically retried with interactive true', async t => {
  const calls = [];
  const f = await api(t, { operations: {
    discover: async (_topic, _log, options) => { calls.push(options); throw new Error('验证码'); },
  } });
  const result = await f.finished(await f.start('/api/discover', { topic: 'MES topic' }));
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, [{ interactive: false }]);
  assert.deepEqual(await credentials(f), f.before);
});

test('login timeout covers navigation and leaves previous credentials intact', async t => {
  const fake = fakeBrowser({ goto: () => new Promise(() => {}) });
  const f = await api(t, { loginOptions: { launchBrowser: fake.launchBrowser, timeoutMs: 30 } });
  const result = await f.finished(await f.start('/api/login'));
  assert.deepEqual(result.result, { loggedIn: false, reason: 'timeout' });
  assert.equal(result.awaitingConfirmation, false);
  assert.deepEqual(await credentials(f), f.before);
});

test('background browser requires a Windows isolated desktop while explicit verification is visible', () => {
  const background = browserLaunchOptions(false);
  const interactive = browserLaunchOptions(true);
  assert.equal(background.headless, false);
  assert.equal(background.requiresHiddenDesktop, true);
  assert.deepEqual(background.args || [], []);
  assert.equal(interactive.headless, false);
  assert.equal(interactive.requiresHiddenDesktop, undefined);
  assert.deepEqual(interactive.args || [], []);
});

test('prepare never passes automation-concealment flags in background or interactive mode', async t => {
  const f = await files(t);
  for (const headed of [false, true]) {
    const fake = fakeBrowser();
    await prepareLinks({ ...f, input: profile, limit: 1, headed, launchBrowser: fake.launchBrowser });
    const launches = fake.calls.filter(([kind]) => kind === 'launch');
    assert.equal(launches.length, 1);
    const options = launches[0][1];
    assert.equal(options.headless, false);
    assert.equal(options.requiresHiddenDesktop, !headed || undefined);
    assert.equal((options.args || []).some(arg => /AutomationControlled/i.test(arg)), false);
  }
});

for (const operation of ['discover', 'prepare']) {
  test(`${operation} challenge launches one isolated-desktop browser and never overwrites credentials`, async t => {
    const f = await files(t);
    const fake = fakeBrowser({ title: '验证码中间页' });
    const run = operation === 'discover'
      ? () => searchDouyinKeywords(['MES'], { ...f, launchBrowser: fake.launchBrowser })
      : () => prepareLinks({ ...f, input: profile, limit: 1, launchBrowser: fake.launchBrowser });
    await assert.rejects(run(), /验证码/);
    const launches = fake.calls.filter(([kind]) => kind === 'launch').map(([, options]) => options);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].headless, false);
    assert.equal(launches[0].requiresHiddenDesktop, true);
    assert.deepEqual(await credentials(f), f.before);
  });
  test(`${operation} explicit interactive success persists cookies; next operation requires isolation and cannot rewrite credentials`, async t => {
    const f = await files(t);
    const launches = [];
    let attempt = 0;
    const launchBrowser = options => {
      launches.push(options);
      attempt += 1;
      return fakeBrowser({ storage: state(attempt === 1 ? 'interactive-refresh' : 'background-must-not-save') }).launchBrowser(options);
    };
    if (operation === 'discover') {
      await discoverTopic('MES topic', { ...f, outputRoot: f.root, headed: true,
        search: (keywords, options) => searchDouyinKeywords(keywords, { ...options, launchBrowser }),
      });
      await discoverTopic('MES topic', { ...f, outputRoot: f.root,
        search: (keywords, options) => searchDouyinKeywords(keywords, { ...options, launchBrowser }),
      });
    } else {
      await prepareLinks({ ...f, input: profile, limit: 1, headed: true, launchBrowser });
      await prepareLinks({ ...f, input: profile, limit: 1, launchBrowser });
    }
    assert.equal(launches.length, 2);
    assert.deepEqual(launches[0].args || [], []);
    assert.equal(launches[1].requiresHiddenDesktop, true);
    assert.equal(JSON.parse((await credentials(f))[0]).sessionid, 'interactive-refresh');
    assert.equal(JSON.parse((await credentials(f))[1]).cookies[0].value, 'interactive-refresh');
  });
  test(`${operation} interactive timeout does not save refreshed cookies`, async t => {
    const f = await files(t);
    const fake = fakeBrowser({ title: '验证码中间页' });
    const options = { ...f, headed: true, verificationTimeoutMs: 0, launchBrowser: fake.launchBrowser };
    await assert.rejects(operation === 'discover'
      ? searchDouyinKeywords(['MES'], options)
      : prepareLinks({ ...options, input: profile, limit: 1 }), /验证码/);
    assert.deepEqual(await credentials(f), f.before);
    const [launch] = fake.calls.filter(([kind]) => kind === 'launch').map(([, value]) => value);
    assert.equal(launch.headless, false);
    assert.deepEqual(launch.args || [], []);
  });
}

test('discover defers credential save until ranking and report writing succeed', async t => {
  const f = await files(t);
  await assert.rejects(discoverTopic('MES topic', { ...f, outputRoot: f.root, headed: true,
    search: async (_keywords, options) => {
      options.onCredentials(state('must-not-save'));
      return { works: [], warnings: [] };
    },
  }), /未取得/);
  assert.deepEqual(await credentials(f), f.before);
});

test('prepare API defers saving until every selected profile succeeds', async t => {
  const f = await api(t, { operations: { prepare: async (_profile, index, _limit, _options, onCredentials) => {
    if (index === 1) throw new Error('验证码');
    onCredentials(state('must-not-save'));
    return { inputType: 'profile', links: [work] };
  } } });
  const result = await f.finished(await f.start('/api/prepare', { profileUrls: [profile, `${profile}2`], interactive: true }));
  assert.equal(result.status, 'failed');
  assert.deepEqual(await credentials(f), f.before);
});
