#!/usr/bin/env node
// Unit tests for conversation-store.js (the side panel's saved-history
// save/merge logic - two open panels share one storage key, so a bad merge
// silently deletes the other panel's conversations).
// Run:  node scripts/test-conversation-store.mjs
import { mergeConversationLists, sortedByNewest } from "../conversation-store.js";
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

// The conversation this panel is showing is authoritative, even when the
// stored copy (written by another panel moments ago) is newer.
eq(
  "current conversation wins over a newer stored copy",
  ids(mergeConversationLists([convo("a", 999)], [convo("a", 100)], "a")),
  "a"
);
eq(
  "current conversation's own copy is the one kept",
  mergeConversationLists([convo("a", 999)], [convo("a", 100)], "a")[0].updatedAt,
  100
);

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

// The saved list is trimmed (in saveConversationsNow) by sorting newest-first
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
