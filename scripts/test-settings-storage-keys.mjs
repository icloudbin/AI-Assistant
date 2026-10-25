#!/usr/bin/env node
// Regression guard for the IndexedDB settings mirror: every user-authored
// setting that options.js saves through saveSettingsBackup() must be listed in
// PERSISTED_SETTING_KEYS, or the write is silently dropped by the key loop and
// a chrome.storage reset loses that setting while customPrompt survives -
// exactly what happened to translationTerms in v1.10.112 (fixed in .113).
// Run:  node scripts/test-settings-storage-keys.mjs
import assert from "node:assert/strict";
import { PERSISTED_SETTING_KEYS, SECRET_SETTING_KEYS } from "../settings-storage.js";
import { LANGUAGE_STORAGE_KEY } from "../storage-keys.js";

// The user-authored settings the options page / storage layer pass to
// saveSettingsBackup(). When you add a new one, extend BOTH this list and
// PERSISTED_SETTING_KEYS - this test exists to catch the second half being
// forgotten.
const MIRRORED_SETTINGS = [
  "customPrompt",
  LANGUAGE_STORAGE_KEY,
  "preferredTranslationLanguage",
  "themePreference",
];
for (const key of MIRRORED_SETTINGS) {
  assert.ok(
    PERSISTED_SETTING_KEYS.includes(key),
    `PERSISTED_SETTING_KEYS is missing "${key}" - saveSettingsBackup() would silently drop it and restoreSettingsFromBackup() could never recover it`
  );
}

// Credentials must stay out of the mirror: they live only in
// chrome.storage.local (see the SECURITY note in settings-storage.js).
for (const key of SECRET_SETTING_KEYS) {
  assert.ok(!PERSISTED_SETTING_KEYS.includes(key), `secret "${key}" must never be mirrored`);
}

console.log("OK: settings-storage.js — mirror whitelist covers every saved setting, no secrets.");
process.exit(0);
