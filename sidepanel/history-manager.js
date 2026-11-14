// sidepanel/history-manager.js
//
// Pure conversation-history shaping helpers, moved verbatim from
// sidepanel.js so they are directly unit-testable
// (scripts/test-history-manager.mjs): topic-title derivation, stored-message
// projection (displayContent dedupe, attachment preview caps), and the
// storage-quota compression pass. The save/merge pipeline itself (the save
// queue, the cross-panel merge and the NOTICE escalation) still lives in
// sidepanel.js because it is bound to the live conversation state and the
// panel's DOM.

import { cutAtCodePointBoundary } from "../models.js";
import { HISTORY_ATTACHMENT_PREVIEW_CHARS, condenseAttachments } from "../attachments.js";
import { sanitizePiiMap } from "../privacy/pii-filter.js";
import { isValidMessageId, isValidTimestamp } from "../conversation-store.js";
//
// makeTopicTitle() takes the empty-input fallback title as an argument:
// sidepanel.js passes the localized "New topic" string; the default keeps
// the function pure ("" - callers show their own placeholder).

function cleanForTopic(text) {
  // Attachments are a separate field of the message now (see attachments.js),
  // so `content` / `displayContent` hold only what the user typed.
  return String(text || "").replace(/\s+/g, " ").trim();
}

function makeTopicTitle(messages, fallbackTitle = "") {
  const userTexts = (messages || [])
    .filter((m) => m.role === "user")
    .map((m) => cleanForTopic(m.displayContent || m.content))
    .filter(Boolean);
  if (!userTexts.length) return fallbackTitle;
  const summarySource = userTexts.join(" ");
  const words = summarySource.split(/\s+/).filter(Boolean);
  // Chinese/Japanese text has no spaces, so the whole message would become the
  // title; cap the length as well as the word count.
  const title = cutAtCodePointBoundary(words.slice(0, 10).join(" "), 80).trim();
  return title || fallbackTitle;
}

// "<Translate>: <first words of the translated text>" for a history entry.
// `label` arrives already localized (the quick-action button label); the
// excerpt mirrors makeTopicTitle's word/length caps so a whole article or a
// long selection cannot flood the dropdown. An empty source keeps the bare
// label (a translation whose capture failed still gets a usable title).
function translationTopicTitle(label, source) {
  const text = cleanForTopic(source);
  if (!label) return text;
  if (!text) return label;
  const words = text.split(/\s+/).filter(Boolean);
  const excerpt = cutAtCodePointBoundary(words.slice(0, 10).join(" "), 60).trim();
  return excerpt ? `${label}: ${excerpt}` : label;
}

// Attachment text can be up to 180,000 characters per message. Stored in full
// across up to 100 conversations it exceeds chrome.storage.local's 10 MB quota,
// after which every save fails and no history is kept. providers/messages.js
// condenses attachments in history turns to this same preview size before
// sending them anyway, so only the stored copy is shortened (the live session
// keeps the full text for the current request). The preview is cut on the
// structured `attachments` field - `content` is never touched, and a message is
// identified by its `id` (see conversation-store.js), so shortening a preview
// can never make a stored message look like a different one.
const STORED_ATTACHMENT_PREVIEW_CHARS = HISTORY_ATTACHMENT_PREVIEW_CHARS;

