// scripts/test-conversation-store.mjs
//
// Regression test for B-04. Run with:  node scripts/test-conversation-store.mjs
//
// B-04  Merging two copies of one conversation (two windows can both have it
//       open) used to identify a message by role + model + content and append
//       whatever the other copy had to the END. So:
//         - window A's Q2/A2 landed AFTER window B's Q3/A3;
//         - identical messages (several "continue" turns) were folded, which
//           could leave an assistant reply with no user message before it.
//       Now every message has a stable id and a creation time; copies are
//       merged by id and ordered by time, in whole turns (a question stays with
//       its answer), and old data gets deterministic ids on migration.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const cs = await import("../conversation-store.js");
const hm = await import("../sidepanel/history-manager.js");
const { mergeConversationLists, mergeMessageLists, withMessageIds, migrateConversationIds, createMessage, newMessageId, isValidMessageId } = cs;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}

// ---- helpers ---------------------------------------------------------------
// A stamped message, the way sidepanel.js makes one (id + createdAt).
const U = (id, content, createdAt, extra = {}) => ({ id, createdAt, role: "user", content, modelLabel: "", modelId: "", ...extra });
const A = (id, content, createdAt, extra = {}) => ({ id, createdAt, role: "assistant", content, modelLabel: "M", modelId: "m1", ...extra });
// An old message: no id, no createdAt.
const oldU = (content) => ({ role: "user", content, modelLabel: "", modelId: "" });
const oldA = (content) => ({ role: "assistant", content, modelLabel: "M", modelId: "m1" });

const convo = (messages, updatedAt = 1, id = "c") => ({ id, title: "t", updatedAt, messages });
const texts = (messages) => messages.map((m) => m.content).join(" ");
const merged = (stored, local, current = "c") => mergeConversationLists(stored, local, current).find((c) => c.id === "c").messages;

// A question may have no answer (a failed or stopped request) - that is a normal
// shape - but an ASSISTANT message must never follow another assistant message
// or open the conversation: it would have lost its question.
function assertNoOrphanReply(messages) {
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    assert.ok(i > 0 && messages[i - 1].role === "user", `reply ${JSON.stringify(m.content)} at ${i} does not follow a user message: ${texts(messages)}`);
  });
}

// ---------------------------------------------------------------------------
await test("sortedByNewest sorts a COPY: the caller's list is not reordered (round-17 #22)", () => {
  const list = [{ id: "old", updatedAt: 100 }, { id: "new", updatedAt: 200 }];
  const snapshot = [...list];
  const sorted = cs.sortedByNewest(list);
  assert.deepEqual(list, snapshot, "the input array is not mutated");
  assert.deepEqual(sorted.map((m) => m.id), ["new", "old"], "the returned copy is newest-first");
});

await test("two windows continue one conversation: each window's turns land where they happened, whichever saves first", () => {
  const base = [U("u1", "Q1", 10), A("a1", "A1", 11)];
  const winA = convo([...base, U("u2", "Q2", 100), A("a2", "A2", 110)], 110);
  const winB = convo([...base, U("u3", "Q3", 200), A("a3", "A3", 210)], 210);
  // The old code gave: Q1 A1 Q3 A3 Q2 A2 (the turn saved first ended up last).
  assert.equal(texts(merged([winA], [winB])), "Q1 A1 Q2 A2 Q3 A3", "A saved first, then B");
  assert.equal(texts(merged([winB], [winA])), "Q1 A1 Q2 A2 Q3 A3", "B saved first, then A");
});

await test("windows that overlap in time keep user/assistant alternation (whole turns are ordered, not single messages)", () => {
  const base = [U("u1", "Q1", 10), A("a1", "A1", 11)];
  // t=100 A asks Q2, t=105 B asks Q3, t=120 A's reply arrives, t=130 B's reply arrives.
  const winA = (withReply) => convo([...base, U("u2", "Q2", 100), ...(withReply ? [A("a2", "A2", 120)] : [])], withReply ? 120 : 100);
  const winB = (withReply) => convo([...base, U("u3", "Q3", 105), ...(withReply ? [A("a3", "A3", 130)] : [])], withReply ? 130 : 105);
  let stored = [convo(base, 11)];
  const save = (local) => { stored = mergeConversationLists(stored, [local], "c"); return stored[0].messages; };
  assert.equal(texts(save(winA(false))), "Q1 A1 Q2");
  assert.equal(texts(save(winB(false))), "Q1 A1 Q2 Q3", "two unanswered questions: the normal shape of a failed request");
  const afterA = save(winA(true));
  assert.equal(texts(afterA), "Q1 A1 Q2 A2 Q3", "A's reply goes with A's question, not after Q3");
  const afterB = save(winB(true));
  assert.equal(texts(afterB), "Q1 A1 Q2 A2 Q3 A3");
  assertNoOrphanReply(afterB);
  // Sorting single messages by time would have produced Q2 Q3 A2 A3.
});

