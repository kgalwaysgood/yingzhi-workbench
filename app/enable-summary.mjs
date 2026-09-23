import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.env.DOUYIN_TOOL_HOME || 'D:\\YingzhiWorkbench';
if (!/^D:[\\/]/i.test(path.resolve(root))) throw new Error('Runtime must be on D drive.');
const directory = path.join(root, 'private');
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, 'knowledge-ai.json'), JSON.stringify({ enabled: true, provider: 'codex', authorizedAt: new Date().toISOString(), scope: 'Video transcripts -> grounded knowledge summaries using existing Codex login; runtime credentials and outputs on D drive.' }, null, 2), 'utf8');
console.log('已启用 Codex 自动知识总结，配置保存在 D 盘私密目录。');
