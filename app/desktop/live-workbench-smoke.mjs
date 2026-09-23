#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkbench } from '../ui/server.mjs';
import { assertWorkbenchSmokeIntegrity } from './smoke-contract.mjs';

const root = process.env.DOUYIN_TOOL_HOME || 'D:\\YingzhiWorkbench';
const credentials = [path.join(root, 'config', 'cookies.json'), path.join(root, 'private', 'playwright-storage-state.json')];
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const before = await Promise.all(credentials.map(hash));
const { server } = createWorkbench({ runtimeRoot: root });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function get(route) {
  const response = await fetch(base + route);
  return response.json();
}

let token;
async function post(route, body) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function complete(jobId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await get(`/api/jobs/${jobId}`);
    if (job.status !== 'running') {
      if (job.status !== 'completed') {
        const details = (job.logs || []).slice(-8).join('\n');
        throw new Error([job.error || `${job.kind} 未完成`, details].filter(Boolean).join('\n'));
      }
      return job;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('真实工作台冒烟测试超时');
}

try {
  const html = await fetch(base).then(response => response.text());
  token = html.match(/name="workbench-token" content="([a-f0-9]+)"/)?.[1];
  if (!token) throw new Error('未取得本地工作台令牌');
  const discover = await post('/api/discover', { topic: 'MES 订单流程' });
  await complete(discover.jobId);
  const afterDiscover = await get('/api/state');
  const creators = afterDiscover.discovery?.creators || [];
  if (!creators.length) throw new Error('真实工作台搜索没有返回候选博主');
  const prepare = await post('/api/prepare', { profileUrls: [creators[0].profileUrl], limit: 10 });
  await complete(prepare.jobId);
  const afterPrepare = await get('/api/state');
  const works = afterPrepare.prepared?.works || [];
  if (!works.length) throw new Error('真实工作台没有返回可选择作品');
  const after = await Promise.all(credentials.map(hash));
  const credentialsUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const taskLockReleased = await fs.access(path.join(root, 'queue', 'workbench-task.lock')).then(() => false, () => true);
  assertWorkbenchSmokeIntegrity({ credentialsUnchanged, taskLockReleased });
  console.log(JSON.stringify({
    status: 'PASS',
    creators: creators.length,
    works: works.length,
    credentialsUnchanged,
    taskLockReleased,
  }));
} finally {
  await new Promise(resolve => server.close(resolve));
}