function toStoredMessage(message) {
  const content = message.content;
  // Only user turns carry attachments. If an earlier quota-pressed save already
  // shrank this message's preview further, the merge keeps that smaller stored
  // copy (see reconcileDuplicate in conversation-store.js), so a later save does
  // not have to fail on quota again before shrinking it.
  const attachments = message.role === "user"
    ? condenseAttachments(message.attachments, STORED_ATTACHMENT_PREVIEW_CHARS)
    : [];
  // displayContent is a display-only copy; store it ONLY when it differs
  // from content - every reader falls back to `content`. Identical copies
  // (every assistant turn, plain user turns) used to double the stored size
  // of the conversation list.
  const displayContent = message.displayContent || message.content;
  return {
    // Identity and creation time (see conversation-store.js): set once when the
    // message is created and carried through every save, so two copies of one
    // conversation can be merged by id and ordered by time.
    ...(isValidMessageId(message.id) ? { id: message.id } : {}),
    ...(isValidTimestamp(message.createdAt) ? { createdAt: message.createdAt } : {}),
    role: message.role,
    content,
    ...(attachments.length ? { attachments } : {}),
    // An assistant reply is stored with its placeholders ([EMAIL#1]) plus the
    // values it uses; they are put back only when it is displayed, and never
    // inside a link target or image URL (see restoreInHtmlText).
    ...(message.role === "assistant" && sanitizePiiMap(message.piiMap) ? { piiMap: sanitizePiiMap(message.piiMap) } : {}),
    ...(displayContent !== content ? { displayContent } : {}),
    modelLabel: message.modelLabel || "",
    modelId: message.modelId || "",
    // Which page (title/url only - never the page text itself) was used for
    // this message, if any. Read back on the next submission to tell the
    // model explicitly when the page has changed - see handleSubmit() below.
    // tabId is deliberately NOT persisted: it is session-scoped and lives
    // only in the in-memory history (two same-URL tabs are a page change
    // within a session, where both copies carry one). Persisting it made the
    // first follow-up after a browser restart wrongly reset the context
    // epoch on the same page (round-17 #9).
    pageContext: message.pageContext
      ? (({ tabId: _tabId, ...rest }) => rest)(message.pageContext)
      : null,
    // Page-context epoch: a page change starts a new epoch, and every later
    // request sends only turns from the current epoch. Persisting it is what
    // keeps the reset in force on the FOLLOW-UP after a page change, not just
    // on the switch request itself.
    ...(Number.isInteger(message.contextEpoch) ? { contextEpoch: message.contextEpoch } : {}),
    // Translation replies are rendered as plain text (no Markdown) so line
    // numbering/indentation survive. Without persisting the flag, a reloaded
    // conversation would re-render them through the Markdown renderer.
    ...(message.plain === true ? { plain: true } : {}),
  };
}

// Persistent history bounds. unlimitedStorage disables Chrome's normal
// quota guard, so enforce per-conversation AND whole-history serialized-byte
// budgets, plus a per-conversation message-count cap.
const MAX_STORED_MESSAGES_PER_CONVERSATION = 200;
const MAX_STORED_CONVERSATION_BYTES = 5 * 1024 * 1024;
export const MAX_STORED_HISTORY_BYTES = 50 * 1024 * 1024;

function messageTurns(messages) {
  const turns = [];
  let turn = [];
  for (const message of messages) {
    if (message?.role === "user" && turn.length) {
      turns.push(turn);
      turn = [];
    }
    turn.push(message);
  }
  if (turn.length) turns.push(turn);
  return turns;
}

const HISTORY_TRUNCATION_NOTICE = "\n\n[Message truncated in saved history to fit the storage limit.]";

function prepareMessageForHistory(message) {
  const candidate = { ...message };
  // Display-only copies and attachment previews are the first things to trim;
  // preserve the user's actual question and assistant response where possible.
  delete candidate.displayContent;
  if (Array.isArray(candidate.attachments)) {
    candidate.attachments = condenseAttachments(candidate.attachments, QUOTA_ATTACHMENT_PREVIEW_CHARS);
    if (!candidate.attachments.length) delete candidate.attachments;
  }
  return candidate;
}

