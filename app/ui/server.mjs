import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTopic } from '../discover-topic.mjs';
import { prepareLinks, isProfileLink, normalizeWorkLink } from '../prepare-links.mjs';
import { summarizeKnowledge } from '../summarize-knowledge.mjs';
import { Library } from './library.mjs';
import { createAccountSession, saveAccountState } from './account-session.mjs';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(uiRoot, '..');
const vendorRoot = path.resolve(toolRoot, '..', 'vendor');
const candidateRoot = path.join(vendorRoot, 'video-batch-download');
const pythonRoot = path.join(vendorRoot, 'douyin-downloader-1');
const MAX_BODY = 1024 * 1024;

function safeDataFile(root, target) {
  const resolved = path.resolve(target);
  const data = path.resolve(root, 'data');
  if (!resolved.startsWith(`${data}${path.sep}`)) throw new Error('数据文件位置超出运行目录');
  return resolved;
}

export function normalizeCreatorInput(raw) {
  const text = String(raw || '');
  const match = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i)
    || text.match(/https?:\/\/(?:www\.)?douyin\.com\/user\/[^\s，。；：！？）)】\]]+/i);
  if (!match) throw new Error('没有找到博主主页链接');
  const value = match[0].replace(/["'.,;:!?，。；：！？）)】\]]+$/g, '');
  const url = new URL(value);
  if (isProfileLink(value)) return value;
  if (url.hostname.toLowerCase() === 'v.douyin.com') return value;
  throw new Error('请提供抖音博主主页或博主分享链接，不要使用单条视频链接');
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function runtimeEnv(root) {
  const pythonBin = path.join(pythonRoot, '.venv', 'Scripts');
  const env = {
    ...process.env,
    DOUYIN_TOOL_HOME: root,
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    HF_HOME: path.join(root, 'cache', 'huggingface'),
    TORCH_HOME: path.join(root, 'cache', 'torch'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'cache', 'playwright-node'),
    PYTHONPATH: pythonRoot,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONPYCACHEPREFIX: path.join(root, 'cache', 'pycache'),
    PATH: `${pythonBin};${path.join(root, 'bin')};${process.env.PATH || ''}`,
  };
  delete env.DOUYIN_MODEL_API_KEY;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GIT_HTTP_PROXY', 'GIT_HTTPS_PROXY']) {
    if (env[key] === 'http://127.0.0.1:9') delete env[key];
  }
  return env;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  let value;
  try { value = JSON.parse(body || '{}'); }
  catch { throw new Error('请求不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求内容须为对象');
  return value;
}

function send(response, status, value, headers = {}) {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Douyin-Tool': 'workbench',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    ...headers,
  });
  response.end(content);
}

function runChild(executable, args, options, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => log(chunk.toString('utf8')));
    child.stderr.on('data', chunk => log(chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`处理程序退出码 ${code}，请查看任务日志`)));
  });
}

