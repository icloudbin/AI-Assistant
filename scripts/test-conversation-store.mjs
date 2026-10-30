#!/usr/bin/env node
// Unit tests for conversation-store.js (the side panel's saved-history
// save/merge logic - two open panels share one storage key, so a bad merge
// silently deletes the other panel's conversations).
// Run:  node scripts/test-conversation-store.mjs
import {
  mergeConversationLists,
  sortedByNewest,
  resolveContextEpoch,
  withHistoryLock,
} from "../conversation-store.js";
import { MAX_SAVED_CONVERSATIONS } from "../storage-keys.js";

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
};
const convo = (id, updatedAt, messages = [{ role: "user", content: "x" }]) => ({ id, updatedAt, messages });
const ids = (list) => list.map((c) => c.id).join(",");

// Two panels, disjoint conversations: nothing is lost on either side.
eq(
  "stored-only (other panel) conversations are preserved",
  ids(mergeConversationLists([convo("a", 100)], [convo("b", 200)], "b")),
  "a,b"
);

// The conversation this panel is showing: both copies may have valid turns
// (another window can append to the same conversation), so their messages are
// unioned instead of one copy silently winning.
{
  const merged = mergeConversationLists(
    [convo("a", 999, [{ role: "user", content: "stored" }])],
    [convo("a", 100, [{ role: "user", content: "local" }])],
    "a"
  )[0];
  eq("current conversation keeps both copies", merged.messages.length, 2);
  eq("current conversation keeps local turn first on a tie", merged.messages[0].content, "local");
  eq("current conversation appends stored-only turn", merged.messages[1].content, "stored");
  eq("current conversation keeps the newest timestamp", merged.updatedAt, 999);
}
{
  // The longer local copy is the base, but the stored copy's unique turn is
  // still appended rather than lost.
  const merged = mergeConversationLists(
    [convo("a", 100, [{ role: "assistant", content: "stored-only" }])],
    [convo("a", 999, [
      { role: "user", content: "local-1" },
      { role: "assistant", content: "local-2" },
    ])],
    "a"
  )[0];
  eq("longer local current conversation keeps its order", merged.messages[0].content, "local-1");
  eq("stored-only turn is appended", merged.messages[2].content, "stored-only");
  eq("longer local current conversation wins metadata", merged.updatedAt, 999);
}

// Any other id: newest updatedAt wins; a tie keeps the local copy.
eq(
  "non-current id, stored newer -> stored copy kept",
  mergeConversationLists([convo("a", 300)], [convo("a", 100)], "other")[0].updatedAt,
  300
);
eq(
  "non-current id, local newer -> local copy kept",
  mergeConversationLists([convo("a", 100)], [convo("a", 300)], "other")[0].updatedAt,
  300
);
eq(
  "non-current id, tie -> local copy kept",
  mergeConversationLists([convo("a", 100)], [convo("a", 100, [{ role: "user", content: "local" }])], "other")[0].messages[0].content,
  "local"
);

// Garbage in either list is dropped, never merged and never thrown on.
eq(
  "null / id-less / message-less entries in stored are skipped",
  ids(mergeConversationLists([null, {}, convo("a", 1), { id: "empty", messages: [] }], [], null)),
  "a"
);
eq(
  "null / id-less entries in local are skipped",
  ids(mergeConversationLists([], [null, {}, convo("b", 1)], null)),
  "b"
);
eq(
  "stored is not an array at all -> treated as empty",
  ids(mergeConversationLists(undefined, [convo("b", 1)], null)),
  "b"
);

// A message-less local entry (never produced today, guarded anyway) must
// not evict the stored copy of the same conversation - not even when it is
// "newer" or claims to be the current one.
eq(
  "message-less local entry (newer, current) cannot evict the stored copy",
  ids(mergeConversationLists([convo("a", 100)], [{ id: "a", updatedAt: 999, messages: [] }], "a")),
  "a"
);
eq(
  "message-less local entry is dropped on its own",
  ids(mergeConversationLists([], [{ id: "b", updatedAt: 1, messages: [] }, convo("c", 1)], null)),
  "c"
);

