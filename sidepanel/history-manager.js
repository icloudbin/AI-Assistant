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
  const title = words.slice(0, 10).join(" ").slice(0, 80).trim();
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
  const content = message.role === "user" ? condenseStoredContent(message.content) : message.content;
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
function compressForQuota(list) {
  return list.map((c) => ({
    ...c,
    messages: (c.messages || []).map((m) => {
      if (!m || typeof m !== "object") return m;
      const compressed = { ...m };
      delete compressed.displayContent;
      if (typeof compressed.content === "string") {
        compressed.content = compressed.content.replace(/\[ATTACHMENTS\][\s\S]*?\[\/ATTACHMENTS\]/gi, (block) =>
          block.length <= QUOTA_ATTACHMENT_PREVIEW_CHARS
            ? block
            : `${block.slice(0, QUOTA_ATTACHMENT_PREVIEW_CHARS).trimEnd()}\n...[/ATTACHMENTS]`
        );
      }
      return compressed;
    }),
  }));
}

export {
  cleanForTopic,
  makeTopicTitle,
  condenseStoredContent,
  toStoredMessage,
  compressForQuota,
  STORED_ATTACHMENT_PREVIEW_CHARS,
  QUOTA_ATTACHMENT_PREVIEW_CHARS,
};