export function createWorkbench({ runtimeRoot = process.env.DOUYIN_TOOL_HOME || 'D:\\YingzhiWorkbench', operations = {}, loginOptions = {}, runProcess = runChild } = {}) {
  const root = path.resolve(runtimeRoot);
  const dataRoot = path.join(root, 'data');
  const queueRoot = path.join(root, 'queue');
  const cookieSource = path.join(root, 'config', 'cookies.json');
  const storageState = path.join(root, 'private', 'playwright-storage-state.json');
  const csrf = randomBytes(24).toString('hex');
  const sessionId = randomUUID();
  const batchSnapshot = path.join(queueRoot, `session-${sessionId}-batch.json`);
  const taskLock = path.join(queueRoot, 'workbench-task.lock');
  const library = new Library(root);
  const jobs = new Map();
  let activeJob = null;
  let loginSession = null;
  let currentKnowledgeIds = new Set();
  let discovery = null;
  let prepared = { works: [] };
  let batch = null;
  let knowledge = null;

  function resetFrom(stage) {
    if (stage <= 0) discovery = null;
    if (stage <= 1) prepared = { works: [] };
    if (stage <= 2) batch = null;
    knowledge = null;
    currentKnowledgeIds = new Set();
  }

  async function captureTranscript(row) {
    if (!row?.jsonPath || !row.hasTranscript || row.status !== 'completed') return;
    const item = await readJson(safeDataFile(root, row.jsonPath));
    if (!item?.transcript?.trim()) return;
    return library.add({ kind: 'transcript', sourceId: String(row.videoId),
      sourceUrl: row.url || item.url || '', title: item.title || row.title || String(row.videoId),
      content: item.transcript }, true);
  }

  async function captureKnowledge(id) {
    const file = path.join(dataRoot, 'knowledge', 'summaries', `${id}.md`);
    const markdown = await fs.readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!markdown?.trim()) return;
    const record = await readJson(path.join(dataRoot, 'knowledge', 'summaries', `${id}.json`), {});
    return library.add({ kind: 'knowledge', sourceId: id, sourceUrl: record.source_url || '',
      title: record.summary?.title || id, content: markdown }, true);
  }

  async function prepareLocalRuntime() {
    await Promise.all(['tmp', 'cache', 'queue', 'data'].map(name => fs.mkdir(path.join(root, name), { recursive: true })));
    const env = runtimeEnv(root);
    for (const key of ['TEMP', 'TMP', 'HF_HOME', 'TORCH_HOME', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'PYTHONPYCACHEPREFIX', 'DOUYIN_TOOL_HOME']) {
      process.env[key] = env[key];
    }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GIT_HTTP_PROXY', 'GIT_HTTPS_PROXY']) {
      if (process.env[key] === 'http://127.0.0.1:9') delete process.env[key];
    }
  }

  async function runBackgroundBrowser(spec, log) {
    const id = randomUUID();
    const specFile = path.join(queueRoot, `background-${id}.json`);
    const resultFile = path.join(queueRoot, `background-${id}-result.json`);
    const logFile = path.join(queueRoot, `background-${id}.log`);
    const payload = { ...spec, resultFile, logFile };
    await fs.writeFile(specFile, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
    let delivered = '';
    let reading = Promise.resolve();
    const flush = () => {
      reading = reading.then(async () => {
        const current = await fs.readFile(logFile, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
        if (!current.startsWith(delivered)) delivered = '';
        const next = current.slice(delivered.length).trim();
        if (next) log(next);
        delivered = current;
      });
      return reading;
    };
    const interval = setInterval(() => flush().catch(() => {}), 400);
    let runnerFailure;
    let runnerOutput = '';
    try {
      const env = { ...runtimeEnv(root), DOUYIN_HIDDEN_DESKTOP: '1' };
      await runProcess('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolRoot, 'desktop', 'run-hidden-desktop.ps1'),
        '-Executable', process.execPath,
        '-Worker', path.join(toolRoot, 'background-worker.mjs'),
        '-Spec', specFile,
        '-WorkingDirectory', toolRoot,
      ], { cwd: toolRoot, env }, value => {
        runnerOutput = (runnerOutput + String(value)).slice(-3000);
        log(value);
      });
    } catch (error) {
      runnerFailure = error;
    } finally {
      clearInterval(interval);
      await flush().catch(() => {});
    }
    let completed;
    try {
      completed = await readJson(resultFile);
    } finally {
      await Promise.all([specFile, resultFile, logFile].map(file => fs.unlink(file).catch(() => {})));
    }
    if (!completed) {
      const detail = runnerOutput.trim();
      throw new Error([runnerFailure?.message || '后台任务未返回结果', detail].filter(Boolean).join('\n'));
    }
    if (!completed.ok) throw new Error(completed.error || '后台任务未完成');
    if (runnerFailure) throw runnerFailure;
    return completed.result;
  }

  const defaults = {
    discover: async (topic, log, { interactive = false } = {}) => {
      await prepareLocalRuntime();
      if (interactive === true) {
        return discoverTopic(topic, {
          cookieSource, storageState, candidateRoot, outputRoot: dataRoot, headed: true, onProgress: log,
        });
      }
      return runBackgroundBrowser({ kind: 'discover', topic, cookieSource, storageState, candidateRoot,
        outputRoot: dataRoot, limit: 10 }, log);
    },
    prepare: async (profileUrl, index, limit, { interactive = false } = {}, onCredentials, log = () => {}) => {
      await prepareLocalRuntime();
      const links = path.join(queueRoot, `ui-${sessionId}-profile-${index}.txt`);
      const manifest = path.join(queueRoot, `ui-${sessionId}-profile-${index}.json`);
      if (interactive === true) {
        return prepareLinks({ input: profileUrl, cookieSource, storageState, candidateRoot, limit, headed: true,
          onCredentials, requireProfile: true, links, manifest });
      }
      return runBackgroundBrowser({ kind: 'prepare', profileUrl, cookieSource, storageState, candidateRoot,
        limit, links, manifest }, log);
    },
    login: async log => {
      await prepareLocalRuntime();
      const session = createAccountSession({ ...loginOptions, cookieSource, storageState, candidateRoot, onProgress: log });
      loginSession = { jobId: activeJob, session };
      try { return await session.run(); }
      finally { loginSession = null; }
    },
    installModel: async log => {
      await runChild('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolRoot, 'install-local-knowledge-model.ps1')], {
        cwd: toolRoot, env: runtimeEnv(root),
      }, log);
      return { installed: true };
    },
    download: async (urls, log, { interactive = false } = {}) => {
      await prepareLocalRuntime();
      const input = path.join(queueRoot, `ui-${sessionId}-selected-links.txt`);
      await fs.writeFile(input, `${urls.join('\n')}\n`, 'utf8');
      const summaryFile = path.join(dataRoot, 'download-summary.json');
      const before = await fs.readFile(summaryFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      let failure;
      try { await runProcess(process.execPath, [path.join(candidateRoot, 'scripts', 'download.mjs'),
        '--input', input, '--output', dataRoot, '--storage-state', storageState,
        '--parse-concurrency', '1', '--download-concurrency', '1', '--max-attempts', '3',
        '--ffmpeg-path', path.join(root, 'bin', 'ffmpeg.exe'),
        '--model', 'small', '--device', 'cpu', '--compute-type', 'int8', '--transcribe-timeout', '1800',
        ...(interactive === true ? ['--headed'] : []),
      ], { cwd: root, env: runtimeEnv(root) }, log); }
      catch (error) { failure = error; }
      const after = await fs.readFile(summaryFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (failure) {
        if (after && after !== before) failure.batch = JSON.parse(after);
        throw failure;
      }
      if (!after || after === before) throw new Error('下载未生成本次处理结果，请查看任务日志');
      return JSON.parse(after);
    },
    summarize: (ids, log) => summarizeKnowledge(batchSnapshot, {
      selectedIds: ids, onProgress: log, outputRoot: dataRoot,
    }),
    clearDiscovery: async () => {
      const directory = path.join(dataRoot, 'discovery');
      const names = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const targets = names.filter(name => /^topic-.*\.(json|md)$/.test(name));
      await Promise.all(targets.map(name => fs.unlink(path.join(directory, name))));
      return { deleted: targets.length };
    },
  };
  const handlers = { ...defaults, ...operations };

  async function state() {
    const deletedIds = new Set((await library.list({ deleted: true })).map(row => row.id));
    const savedItems = new Map((await library.list()).map(row => [row.id, row]));
    const [catalog, cookies, transcription, model, runner] = await Promise.all([
      currentKnowledgeIds.size ? readJson(path.join(dataRoot, 'knowledge', 'summaries', 'catalog.json'), {}) : {},
      fs.access(cookieSource).then(() => true, () => false),
      fs.access(path.join(pythonRoot, '.venv', 'Scripts', 'python.exe')).then(() => true, () => false),
      fs.access(path.join(root, 'models', 'knowledge', 'Qwen3-4B-Q4_K_M.gguf')).then(() => true, () => false),
      fs.access(path.join(root, 'bin', 'llama-cpp', 'llama-server.exe')).then(() => true, () => false),
    ]);
    const knowledgeItems = await Promise.all(Object.entries(catalog).filter(([id, value]) => (
      value.status === 'completed' && currentKnowledgeIds.has(id) && !deletedIds.has(`knowledge:${id}`)
    )).map(async ([id]) => {
      const record = await readJson(path.join(dataRoot, 'knowledge', 'summaries', `${id}.json`));
      const saved = savedItems.get(`knowledge:${id}`);
      return record ? { videoId: id, title: saved?.title || record.summary?.title || id, topic: record.summary?.topic || '', reviewStatus: saved?.reviewStatus || record.reviewStatus || 'pending' } : null;
    }));
    const visibleBatch = batch ? { ...batch, results: batch.results.filter(row => !deletedIds.has(`transcript:${row.videoId}`))
      .map(row => ({ ...row, title: savedItems.get(`transcript:${row.videoId}`)?.title || row.title })) } : null;
    return { runtimeRoot: root, discovery, prepared, batch: visibleBatch, knowledge, knowledgeItems: knowledgeItems.filter(Boolean), ready: { cookies, transcription, summaryModel: model && runner }, activeJob };
  }

  function startJob(kind, task) {
    if (activeJob) { const error = new Error('已有任务正在运行，请等待或查看进度'); error.status = 409; throw error; }
    const id = randomUUID();
    const job = {
      id, kind, status: 'running', logs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phase: 0, phaseTotal: 0, progress: 2, message: '任务已启动', result: null, error: null,
    };
    jobs.set(id, job);
    if (jobs.size > 30) jobs.delete(jobs.keys().next().value);
    activeJob = id;
    const log = value => {
      const message = String(value).trim().slice(-1500);
      if (!message) return;
      job.logs.push(message);
      job.logs = job.logs.slice(-30);
      job.message = message.split(/\r?\n/).filter(Boolean).at(-1) || message;
      job.updatedAt = new Date().toISOString();
      const phase = message.match(/阶段\s*(\d+)\s*\/\s*(\d+)/);
      if (phase) {
        job.phase = Number(phase[1]);
        job.phaseTotal = Number(phase[2]);
        const completed = /已完成/.test(message) ? job.phase : Math.max(0, job.phase - 1);
        job.progress = Math.max(job.progress, Math.min(96, Math.round((completed / job.phaseTotal) * 100)));
      } else {
        const unit = message.match(/(?:\[知识总结\s*|\[|第\s*)(\d+)\s*\/\s*(\d+)/);
        if (unit) job.progress = Math.max(job.progress, Math.min(96, Math.round((Number(unit[1]) / Number(unit[2])) * 100)));
      }
    };
    Promise.resolve().then(async () => {
      await fs.mkdir(queueRoot, { recursive: true });
      let handle;
      try { handle = await fs.open(taskLock, 'wx'); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('其他工作台窗口正在处理任务；若窗口意外退出，请联系维护人员检查任务锁');
        throw error;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, sessionId, jobId: id }));
        return await task(log);
      } finally { await handle.close(); await fs.unlink(taskLock); }
    }).then(result => {
      job.result = result;
      job.status = 'completed';
      job.progress = 100;
      job.message = kind === 'login'
        ? (result?.loggedIn ? '登录信息已保存，下次搜索将在后台运行' : '账号验证已结束，未保存，原登录信息保留')
        : '本步骤已完成';
      job.updatedAt = new Date().toISOString();
    }).catch(error => {
      job.error = error.message;
      job.status = 'failed';
      job.message = error.message;
      job.updatedAt = new Date().toISOString();
      log(error.message);
    }).finally(() => { activeJob = null; });
    return job;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { send(response, 403, { error: '仅允许本机访问' }); return; }
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        let content = await fs.readFile(path.join(uiRoot, file), 'utf8');
        if (file === 'index.html') content = content.replace('__CSRF_TOKEN__', csrf);
        send(response, 200, content, { 'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') { send(response, 200, await state()); return; }
      if (request.method === 'GET' && url.pathname === '/api/library') {
        send(response, 200, { items: await library.list({ query: url.searchParams.get('q') || '', deleted: url.searchParams.get('deleted') === '1' }) }); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/library/')) {
        send(response, 200, await library.get(decodeURIComponent(url.pathname.slice('/api/library/'.length)), true)); return;
      }
      if (request.method === 'GET' && /^\/api\/jobs\/[a-f0-9-]+$/.test(url.pathname)) {
        const job = jobs.get(url.pathname.split('/').at(-1));
        send(response, job ? 200 : 404, job ? { ...job,
          awaitingConfirmation: job.kind === 'login' && loginSession?.jobId === job.id && loginSession.session.waiting,
        } : { error: '任务不存在' }); return;
      }
      if (request.method === 'GET' && /^\/api\/transcripts\/\d+$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1);
        const row = batch?.results?.find(item => String(item.videoId) === id);
        if (!row?.jsonPath) { send(response, 404, { error: '文字稿不存在' }); return; }
        const item = await readJson(safeDataFile(root, row.jsonPath));
        if (!item) { send(response, 404, { error: '文字稿文件缺失，请重新下载转写' }); return; }
        const saved = await captureTranscript(row);
        if (saved?.deletedAt) { send(response, 404, { error: '文字稿已移入回收站，请先恢复' }); return; }
        send(response, 200, { videoId: id, title: saved?.title || item.title || row.title || '', transcript: saved?.content || item.transcript || '', sourceUrl: row.url, status: row.status }); return;
      }
      if (request.method === 'GET' && /^\/api\/knowledge\/\d+$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1);
        const record = await readJson(path.join(dataRoot, 'knowledge', 'summaries', `${id}.json`));
        send(response, record ? 200 : 404, record || { error: '知识总结尚未生成' }); return;
      }
      if (request.method === 'GET' && /^\/api\/knowledge\/\d+\/markdown$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-2);
        const markdown = await fs.readFile(path.join(dataRoot, 'knowledge', 'summaries', `${id}.md`), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        send(response, markdown === null ? 404 : 200, markdown ?? '知识总结尚未生成', {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="douyin-knowledge-${id}.md"`,
        }); return;
      }
      if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) { send(response, 404, { error: '接口不存在' }); return; }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) { send(response, 403, { error: '来源不匹配' }); return; }
      if (request.headers['x-workbench-token'] !== csrf) { send(response, 403, { error: '请求校验失败' }); return; }
      const body = await readBody(request);
      if (url.pathname === '/api/login/confirm') {
        if (!['save', 'cancel'].includes(body.action)) { send(response, 400, { error: 'action 必须为 save 或 cancel' }); return; }
        if (!loginSession || loginSession.jobId !== activeJob || jobs.get(activeJob)?.kind !== 'login' || !loginSession.session.waiting) {
          send(response, 409, { error: '当前没有等待确认的账号验证任务' }); return;
        }
        send(response, 200, await loginSession.session.confirm(body.action)); return;
      }
      if (activeJob) { send(response, 409, { error: '已有任务正在运行，请等待或查看进度' }); return; }
      if (await fs.access(taskLock).then(() => true, () => false)) {
        send(response, 409, { error: '其他工作台窗口正在处理任务；请等待完成，若窗口意外退出请联系维护人员检查任务锁' }); return;
      }
      let job;
      if (url.pathname === '/api/library/add') {
        send(response, 201, await library.add({ title: body.title, content: body.content, reviewStatus: body.reviewStatus })); return;
      } else if (url.pathname === '/api/library/change') {
        const changed = await library.change(body.id, body.revision, body.action, body);
        if (changed.kind === 'transcript' && body.action === 'edit') {
          currentKnowledgeIds.delete(String(changed.sourceId));
          knowledge = null;
        }
        send(response, 200, changed); return;
      } else if (url.pathname === '/api/library/import-history') {
        job = startJob('import-history', async () => {
          const prior = await readJson(path.join(dataRoot, 'download-summary.json'), {});
          const catalog = await readJson(path.join(dataRoot, 'knowledge', 'summaries', 'catalog.json'), {});
          let imported = 0;
          const errors = [];
          for (const row of prior.results || []) {
            try { if (await captureTranscript(row)) imported++; }
            catch { errors.push(`${row.videoId}: 文字稿未导入`); }
          }
          for (const id of Object.keys(catalog).filter(id => /^\d+$/.test(id))) {
            try {
              if (catalog[id].sourcePath) await captureTranscript({ videoId: id, status: 'completed', hasTranscript: true, jsonPath: catalog[id].sourcePath });
              if (catalog[id].status === 'completed' && await captureKnowledge(id)) imported++;
            } catch { errors.push(`${id}: 历史资料未导入`); }
          }
          if (errors.length) throw new Error(`部分历史资料未导入，已保留成功结果：${errors.join('；')}`);
          return { imported };
        });
      } else if (url.pathname === '/api/list/upsert') {
        if (!['creators', 'works'].includes(body.kind)) throw new Error('列表类型无效');
        const title = String(body.title || '').trim();
        if (!title || title.length > 200) throw new Error('显示名称须为 1 到 200 字');
        const link = body.kind === 'creators' ? normalizeCreatorInput(body.url) : normalizeWorkLink(body.url);
        if (!link) throw new Error('请填写有效的抖音链接');
        job = startJob('upsert', async () => {
          if (body.kind === 'creators') {
            const creators = [...(discovery?.creators || [])];
            const existing = creators.find(row => row.profileUrl === link);
            if (existing) existing.author = title;
            else creators.push({ author: title, profileUrl: link, reason: '手工录入名称，身份待核对' });
            discovery = { ...discovery, creators };
          } else {
            const works = [...prepared.works];
            const existing = works.find(row => row.url === link);
            if (existing) existing.title = title;
            else works.push({ title, url: link, videoId: link.split('/').at(-1), manual: true });
            prepared = { ...prepared, works };
          }
          return { saved: true };
        });
      } else if (url.pathname === '/api/list/remove') {
        if (!['creators', 'works', 'transcripts', 'knowledge'].includes(body.kind)) throw new Error('列表类型无效');
        if (!Array.isArray(body.ids) || !body.ids.length) throw new Error('请先选择需要移出的条目');
        const ids = new Set(body.ids.map(String));
        job = startJob('remove', async () => {
          if (body.kind === 'creators') {
            if (discovery) discovery = { ...discovery, creators: discovery.creators.filter(row => !ids.has(row.profileUrl)) };
          } else if (body.kind === 'works') prepared = { ...prepared, works: prepared.works.filter(row => !ids.has(row.url)) };
          else if (body.kind === 'transcripts' && batch) {
            batch = { ...batch, results: batch.results.filter(row => !ids.has(String(row.videoId))) };
            await fs.writeFile(batchSnapshot, JSON.stringify(batch), 'utf8');
          } else if (body.kind === 'knowledge') for (const id of ids) currentKnowledgeIds.delete(id);
          return { removed: true };
        });
      } else if (url.pathname === '/api/login') {
        job = startJob('login', log => handlers.login(log));
      } else if (url.pathname === '/api/install-model') {
        job = startJob('install-model', log => handlers.installModel(log));
      } else if (url.pathname === '/api/discover') {
        const topic = String(body.topic || '').trim();
        if (topic.length < 4 || topic.length > 160) throw new Error('学习主题请输入 4 到 160 字');
        job = startJob('discover', async log => {
          resetFrom(0);
          const result = await handlers.discover(topic, log, { interactive: body.interactive === true });
          discovery = result.report;
          return result;
        });
      } else if (url.pathname === '/api/prepare') {
        if (!Array.isArray(body.profileUrls)) throw new Error('请选择博主主页');
        const profiles = [...new Set(body.profileUrls.map(normalizeCreatorInput))];
        if (!profiles.length) throw new Error('请至少选择一个有效博主主页');
        const limit = Number(body.limit ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每个博主的作品数量须为 1 到 100');
        job = startJob('prepare', async log => {
          resetFrom(1);
          await fs.mkdir(queueRoot, { recursive: true });
          const works = new Map();
          let refreshed;
          for (const [index, profile] of profiles.entries()) {
            log(`正在列出第 ${index + 1}/${profiles.length} 个博主的作品`);
            const result = await handlers.prepare(profile, index, limit, { interactive: body.interactive === true }, value => { refreshed = value; }, log);
            if (result.inputType !== 'profile') throw new Error('该链接最终指向单条作品，不是博主主页');
            for (const work of result.works || result.links.map(link => ({ url: link, title: '' }))) {
              works.set(work.url, { ...work, creator: profile, videoId: work.url.split('/').at(-1) });
            }
          }
          if (!works.size) throw new Error('未取得可选择的作品，请检查博主主页或登录状态后重试');
          prepared = { createdAt: new Date().toISOString(), profiles, works: [...works.values()] };
          await fs.writeFile(path.join(queueRoot, 'ui-works.json'), JSON.stringify(prepared, null, 2), 'utf8');
          if (body.interactive === true && refreshed) await saveAccountState({ cookieSource, storageState }, refreshed);
          return prepared;
        });
      } else if (url.pathname === '/api/download') {
        const allowed = new Set(prepared.works.map(item => item.url));
        if (!Array.isArray(body.urls)) throw new Error('请选择需要下载的作品');
        const urls = [...new Set(body.urls || [])].map(normalizeWorkLink);
        if (!Array.isArray(body.urls) || !urls.length || urls.some(item => !item || !allowed.has(item))) throw new Error('只能下载当前已列出且已勾选的作品');
        job = startJob('download', async log => {
          resetFrom(2);
          await fs.mkdir(queueRoot, { recursive: true });
          const ids = new Set(urls.map(url => url.split('/').at(-1)));
          const keepBatch = async result => {
            if (!Array.isArray(result?.results)) return;
            batch = { ...result, results: result.results.filter(row => ids.has(String(row.videoId))) };
            await fs.writeFile(batchSnapshot, JSON.stringify(batch), 'utf8');
            for (const row of batch.results) await captureTranscript(row);
          };
          try {
            const result = await handlers.download(urls, log, { interactive: body.interactive === true });
            await keepBatch(result);
            if (!batch?.results.length) throw new Error('下载未生成本次处理结果，请查看任务日志');
            const completed = batch.results.filter(row => row.status === 'completed').length;
            if (completed !== ids.size) throw new Error(`本次 ${ids.size} 条作品中 ${completed} 条完成，其余未完成；已完成文字稿可在第四步查看`);
            return batch;
          } catch (error) {
            if (error.batch) await keepBatch(error.batch);
            throw error;
          }
        });
      } else if (url.pathname === '/api/summarize') {
        if (!Array.isArray(body.videoIds)) throw new Error('请选择需要总结的文字稿');
        const ids = [...new Set((body.videoIds || []).map(String))];
        const allowed = new Set((batch?.results || []).filter(item => item.status === 'completed' && item.hasTranscript).map(item => String(item.videoId)));
        if (!Array.isArray(body.videoIds) || !ids.length || ids.some(id => !/^\d+$/.test(id) || !allowed.has(id))) throw new Error('只能总结当前已完成本地转写的作品');
        job = startJob('summarize', async log => {
          resetFrom(3);
          // Use corrected managed copies without overwriting machine transcripts.
          const snapshot = structuredClone(batch);
          for (const row of snapshot.results.filter(row => ids.includes(String(row.videoId)))) {
            const managed = await captureTranscript(row);
            if (managed?.deletedAt) throw new Error('所选文字稿已在回收站，请恢复后再总结');
            if (managed?.edited) {
              const raw = await readJson(safeDataFile(root, row.jsonPath));
              const corrected = path.join(dataRoot, 'workbench-library', `transcript-${sessionId}-${row.videoId}.json`);
              await fs.writeFile(corrected, JSON.stringify({ ...raw, title: managed.title, transcript: managed.content }), 'utf8');
              row.jsonPath = corrected;
            }
          }
          await fs.mkdir(queueRoot, { recursive: true });
          await fs.writeFile(batchSnapshot, JSON.stringify(snapshot), 'utf8');
          currentKnowledgeIds = new Set(ids);
          try { knowledge = await handlers.summarize(ids, log); }
          finally {
            const completed = await readJson(path.join(dataRoot, 'knowledge', 'summaries', 'catalog.json'), {});
            for (const id of ids) if (completed[id]?.status === 'completed') await captureKnowledge(id);
          }
          return knowledge;
        });
      } else if (url.pathname === '/api/clear-discovery') {
        job = startJob('clear-discovery', async () => {
          const result = await handlers.clearDiscovery();
          resetFrom(0);
          return result;
        });
      } else if (url.pathname === '/api/reset') {
        job = startJob('reset', async () => { resetFrom(0); return { reset: true }; });
      } else { send(response, 404, { error: '接口不存在' }); return; }
      send(response, 202, { jobId: job.id });
    } catch (error) {
      send(response, error.status || 400, { error: error.message });
    }
  });

  return { server, state };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--port');
  const port = index >= 0 ? Number(process.argv[index + 1]) : 8765;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  const { server } = createWorkbench();
  server.listen(port, '127.0.0.1', () => console.log(`抖音知识工作台：http://127.0.0.1:${port}`));
}