await test("identical messages are not folded: three 'continue' turns stay three turns, and no reply loses its question", () => {
  const winB = convo([U("u1", "go", 10), A("a1", "ok", 11), U("u2", "continue", 20), A("a2", "more", 21), U("u3", "continue", 30), A("a3", "even more", 31)], 31);
  const winA = convo([U("u1", "go", 10), A("a1", "ok", 11), U("u2", "continue", 20), A("a2", "more", 21), U("u4", "q4", 40), A("a4", "a4", 41), U("u5", "q5", 50), A("a5", "a5", 51)], 51);
  const out = merged([winB], [winA]);
  // The old code folded B's second "continue" and appended its reply alone: "... a5 even more".
  assert.equal(texts(out), "go ok continue more continue even more q4 a4 q5 a5");
  assertNoOrphanReply(out);
  assert.equal(out.filter((m) => m.content === "continue").length, 2);
});

await test("merging is idempotent, never duplicates, and does not depend on which copy is primary when every message has a time", () => {
  const a = [U("u1", "Q1", 10), A("a1", "A1", 11), U("u2", "Q2", 20), A("a2", "A2", 21)];
  const b = [U("u1", "Q1", 10), A("a1", "A1", 11), U("u3", "Q3", 30), A("a3", "A3", 31)];
  const ab = mergeMessageLists(a, b);
  assert.equal(texts(ab), "Q1 A1 Q2 A2 Q3 A3");
  assert.deepEqual(mergeMessageLists(b, a), ab);
  assert.deepEqual(mergeMessageLists(ab, a), ab);
  assert.deepEqual(mergeMessageLists(ab, ab), ab);
  assert.deepEqual(mergeMessageLists(a, a), a);
  assert.deepEqual(mergeMessageLists(a, []), a);
  assert.deepEqual(mergeMessageLists([], b), b);
  assert.deepEqual(mergeMessageLists(undefined, null), []);
});

await test("a reply that one copy attached to a different question is kept once, never dropped or duplicated", () => {
  // An old, scrambled copy has the reply after the wrong question; the good copy has it in place.
  const scrambled = [U("u1", "Q1", 10), U("u2", "Q2", 20), A("a2", "A2", 21)];
  const good = [U("u1", "Q1", 10), A("a1", "A1", 11), U("u2", "Q2", 20), A("a2", "A2", 21)];
  const out = mergeMessageLists(scrambled, good);
  assert.deepEqual(out.map((m) => m.id).sort(), ["a1", "a2", "u1", "u2"]);
});

// ---------------------------------------------------------------------------
await test("old messages get DETERMINISTIC ids: same in every copy and on every run, repeats stay distinct", () => {
  const legacy = [oldU("go"), oldA("ok"), oldU("continue"), oldA("more"), oldU("continue"), oldA("more")];
  const first = withMessageIds(legacy);
  const second = withMessageIds(legacy.map((m) => ({ ...m })));
  assert.deepEqual(first.map((m) => m.id), second.map((m) => m.id), "a second run gives the same ids");
  assert.equal(new Set(first.map((m) => m.id)).size, 6, "the two 'continue' turns (and the two 'more' replies) are different messages");
  assert.ok(first.every((m) => isValidMessageId(m.id)));
  assert.ok(first.every((m) => m.createdAt === undefined), "no timestamp is invented for old messages");
  // A copy that has more messages appended agrees on the shared prefix.
  const longer = withMessageIds([...legacy, oldU("new")]);
  assert.deepEqual(longer.slice(0, 6).map((m) => m.id), first.map((m) => m.id));
  // Migrating migrated data changes nothing (and allocates nothing).
  assert.equal(withMessageIds(first), first);
  // The id is about what the message IS: a shortened preview or a dropped display copy does not change it.
  const withFiles = [{ ...oldU("go"), attachments: [{ name: "a", kind: "text", text: "x".repeat(5000) }], displayContent: "go\n\n📎 a" }];
  const condensed = hm.compressForQuota([{ id: "c", messages: withFiles }])[0].messages;
  assert.equal(withMessageIds(withFiles)[0].id, withMessageIds(condensed)[0].id);
});

await test("old copies of one conversation merge without duplicates and keep the old behaviour (primary first, extras appended)", () => {
  const stored = convo([oldU("go"), oldA("ok"), oldU("continue"), oldA("more")]);
  const local = convo([oldU("go"), oldA("ok"), oldU("other"), oldA("x")]);
  const out = merged([stored], [local]);
  assert.equal(texts(out), "go ok other x continue more");
  assertNoOrphanReply(out);
  // Migrating the stored list first (what the side panel does on load) changes nothing about the result.
  assert.equal(texts(merged(migrateConversationIds([stored]), [local])), texts(out));
});

