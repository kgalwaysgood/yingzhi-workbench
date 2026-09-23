#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { summarizeKnowledge } from "./summarize-knowledge.mjs";

function text(value, fallback = "未提供") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function formatDate(value) {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString();
}

export function renderKnowledgeCard(item, generatedAt = new Date().toISOString()) {
  const transcript = text(item.transcript, "无机器逐字稿");
  const author = text(item.author?.nickname || item.author?.name);
  const sourceUrl = text(item.canonical_url || item.source_url || item.url);
  const title = text(item.title || item.description, `抖音作品 ${text(item.video_id || item.videoId)}`);
  const language = text(item.transcription?.language || item.language);
  const probability = item.transcription?.language_probability ?? item.language_probability ?? "未提供";

  return `# ${title}\n\n` +
    `## 来源与状态\n\n` +
    `- 内容状态：${String(item.transcript ?? '').trim() ? '机器转写完成，待人工复核' : '仅媒体/元数据，尚无有效文字稿'}\n` +
    `- 来源平台：抖音\n` +
    `- 原始链接：${sourceUrl}\n` +
    `- 作者：${author}\n` +
    `- 作品ID：${text(item.video_id || item.videoId)}\n` +
    `- 发布时间：${formatDate(item.post_time || item.publish_time)}\n` +
    `- 生成时间：${generatedAt}\n` +
    `- 转写语言：${language}\n` +
    `- 语言置信度：${probability}\n\n` +
    `## 视频简介\n\n${text(item.description, "原始数据未提供简介")}\n\n` +
    `## 机器逐字稿\n\n> 以下内容由语音识别生成，可能存在错字、漏字和断句错误，引用前必须复核。\n\n${transcript}\n\n` +
    `## 待整理\n\n- [ ] 校对逐字稿\n- [ ] 提炼核心观点\n- [ ] 标注可复用知识与适用边界\n- [ ] 关联已有知识条目\n`;
}

export async function buildKnowledgeCards(summaryPath) {
  const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  const generatedAt = new Date().toISOString();
  const cards = [];

  for (const result of summary.results ?? []) {
    if (result.status !== "completed" || !result.jsonPath) continue;
    const item = JSON.parse(await fsp.readFile(result.jsonPath, "utf8"));
    const cardPath = path.join(path.dirname(result.jsonPath), `${path.basename(result.jsonPath, ".json")}_knowledge.md`);
    await fsp.writeFile(cardPath, renderKnowledgeCard(item, generatedAt), "utf8");
    cards.push({ title: text(item.title || item.description, result.title), cardPath, sourceUrl: text(item.canonical_url || item.source_url || result.url) });
  }

  if (cards.length === 0) throw new Error("汇总文件中没有可生成知识卡片的已完成作品。");
  const indexPath = path.join(path.dirname(summaryPath), "transcript-index.md");
  const lines = ["# 抖音知识卡片索引", "", `生成时间：${generatedAt}`, "", "状态说明：条目可能仅含媒体资料，是否已转写以卡片状态为准；文字稿必须人工复核后才能进入正式知识库。", ""];
  for (const card of cards) {
    const relative = path.relative(path.dirname(indexPath), card.cardPath).replaceAll("\\", "/");
    lines.push(`- [${card.title}](${relative}) - [原始视频](${card.sourceUrl})`);
  }
  await fsp.writeFile(indexPath, `${lines.join("\n")}\n`, "utf8");
  return { cards: cards.length, indexPath };
}

async function main() {
  const index = process.argv.indexOf("--summary");
  if (index < 0 || !process.argv[index + 1]) throw new Error("缺少 --summary 参数。");
  const result = await buildKnowledgeCards(process.argv[index + 1]);
  console.log(`知识卡片：${result.cards} 条；索引：${result.indexPath}`);
  if (!process.argv.includes('--transcript-only')) {
    console.log('进入AI核心知识总结：提炼观点、核对原文、归集主题。');
    const knowledge = await summarizeKnowledge(process.argv[index + 1]);
    console.log(`知识闭环完成：本批 ${knowledge.requested} 条；打开 data/knowledge/index.html 查看。`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`知识卡片生成失败：${error.message}`);
    process.exitCode = 2;
  });
}
