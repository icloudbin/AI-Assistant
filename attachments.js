// attachments.js
//
// Attachments travel as STRUCTURED DATA on a message (`message.attachments`),
// never as text spliced into the user's own words. They used to be pasted into
// the user turn between a fixed "[ATTACHMENTS]" ... "[/ATTACHMENTS]" pair, so a
// downloaded file that contained "[/ATTACHMENTS]" followed by a fake
// instruction "escaped" the block and read as the user's own request, and file
// / ZIP-entry names (which may hold newlines) were written into the headers
// as-is. Now:
//   - the side panel stores and sends `attachments: [...]` (shape below);
//   - providers/messages.js turns them into text only when a request is built,
//     inside a random per-request UNTRUSTED boundary (see untrustedBoundary());
//   - history condensing works on this structure (condenseAttachments), so no
//     code has to find a block inside a string any more.
//
// Shape (every field is validated by normalizeAttachments, which every reader
// of foreign data - the port, a restored backup, old storage - goes through):
//   { name, kind: "text",  text,    note? }
//   { name, kind: "zip",   entries: [{ name, text }], note? }
//   { name, kind: "image" }                    (the pixels travel in `images`)
// plus `condensed: true` on a copy that was cut to a preview.
//
// DOM-free and chrome-free so it can be imported by the service worker, the
// side panel and the options page, and unit-tested in Node.

import { cutAtCodePointBoundary } from "./models.js";

export const MAX_ATTACHMENT_NAME_CHARS = 120;
export const MAX_ATTACHMENT_NOTE_CHARS = 2000;
// How much of an attachment's text a HISTORY turn (and the stored copy of a
// message) keeps; the full text is only sent with the request it belongs to.
export const HISTORY_ATTACHMENT_PREVIEW_CHARS = 4000;
// Sanity caps for data that arrives from outside this module's own producer
// (the UI's own limits are lower: 10 attachments, 80 ZIP entries).
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const MAX_ENTRIES_PER_ZIP = 200;

const LINE_BREAKING_CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu; // newlines, tabs, NUL, U+2028/2029 ...
const INVISIBLE_FORMAT_CHARS = /\p{Cf}/gu; // bidi overrides, zero-width chars, BOM, Unicode "tag" characters

function oneLine(value, max) {
  let s = String(value ?? "");
  if (typeof s.toWellFormed === "function") s = s.toWellFormed();
  s = s.replace(LINE_BREAKING_CONTROLS, " ").replace(INVISIBLE_FORMAT_CHARS, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  if (chars.length > max) s = `${chars.slice(0, max - 1).join("").trimEnd()}…`;
  return s;
}

// A file or ZIP-entry name as the MODEL sees it: one line, no control or
// invisible formatting characters, bounded length. (The chip in the panel keeps
// showing the real name.)
export function sanitizeAttachmentName(name, max = MAX_ATTACHMENT_NAME_CHARS) {
  return oneLine(name, max) || "unnamed";
}

// The extension's own remark about an attachment ("cut after N characters",
// "these ZIP entries were left out: <names>"). It embeds names, so it gets the
// same treatment.
export function sanitizeAttachmentNote(note) {
  return oneLine(note, MAX_ATTACHMENT_NOTE_CHARS);
}

function cleanText(value) {
  let s = typeof value === "string" ? value : "";
  if (typeof s.toWellFormed === "function") s = s.toWellFormed();
  return s;
}

// Validates and cleans a list of attachments from ANY source. Unknown kinds and
// malformed items are dropped; names and notes are sanitized; nothing else is
// trusted. Always returns a fresh array.
export function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    if (!item || typeof item !== "object") continue;
    const name = sanitizeAttachmentName(item.name);
    const note = sanitizeAttachmentNote(item.note);
    const condensed = item.condensed === true ? { condensed: true } : {};
    if (item.kind === "image") {
      out.push({ name, kind: "image" });
    } else if (item.kind === "text") {
      const text = cleanText(item.text);
      if (!text.trim()) continue;
      out.push({ name, kind: "text", ...(note ? { note } : {}), text, ...condensed });
    } else if (item.kind === "zip") {
      const entries = [];
      for (const entry of Array.isArray(item.entries) ? item.entries : []) {
        if (entries.length >= MAX_ENTRIES_PER_ZIP) break;
        if (!entry || typeof entry !== "object") continue;
        const text = cleanText(entry.text);
        if (!text.trim()) continue;
        entries.push({ name: sanitizeAttachmentName(entry.name), text });
      }
      if (!entries.length) continue;
      out.push({ name, kind: "zip", ...(note ? { note } : {}), entries, ...condensed });
    }
  }
  return out;
}

