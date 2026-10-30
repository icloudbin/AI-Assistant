#!/usr/bin/env node
// Unit tests for the request-wide attachment budgets.
// Run:  node scripts/test-attachment-budget.mjs
import assert from "node:assert/strict";
import {
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_TEXT_CHARS,
  MAX_TOTAL_ATTACHMENT_IMAGE_BYTES,
  dataUrlByteLength,
  attachmentTextChars,
  attachmentImageBytes,
  remainingTextChars,
  fitsImageBudget,
} from "../sidepanel/attachment-budget.js";

// data: URL payload length, including the padding-independent estimate.
{
  const bytes = Buffer.from("hello world");
  const url = `data:image/png;base64,${bytes.toString("base64")}`;
  assert.equal(dataUrlByteLength(url), Math.floor((bytes.toString("base64").length * 3) / 4));
  assert.equal(dataUrlByteLength(""), 0);
  assert.equal(dataUrlByteLength("not-a-data-url"), 0);
}

// Text budget counts text and ZIP attachment text, but never image bytes.
{
  const attachments = [
    { kind: "text", text: "a".repeat(100) },
    { kind: "zip", text: "b".repeat(50) },
    { kind: "image", text: "", dataUrl: "data:image/png;base64,AAAA" },
    { kind: "text", text: "" },
    null,
  ];
  assert.equal(attachmentTextChars(attachments), 150);
  assert.equal(remainingTextChars(attachments), MAX_TOTAL_ATTACHMENT_TEXT_CHARS - 150);
}

// Image budget is a decoded-byte total and ignores text attachments.
{
  const onePixel = "data:image/png;base64,iVBORw0KGgo=";
  const attachments = [
    { kind: "image", dataUrl: onePixel },
    { kind: "text", text: "x".repeat(1000) },
  ];
  assert.equal(attachmentImageBytes(attachments), dataUrlByteLength(onePixel));
  assert.equal(fitsImageBudget([], MAX_TOTAL_ATTACHMENT_IMAGE_BYTES), true);
  assert.equal(fitsImageBudget([], MAX_TOTAL_ATTACHMENT_IMAGE_BYTES + 1), false);
  assert.equal(
    fitsImageBudget([{ kind: "image", dataUrl: onePixel }], MAX_TOTAL_ATTACHMENT_IMAGE_BYTES - dataUrlByteLength(onePixel)),
    true
  );
}

// The shared text budget cannot be exceeded by a second file.
{
  const used = [{ kind: "text", text: "z".repeat(MAX_TOTAL_ATTACHMENT_TEXT_CHARS) }];
  assert.equal(remainingTextChars(used), 0);
  assert.equal(fitsImageBudget([], 0), true);
}

assert.ok(MAX_ATTACHMENTS > 0);
console.log("OK: attachment-budget — shared text and image budgets, data-URL sizing.");
process.exit(0);