// ---------- page-context epochs ----------
// history always includes the CURRENT user message as its last entry.
const pageA = { title: "A", url: "https://a.example/", tabId: 1 };
const pageB = { title: "B", url: "https://b.example/", tabId: 2 };
const user = (content, pageContext, contextEpoch) => ({
  role: "user",
  content,
  ...(pageContext ? { pageContext } : {}),
  ...(contextEpoch !== undefined ? { contextEpoch } : {}),
});
const assistant = (content) => ({ role: "assistant", content });
{
  const first = resolveContextEpoch([user("q1")], null);
  eq("first message: epoch 0", first.epoch, 0);
  eq("first message: no change", first.changed, false);
  eq("first message: current index is the boundary", first.start, 0);
}
{
  const firstWithPage = resolveContextEpoch([user("q1", pageA, 0), assistant("a1"), user("q2")], pageA);
  eq("same-page follow-up: no new epoch", firstWithPage.epoch, 0);
  eq("same-page follow-up: starts at first turn", firstWithPage.start, 0);
  eq("same-page follow-up: previous page available but not a change", firstWithPage.previousPage.url, pageA.url);
}
{
  const switched = resolveContextEpoch(
    [user("q1", pageA, 0), assistant("a1 (page A)"), user("q2")],
    pageB
  );
  eq("page switch: new epoch", switched.epoch, 1);
  eq("page switch: change detected", switched.changed, true);
  eq("page switch: previous page reported", switched.previousPage.url, pageA.url);
  eq("page switch: current request gets no earlier history", switched.start, 2);
}
{
  // The bug this fixes: on the FOLLOW-UP after the switch, the old assistant
  // answer must still be excluded, not just on the switch request itself.
  const followUp = resolveContextEpoch(
    [user("q1", pageA, 0), assistant("a1 (page A)"), user("q2", pageB, 1), assistant("a2 (page B)"), user("q3")],
    pageB
  );
  eq("follow-up after switch: same epoch", followUp.epoch, 1);
  eq("follow-up after switch: no change", followUp.changed, false);
  eq("follow-up after switch: starts at page-B turn", followUp.start, 2);
}
{
  // Switching back to A starts a third epoch; old A turns stay excluded.
  const back = resolveContextEpoch(
    [
      user("q1", pageA, 0), assistant("a1"),
      user("q2", pageB, 1), assistant("a2"),
      user("q3"),
    ],
    pageA
  );
  eq("switch back: new epoch", back.epoch, 2);
  eq("switch back: starts at current request", back.start, 4);
}
{
  // Same URL but a different tab is a different page context.
  const otherTab = { ...pageA, tabId: 99 };
  const tabSwitch = resolveContextEpoch(
    [user("q1", pageA, 0), assistant("a1"), user("q2")],
    otherTab
  );
  eq("same URL in a different tab: new epoch", tabSwitch.epoch, 1);
  eq("same URL in a different tab: change detected", tabSwitch.changed, true);
}
{
  // Legacy conversations have no contextEpoch. The first real page change still
  // starts epoch 1 and excludes the old turns.
  const legacy = resolveContextEpoch(
    [user("q1", pageA), assistant("a1"), user("q2")],
    pageB
  );
  eq("legacy history: page switch gets epoch 1", legacy.epoch, 1);
  eq("legacy history: current request gets no earlier history", legacy.start, 2);
}
{
  // Legacy follow-up AFTER a page switch must also derive the epoch, even
  // though none of the stored messages has a contextEpoch yet.
  const legacyFollowUp = resolveContextEpoch(
    [user("q1", pageA), assistant("a1"), user("q2", pageB), assistant("a2"), user("q3")],
    pageB
  );
  eq("legacy follow-up after switch: derived epoch 1", legacyFollowUp.epoch, 1);
  eq("legacy follow-up after switch: starts at page-B turn", legacyFollowUp.start, 2);
}

// ---------- cross-context history write lock ----------
{
  let ran = false;
  await withHistoryLock(async () => { ran = true; });
  eq("withHistoryLock runs the task without Web Locks", ran, true);
}
{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let requested = null;
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: async (name, options, task) => { requested = { name, options }; return task(); } } },
    });
    let ran = false;
    await withHistoryLock(async () => { ran = true; });
    eq("withHistoryLock uses the named exclusive lock", requested?.name, "ai-assistant-history-write");
    eq("withHistoryLock requests exclusive mode", requested?.options?.mode, "exclusive");
    eq("withHistoryLock runs the task inside the lock", ran, true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
}


// and slicing to MAX_SAVED_CONVERSATIONS; the trim keeps the NEWEST ones.
{
  const stored = [];
  for (let i = 0; i < MAX_SAVED_CONVERSATIONS + 5; i++) stored.push(convo(`c${i}`, i));
  const trimmed = sortedByNewest(mergeConversationLists(stored, [], null)).slice(0, MAX_SAVED_CONVERSATIONS);
  eq("trim to MAX_SAVED_CONVERSATIONS keeps exactly that many", trimmed.length, MAX_SAVED_CONVERSATIONS);
  eq("trim keeps the newest (highest updatedAt)", trimmed[0].id, `c${MAX_SAVED_CONVERSATIONS + 4}`);
  eq("trim drops the oldest", trimmed.some((c) => c.id === "c0"), false);
}

// sortedByNewest: descending, missing updatedAt counts as 0.
eq(
  "sortedByNewest orders descending",
  ids(sortedByNewest([convo("old", 1), convo("new", 9), convo("mid", 5)])),
  "new,mid,old"
);
eq(
  "missing updatedAt sorts as 0",
  ids(sortedByNewest([convo("undated", undefined), convo("dated", 1)])),
  "dated,undated"
);

process.exit(failed ? 1 : 0);
