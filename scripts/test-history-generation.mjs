#!/usr/bin/env node
// Run: node scripts/test-history-generation.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeHistoryGeneration, nextHistoryGeneration, isHistoryGenerationCurrent } from "../history-generation.js";

assert.equal(normalizeHistoryGeneration(undefined), 0);
assert.equal(normalizeHistoryGeneration(-1), 0);
assert.equal(normalizeHistoryGeneration("2"), 0);
assert.equal(normalizeHistoryGeneration(2), 2);
assert.equal(nextHistoryGeneration(undefined), 1);
assert.equal(nextHistoryGeneration(1), 2);
assert.throws(() => nextHistoryGeneration(Number.MAX_SAFE_INTEGER), /exhausted/);
assert.equal(isHistoryGenerationCurrent(0, undefined), true, "legacy snapshots use generation zero");
assert.equal(isHistoryGenerationCurrent(2, 1), false, "pre-delete snapshots are stale");
assert.equal(isHistoryGenerationCurrent(2, 2), true, "current snapshots may save");

const root = new URL("../", import.meta.url);
const sidepanel = readFileSync(new URL("sidepanel/sidepanel.js", root), "utf8");
const options = readFileSync(new URL("options/options.js", root), "utf8");
const i18n = readFileSync(new URL("i18n.js", root), "utf8");
assert.match(sidepanel, /isHistoryGenerationCurrent\(storedGeneration, historyGeneration\)/, "save must reject stale snapshots");
assert.match(options, /HISTORY_GENERATION_STORAGE_KEY\]: generation,[\s\S]*HISTORY_STORAGE_KEY\]: \[\]/, "delete must publish generation and empty history together");
assert.match(options, /restoreGeneration = normalizeHistoryGeneration\(startState\[HISTORY_GENERATION_STORAGE_KEY\]\)/, "restore captures the generation before ZIP parsing");
assert.match(options, /readBackupFile\(restoreHistoryFile\.files\?\.\[0\]\)[\s\S]*withHistoryLock\(async \(\) => \{[\s\S]*isHistoryGenerationCurrent\(currentGeneration, restoreGeneration\)/, "restore rechecks the generation inside the shared write lock after parsing");
assert.match(options, /restore_cancelled_by_delete/, "stale restore is explicitly cancelled instead of writing history");

// The cancellation is identified by an error CODE, never by comparing
// localized message text (a refactor or a second throw site would silently
// misclassify), and an expected cancellation must not hit console.error.
assert.match(
  options,
  /cancelled\.code = "restore_cancelled_by_delete"/,
  "the cancellation error carries a code marker"
);
assert.match(
  options,
  /const cancelledByDelete = err\?\.code === "restore_cancelled_by_delete"/,
  "the catch identifies the cancellation by code, not by message text"
);
assert.doesNotMatch(
  options,
  /console\.error\([^\n]*\)[\s\S]{0,200}const cancelledByDelete/,
  "an expected cancellation is not logged as an error"
);

// Web Locks make the in-lock recheck airtight; the no-locks fallback leaves a
// window a Delete All could slip through. A second recheck must sit between
// the limited list and the first storage write.
assert.match(
  options,
  /recheck = await chrome\.storage\.local\.get\(HISTORY_GENERATION_STORAGE_KEY\)[\s\S]{0,300}isHistoryGenerationCurrent\([\s\S]{0,120}restoreGeneration\)[\s\S]{0,300}cancelled\.code = "restore_cancelled_by_delete"/,
  "restore rechecks the tombstone immediately before its first write (no-locks fallback mitigation)"
);

// The deterministic 50 MiB cap is NOT a storage-quota emergency: size-cap
// drops get their own truthful notice in both writers, and the quota wording
// stays reserved for real quota escalation.
assert.match(i18n, /history_sizeLimitDropped_template: `[^`]*\{count\}[^`]*`/, "the size-limit notice key exists with a count placeholder");
assert.match(sidepanel, /history_sizeLimitDropped_template/, "the side panel reports size-cap drops with the truthful notice");
assert.match(options, /history_sizeLimitDropped_template/, "restore reports cap evictions with the truthful notice");
assert.match(sidepanel, /limitStoredConversationMessages[\s\S]{0,600}emptied/, "silently-emptied conversations are counted, not dropped without a trace");

console.log("OK: history-generation.js — stale snapshot rejection, atomic deletion, and stale restore cancellation.");