// Number of characters of file text in a list (names and notes excluded).
export function attachmentCharCount(list) {
  let total = 0;
  for (const a of Array.isArray(list) ? list : []) {
    if (!a) continue;
    if (typeof a.text === "string") total += a.text.length;
    for (const e of Array.isArray(a.entries) ? a.entries : []) total += String(e?.text || "").length;
  }
  return total;
}

// A copy of `list` whose file text is cut to about `maxChars` IN TOTAL, shared
// fairly between the texts (a short file leaves its unused share to the next
// ones; a long one is cut at a code-point boundary). Anything that was cut
// carries `condensed: true`, which makes the request builder add a note for the
// model. Idempotent: condensing a condensed list again changes nothing, so a
// preview never compounds. Files and entries are never dropped - only their
// text is shortened - so names always survive.
export function condenseAttachments(list, maxChars) {
  const items = normalizeAttachments(list);
  let units = 0;
  for (const a of items) {
    if (a.kind === "text") units++;
    else if (a.kind === "zip") units += a.entries.length;
  }
  let remaining = Math.max(0, maxChars);
  const cut = (text) => {
    const share = Math.floor(remaining / Math.max(1, units));
    units--;
    if (text.length <= share) {
      remaining -= text.length;
      return { text, cut: false };
    }
    const kept = cutAtCodePointBoundary(text, share).trimEnd();
    remaining -= kept.length;
    return { text: kept, cut: true };
  };
  return items.map((a) => {
    if (a.kind === "text") {
      const r = cut(a.text);
      return r.cut || a.condensed ? { ...a, text: r.text, condensed: true } : a;
    }
    if (a.kind === "zip") {
      let any = a.condensed === true;
      const entries = a.entries.map((e) => {
        const r = cut(e.text);
        if (r.cut) any = true;
        return r.cut ? { ...e, text: r.text } : e;
      });
      return any ? { ...a, entries, condensed: true } : a;
    }
    return a;
  });
}

// ---------------------------------------------------------------------------
// ONE-TIME MIGRATION of the old storage format. Before this change a message's
// `content` held the question followed by the attachments as inline text
// ("[ATTACHMENTS] ... [/ATTACHMENTS]"). That text is the only place the marker
// is still looked for, and only to convert such a message into the structured
// form; nothing that builds a request ever parses it.
//
// Attachments were always appended AFTER the question, so everything from the
// first marker to the end of the message came from files. It is all kept as one
// untrusted attachment - NOT cut at the first "[/ATTACHMENTS]", because a file
// may contain that very string followed by text that was never the user's.
// ---------------------------------------------------------------------------
const LEGACY_OPEN = /\[ATTACHMENTS\]/i;
const LEGACY_CLOSE_AT_END = /\s*\[\/ATTACHMENTS\]\s*$/i;

export function migrateLegacyMessage(message) {
  if (!message || typeof message !== "object") return message;
  if (message.role !== "user" || typeof message.content !== "string") return message;
  if (Array.isArray(message.attachments)) return { ...message, attachments: normalizeAttachments(message.attachments) };
  const open = message.content.search(LEGACY_OPEN);
  if (open < 0) return message;
  const question = message.content.slice(0, open).trimEnd();
  const block = message.content.slice(open + "[ATTACHMENTS]".length).replace(LEGACY_CLOSE_AT_END, "").trim();
  const attachments = block
    ? normalizeAttachments([{ name: "attachments of an earlier message", kind: "text", text: block, condensed: block.includes("[attachment contents truncated") }])
    : [];
  return { ...message, content: question, ...(attachments.length ? { attachments } : {}) };
}

export function migrateLegacyConversations(list) {
  if (!Array.isArray(list)) return list;
  return list.map((c) => (c && Array.isArray(c.messages) ? { ...c, messages: c.messages.map(migrateLegacyMessage) } : c));
}
