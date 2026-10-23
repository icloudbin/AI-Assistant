// conversation-store.js
//
// Pure conversation-list helpers used by sidepanel.js when saving history to
// chrome.storage.local. Deliberately free of DOM and chrome.* calls so they
// can be unit-tested in Node (scripts/test-conversation-store.mjs); they
// previously lived inline in sidepanel.js, untested.

export function sortedByNewest(list) {
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Merge the stored list with this panel's list by id. The conversation this
// panel is showing is authoritative; any other id keeps the copy with the
// newest updatedAt (ties keep the local one). Conversations that exist only in
// storage (saved by another panel) are preserved.
export function mergeConversationLists(stored, local, currentId) {
  const byId = new Map();
  for (const c of Array.isArray(stored) ? stored : []) {
    if (c && c.id && c.messages?.length) byId.set(c.id, c);
  }
  for (const c of local) {
    // A message-less local entry must not be allowed to win: replacing the
    // stored copy of the same id (it is "newer", or it is the current
    // conversation) would drop that conversation from the merged result
    // entirely, because the output filter below discards message-less
    // entries. No current caller produces such an entry - this guard keeps
    // a future caller from silently deleting saved history.
    if (!c || !c.id || !c.messages?.length) continue;
    const other = byId.get(c.id);
    if (!other || c.id === currentId || (c.updatedAt || 0) >= (other.updatedAt || 0)) {
      byId.set(c.id, c);
    }
  }
  return [...byId.values()].filter((c) => c.messages?.length);
}
