#!/usr/bin/env node
// Unit tests for models.js catalog, vision flags, aliases and lookups.
// Run:  node scripts/test-models.mjs
import assert from "node:assert/strict";
import {
  MODELS,
  MAX_PAGE_CONTEXT_CHARS,
  DEFAULT_MAX_PAGE_CHARS,
  modelSupportsVision,
  findModelById,
  findKnownModel,
  resolveModelId,
  findModelIdByLabel,
  cutAtCodePointBoundary,
} from "../models.js";

// ---------- 1. Catalog integrity & constants ----------
assert.ok(Array.isArray(MODELS) && MODELS.length >= 5, "MODELS is non-empty array");
assert.equal(MAX_PAGE_CONTEXT_CHARS, 120000, "MAX_PAGE_CONTEXT_CHARS is 120,000");
assert.equal(DEFAULT_MAX_PAGE_CHARS, MAX_PAGE_CONTEXT_CHARS, "DEFAULT_MAX_PAGE_CHARS matches MAX_PAGE_CONTEXT_CHARS");

for (const m of MODELS) {
  assert.ok(typeof m.id === "string" && m.id, `model ${m.id} has id`);
  assert.ok(typeof m.label === "string" && m.label, `model ${m.id} has label`);
  assert.ok(typeof m.provider === "string" && m.provider, `model ${m.id} has provider`);
  assert.ok(typeof m.apiModel === "string" && m.apiModel, `model ${m.id} has apiModel`);
  assert.ok(typeof m.maxPageChars === "number" && m.maxPageChars > 0, `model ${m.id} has maxPageChars`);
}

// ---------- 2. Vision capability flags (#7 regression guard) ----------
// Text-only models MUST have vision: false to avoid HTTP 400 from providers
assert.equal(modelSupportsVision(findKnownModel("groq-gpt-oss-120b")), false, "groq-gpt-oss-120b is text-only");
assert.equal(modelSupportsVision(findKnownModel("groq-qwen3.8-27b")), false, "groq-qwen3.8-27b is text-only");
assert.equal(modelSupportsVision(findKnownModel("groq-gpt-oss-20b")), false, "groq-gpt-oss-20b is text-only");
assert.equal(modelSupportsVision(findKnownModel("openrouter-free-auto")), false, "openrouter-free-auto is text-only");

assert.equal(modelSupportsVision(findKnownModel("deepseek-flash")), true, "deepseek-flash accepts vision");
assert.equal(modelSupportsVision(null), true, "null model defaults to vision true");

// ---------- 3. Resolving aliases ----------
assert.equal(resolveModelId("deepseek-flash"), "deepseek-flash");
assert.equal(resolveModelId("deepseek-v4.1-flash"), "deepseek-flash", "legacy alias resolved");
assert.equal(resolveModelId("deepseek-v4-flash"), "deepseek-flash", "legacy alias resolved");
assert.equal(resolveModelId("openrouter-free"), "openrouter-free-auto", "legacy alias resolved");
assert.equal(resolveModelId("unknown-model-xyz"), MODELS[0].id, "unknown falls back to default model");
assert.equal(resolveModelId(""), MODELS[0].id, "empty id falls back to default model");

// ---------- 4. Lookups ----------
assert.equal(findModelById("openrouter-free").id, "openrouter-free-auto", "tolerant lookup resolves alias");
assert.equal(findModelById("non-existent").id, MODELS[0].id, "tolerant lookup fallback");

assert.equal(findKnownModel("deepseek-v4-flash")?.id, "deepseek-flash", "strict lookup resolves alias");
assert.equal(findKnownModel("non-existent"), undefined, "strict lookup returns undefined for unknown");
assert.equal(findKnownModel(""), undefined, "strict lookup returns undefined for empty");

assert.equal(findModelIdByLabel(MODELS[0].label), MODELS[0].id, "find by exact label");
assert.equal(findModelIdByLabel("Non Existent Label"), null, "unknown label returns null");
assert.equal(findModelIdByLabel(""), null, "empty label returns null");

// ---------- 5. Surrogate-safe truncation ----------
assert.equal(cutAtCodePointBoundary("abc", 10), "abc", "short text unchanged");
assert.equal(cutAtCodePointBoundary("a😀b", 2), "a", "a high surrogate at the boundary is backed off");
assert.equal(cutAtCodePointBoundary("a😀b", 3), "a😀", "a complete surrogate pair is kept");
assert.equal(cutAtCodePointBoundary("a😀b", 0), "", "zero limit returns empty string");

console.log("OK: models.js — catalog integrity, vision capability flags, aliases, strict & tolerant lookups, surrogate-safe cuts.");
process.exit(0);
