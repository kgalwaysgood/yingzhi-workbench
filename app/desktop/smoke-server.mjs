// Isolated local integration fixture. It never contacts Douyin or invokes a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkbench } from '../ui/server.mjs';

const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3]);
const data = path.join(root, 'data');
for (const directory of ['data', 'config', 'models/knowledge', 'bin/llama-cpp']) await fs.mkdir(path.join(root, directory), { recursive: true });
for (const file of ['config/cookies.json', 'models/knowledge/Qwen3-4B-Q4_K_M.gguf', 'bin/llama-cpp/llama-server.exe']) await fs.writeFile(path.join(root, file), 'TEST FIXTURE ONLY');
const { server } = createWorkbench({ runtimeRoot: root, operations: {
  discover: async () => ({ report: { creators: [{ author: '测试博主', profileUrl: 'https://www.douyin.com/user/fixture' }] } }),
  prepare: async () => ({ inputType: 'profile', works: Array.from({ length: 12 }, (_, i) => ({ title: `测试作品 ${i + 1}`, url: `https://www.douyin.com/video/${100 + i}` })) }),
  download: async urls => {
    const results = [];
    for (const url of urls) {
      const videoId = url.split('/').at(-1);
      const jsonPath = path.join(data, `${videoId}.json`);
      await fs.writeFile(jsonPath, JSON.stringify({ video_id: videoId, title: `稿件 ${videoId}`, transcript: '测试机器文字稿：订单、生产计划和交付需要记录清楚。' }));
      results.push({ videoId, jsonPath, url, title: `稿件 ${videoId}`, status: 'completed', hasTranscript: true });
    }
    return { results };
  },
  summarize: async ids => {
    const dir = path.join(data, 'knowledge', 'summaries');
    await fs.mkdir(dir, { recursive: true });
    const snapshot = (await fs.readdir(path.join(root, 'queue'))).find(name => /^session-.*-batch.json$/.test(name));
    const batch = JSON.parse(await fs.readFile(path.join(root, 'queue', snapshot), 'utf8'));
    const catalog = {};
    for (const id of ids) {
      const raw = JSON.parse(await fs.readFile(batch.results.find(row => row.videoId === id).jsonPath, 'utf8'));
      await fs.writeFile(path.join(dir, `${id}.md`), `# 离线夹具知识稿\n\n${raw.transcript}`);
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ summary: { title: `知识 ${id}`, topic: '测试' } }));
      catalog[id] = { status: 'completed' };
    }
    await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
    return { completed: ids.length };
  },
} });
server.listen(port, '127.0.0.1', () => console.log('READY'));
