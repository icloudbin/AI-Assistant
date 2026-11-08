// conversation-store.js
//
// Pure conversation-list helpers used by sidepanel.js when saving history to
// chrome.storage.local. Deliberately free of DOM and chrome.* calls so they
// can be unit-tested in Node (scripts/test-conversation-store.mjs); they
// previously lived inline in sidepanel.js, untested.

import { attachmentCharCount } from "./attachments.js";

export function sortedByNewest(list) {
  // Pure helper: sort a COPY. Callers pass arrays they own, and an in-place
  // sort here silently reordered the caller's list (round-17 #22).
  return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ---------------------------------------------------------------------------
// Message identity
//
// Every stored message carries
//   id         a UUID, made once when the message is created and never changed,
//              so the same message is recognised in every copy of its
//              conversation (two windows can both have it open);
//   createdAt  epoch milliseconds of that moment: a real chronology for the
//              merge, instead of "whatever order the copies happened to be in".
// What a message SAYS is not part of its identity. Two identical "continue"
// turns are two messages, and a message whose stored attachment preview was
// shortened is still the same message.
//
// Messages saved before this change have neither. They get a DETERMINISTIC id
// derived from what they are (role, model, text, and which repetition of that
// text this is): the same old message gets the same id in every copy and on
// every run, so two copies that were both loaded from old storage still merge
// without duplicates. They get no createdAt (it would be invented); the merge
// keeps their order instead.
// ---------------------------------------------------------------------------

const MAX_MESSAGE_ID_CHARS = 100;

// Ids and timestamps also arrive from outside (a restored backup, old storage),
// so they are validated before they are trusted.
export function isValidMessageId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_MESSAGE_ID_CHARS;
}

export function isValidTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function newMessageId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A new message for the END of `list`: it gets its id and timestamp here, once.
// The timestamp never falls below the previous message's, so a system clock
// that steps backwards cannot make a later message sort before an earlier one.
export function createMessage(fields, list = [], now = Date.now()) {
  const last = Array.isArray(list) ? list[list.length - 1] : null;
  const floor = isValidTimestamp(last?.createdAt) ? last.createdAt : 0;
  return { id: newMessageId(), createdAt: Math.max(now, floor), ...fields };
}

// cyrb53, a public-domain 53-bit string hash. Two different seeds give about
// 106 bits together, so two different old messages sharing an id is not a
// realistic risk. Synchronous on purpose (SubtleCrypto is async) so migration
// stays a plain function.
function hash53(text, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function legacyIdBase(message) {
  const text = `${message.role || ""}\u0000${message.modelId || ""}\u0000${String(message.content ?? "")}`;
  const part = (seed) => hash53(text, seed).toString(16).padStart(14, "0");
  return `legacy-${part(0)}${part(0x9e3779b9)}`;
}

// Gives every message in the list an id; returns the SAME array when none
// needed one (so calling it on already-migrated data costs one pass and no
// allocation). A repeated id inside one list - a hand-edited backup, say - is
// treated like a missing one for the repeat, so no message is lost to a merge.
// Deterministic and idempotent: the n-th message with the same role, model and
// text (among those that need an id) always gets "<hash>-n".
export function withMessageIds(messages) {
  if (!Array.isArray(messages)) return messages;
  const taken = new Set();
  const repeats = new Map();
  let changed = false;
  const out = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (isValidMessageId(message.id) && !taken.has(message.id)) {
      taken.add(message.id);
      return message;
    }
    const base = legacyIdBase(message);
    let n = repeats.get(base) || 0;
    let id;
    do { id = `${base}-${n++}`; } while (taken.has(id));
    repeats.set(base, n);
    taken.add(id);
    changed = true;
    return { ...message, id };
  });
  return changed ? out : messages;
}

// withMessageIds() over a whole saved-conversation list (the stored format).
export function migrateConversationIds(list) {
  if (!Array.isArray(list)) return list;
  return list.map((c) => {
    if (!c || !Array.isArray(c.messages)) return c;
    const messages = withMessageIds(c.messages);
    return messages === c.messages ? c : { ...c, messages };
  });
}

function withIds(conversation) {
  const messages = withMessageIds(conversation.messages);
  return messages === conversation.messages ? conversation : { ...conversation, messages };
}

// ---------------------------------------------------------------------------
// Merging two copies of one conversation
// ---------------------------------------------------------------------------

// The same message (same id) found in both copies; `primary` is the base. Only
// two things can legitimately differ between two copies of one message:
//  - the page context / epoch of a user turn: it is attached just after the
//    turn was first stored, so one copy may not have it yet - whichever copy
//    has it provides it;
//  - the attachment preview: the storage-quota pass writes SHORTER previews,
//    and that has to stick. Otherwise the next save would bring the long
//    preview back from the live copy, exceed the quota again and compress it
//    again on every save. (Content-based identity could not tell the two
//    versions apart, which is why a flag on the live message used to do this.)
function reconcileDuplicate(primary, secondary) {
  const out = { ...primary };
  for (const key of ["pageContext", "contextEpoch"]) {
    if ((out[key] === undefined || out[key] === null) && secondary[key] !== undefined && secondary[key] !== null) {
      out[key] = secondary[key];
    }
  }
  if (attachmentCharCount(secondary.attachments) < attachmentCharCount(primary.attachments)) {
    out.attachments = secondary.attachments;
  }
  return out;
}

