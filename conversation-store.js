// conversation-store.js
//
// Pure conversation-list helpers used by sidepanel.js when saving history to
// chrome.storage.local. Deliberately free of DOM and chrome.* calls so they
// can be unit-tested in Node (scripts/test-conversation-store.mjs); they
// previously lived inline in sidepanel.js, untested.

export function sortedByNewest(list) {
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// One identity per stored message, used only to merge two copies of the SAME
// conversation (two windows can both have it open). Messages do not carry ids
// yet, so role + model + content is the best stable identity available; a
// repeated identical message is the only case this can collapse.
function messageIdentity(message) {
  return `${message?.role || ""}\u0000${message?.modelId || ""}\u0000${message?.content || ""}`;
}

// Union of both copies, preserving the primary copy's order and appending
// secondary messages that are not already present. This keeps turns written by
// another panel instead of letting whichever copy was shorter disappear.
function mergeMessageLists(primary, secondary) {
  const out = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(out.map(messageIdentity));
  for (const message of Array.isArray(secondary) ? secondary : []) {
    const key = messageIdentity(message);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

// Merge the stored list with this panel's list by id. For the conversation this
// panel is showing, the two copies are combined rather than one being chosen:
// another window may have appended turns to the same conversation since this
// panel loaded it. Any other id keeps the copy with the newest updatedAt (ties
// keep the local one). Conversations that exist only in storage (saved by
// another panel) are preserved.
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
    if (!other) {
      byId.set(c.id, c);
      continue;
    }
    if (c.id === currentId) {
      // Keep both sides of a concurrent edit. Metadata comes from the longer
      // copy so a stale, shorter local entry cannot discard the other panel's
      // title/updatedAt, but all messages from both copies survive.
      const localIsLonger = c.messages.length >= other.messages.length;
      const base = localIsLonger ? c : other;
      const extra = localIsLonger ? other : c;
      byId.set(c.id, {
        ...base,
        messages: mergeMessageLists(base.messages, extra.messages),
        updatedAt: Math.max(base.updatedAt || 0, extra.updatedAt || 0),
      });
      continue;
    }
    if ((c.updatedAt || 0) >= (other.updatedAt || 0)) {
      byId.set(c.id, c);
    }
  }
  return [...byId.values()].filter((c) => c.messages?.length);
}

// Cross-context write lock for HISTORY_STORAGE_KEY. chrome.storage.local has no
// compare-and-set, so two side panels (or the Settings page) doing
// read-merge-write concurrently can otherwise lose one writer's conversations.
// Web Locks are origin-scoped, so every extension page and the service worker
// participate. Older environments without navigator.locks keep the previous
// behaviour (the per-panel save queue still serializes that panel).
export const HISTORY_WRITE_LOCK = "ai-assistant-history-write";
export const CONTEXT_ACTION_LOCK = "ai-assistant-context-action";

export async function withNamedLock(name, task) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return task();
  return locks.request(name, { mode: "exclusive" }, () => task());
}

export async function withHistoryLock(task) {
  return withNamedLock(HISTORY_WRITE_LOCK, task);
}

function samePage(a, b) {
  if (!a || !b) return false;
  if (String(a.url || "") !== String(b.url || "")) return false;
  // Same URL in a different tab is a different page context (two Gmail tabs,
  // two documents, ...). Tab ids are session-scoped; compare them only when
  // both copies have one.
  if (a.tabId != null && b.tabId != null && Number(a.tabId) !== Number(b.tabId)) return false;
  return true;
}

// Resolve the "model context epoch" for the request currently being submitted.
// `history` includes the current user message as its last entry. A page change
// starts a new epoch; every later request in the same epoch sends only turns
// from that epoch, so old page-derived assistant answers cannot return on the
// next follow-up. Returns:
//   epoch        - epoch the current message belongs to
//   changed      - whether this request detected a page change
//   previousPage - the previous page context (for the model hint), or null
//   start        - index in history where the epoch starts (current index for
//                  a brand-new epoch, i.e. the request gets no prior turns)
export function resolveContextEpoch(history, currentPageContext) {
  const list = Array.isArray(history) ? history : [];
  const prior = list.slice(0, -1);
  let previousPage = null;
  let previousEpoch = 0;
  // Scan backward for two INDEPENDENT facts: the epoch of the most recent
  // submitted turn, and the most recent page context anywhere before this
  // request. They can sit in different messages: a turn submitted with page
  // reading off (or after a failed capture) carries an epoch but no page, and
  // stopping the scan at that message hid a later page change - the previous
  // page's turns stayed in the request history and the "page changed" hint was
  // never built.
  let epochFound = false;
  for (let i = prior.length - 1; i >= 0; i--) {
    const message = prior[i];
    if (!message || message.role !== "user") continue;
    if (!previousPage && message.pageContext) previousPage = message.pageContext;
    if (!epochFound && Number.isInteger(message.contextEpoch)) {
      previousEpoch = message.contextEpoch;
      epochFound = true;
    }
    if (previousPage && epochFound) break;
  }
  // Conversations saved by older builds have no explicit epoch. Derive one
  // from the pageContext transitions so a page change that was persisted
  // before this feature existed still starts a new context instead of
  // re-including the old page's assistant answers.
  const hasExplicitEpoch = prior.some(
    (message) => message?.role === "user" && Number.isInteger(message.contextEpoch)
  );
  let derivedByIndex = null;
  if (!hasExplicitEpoch) {
    derivedByIndex = new Map();
    let lastPage = null;
    let derived = 0;
    for (let i = 0; i < prior.length; i++) {
      const message = prior[i];
      if (!message || message.role !== "user") continue;
      if (message.pageContext) {
        if (lastPage && !samePage(lastPage, message.pageContext)) derived++;
        lastPage = message.pageContext;
      }
      derivedByIndex.set(i, derived);
    }
    previousEpoch = derived;
  }
  const changed = Boolean(
    currentPageContext && previousPage && !samePage(previousPage, currentPageContext)
  );
  // A page change gets a wall-clock epoch id, not previousEpoch + 1: two side
  // panels sharing one conversation (and submitting from different pages) each
  // incremented the counter to the SAME value, and after the union merge the
  // history contained two runs of that epoch - the forward start-scan then
  // locked onto the first run and sent the OTHER page's turns as context.
  // Timestamps make every page change unique, so the current epoch always has
  // exactly one run. max() keeps the value monotonic if the clock steps
  // backwards; two panels changing pages within the same millisecond falls
  // back to the old shared-id behaviour (vanishingly rare, human-driven).
  const epoch = changed ? Math.max(previousEpoch + 1, Date.now()) : previousEpoch;
  // The current message is not tagged yet, so only search the prior turns for
  // the start of this epoch. If none exists this is a new epoch and the request
  // starts at the current message (no earlier history).
  let start = Math.max(0, list.length - 1);
  for (let i = 0; i < prior.length; i++) {
    const message = prior[i];
    if (!message || message.role !== "user") continue;
    const messageEpoch = derivedByIndex
      ? (derivedByIndex.get(i) ?? 0)
      : (Number.isInteger(message.contextEpoch) ? message.contextEpoch : 0);
    if (messageEpoch === epoch) {
      start = i;
      break;
    }
  }
  return { epoch, changed, previousPage, start };
}