await test("an old conversation continued in two windows: old part first, then both new turns in time order", () => {
  const legacy = [oldU("go"), oldA("ok")];
  const loadedByA = withMessageIds(legacy);
  const loadedByB = withMessageIds(legacy.map((m) => ({ ...m })));
  const winA = convo([...loadedByA, U("n1", "from A", 300), A("n2", "reply A", 310)], 310);
  const winB = convo([...loadedByB, U("n3", "from B", 200), A("n4", "reply B", 210)], 210);
  const out = merged([winA], [winB]);
  assert.equal(texts(out), "go ok from B reply B from A reply A");
  assertNoOrphanReply(out);
});

await test("a turn without a time (an old one added after stamped ones) inherits the time of what came before it in its copy", () => {
  const copy = [U("u1", "Q1", 100), A("a1", "A1", 110), oldU("old question"), oldA("old reply")];
  const other = [U("u1", "Q1", 100), A("a1", "A1", 110), U("u9", "Q9", 120)];
  assert.equal(texts(mergeMessageLists(copy, other)), "Q1 A1 old question old reply Q9");
  assert.equal(texts(mergeMessageLists(other, copy)), "Q1 A1 old question old reply Q9", "same either way round");
});

await test("an id used twice in one list does not make a merge lose a message", () => {
  const dup = [U("same", "first", 10), A("same", "second", 11)];
  const fixed = withMessageIds(dup);
  assert.equal(new Set(fixed.map((m) => m.id)).size, 2);
  assert.equal(fixed[0].id, "same", "the first one keeps its id");
  assert.deepEqual(mergeMessageLists(dup, []).map((m) => m.content), ["first", "second"]);
  // Invalid ids (not a string, empty, absurdly long) are replaced, not trusted.
  const odd = withMessageIds([{ ...oldU("a"), id: 5 }, { ...oldU("b"), id: "" }, { ...oldU("c"), id: "x".repeat(500) }]);
  assert.ok(odd.every((m) => isValidMessageId(m.id) && m.id.startsWith("legacy-")));
});

// ---------------------------------------------------------------------------
await test("the same message in both copies: a page context saved later is kept, whichever copy has it", () => {
  const first = U("u1", "Q1", 10); // stored right after sending: no page context yet
  const later = U("u1", "Q1", 10, { pageContext: { title: "T", url: "https://example.org/", tabId: 3 }, contextEpoch: 7 });
  for (const [stored, local] of [[first, later], [later, first]]) {
    const out = merged([convo([stored, A("a1", "A1", 11)])], [convo([local, A("a1", "A1", 11)])]);
    assert.equal(out.length, 2);
    assert.equal(out[0].pageContext?.url, "https://example.org/");
    assert.equal(out[0].contextEpoch, 7);
  }
  // An explicit null (what toStoredMessage writes) does not hide a real value either.
  const nulled = U("u1", "Q1", 10, { pageContext: null });
  assert.equal(merged([convo([nulled])], [convo([later])])[0].pageContext?.url, "https://example.org/");
});

await test("a quota-shortened attachment preview sticks: the live long copy does not bring it back (replaces the quotaCondensed flag)", () => {
  const big = "x".repeat(20000);
  const live = { ...U("u1", "q", 10), attachments: [{ name: "a.txt", kind: "text", text: big }], displayContent: "q\n\n📎 a.txt" };
  const stored1 = hm.toStoredMessage(live); // what the first save writes: 4000 characters
  assert.ok(stored1.attachments[0].text.length <= 4000);
  // The quota pass shortens what is stored to 800 and writes that.
  const shrunk = hm.compressForQuota([convo([stored1])])[0];
  assert.ok(shrunk.messages[0].attachments[0].text.length <= 800);
  assert.equal(shrunk.messages[0].id, "u1", "ids survive the quota pass");
  assert.equal(shrunk.messages[0].createdAt, 10);
  // The next save: the live message (full text) is projected again, and merged with storage.
  const next = merged([shrunk], [convo([hm.toStoredMessage(live), A("a1", "A1", 11)])]);
  assert.equal(next.length, 2);
  assert.ok(next[0].attachments[0].text.length <= 800, `the long preview came back: ${next[0].attachments[0].text.length}`);
  // The same holds when the stored copy is the longer one (another window added turns).
  const longerStored = convo([...shrunk.messages, A("a1", "A1", 11), U("u2", "more", 20)], 20);
  const next2 = merged([longerStored], [convo([hm.toStoredMessage(live)])]);
  assert.ok(next2[0].attachments[0].text.length <= 800);
  assert.equal(texts(next2), "q A1 more");
  assert.equal(hm.rememberQuotaCondensedAttachments, undefined, "the bookkeeping helper is gone");
});

