#!/usr/bin/env node
// Unit tests for settings backup import filtering and validation (options.js).
// Ensures empty string settings, booleans, and numeric fields restore properly (#8).
// Run:  node scripts/test-options-backup.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { LANGUAGE_STORAGE_KEY, AUTO_WEB_RESEARCH_KEY } from "../storage-keys.js";

const SETTINGS_BACKUP_SECRET_KEYS = ["apiKey", "groqApiKey", "openrouterApiKey", "tavilyApiKey"];
const SETTINGS_BACKUP_PLAIN_KEYS = [
  "customPrompt",
  LANGUAGE_STORAGE_KEY,
  "preferredTranslationLanguage",
  "themePreference",
  "piiFilterEnabled",
  "pageVisualsEnabled",
  AUTO_WEB_RESEARCH_KEY,
  "includeCurrentPageContext",
  "selectedModelId",
  "micRecognitionLang",
  "composerHeight",
];
const SETTINGS_BACKUP_KEYS = [...SETTINGS_BACKUP_SECRET_KEYS, ...SETTINGS_BACKUP_PLAIN_KEYS];

// Mirrors the import loop in options/options.js (importSettings). Keep the two
// in step: this copy exists so the filtering rules can be exercised without a DOM.
function filterImportSettings(backupSettings) {
  const NUMERIC_SETTINGS_KEYS = new Set(["composerHeight"]);
  const BOOLEAN_SETTINGS_KEYS = new Set(["piiFilterEnabled", "pageVisualsEnabled", AUTO_WEB_RESEARCH_KEY]);
  const restored = {};
  for (const key of SETTINGS_BACKUP_KEYS) {
    const value = backupSettings[key];
    if (NUMERIC_SETTINGS_KEYS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) restored[key] = value;
    } else if (BOOLEAN_SETTINGS_KEYS.has(key)) {
      if (typeof value === "boolean") restored[key] = value;
    } else if (key === "includeCurrentPageContext") {
      // A legacy "ask" imports as checked; an absent / unrecognised value says
      // nothing about the box (it used to be coerced to false).
      if (value === "ask") restored[key] = true;
      else if (typeof value === "boolean") restored[key] = value;
    } else if (typeof value === "string") {
      restored[key] = value;
    }
  }
  return restored;
}

// ---------- 1. Empty string restoration (#8) ----------
{
  const input = {
    customPrompt: "", // User intentionally cleared custom prompt
    themePreference: "dark",
    [LANGUAGE_STORAGE_KEY]: "zh-CN",
  };
  const filtered = filterImportSettings(input);
  assert.equal(filtered.customPrompt, "", "empty string customPrompt must be restored");
  assert.equal(filtered.themePreference, "dark");
  assert.equal(filtered[LANGUAGE_STORAGE_KEY], "zh-CN");
}

// ---------- 2. Numeric and boolean validation ----------
{
  const input = {
    composerHeight: 180,
    piiFilterEnabled: false,
    pageVisualsEnabled: true,
    includeCurrentPageContext: true,
  };
  const filtered = filterImportSettings(input);
  assert.equal(filtered.composerHeight, 180, "valid number accepted for composerHeight");
  assert.equal(filtered.piiFilterEnabled, false, "valid boolean accepted");
  assert.equal(filtered.pageVisualsEnabled, true, "valid boolean accepted");
}

// ---------- 3. Invalid types are filtered out ----------
{
  const maliciousInput = {
    apiKey: 12345, // Number over API key: rejected
    composerHeight: "not-a-number", // String over numeric field: rejected
    piiFilterEnabled: "true", // String over boolean toggle: rejected
    unknownExtraKey: "should be ignored", // Unknown key: rejected
    __proto__: { evil: true },
  };
  const filtered = filterImportSettings(maliciousInput);
  assert.equal("apiKey" in filtered, false, "non-string apiKey rejected");
  assert.equal("composerHeight" in filtered, false, "non-number composerHeight rejected");
  assert.equal("piiFilterEnabled" in filtered, false, "non-boolean toggle rejected");
  assert.equal("unknownExtraKey" in filtered, false, "unknown key rejected");
}

// ---------- 4. "Read current page": an absent key says nothing about the box ----------
{
  // A file that does not carry the key must not produce a value for it.
  const without = filterImportSettings({ themePreference: "light" });
  assert.equal("includeCurrentPageContext" in without, false, "an absent key must not be imported as false");
  assert.deepEqual(Object.keys(without), ["themePreference"]);
  // A file with no recognised setting at all restores nothing (the importer then refuses it).
  assert.deepEqual(filterImportSettings({ somethingElse: 1 }), {}, "an unrelated file restores nothing");
  // Explicit values still import; the legacy "ask" reads as checked.
  assert.equal(filterImportSettings({ includeCurrentPageContext: false }).includeCurrentPageContext, false);
  assert.equal(filterImportSettings({ includeCurrentPageContext: true }).includeCurrentPageContext, true);
  assert.equal(filterImportSettings({ includeCurrentPageContext: "ask" }).includeCurrentPageContext, true);
  // Anything else (null, a number, another string) is ignored rather than coerced.
  for (const junk of [null, 0, 1, "never", "false", {}, []]) {
    assert.equal("includeCurrentPageContext" in filterImportSettings({ includeCurrentPageContext: junk }), false, `${JSON.stringify(junk)} must be ignored`);
  }
}

// ---------- 5. The real importer still follows the rule mirrored above ----------
// filterImportSettings() is a copy, so it cannot notice options/options.js
// drifting back to the old behaviour; pin the importer's own source as well.
{
  const options = fs.readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
  assert.ok(!/value === "ask" \? true : value === true/.test(options), "options.js coerces an absent 'Read current page' key to false again");
  assert.ok(
    /value === "ask"\) restored\[key\] = true;\s*else if \(typeof value === "boolean"\) restored\[key\] = value;/.test(options),
    "options.js: the 'Read current page' import rule changed - update the mirror in this test"
  );
}

console.log("OK: options-backup — empty string restoration, numeric/boolean validation, type filtering, absent 'Read current page' key.");
process.exit(0);
