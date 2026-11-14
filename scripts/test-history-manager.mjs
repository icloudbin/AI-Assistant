#!/usr/bin/env node
// Unit tests for sidepanel/history-manager.js (pure history-shaping helpers).
// v1.10.140: attachments are STRUCTURED data on a message (attachments.js) -
// `content` is only what the user typed and is never condensed; the storage
// projection and the quota pass shrink the `attachments` field instead, which
// also keeps a message's merge identity (role + model + content) stable.
// Run:  node scripts/test-history-manager.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanForTopic,
  makeTopicTitle,
  translationTopicTitle,
  toStoredMessage,
  compressForQuota,
  limitStoredConversationMessages,
  MAX_STORED_MESSAGES_PER_CONVERSATION,
  MAX_STORED_CONVERSATION_BYTES,
  MAX_STORED_HISTORY_BYTES,
  limitStoredHistoryBytes,
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
  const huge = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: "assistant", content: "x".repeat(400_000) }));
  const byteLimited = limitStoredConversationMessages({ id: "bytes", messages: huge });
  const byteSize = new TextEncoder().encode(JSON.stringify(byteLimited.messages)).length;
  assert.ok(byteSize <= MAX_STORED_CONVERSATION_BYTES, `serialized history stays within byte budget (${byteSize})`);
  assert.ok(byteLimited.messages.some((message) => /Message truncated in saved history/.test(message.content)), "oversized message content is explicitly truncated instead of discarding the conversation");

  // An oversized newest turn is bounded (truncated with a visible marker), not
  // skipped; earlier complete turns remain available instead of the whole
  // conversation becoming empty.
  const oversizedLatest = [
    { id: "u-old", role: "user", content: "older question" },
    { id: "a-old", role: "assistant", content: "older answer" },
    { id: "u-new", role: "user", content: "new question" },
    { id: "a-new", role: "assistant", content: "x".repeat(MAX_STORED_CONVERSATION_BYTES + 1000) },
  ];
  const retained = limitStoredConversationMessages({ id: "oversized-latest", messages: oversizedLatest });
  assert.deepEqual(retained.messages.map((m) => m.id), ["u-old", "a-old", "u-new", "a-new"], "oversized newest message is retained in a bounded form");
  assert.match(retained.messages.at(-1).content, /Message truncated in saved history/, "truncated content is clearly marked");
  assert.ok(new TextEncoder().encode(JSON.stringify(retained.messages)).length <= MAX_STORED_CONVERSATION_BYTES, "truncated turn remains within the per-conversation byte budget");

  // The same reservation holds when an older turn's content is longer than its
  // own minimum: bounding the newest turn must leave older turns their floor
  // instead of consuming the whole remaining budget.
  const olderLong = [
    { id: "u-old", role: "user", content: "y".repeat(2000) },
    { id: "a-old", role: "assistant", content: "z".repeat(2000) },
    { id: "u-new", role: "user", content: "new question" },
    { id: "a-new", role: "assistant", content: "w".repeat(MAX_STORED_CONVERSATION_BYTES + 1000) },
  ];
  const reservedOlder = limitStoredConversationMessages({ id: "reserved-older", messages: olderLong });
  assert.deepEqual(reservedOlder.messages.map((m) => m.id), ["u-old", "a-old", "u-new", "a-new"], "older complete turns keep their reserved floor when the newest turn is bounded");
  assert.match(reservedOlder.messages[0].content, /Message truncated in saved history/, "an older turn beyond its floor is truncated, not dropped");
  assert.match(reservedOlder.messages.at(-1).content, /Message truncated in saved history/, "the newest oversized message is still bounded");
  assert.ok(new TextEncoder().encode(JSON.stringify(reservedOlder.messages)).length <= MAX_STORED_CONVERSATION_BYTES, "reservation keeps the whole conversation within the byte budget");

  // An older oversized turn with a newer small turn keeps both turns: the
  // older turn is bounded, the newer one stays whole.
  const olderOversized = [
    { id: "u-old", role: "user", content: "x".repeat(MAX_STORED_CONVERSATION_BYTES + 1000) },
    { id: "a-old", role: "assistant", content: "old answer" },
    { id: "u-new", role: "user", content: "new question" },
    { id: "a-new", role: "assistant", content: "new answer" },
  ];
  const keptBoth = limitStoredConversationMessages({ id: "older-oversized", messages: olderOversized });
  assert.deepEqual(keptBoth.messages.map((m) => m.id), ["u-old", "a-old", "u-new", "a-new"], "an older oversized turn is bounded, not dropped");
  assert.match(keptBoth.messages[0].content, /Message truncated in saved history/, "the older oversized message is truncated");
  assert.equal(keptBoth.messages.at(-1).content, "new answer", "the newer small turn stays whole");

  // The aggregate budget is applied to the complete history, newest first.
  const globalInput = [
    { id: "old", updatedAt: 1, messages: [{ role: "user", content: "o".repeat(30 * 1024 * 1024) }] },
    { id: "new", updatedAt: 2, messages: [{ role: "user", content: "n".repeat(30 * 1024 * 1024) }] },
  ];
  const global = limitStoredHistoryBytes(globalInput);
  assert.ok(global.bytes <= MAX_STORED_HISTORY_BYTES, "entire serialized history stays within global budget");
  assert.deepEqual(global.conversations.map((item) => item.id), ["new"], "newer conversation wins global budget");
  assert.equal(global.dropped, 1, "global limit reports the number of omitted conversations");
}

