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
//
// makeTopicTitle() takes the empty-input fallback title as an argument:
// sidepanel.js passes the localized "New topic" string; the default keeps
// the function pure ("" - callers show their own placeholder).

function cleanForTopic(text) {
  return String(text || "")
    .replace(/\[ATTACHMENTS\][\s\S]*?\[\/ATTACHMENTS\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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
// after which every save fails and no history is kept. background.js condenses
// attachment blocks in history turns to this same preview size before sending
// them anyway, so only the stored copy is shortened (the live session keeps the
// full text for the current request).
const STORED_ATTACHMENT_PREVIEW_CHARS = 4000;
function condenseStoredContent(text) {
  return String(text || "").replace(/\[ATTACHMENTS\][\s\S]*?\[\/ATTACHMENTS\]/gi, (block) => {
    if (block.length <= STORED_ATTACHMENT_PREVIEW_CHARS) return block;
    return `${block.slice(0, STORED_ATTACHMENT_PREVIEW_CHARS).trimEnd()}\n...[attachment contents truncated]\n[/ATTACHMENTS]`;
  });
}

function toStoredMessage(message) {
  // Once a quota-escalated save condensed this message for storage
  // (rememberQuotaCondensedContent), the condensed form IS the storage
  // projection: re-projecting the full text would give the stored condensed
  // copy a different merge identity and duplicate the turn. A reload never
  // sees the flag - it reads the condensed copy back as content.
  const content = message.role === "user"
    ? (typeof message.quotaCondensedContent === "string" && message.quotaCondensedContent
        ? message.quotaCondensedContent
        : condenseStoredContent(message.content))
    : message.content;
  // displayContent is a display-only copy; store it ONLY when it differs
  // from content - every reader falls back to `content`. Identical copies
  // (every assistant turn, plain user turns) used to double the stored size
  // of the conversation list.
  const displayContent = message.displayContent || message.content;
  return {
    role: message.role,
    content,
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
// The exact per-content transform of the quota pass. Shared with
// rememberQuotaCondensedContent(), which must recognize the condensed form it
// produced - the two must never drift apart.
function quotaCondenseContent(text) {
  return String(text || "").replace(/\[ATTACHMENTS\][\s\S]*?\[\/ATTACHMENTS\]/gi, (block) =>
    block.length <= QUOTA_ATTACHMENT_PREVIEW_CHARS
      ? block
      : `${block.slice(0, QUOTA_ATTACHMENT_PREVIEW_CHARS).trimEnd()}\n...[/ATTACHMENTS]`
  );
}
function compressForQuota(list) {
  return list.map((c) => ({
    ...c,
    messages: (c.messages || []).map((m) => {
      if (!m || typeof m !== "object") return m;
      const compressed = { ...m };
      delete compressed.displayContent;
      if (typeof compressed.content === "string") {
        compressed.content = quotaCondenseContent(compressed.content);
      }
      return compressed;
    }),
  }));
}

// After a quota-escalated save persisted condensed copies, remember the
// condensed text on the LIVE messages (index-aligned with the stored current
// conversation - syncCurrentConversationFromHistory projects history 1:1).
// Without this, the next save re-projects the full text, the stored condensed
// copy gets a different merge identity (role+modelId+content), and the union
// merge keeps BOTH copies: a duplicate bubble after a reload and the same
// question sent to the model twice. Only a genuine condensed form of the live
// content is remembered - a diverged stored turn (another panel appended its
// own turn at this index) must never overwrite this panel's message. A reload
// needs no flag: it reads the condensed copy back as content, so its
// re-projection is already identical.
function rememberQuotaCondensedContent(history, storedMessages) {
  if (!Array.isArray(history) || !Array.isArray(storedMessages)) return;
  const length = Math.min(history.length, storedMessages.length);
  for (let i = 0; i < length; i++) {
    const live = history[i];
    const stored = storedMessages[i];
    if (!live || !stored || live.role !== stored.role || typeof stored.content !== "string") break;
    const fresh = toStoredMessage(live).content;
    if (fresh === stored.content) continue;
    if (quotaCondenseContent(fresh) === stored.content) {
      live.quotaCondensedContent = stored.content;
    } else {
      break;
    }
  }
}

export {
  cleanForTopic,
  makeTopicTitle,
  condenseStoredContent,
  toStoredMessage,
  compressForQuota,
  rememberQuotaCondensedContent,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
};
