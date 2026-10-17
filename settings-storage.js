// settings-storage.js
// Persistent second copy of NON-SECRET user settings using IndexedDB.
// chrome.storage.local remains the primary store. IndexedDB is used only as
// a recovery layer because extension settings should survive browser restarts
// even if the browser's extension-storage database is unexpectedly reset.
//
// SECURITY: credentials (API keys) are deliberately NOT mirrored here. A second
// plaintext copy doubles where a secret lives, and - worse - "restore keys that
// are missing from chrome.storage.local" cannot tell a storage reset from the
// user deliberately removing a key, so a deleted key would reappear on the next
// service-worker start. Keys live only in chrome.storage.local; the Settings
// export can carry them, but only encrypted with a passphrase (settings-crypto.js).

import { LANGUAGE_STORAGE_KEY } from "./storage-keys.js";

const DB_NAME = "ai-assistant-settings";
const DB_VERSION = 1;
const STORE_NAME = "settings";
const SETTINGS_RECORD_KEY = "user-settings";

// Credentials. Never written to, and never restored from, the IndexedDB mirror.
export const SECRET_SETTING_KEYS = [
  "apiKey",
  "openrouterApiKey",
  "groqApiKey",
  "groqKey", // legacy alias of groqApiKey
  "tavilyApiKey",
];

export const PERSISTED_SETTING_KEYS = [
  "customPrompt",
  // The display language is stored under LANGUAGE_STORAGE_KEY ("languagePreference").
  // Backups made by older builds used the field name "language", which never
  // matched the real storage key, so the language was never actually restored.
  LANGUAGE_STORAGE_KEY,
  "preferredTranslationLanguage",
  "themePreference",
];

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open settings database."));
  });
}

async function readBackup() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(SETTINGS_RECORD_KEY);
      request.onsuccess = () => resolve(request.result || {});
      request.onerror = () => reject(request.error || new Error("Unable to read settings backup."));
    });
  } finally {
    db.close();
  }
}

export async function saveSettingsBackup(values) {
  const current = await readBackup().catch(() => ({}));
  const next = { ...current };
  // Drop any credentials an older build mirrored into this record.
  for (const key of SECRET_SETTING_KEYS) delete next[key];
  for (const key of PERSISTED_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      next[key] = values[key];
    }
  }

  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(next, SETTINGS_RECORD_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Unable to save settings backup."));
      tx.onabort = () => reject(tx.error || new Error("Settings backup transaction aborted."));
    });
  } finally {
    db.close();
  }
}

// Removes credentials that older builds mirrored into the IndexedDB record.
// Only writes when something is actually there, so it is a no-op afterwards.
export async function scrubSecretsFromBackup() {
  const current = await readBackup().catch(() => ({}));
  if (!SECRET_SETTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(current, key))) return false;
  const next = { ...current };
  for (const key of SECRET_SETTING_KEYS) delete next[key];
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(next, SETTINGS_RECORD_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Unable to scrub settings backup."));
      tx.onabort = () => reject(tx.error || new Error("Settings backup scrub aborted."));
    });
  } finally {
    db.close();
  }
  return true;
}

export async function getSettingsBackup() {
  const backup = await readBackup().catch(() => ({}));
  // Migrate the legacy "language" field written by older builds.
  if (backup.language !== undefined && backup[LANGUAGE_STORAGE_KEY] === undefined) {
    return { ...backup, [LANGUAGE_STORAGE_KEY]: backup.language };
  }
  return backup;
}

// Restore only keys that are genuinely absent from chrome.storage.local.
// This means an intentional empty-string setting is never overwritten.
export async function restoreSettingsFromBackup() {
  try {
    // Remove the Gemini API key left by older builds; Gemini is no longer a supported provider.
    await chrome.storage.local.remove(["geminiApiKey"]);
    const [local, backup] = await Promise.all([
      chrome.storage.local.get(PERSISTED_SETTING_KEYS),
      getSettingsBackup(),
    ]);
    // One-time cleanup of keys mirrored by earlier builds (the restore loop
    // below only ever touches PERSISTED_SETTING_KEYS, so they are never
    // resurrected even if this scrub fails).
    if (SECRET_SETTING_KEYS.some((key) => backup[key] !== undefined)) {
      await scrubSecretsFromBackup().catch(() => {});
    }
    const restored = {};
    for (const key of PERSISTED_SETTING_KEYS) {
      if (local[key] === undefined && backup[key] !== undefined) {
        restored[key] = backup[key];
      }
    }
    if (Object.keys(restored).length) {
      await chrome.storage.local.set(restored);
    }
    return restored;
  } catch {
    return {};
  }
}
