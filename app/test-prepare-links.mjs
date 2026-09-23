import assert from "node:assert/strict";
import test from "node:test";

import { invalidRedirectMessage, isDouyinUrl, isProfileLink, normalizeCookies, normalizeWorkLink } from "./prepare-links.mjs";

test("explains a short link that lands on the Douyin homepage", () => {
  assert.match(invalidRedirectMessage("https://v.douyin.com/abc/", "https://www.douyin.com/"), /完整链接/);
  assert.match(invalidRedirectMessage("https://www.douyin.com/user/abc", "https://www.douyin.com/"), /跳转后不是博主主页/);
});

test("accepts Douyin hosts and rejects malformed or unrelated URLs", () => {
  assert.equal(isDouyinUrl("https://www.douyin.com/user/abc"), true);
  assert.equal(isDouyinUrl("https://v.douyin.com/abc"), true);
  assert.equal(isDouyinUrl("not-a-valid-url"), false);
  assert.equal(isDouyinUrl("https://example.com/video/1"), false);
});

test("normalizes canonical video and note links", () => {
  assert.equal(normalizeWorkLink("https://www.douyin.com/video/7510985027376827711?x=1"), "https://www.douyin.com/video/7510985027376827711");
  assert.equal(normalizeWorkLink("/note/7296623484266990867"), "https://www.douyin.com/note/7296623484266990867");
  assert.equal(normalizeWorkLink("https://example.com/video/1"), null);
});

test("recognizes profile links without misclassifying works", () => {
  assert.equal(isProfileLink("https://www.douyin.com/user/MS4wLjABAAAA"), true);
  assert.equal(isProfileLink("https://www.douyin.com/video/7510985027376827711"), false);
});

test("converts flat cookie dictionaries into Playwright cookies", () => {
  const cookies = normalizeCookies({ sessionid: "abc", msToken: "xyz" });
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].domain, ".douyin.com");
  assert.equal(cookies[0].sameSite, "Lax");
});

test("preserves valid cookie attributes from storage state", () => {
  const cookies = normalizeCookies({ cookies: [{ name: "sid", value: "1", domain: ".douyin.com", sameSite: "None", secure: true }] });
  assert.deepEqual(cookies[0], {
    name: "sid", value: "1", domain: ".douyin.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "None",
  });
});
