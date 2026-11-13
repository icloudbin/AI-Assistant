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

// Storage-quota pressure valve, applied to the merged list BEFORE any
// conversation is dropped: shrink attachment previews further and drop the
// display-only copy of every message (readers fall back to `content`).
// Lossy for display, but every conversation and every turn is kept (ids and
// timestamps are untouched, so the shortened copy is still the same message).
// Persistent per-topic bounds. unlimitedStorage disables Chrome's normal
// quota guard, so enforce both a message count and a serialized-byte budget.
export const MAX_STORED_MESSAGES_PER_CONVERSATION = 200;
export const MAX_STORED_CONVERSATION_BYTES = 5 * 1024 * 1024;

export function limitStoredConversationMessages(conversation) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const messages = conversation.messages;
  const encoder = new TextEncoder();
  const kept = [];
  let totalBytes = 2;
  for (let i = messages.length - 1; i >= 0 && kept.length < MAX_STORED_MESSAGES_PER_CONVERSATION; i--) {
    let size;
    try { size = encoder.encode(JSON.stringify(messages[i])).length + 1; }
    catch { continue; }
    if (totalBytes + size > MAX_STORED_CONVERSATION_BYTES) break;
    kept.push(messages[i]);
    totalBytes += size;
  }
  if (kept.length === messages.length) return conversation;
  kept.reverse();
  return { ...conversation, messages: kept };
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
  toStoredMessage,
  compressForQuota,
  limitStoredConversationMessages,
  MAX_STORED_MESSAGES_PER_CONVERSATION,
  MAX_STORED_CONVERSATION_BYTES,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
};
