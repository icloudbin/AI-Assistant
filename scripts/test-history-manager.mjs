#!/usr/bin/env node
// Unit tests for sidepanel/history-manager.js (pure history-shaping helpers).
// v1.10.140: attachments are STRUCTURED data on a message (attachments.js) -
// `content` is only what the user typed and is never condensed; the storage
// projection and the quota pass shrink the `attachments` field instead, which
// also keeps a message's merge identity (role + model + content) stable.
// Run:  node scripts/test-history-manager.mjs
import assert from "node:assert/strict";
import {
  cleanForTopic,
  makeTopicTitle,
  toStoredMessage,
  compressForQuota,
  rememberQuotaCondensedAttachments,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
} from "../sidepanel/history-manager.js";
import { attachmentCharCount } from "../attachments.js";
import { mergeConversationLists } from "../conversation-store.js";

// ---------- cleanForTopic: content is only the user's own words ----------
assert.equal(cleanForTopic("hi   there\t\nagain"), "hi there again");

// ---------- makeTopicTitle: words, CJK cap, fallback ----------
assert.equal(makeTopicTitle([{ role: "user", content: "one two three" }]), "one two three");
assert.equal(makeTopicTitle([{ role: "assistant", content: "no user turn" }], "fallback"), "fallback", "no user text -> caller fallback");
const longWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
assert.equal(makeTopicTitle([{ role: "user", content: longWords }]).split(" ").length, 10, "at most 10 words");
assert.equal(makeTopicTitle([{ role: "user", content: "很长的中文标题".repeat(30) }]).length, 80, "CJK capped at 80 chars");
assert.equal(makeTopicTitle([{ role: "user", displayContent: "shown", content: "stored" }]), "shown", "displayContent preferred for titles");
// Attached file text is not part of the title (it rides in `attachments`).
assert.equal(
  makeTopicTitle([{ role: "user", content: "what is this?", attachments: [{ name: "f.txt", kind: "text", text: "attachment words that must not title" }] }]),
  "what is this?",
  "attachment text never leaks into the title"
);

// ---------- surrogate safety at the attachment caps ----------
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
{
  // A preview cap landing inside a surrogate pair: the condensed attachment
  // must never carry a lone surrogate (it goes to the model, and
  // JSON.stringify emits an unpaired \ud83d that some backends reject
  // with 400/500).
  const stored = toStoredMessage({
    role: "user",
    content: "q",
    attachments: [{ name: "emoji.txt", kind: "text", text: "text\n" + "\u{1F600}".repeat(2500) }],
  });
  const att = stored.attachments[0];
  assert.ok(att.condensed === true, "oversized attachment condensed on store");
  assert.ok(attachmentCharCount(stored.attachments) <= STORED_ATTACHMENT_PREVIEW_CHARS, `preview bounded (${attachmentCharCount(stored.attachments)})`);
  assert.ok(!LONE.test(att.text), "stored condensation has no lone surrogate");
  assert.equal(stored.content, "q", "content itself is never touched");
}

// ---------- toStoredMessage: structured attachments, piiMap, display copy ----------
const big = "z".repeat(STORED_ATTACHMENT_PREVIEW_CHARS + 500);
const stored = toStoredMessage({ role: "user", content: "q", attachments: [{ name: "big.txt", kind: "text", text: big }] });
assert.ok(attachmentCharCount(stored.attachments) < big.length, "oversized attachment preview condensed on store");
assert.ok(stored.attachments[0].name === "big.txt", "file names survive condensing");
// Dedupe applies when the display copy would be byte-identical to the stored one.
assert.ok(!("displayContent" in toStoredMessage({ role: "user", content: "plain question" })), "identical displayContent is not stored twice");
const differing = toStoredMessage({ role: "user", content: "api text", displayContent: "pretty text" });
assert.equal(differing.displayContent, "pretty text", "differing displayContent is kept");
assert.equal(differing.pageContext, null, "pageContext defaults to null");
assert.ok(!("attachments" in toStoredMessage({ role: "user", content: "no files" })), "no attachments field when there are none");
const plain = toStoredMessage({ role: "assistant", content: "x", plain: true });
assert.equal(plain.plain, true, "plain flag persisted for translation replies");
assert.ok(!("plain" in toStoredMessage({ role: "assistant", content: "x" })), "plain flag omitted otherwise");
// Assistant replies keep their placeholder->value map (sanitized); user turns never do.
const withMap = toStoredMessage({ role: "assistant", content: "mail [EMAIL#1]", piiMap: { "[EMAIL#1]": "jane@example.com", "bad key": "x", "[EMAIL#2]": "v".repeat(3000) } });
assert.deepEqual(withMap.piiMap, { "[EMAIL#1]": "jane@example.com" }, "piiMap sanitized: unknown keys and oversized values dropped");
assert.ok(!("piiMap" in toStoredMessage({ role: "assistant", content: "no map" })), "no piiMap field when there is none");
assert.ok(!("piiMap" in toStoredMessage({ role: "user", content: "u", piiMap: { "[EMAIL#1]": "x" } })), "user turns never carry a piiMap");
assert.ok(!("attachments" in toStoredMessage({ role: "assistant", content: "a", attachments: [{ name: "x", kind: "text", text: "t" }] })), "assistant turns never carry attachments");