// ---------------------------------------------------------------------------
await test("createMessage: UUID id, creation time, and a clock that steps backwards cannot reorder messages", () => {
  const m = createMessage({ role: "user", content: "hi" }, [], 1000);
  assert.match(m.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(m.createdAt, 1000);
  assert.equal(m.role, "user");
  const later = createMessage({ role: "assistant", content: "yo" }, [m], 500); // the clock went back
  assert.equal(later.createdAt, 1000, "never earlier than the message before it");
  assert.equal(createMessage({ role: "user", content: "x" }, [m], 2000).createdAt, 2000);
  assert.equal(new Set(Array.from({ length: 2000 }, () => newMessageId())).size, 2000);
  // Real clock by default.
  const before = Date.now();
  const now = createMessage({ role: "user", content: "x" }).createdAt;
  assert.ok(now >= before && now <= Date.now());
});

await test("toStoredMessage keeps the id and creation time (and never invents an id)", () => {
  const stored = hm.toStoredMessage(U("u1", "Q1", 123, { displayContent: "Q1 shown" }));
  assert.equal(stored.id, "u1");
  assert.equal(stored.createdAt, 123);
  assert.equal(stored.displayContent, "Q1 shown");
  const bare = hm.toStoredMessage(oldU("old"));
  assert.equal("id" in bare, false);
  assert.equal("createdAt" in bare, false);
  assert.equal("id" in hm.toStoredMessage({ ...oldU("x"), id: 5, createdAt: "soon" }), false, "invalid values are not stored");
});

await test("mergeConversationLists: other conversations still keep the newest copy; storage-only conversations survive; a message-less local entry cannot delete", () => {
  const msgs = (word, t0) => [U(`${word}-u`, `${word}?`, t0), A(`${word}-a`, `${word}!`, t0 + 1)];
  const stored = [convo(msgs("x", 10), 20, "x"), convo(msgs("y", 10), 20, "y"), convo(msgs("z", 10), 20, "z")];
  const local = [
    convo(msgs("x2", 100), 30, "x"), // newer local copy of a non-current conversation: wins
    convo(msgs("y2", 100), 10, "y"), // older local copy: loses
    { id: "z", title: "", messages: [], updatedAt: 99 }, // must not delete the stored z
    convo(msgs("w", 100), 30, "w"), // only local
  ];
  const out = Object.fromEntries(mergeConversationLists(stored, local, "none").map((c) => [c.id, texts(c.messages)]));
  assert.deepEqual(out, { x: "x2? x2!", y: "y? y!", z: "z? z!", w: "w? w!" });
});

await test("migrateConversationIds: ids are added to every message of every conversation, other entries pass through", () => {
  const list = [convo([oldU("a"), oldA("b")]), null, { id: "no-messages" }, convo([U("u", "c", 5)], 1, "d")];
  const out = migrateConversationIds(list);
  assert.ok(out[0].messages.every((m) => isValidMessageId(m.id)));
  assert.equal(out[1], null);
  assert.deepEqual(out[2], { id: "no-messages" });
  assert.equal(out[3], list[3], "an already-migrated conversation is returned as it is");
  assert.equal(migrateConversationIds(undefined), undefined);
});

// ---------------------------------------------------------------------------
await test("source: every message the panel creates goes through createMessage; the quotaCondensed mechanism is gone", () => {
  const panel = read("sidepanel/sidepanel.js");
  const code = (src) => src.replace(/\/\/.*$/gm, "");
  assert.ok(!/history\.push\(\{/.test(code(panel)), "sidepanel.js pushes a message without createMessage()");
  assert.equal((code(panel).match(/history\.push\(createMessage\(/g) || []).length, 5, "user turn + DONE + ERROR + worker-recycle recovery + the Stop button (stopGeneration)");
  for (const f of ["sidepanel/sidepanel.js", "sidepanel/history-manager.js", "conversation-store.js", "options/options.js"]) {
    assert.ok(!/rememberQuotaCondensed|\.quotaCondensed|quotaCondensed\s*[:=]/.test(code(read(f))), `${f} still uses the quotaCondensed mechanism`);
  }
  // A restored backup keeps its ids and times, and old backups get deterministic ones.
  const options = code(read("options/options.js"));
  assert.ok(/isValidMessageId\(m\.id\)/.test(options) && /isValidTimestamp\(m\.createdAt\)/.test(options) && /withMessageIds\(messages\)/.test(options));
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
