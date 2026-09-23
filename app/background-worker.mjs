#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { discoverTopic } from './discover-topic.mjs';
import { prepareLinks } from './prepare-links.mjs';

function parseArgs(argv) {
  const index = argv.indexOf('--spec');
  if (index < 0 || !argv[index + 1]) throw new Error('缺少后台任务说明文件');
  return argv[index + 1];
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2), 'utf8');
}

async function appendLog(target, message) {
  await fs.appendFile(target, `${String(message).replace(/[\r\n]+/g, ' ').trim()}\n`, 'utf8');
}

async function run(spec) {
  if (process.env.DOUYIN_HIDDEN_DESKTOP !== '1') {
    throw new Error('后台任务未运行在 Windows 隔离桌面');
  }
  const progress = message => appendLog(spec.logFile, message).catch(() => {});
  if (spec.kind === 'discover') {
    return discoverTopic(spec.topic, {
      cookieSource: spec.cookieSource,
      storageState: spec.storageState,
      candidateRoot: spec.candidateRoot,
      outputRoot: spec.outputRoot,
      limit: spec.limit,
      headed: false,
      onProgress: progress,
    });
  }
  if (spec.kind === 'prepare') {
    return prepareLinks({
      input: spec.profileUrl,
      cookieSource: spec.cookieSource,
      storageState: spec.storageState,
      candidateRoot: spec.candidateRoot,
      limit: spec.limit,
      headed: false,
      requireProfile: true,
      links: spec.links,
      manifest: spec.manifest,
    });
  }
  throw new Error('未知后台任务类型');
}

const specFile = parseArgs(process.argv.slice(2));
const spec = JSON.parse(await fs.readFile(specFile, 'utf8'));
try {
  const result = await run(spec);
  await writeJson(spec.resultFile, { ok: true, result });
} catch (error) {
  await writeJson(spec.resultFile, { ok: false, error: String(error?.message || error).slice(0, 1000) });
  process.exitCode = 2;
}