// ---------- compressForQuota: shrink attachment previews, drop display copies, keep everything else ----------
const bigText = "y".repeat(QUOTA_ATTACHMENT_PREVIEW_CHARS + 900);
const quotaIn = [{
  id: "c1",
  title: "t",
  messages: [
    { role: "user", content: "question?", attachments: [{ name: "a.txt", kind: "text", text: bigText }], displayContent: "dup" },
    { role: "assistant", content: "answer" },
  ],
}];
const quotaOut = compressForQuota(quotaIn);
assert.equal(quotaOut[0].messages.length, 2, "no messages dropped");
assert.ok(!("displayContent" in quotaOut[0].messages[0]), "display-only copy dropped");
assert.ok(attachmentCharCount(quotaOut[0].messages[0].attachments) <= QUOTA_ATTACHMENT_PREVIEW_CHARS, "attachment preview shrunk to the quota cap");
assert.equal(quotaOut[0].messages[0].attachments[0].condensed, true, "quota-shrunk copy is marked condensed");
assert.equal(quotaOut[0].messages[0].content, "question?", "content untouched by the quota pass");
assert.ok(!("attachments" in quotaOut[0].messages[1]), "non-attachment messages untouched");
const before = JSON.stringify(quotaIn);
compressForQuota(quotaIn);
assert.equal(JSON.stringify(quotaIn), before, "input not mutated");

// ---------- quota shrinking does not disturb the merge identity ----------
// content is never condensed, so a stored quota-shrunk copy and a fresh
// projection of the same message have the SAME merge identity - the union
// merge cannot duplicate the turn. The remembered flag only stops the next
// save from re-trying the large preview and failing on quota again.
{
  const live = {
    role: "user",
    content: "Question?",
    attachments: [{ name: "x.txt", kind: "text", text: "x".repeat(9000) }],
    displayContent: "Question?",
    modelLabel: "",
    modelId: "",
  };
  const history = [live];
  const storedConvo = { id: "c", updatedAt: 1, messages: [toStoredMessage(live)] };
  const compressed = compressForQuota([storedConvo])[0];
  assert.ok(attachmentCharCount(compressed.messages[0].attachments) < attachmentCharCount(storedConvo.messages[0].attachments), "quota pass shortens this message further");

  // Merge identity survives the quota pass (no duplicate bubble, no double send).
  const freshConvo = { id: "c", updatedAt: 2, messages: history.map(toStoredMessage) };
  const merged = mergeConversationLists([compressed], [freshConvo], "c");
  assert.equal(merged[0].messages.length, 1, "quota-condensed copy merges with the fresh projection (identity is content-based)");

  // The fix: the panel remembers the shrunken preview on the live message, so
  // the next save starts small instead of failing on quota again.
  rememberQuotaCondensedAttachments(history, compressed.messages);
  assert.equal(live.quotaCondensed, true, "quota-shrunken preview remembered on the live message");
  const reprojected = history.map(toStoredMessage);
  assert.ok(attachmentCharCount(reprojected[0].attachments) <= QUOTA_ATTACHMENT_PREVIEW_CHARS, "re-projection starts from the small preview");
}
{
  // rememberQuotaCondensedAttachments must never adopt a diverged stored turn
  // (another panel's different message at this index).
  const live = { role: "user", content: "my question", attachments: [{ name: "a.txt", kind: "text", text: "t".repeat(9000) }] };
  rememberQuotaCondensedAttachments([live], [{ role: "user", content: "another panel's different turn" }]);
  assert.equal(live.quotaCondensed, undefined, "diverged stored turn is not adopted");
}

console.log("OK: history-manager.js — titles, structured-attachment projection, quota compression.");
process.exit(0);
