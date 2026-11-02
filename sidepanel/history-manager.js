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
import {
  HISTORY_ATTACHMENT_PREVIEW_CHARS,
  attachmentCharCount,
  condenseAttachments,
  normalizeAttachments,
} from "../attachments.js";
import { sanitizePiiMap } from "../privacy/pii-filter.js";
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
// structured `attachments` field - `content` is never touched, which also keeps
// a message's merge identity (role + model + content) stable across saves.
const STORED_ATTACHMENT_PREVIEW_CHARS = HISTORY_ATTACHMENT_PREVIEW_CHARS;

function toStoredMessage(message) {
  const content = message.content;
  // Only user turns carry attachments. A message that an earlier quota-pressed
  // save already shrank further (see rememberQuotaCondensedAttachments) keeps
  // the smaller preview, so every later save does not have to fail on quota
  // again before it is shrunk.
  const attachments = message.role === "user"
    ? condenseAttachments(message.attachments, message.quotaCondensed === true ? QUOTA_ATTACHMENT_PREVIEW_CHARS : STORED_ATTACHMENT_PREVIEW_CHARS)
    : [];
  // displayContent is a display-only copy; store it ONLY when it differs
  // from content - every reader falls back to `content`. Identical copies
  // (every assistant turn, plain user turns) used to double the stored size
  // of the conversation list.
  const displayContent = message.displayContent || message.content;
  return {
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
    // Which page (title/url/tab only - never the page text itself) was used
    // for this message, if any. Read back on the next submission to tell the
    // model explicitly when the page has changed - see handleSubmit() below.
    pageContext: message.pageContext || null,
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
// Lossy for display, but every conversation and every turn is kept.
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

// After a quota-escalated save persisted shrunken previews, remember that on the
// LIVE messages (index-aligned with the stored current conversation -
// syncCurrentConversationFromHistory projects history 1:1): their next stored
// projection then starts from the small preview instead of re-trying the large
// one and failing on quota again. Only a message that really matches the stored
// turn (same role and content) is marked - a diverged stored turn (another panel
// appended its own turn at this index) must never affect this panel's message.
function rememberQuotaCondensedAttachments(history, storedMessages) {
  if (!Array.isArray(history) || !Array.isArray(storedMessages)) return;
  const length = Math.min(history.length, storedMessages.length);
  for (let i = 0; i < length; i++) {
    const live = history[i];
    const stored = storedMessages[i];
    if (!live || !stored || live.role !== stored.role || live.content !== stored.content) break;
    if (live.role !== "user" || !live.attachments?.length) continue;
    const storedChars = attachmentCharCount(normalizeAttachments(stored.attachments));
    const freshChars = attachmentCharCount(condenseAttachments(live.attachments, STORED_ATTACHMENT_PREVIEW_CHARS));
    if (storedChars < freshChars) live.quotaCondensed = true;
  }
}

export {
  cleanForTopic,
  makeTopicTitle,
  toStoredMessage,
  compressForQuota,
  rememberQuotaCondensedAttachments,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
};