// A turn is a user message together with the assistant replies after it, as
// they stand in ONE copy. Turns, not single messages, are what gets ordered:
// two windows answering at the same time would otherwise interleave as
// Q2 Q3 A2 A3 and break the user/assistant alternation that providers expect.
// A turn's time is its first message's createdAt, or - for a message saved
// before timestamps existed - the latest time seen before it in the same copy,
// so old messages keep their place. A copy may START with an assistant message
// (an old merge could leave one); that forms a turn of its own.
function splitIntoTurns(messages) {
  const turns = [];
  let time = 0;
  let turn = null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (isValidTimestamp(message.createdAt)) time = message.createdAt;
    if (!turn || message.role === "user") {
      turn = { key: message.id, time, messages: [] };
      turns.push(turn);
    }
    turn.messages.push(message);
  }
  return turns;
}

// Inside one turn the first message stays first (it is what the turn is named
// after); anything after it is ordered by time, ties keeping their order.
function orderWithinTurn(messages) {
  if (messages.length < 3) return messages;
  const [head, ...tail] = messages;
  let time = 0;
  const keyed = tail.map((message, index) => {
    if (isValidTimestamp(message.createdAt)) time = message.createdAt;
    return { message, index, time };
  });
  keyed.sort((a, b) => a.time - b.time || a.index - b.index);
  return [head, ...keyed.map((k) => k.message)];
}

// Union of two copies of one conversation by message id, ordered by time.
//  - The same id in both copies is one message (see reconcileDuplicate).
//  - Turns from both copies are put in order of when they started, so a turn
//    written in another window lands where it happened instead of at the end.
//  - A message is never placed twice and never dropped: an id that the two
//    copies attach to different turns stays with the first one found.
// Messages without a createdAt (old storage) sort by position: before anything
// timestamped, in the order of the primary copy, then the secondary's extras.
export function mergeMessageLists(primary, secondary) {
  const copies = [primary, secondary].map((list) => (Array.isArray(list) ? withMessageIds(list) : []));
  const kept = new Map(); // message id -> the message that is kept
  const turnsByKey = new Map(); // id of a turn's first message -> { time, ids }
  const placed = new Set();
  for (const copy of copies) {
    for (const turn of splitIntoTurns(copy)) {
      let target = turnsByKey.get(turn.key);
      for (const message of turn.messages) {
        const known = kept.get(message.id);
        kept.set(message.id, known ? reconcileDuplicate(known, message) : message);
        if (placed.has(message.id)) continue;
        placed.add(message.id);
        if (!target) {
          target = { time: turn.time, ids: [] };
          turnsByKey.set(turn.key, target);
        }
        target.ids.push(message.id);
      }
    }
  }
  // Array.prototype.sort is stable: equal times keep the order the turns were
  // first seen in (the primary copy's own order first).
  return [...turnsByKey.values()]
    .sort((a, b) => a.time - b.time)
    .flatMap((turn) => orderWithinTurn(turn.ids.map((id) => kept.get(id))));
}

// Merge the stored list with this panel's list by id. For the conversation this
// panel is showing, the two copies are combined rather than one being chosen:
// another window may have appended turns to the same conversation since this
// panel loaded it (see mergeMessageLists). Any other id keeps the copy with the
// newest updatedAt (ties keep the local one). Conversations that exist only in
// storage (saved by another panel) are preserved. Messages that have no id yet
// (old storage) are given their deterministic one first.
export function mergeConversationLists(stored, local, currentId) {
  const byId = new Map();
  for (const c of Array.isArray(stored) ? stored : []) {
    if (c && c.id && c.messages?.length) byId.set(c.id, withIds(c));
  }
  for (const entry of Array.isArray(local) ? local : []) {
    // A message-less local entry must not be allowed to win: replacing the
    // stored copy of the same id (it is "newer", or it is the current
    // conversation) would drop that conversation from the merged result
    // entirely, because the output filter below discards message-less
    // entries. No current caller produces such an entry - this guard keeps
    // a future caller from silently deleting saved history.
    if (!entry || !entry.id || !entry.messages?.length) continue;
    const c = withIds(entry);
    const other = byId.get(c.id);
    if (!other) {
      byId.set(c.id, c);
      continue;
    }
    if (c.id === currentId) {
      // Keep both sides of a concurrent edit. Metadata comes from the longer
      // copy so a stale, shorter local entry cannot discard the other panel's
      // title/updatedAt, but all messages from both copies survive. This
      // panel's own copy is the primary one for the messages: it is the live
      // one, and the stored copy may only differ from it by later additions
      // from another window or by a quota-shortened preview.
      const base = c.messages.length >= other.messages.length ? c : other;
      byId.set(c.id, {
        ...base,
        messages: mergeMessageLists(c.messages, other.messages),
        updatedAt: Math.max(c.updatedAt || 0, other.updatedAt || 0),
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
  // Anchors do not change the page: a full-URL compare treated an in-page jump
  // (#section) as a page change and wrongly reset the model's page context.
  // The query string is kept - different query parameters usually mean
  // different content (search results, filters, pagination).
  const url = (x) => String(x?.url || "").split("#")[0];
  if (url(a) !== url(b)) return false;
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