function fitMessageToByteBudget(message, maxBytes, encoder) {
  const candidate = prepareMessageForHistory(message);
  const sizeOf = (value) => {
    try { return encoder.encode(JSON.stringify(value)).length; }
    catch { return Infinity; }
  };
  if (sizeOf(candidate) <= maxBytes) return candidate;
  if (typeof candidate.content !== "string") return null;

  const original = candidate.content;
  let low = 0;
  let high = original.length;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const content = cutAtCodePointBoundary(original, middle).trimEnd() + HISTORY_TRUNCATION_NOTICE;
    const trial = { ...candidate, content };
    if (sizeOf(trial) <= maxBytes) {
      best = trial;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

// The smallest a message can be serialized for storage: display copies
// dropped, attachment previews condensed, string content replaced by the
// truncation notice. Infinity when even this shape cannot be serialized.
// Shared by the per-turn fit and the older-turn reservation so the two
// cannot drift apart.
function minimumMessageSize(message, encoder) {
  const minimum = prepareMessageForHistory(message);
  if (typeof minimum.content === "string") minimum.content = HISTORY_TRUNCATION_NOTICE;
  try { return encoder.encode(JSON.stringify(minimum)).length; }
  catch { return Infinity; }
}

// Serialized size of a turn reduced to every message's minimum: the floor a
// kept turn occupies no matter how its content is truncated.
function turnMinimumSize(turn, encoder) {
  let total = 2; // JSON array brackets
  for (let i = 0; i < turn.length; i++) {
    const size = minimumMessageSize(turn[i], encoder);
    if (!Number.isFinite(size)) return Infinity;
    total += size + (i > 0 ? 1 : 0);
  }
  return total;
}

function fitTurnToByteBudget(turn, maxBytes, encoder) {
  const minimumSizes = turn.map((message) => minimumMessageSize(message, encoder));
  const minimumTotal = 2 + minimumSizes.reduce((sum, size) => sum + size, 0) + Math.max(0, turn.length - 1);
  if (minimumTotal > maxBytes || minimumSizes.some((size) => !Number.isFinite(size))) return null;

  const fitted = [];
  let used = 2; // JSON array brackets
  for (let i = 0; i < turn.length; i++) {
    const separator = i > 0 ? 1 : 0;
    const reserve = minimumSizes.slice(i + 1).reduce((sum, size) => sum + size, 0)
      + Math.max(0, turn.length - i - 1);
    const available = maxBytes - used - separator - reserve;
    if (available < minimumSizes[i]) return null;
    const message = fitMessageToByteBudget(turn[i], available, encoder);
    if (!message) return null;
    const size = encoder.encode(JSON.stringify(message)).length;
    if (used + separator + size + reserve > maxBytes) return null;
    fitted.push(message);
    used += separator + size;
  }
  return fitted;
}

function limitStoredConversationMessages(conversation) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const messages = conversation.messages;
  const encoder = new TextEncoder();
  const turns = messageTurns(messages);
  const keptTurns = [];
  let totalBytes = 2;
  let totalMessages = 0;

  // Which turns fit the per-conversation message count. A fitted turn keeps
  // every message, so this walk is independent of any truncation below.
  const countKeepable = new Array(turns.length).fill(false);
  let countable = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (countable + turns[i].length > MAX_STORED_MESSAGES_PER_CONVERSATION) continue;
    countKeepable[i] = true;
    countable += turns[i].length;
  }
  // Older turns' serialized minimums, computed lazily: only conversations that
  // actually exceed the byte budget pay for the reservation. reserveBefore[i]
  // is what every count-keepable turn OLDER than i is promised.
  let reserveBefore = null;
  const reserveForOlder = (index) => {
    if (!reserveBefore) {
      reserveBefore = new Array(turns.length);
      let accumulated = 0;
      for (let j = 0; j < turns.length; j++) {
        reserveBefore[j] = accumulated;
        if (countKeepable[j]) {
          const minimum = turnMinimumSize(turns[j], encoder);
          if (Number.isFinite(minimum)) accumulated += 1 + minimum;
        }
      }
    }
    return reserveBefore[index];
  };

  // Keep complete turns, newest first. A turn that does not fit the remaining
  // budget is trimmed (display/attachment copies dropped, oversized text
  // truncated with a visible marker) instead of dropped as a whole - and the
  // fit leaves every OLDER complete turn its reserved minimum, so bounding the
  // newest turn cannot silently starve earlier exchanges.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (!countKeepable[i]) continue;
    const turn = turns[i];
    const separator = keptTurns.length ? 1 : 0;
    let fitted = turn;
    let size;
    try { size = encoder.encode(JSON.stringify(turn)).length; }
    catch { continue; }
    if (totalBytes + separator + size > MAX_STORED_CONVERSATION_BYTES) {
      const available = MAX_STORED_CONVERSATION_BYTES - totalBytes - separator - reserveForOlder(i);
      fitted = size <= available ? turn : fitTurnToByteBudget(turn, available, encoder);
      if (fitted === null) {
        // The reserved older minimums leave not even this turn's minimum.
        // Keep the newest turn anyway rather than dropping the most recent
        // exchange; older turns then compete for what is left, as before.
        fitted = fitTurnToByteBudget(turn, MAX_STORED_CONVERSATION_BYTES - totalBytes - separator, encoder);
        if (!fitted) continue;
      }
      size = encoder.encode(JSON.stringify(fitted)).length;
    }
    keptTurns.push(fitted);
    totalBytes += separator + size;
    totalMessages += fitted.length;
  }

  if (keptTurns.length === turns.length && totalMessages === messages.length
      && keptTurns.every((turn, i) => turn.every((message, j) => message === turns[turns.length - 1 - i][j]))) return conversation;
  keptTurns.reverse();
  const kept = keptTurns.flat();
  // A leading assistant-only turn is not useful provider history. This can
  // occur when the retained window begins mid-conversation.
  while (kept.length && kept[0]?.role !== "user" && kept.some((message) => message?.role === "user")) {
    const firstUser = kept.findIndex((message) => message?.role === "user");
    kept.splice(0, firstUser);
  }
  return { ...conversation, messages: kept };
}

