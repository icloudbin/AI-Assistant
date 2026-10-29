#!/usr/bin/env node
// Regression guard for the IndexedDB settings mirror: every user-authored
// setting that options.js saves through saveSettingsBackup() must be listed in
// PERSISTED_SETTING_KEYS, or the write is silently dropped by the key loop and
// a chrome.storage reset loses that setting while customPrompt survives -
// exactly what happened to translationTerms in v1.10.112 (fixed in .113).
// Run:  node scripts/test-settings-storage-keys.mjs
import assert from "node:assert/strict";
import { PERSISTED_SETTING_KEYS, SECRET_SETTING_KEYS, restoreSettingsFromBackup } from "../settings-storage.js";
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
  // The import path passes its whole restored object to saveSettingsBackup(),
  // and the live toggle handlers mirror directly - all of these must survive
  // an unexpected storage reset (especially the privacy flags).
  "piiFilterEnabled",
  "pageVisualsEnabled",
  "autoWebResearchEnabled",
  "includeCurrentPageContext",
  "selectedModelId",
  "micRecognitionLang",
  "composerHeight",
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

// ---------- restoreSettingsFromBackup: legacy cleanup & non-redundant remove (#10) ----------
{
  const removedKeys = [];
  const localStore = {
    geminiApiKey: "legacy-key-to-scrub",
    piiFilterEnabled: true,
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const res = {};
          for (const k of keys) if (k in localStore) res[k] = localStore[k];
          return res;
        },
        remove: async (keys) => {
          removedKeys.push(...keys);
          for (const k of keys) delete localStore[k];
        },
        set: async (obj) => Object.assign(localStore, obj),
      },
    },
  };

  // Run with legacy key present -> remove called
  await restoreSettingsFromBackup();
  assert.ok(removedKeys.includes("geminiApiKey"), "legacy key geminiApiKey removed when present");
  assert.equal("geminiApiKey" in localStore, false);

  // Run again without legacy keys -> remove MUST NOT be called!
  removedKeys.length = 0;
  await restoreSettingsFromBackup();
  assert.equal(removedKeys.length, 0, "remove is NOT called when no legacy keys exist");
}

console.log("OK: settings-storage.js — mirror whitelist covers every saved setting, no secrets, conditional cleanup.");
process.exit(0);
