// sidepanel/attachment-budget.js
//
// Request-wide attachment budgets. Per-file limits alone are not enough: the
// file picker accepts multiple files, and every ready text attachment is
// concatenated into the SAME provider request, while every attached image is
// sent in the same payload. A user can otherwise attach an unbounded number of
// files (or an unbounded total number of characters/bytes) and produce a
// request that the provider rejects with 413, a storage-quota failure, or a
// memory spike.
//
// Kept DOM-free so the arithmetic is directly unit-testable
// (scripts/test-attachment-budget.mjs).

export const MAX_ATTACHMENTS = 10;
// Shared by every text/zip attachment in ONE request (the same budget the ZIP
// extractor used internally).
export const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 180000;
// Shared by every image attachment in ONE request. Each individual file is
// already capped at 12 MB (MAX_FILE_BYTES in sidepanel.js).
export const MAX_TOTAL_ATTACHMENT_IMAGE_BYTES = 24 * 1024 * 1024;

// Byte length of a data: URL's decoded payload. Used for image budgets and the
// page-image cache; shared here to avoid a second, subtly different estimate.
export function dataUrlByteLength(dataUrl) {
  const encoded = String(dataUrl || "").split(",", 2)[1] || "";
  return Math.floor((encoded.length * 3) / 4);
}

export function attachmentTextChars(attachments) {
  let total = 0;
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || attachment.kind === "image") continue;
    if (typeof attachment.text === "string") total += attachment.text.length;
  }
  return total;
}

export function attachmentImageBytes(attachments) {
  let total = 0;
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || attachment.kind !== "image") continue;
    if (typeof attachment.dataUrl === "string") total += dataUrlByteLength(attachment.dataUrl);
  }
  return total;
}

export function remainingTextChars(attachments) {
  return Math.max(0, MAX_TOTAL_ATTACHMENT_TEXT_CHARS - attachmentTextChars(attachments));
}

export function fitsImageBudget(attachments, newImageBytes) {
  return attachmentImageBytes(attachments) + Math.max(0, Number(newImageBytes) || 0) <= MAX_TOTAL_ATTACHMENT_IMAGE_BYTES;
}
