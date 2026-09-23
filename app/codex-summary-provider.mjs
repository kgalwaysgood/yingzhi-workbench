import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function resolveCodexExecutable(env = process.env) {
  if (env.DOUYIN_CODEX_EXE) {
    const file = env.DOUYIN_CODEX_EXE;
    if (!path.isAbsolute(file) || !(await fs.stat(file).catch(() => null))?.isFile()) {
      throw new Error('DOUYIN_CODEX_EXE 必须指向已安装 Codex 的绝对文件路径');
    }
    return file;
  }
  // Explorer-launched menus do not inherit the desktop agent's injected PATH.
  const bin = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  const versions = await fs.readdir(bin, { withFileTypes: true }).catch(() => []);
  const installed = [];
  for (const version of versions) {
    if (!version.isDirectory() || version.isSymbolicLink()) continue;
    const file = path.join(bin, version.name, 'codex.exe');
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) installed.push({ file, time: stat.mtimeMs });
  }
  installed.sort((a, b) => b.time - a.time);
  if (installed.length) return installed[0].file;
  for (const directory of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, 'codex.exe');
    if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
  }
  throw new Error('找不到已安装的Codex程序，请设置DOUYIN_CODEX_EXE为绝对路径；文字稿已保留。');
}

export async function generateWithCodex(prompt, schema, runtimeRoot) {
  if (!/^D:[\\/]/i.test(path.resolve(runtimeRoot))) throw new Error('AI runtime must be on D drive.');
  const authorization = await fs.readFile(path.join(runtimeRoot, 'private', 'knowledge-ai.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (authorization?.enabled !== true || authorization?.provider !== 'codex') {
    throw new Error('AI总结尚未授权配置；文字稿已保留，授权后可用菜单6继续。');
  }
  const executable = await resolveCodexExecutable();
  const aiHome = path.join(runtimeRoot, 'private', 'summary-codex');
  const work = path.join(runtimeRoot, 'tmp', 'summary-work');
  const job = path.join(runtimeRoot, 'tmp', `summary-${randomUUID()}`);
  for (const directory of [aiHome, work, job]) await fs.mkdir(directory, { recursive: true });
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sourceAuth = path.join(sourceHome, 'auth.json');
  const targetAuth = path.join(aiHome, 'auth.json');
  const sourceStat = await fs.stat(sourceAuth).catch(() => null);
  const targetStat = await fs.stat(targetAuth).catch(() => null);
  if (sourceStat && (!targetStat || sourceStat.mtimeMs > targetStat.mtimeMs)) {
    await fs.copyFile(sourceAuth, targetAuth);
  }
  if (!sourceStat && !targetStat) throw new Error('Codex 尚未登录，请先登录 Codex 后使用菜单 6 重试总结。');
  const schemaPath = path.join(job, 'schema.json');
  const outputPath = path.join(job, 'result.json');
  await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '-C', work, '--color', 'never',
    '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
    '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="never"',
    '-m', process.env.DOUYIN_SUMMARY_MODEL || 'gpt-5.5',
    '--output-schema', schemaPath, '-o', outputPath, '-'];
  const env = { ...process.env, CODEX_HOME: aiHome, TEMP: path.join(runtimeRoot, 'tmp'), TMP: path.join(runtimeRoot, 'tmp') };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    if (env[name] === 'http://127.0.0.1:9') delete env[name];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const started = Date.now();
    const heartbeat = setInterval(() => console.log(`[AI] 等待总结服务返回，已用 ${Math.round((Date.now() - started) / 1000)} 秒`), 15000);
    const timer = setTimeout(() => child.kill(), 240000);
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearInterval(heartbeat); clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearInterval(heartbeat); clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex 总结失败（${code ?? '超时'}）：${stderr.slice(-1800)}`));
    });
    child.stdin.end(prompt);
  });
  return JSON.parse((await fs.readFile(outputPath, 'utf8')).replace(/^\uFEFF/, ''));
}
