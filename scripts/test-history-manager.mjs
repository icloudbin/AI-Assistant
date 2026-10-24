#!/usr/bin/env node
// Unit tests for sidepanel/history-manager.js (pure history-shaping helpers
// moved verbatim from sidepanel.js). Run:  node scripts/test-history-manager.mjs
import assert from "node:assert/strict";
import {
  cleanForTopic,
  makeTopicTitle,
  condenseStoredContent,
  toStoredMessage,
  compressForQuota,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
} from "../sidepanel/history-manager.js";

// ---------- cleanForTopic strips attachment blocks ----------
assert.equal(cleanForTopic("hi [ATTACHMENTS]\nblob\n[/ATTACHMENTS] there"), "hi there");

// ---------- makeTopicTitle: words, CJK cap, fallback ----------
assert.equal(makeTopicTitle([{ role: "user", content: "one two three" }]), "one two three");
assert.equal(makeTopicTitle([{ role: "assistant", content: "no user turn" }], "fallback"), "fallback", "no user text -> caller fallback");
const longWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
assert.equal(makeTopicTitle([{ role: "user", content: longWords }]).split(" ").length, 10, "at most 10 words");
assert.equal(makeTopicTitle([{ role: "user", content: "很长的中文标题".repeat(30) }]).length, 80, "CJK capped at 80 chars");
assert.equal(makeTopicTitle([{ role: "user", displayContent: "shown", content: "stored" }]), "shown", "displayContent preferred for titles");

// ---------- condenseStoredContent / toStoredMessage ----------
const big = `[ATTACHMENTS]\n${"z".repeat(STORED_ATTACHMENT_PREVIEW_CHARS + 500)}\n[/ATTACHMENTS]`;
const stored = toStoredMessage({ role: "user", content: `q ${big}` });
assert.ok(stored.content.length < `q ${big}`.length, "oversized attachment preview condensed on store");
assert.equal(stored.displayContent, `q ${big}`, "the pre-condensation text survives as displayContent for the live session");
// Dedupe applies when the display copy would be byte-identical to the stored one.
assert.ok(!("displayContent" in toStoredMessage({ role: "user", content: "plain question" })), "identical displayContent is not stored twice");
const differing = toStoredMessage({ role: "user", content: "api text", displayContent: "pretty text" });
assert.equal(differing.displayContent, "pretty text", "differing displayContent is kept");
assert.equal(differing.pageContext, null, "pageContext defaults to null");
const plain = toStoredMessage({ role: "assistant", content: "x", plain: true });
assert.equal(plain.plain, true, "plain flag persisted for translation replies");
assert.ok(!("plain" in toStoredMessage({ role: "assistant", content: "x" })), "plain flag omitted otherwise");

// ---------- compressForQuota: drop display copies, shrink previews, keep everything else ----------
const quotaIn = [{
  id: "c1",
  title: "t",
  messages: [
    { role: "user", content: "[ATTACHMENTS]\n" + "y".repeat(QUOTA_ATTACHMENT_PREVIEW_CHARS + 900) + "\n[/ATTACHMENTS]", displayContent: "dup" },
    { role: "assistant", content: "answer" },
  ],
}];
const quotaOut = compressForQuota(quotaIn);
assert.equal(quotaOut[0].messages.length, 2, "no messages dropped");
assert.ok(!("displayContent" in quotaOut[0].messages[0]), "display-only copy dropped");
assert.ok(quotaOut[0].messages[0].content.length < quotaIn[0].messages[0].content.length, "attachment preview shrunk to the quota cap");
assert.match(quotaOut[0].messages[0].content, /\.\.\.\[\/ATTACHMENTS\]$/, "quota form keeps the closing marker");
assert.equal(quotaOut[0].messages[1].content, "answer", "non-attachment messages untouched");
const before = JSON.stringify(quotaIn);
compressForQuota(quotaIn);
assert.equal(JSON.stringify(quotaIn), before, "input not mutated");

console.log("OK: history-manager.js — titles, stored-message projection, quota compression.");
process.exit(0);