// ---------- translationTopicTitle: "<label>: <excerpt of the source>" ----------
{
  const label = "Translate";
  assert.equal(translationTopicTitle(label, "Hello world."), "Translate: Hello world.");
  // Long source: first 10 words, capped at 60 code points (CJK has no spaces).
  const longAscii = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  assert.ok(translationTopicTitle(label, longAscii).startsWith("Translate: w0 w1 w2 w3 w4 w5 w6 w7 w8 w9"), translationTopicTitle(label, longAscii));
  assert.ok(!translationTopicTitle(label, longAscii).includes("w10"), "excerpt stops at 10 words");
  const cjk = "汉".repeat(120);
  const cjkTitle = translationTopicTitle(label, cjk);
  assert.ok(cjkTitle.startsWith("Translate: ") && [...cjkTitle].length <= "Translate: ".length + 60 + 1, `CJK excerpt capped at 60 code points (${[...cjkTitle].length})`);
  // Empty/blank source keeps the bare label (capture failed / cancelled).
  assert.equal(translationTopicTitle(label, ""), label);
  assert.equal(translationTopicTitle(label, "   "), label);
  assert.equal(translationTopicTitle(label, null), label);
  // A missing label still returns text (never "undefined: ...").
  assert.equal(translationTopicTitle("", "Hello"), "Hello");
}

// ---------- the kept window is CONTIGUOUS (a skipped turn ends the walk) ----------
{
  // Turn sizes: newest 2, middle 199 (over the cap once the newest is kept),
  // oldest 2. A middle turn that cannot be kept must END the walk instead of
  // leaving a silent hole between the newest and oldest exchanges.
  const holeMessages = [
    { id: "u0", role: "user", content: "old q", createdAt: 10 },
    { id: "a0", role: "assistant", content: "old a", createdAt: 11 },
    { id: "u1", role: "user", content: "mid q", createdAt: 20 },
    ...Array.from({ length: 198 }, (_, i) => ({ id: `m${i}`, role: "assistant", content: `mid ${i}`, createdAt: 21 + i })),
    { id: "u2", role: "user", content: "new q", createdAt: 40 },
    { id: "a2", role: "assistant", content: "new a", createdAt: 41 },
  ];
  const kept = limitStoredConversationMessages({ id: "hole", messages: holeMessages });
  assert.deepEqual(
    kept.messages.map((m) => m.id),
    ["u2", "a2"],
    "a turn that cannot be kept ends the walk: the retained window stays contiguous (no silent hole)"
  );

  // The same contiguity on the byte path: the middle turn's minimum exceeds
  // what the newest turn left, so the older turn is not kept behind the gap.
  const byteHole = [
    { id: "old-u", role: "user", content: "old q", createdAt: 10 },
    { id: "old-a", role: "assistant", content: "old a", createdAt: 11 },
    { id: "mid-u", role: "user", content: "mid q", attachments: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, kind: "text", text: "a".repeat(900) })), createdAt: 20 },
    { id: "n-u", role: "user", content: "z".repeat(MAX_STORED_CONVERSATION_BYTES - 600), createdAt: 40 },
    { id: "n-a", role: "assistant", content: "new a", createdAt: 41 },
  ];
  const byteKept = limitStoredConversationMessages({ id: "byte-hole", messages: byteHole });
  assert.deepEqual(
    byteKept.messages.map((m) => m.id).filter((id) => id !== "n-u" && id !== "n-a"),
    [],
    "no older turn is kept behind a middle turn the budget cannot represent"
  );
}

// ---------- a conversation whose only turn exceeds the message cap is force-kept ----------
{
  // 201 assistant messages form ONE turn; the count walk cannot keep it and
  // used to silently empty the whole conversation. The newest 200 messages are
  // now kept in bounded form instead.
  const one = { id: "force", title: "t", createdAt: 1, updatedAt: 2, messages: [] };
  for (let i = 0; i < 201; i++) one.messages.push({ id: `m${i}`, role: "assistant", content: `reply ${i}`, createdAt: i });
  const forced = limitStoredConversationMessages(one);
  assert.equal(forced.messages.length, MAX_STORED_MESSAGES_PER_CONVERSATION, "the newest turn is force-kept in bounded form, not dropped");
  assert.equal(forced.messages[0].id, "m0", "the turn's first message anchors the kept window");
  assert.equal(forced.messages.at(-1).id, "m200", "the newest messages are the ones kept");
  assert.ok(
    new TextEncoder().encode(JSON.stringify(forced.messages)).length <= MAX_STORED_CONVERSATION_BYTES,
    "the force-kept turn respects the byte budget"
  );

  // A user-led oversized turn keeps its question as the anchor and the newest
  // replies within the cap.
  const two = { id: "force2", title: "t", createdAt: 1, updatedAt: 2, messages: [{ id: "u", role: "user", content: "q", createdAt: 0 }] };
  for (let i = 0; i < 220; i++) two.messages.push({ id: `a${i}`, role: "assistant", content: `r${i}`, createdAt: i });
  const forced2 = limitStoredConversationMessages(two);
  assert.equal(forced2.messages.length, MAX_STORED_MESSAGES_PER_CONVERSATION, "bounded turn keeps the cap count");
  assert.equal(forced2.messages[0].id, "u", "the user question anchors the kept window");
  assert.equal(forced2.messages.at(-1).id, "a219", "the newest replies are the ones kept");
}

// ---------- history-manager.js keeps ONE export site ----------
{
  // A second inline export in this module is a SyntaxError ("Duplicate
  // export") that kills the whole panel module tree - the v1.10.168 release
  // shipped exactly that. Pin the convention: no inline exports at all.
  const source = readFileSync(new URL("../sidepanel/history-manager.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(^|\n)export (const|let|var|function|class)\b/, "no inline exports: everything goes through the bottom export block");
}

console.log("OK: history-manager.js — titles, structured-attachment projection, quota compression.");
process.exit(0);
