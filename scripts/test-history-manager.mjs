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
  limitStoredConversationMessages,
  MAX_STORED_MESSAGES_PER_CONVERSATION,
  MAX_STORED_CONVERSATION_BYTES,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
} from "../sidepanel/history-manager.js";
import { attachmentCharCount } from "../attachments.js";
import { mergeConversationLists, createMessage } from "../conversation-store.js";

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

// ---------- toStoredMessage: pageContext keeps title/url, drops the tabId ----------
// tabId is session-scoped; persisting it made the first follow-up after a
// browser restart wrongly reset the context epoch on the same page
// (round-17 #9). The live in-memory history keeps the tabId.
{
  const stored = toStoredMessage({
    role: "user",
    content: "q",
    pageContext: { title: "T", url: "https://x/", tabId: 42 },
  });
  assert.equal(stored.pageContext.title, "T", "title survives the storage projection");
  assert.equal(stored.pageContext.url, "https://x/", "url survives the storage projection");
  assert.ok(!("tabId" in stored.pageContext), "tabId is not persisted");
  assert.deepEqual(toStoredMessage({ role: "user", content: "q" }).pageContext, null, "no pageContext stays null");
}

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

// ---------- quota shrinking sticks through the merge by message id (B-04) ----------
// The quota pass shrinks only the structured `attachments` field; the message
// keeps its id, so the merge (reconcileDuplicate in conversation-store.js)
// keeps the SHORTER stored preview instead of the live full text coming back.
{
  const live = createMessage({
    role: "user",
    content: "Question?",
    attachments: [{ name: "x.txt", kind: "text", text: "x".repeat(9000) }],
    displayContent: "Question?",
    modelLabel: "",
    modelId: "",
  });
  const history = [live];
  const storedConvo = { id: "c", updatedAt: 1, messages: history.map(toStoredMessage) };
  const compressed = compressForQuota([storedConvo])[0];
  assert.ok(attachmentCharCount(compressed.messages[0].attachments) < attachmentCharCount(storedConvo.messages[0].attachments), "quota pass shortens this message further");

  // The same message (same id) in both copies merges into ONE, carrying the
  // shorter stored preview; content is untouched.
  const freshConvo = { id: "c", updatedAt: 2, messages: history.map(toStoredMessage) };
  const merged = mergeConversationLists([compressed], [freshConvo], "c");
  assert.equal(merged[0].messages.length, 1, "same id merges into one message (no duplicate bubble)");
  assert.ok(attachmentCharCount(merged[0].messages[0].attachments) <= QUOTA_ATTACHMENT_PREVIEW_CHARS, `the shorter stored preview wins (${attachmentCharCount(merged[0].messages[0].attachments)})`);
  assert.equal(merged[0].messages[0].content, "Question?", "content identity untouched");
  assert.equal(merged[0].messages[0].id, live.id, "the merged message keeps the live id");
}


{
  const many = Array.from({ length: MAX_STORED_MESSAGES_PER_CONVERSATION + 50 }, (_, i) => ({
    id: String(i), role: i % 2 === 0 ? "user" : "assistant", content: `message-${i}`,
  }));
  const limited = limitStoredConversationMessages({ id: "long", messages: many });
  assert.equal(limited.messages.length, MAX_STORED_MESSAGES_PER_CONVERSATION);
  assert.equal(limited.messages[0].id, String(many.length - MAX_STORED_MESSAGES_PER_CONVERSATION));
  assert.equal(limited.messages.at(-1).id, String(many.length - 1));
  assert.equal(limitStoredConversationMessages({ id: "small", messages: many.slice(0, 2) }).messages.length, 2);
  const huge = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: "assistant", content: String(i).repeat(400_000) }));
  const byteLimited = limitStoredConversationMessages({ id: "bytes", messages: huge });
  const byteSize = new TextEncoder().encode(JSON.stringify(byteLimited.messages)).length;
  assert.ok(byteSize <= MAX_STORED_CONVERSATION_BYTES, `serialized history stays within byte budget (${byteSize})`);
  assert.ok(byteLimited.messages.length < huge.length);
}

console.log("OK: history-manager.js — titles, structured-attachment projection, quota compression.");
process.exit(0);
