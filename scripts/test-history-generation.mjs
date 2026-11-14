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
assert.match(sidepanel, /isHistoryGenerationCurrent\(storedGeneration, historyGeneration\)/, "save must reject stale snapshots");
assert.match(options, /HISTORY_GENERATION_STORAGE_KEY\]: generation,[\s\S]*HISTORY_STORAGE_KEY\]: \[\]/, "delete must publish generation and empty history together");
console.log("OK: history-generation.js — stale snapshot rejection, atomic deletion, and stale restore cancellation.");

assert.match(options, /restoreGeneration = normalizeHistoryGeneration\(startState\[HISTORY_GENERATION_STORAGE_KEY\]\)/, "restore captures the generation before ZIP parsing");
assert.match(options, /readBackupFile\(restoreHistoryFile\.files\?\.\[0\]\)[\s\S]*withHistoryLock\(async \(\) => \{[\s\S]*isHistoryGenerationCurrent\(currentGeneration, restoreGeneration\)/, "restore rechecks the generation inside the shared write lock after parsing");
assert.match(options, /restore_cancelled_by_delete/, "stale restore is explicitly cancelled instead of writing history");
