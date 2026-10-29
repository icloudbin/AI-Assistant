#!/usr/bin/env node
// Unit tests for settings backup import filtering and validation (options.js).
// Ensures empty string settings, booleans, and numeric fields restore properly (#8).
// Run:  node scripts/test-options-backup.mjs
import assert from "node:assert/strict";
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

function filterImportSettings(backupSettings) {
  const NUMERIC_SETTINGS_KEYS = new Set(["composerHeight"]);
  const BOOLEAN_SETTINGS_KEYS = new Set(["piiFilterEnabled", "pageVisualsEnabled", AUTO_WEB_RESEARCH_KEY, "includeCurrentPageContext"]);
  const restored = {};
  for (const key of SETTINGS_BACKUP_KEYS) {
    const value = backupSettings[key];
    if (NUMERIC_SETTINGS_KEYS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) restored[key] = value;
    } else if (BOOLEAN_SETTINGS_KEYS.has(key)) {
      if (typeof value === "boolean") restored[key] = value;
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

console.log("OK: options-backup — empty string restoration, numeric/boolean validation, type filtering.");
process.exit(0);
