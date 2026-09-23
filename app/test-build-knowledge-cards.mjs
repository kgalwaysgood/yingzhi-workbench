import assert from "node:assert/strict";
import test from "node:test";

import { renderKnowledgeCard } from "./build-knowledge-cards.mjs";

test("renders traceable machine transcript without claiming AI summary", () => {
  const card = renderKnowledgeCard({
    title: "示例视频",
    description: "示例简介",
    canonical_url: "https://www.douyin.com/video/1",
    video_id: "1",
    author: { nickname: "作者" },
    post_time: "2026-09-21T00:00:00Z",
    transcript: "机器识别内容",
    transcription: { language: "zh", language_probability: 0.99 },
  }, "2026-09-21T01:00:00Z");

  assert.match(card, /机器转写完成，待人工复核/);
  assert.match(card, /机器识别内容/);
  assert.match(card, /原始链接：https:\/\/www\.douyin\.com\/video\/1/);
  assert.doesNotMatch(card, /AI深度总结/);
});

test("uses explicit placeholders for missing metadata", () => {
  const card = renderKnowledgeCard({ video_id: "2", transcript: "" });
  assert.match(card, /作者：未提供/);
  assert.match(card, /无机器逐字稿/);
  assert.match(card, /尚无有效文字稿/);
  assert.doesNotMatch(card, /机器转写完成/);
});