// Enforce one serialized-byte ceiling across all saved conversations. Input
// order is irrelevant: newest conversations win. Oversized/unserializable
// entries are skipped without preventing older entries from being considered.
export function limitStoredHistoryBytes(conversations, maxBytes = MAX_STORED_HISTORY_BYTES) {
  const encoder = new TextEncoder();
  const ordered = [...(Array.isArray(conversations) ? conversations : [])]
    .sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
  const kept = [];
  let totalBytes = 2; // JSON array brackets
  let dropped = 0;
  for (const conversation of ordered) {
    let size;
    try { size = encoder.encode(JSON.stringify(conversation)).length + (kept.length ? 1 : 0); }
    catch { dropped++; continue; }
    if (totalBytes + size > maxBytes) {
      dropped++;
      continue;
    }
    kept.push(conversation);
    totalBytes += size;
  }
  return { conversations: kept, dropped, bytes: totalBytes };
}

const QUOTA_ATTACHMENT_PREVIEW_CHARS = 800;
function compressForQuota(list) {
  return list.map((c) => ({
    ...c,
    messages: (c.messages || []).map((m) => {
      if (!m || typeof m !== "object") return m;
      const compressed = { ...m };
      delete compressed.displayContent;
      if (Array.isArray(compressed.attachments)) {
        compressed.attachments = condenseAttachments(compressed.attachments, QUOTA_ATTACHMENT_PREVIEW_CHARS);
        if (!compressed.attachments.length) delete compressed.attachments;
      }
      return compressed;
    }),
  }));
}

export {
  cleanForTopic,
  makeTopicTitle,
  translationTopicTitle,
  toStoredMessage,
  compressForQuota,
  limitStoredConversationMessages,
  MAX_STORED_MESSAGES_PER_CONVERSATION,
  MAX_STORED_CONVERSATION_BYTES,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
};
