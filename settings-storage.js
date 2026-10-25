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
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      // Read-modify-write inside ONE readwrite transaction. The old shape read
      // in a readonly transaction and wrote in a second one, so two concurrent
      // callers could interleave read/read/write/write and lose one caller's
      // keys; readwrite transactions on the same store serialize, closing
      // that window.
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(SETTINGS_RECORD_KEY);
      getReq.onsuccess = () => {
        const next = { ...(getReq.result || {}) };
        // Drop any credentials an older build mirrored into this record.
        for (const key of SECRET_SETTING_KEYS) delete next[key];
        for (const key of PERSISTED_SETTING_KEYS) {
          if (Object.prototype.hasOwnProperty.call(values, key)) {
            next[key] = values[key];
          }
        }
        store.put(next, SETTINGS_RECORD_KEY);
      };
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
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      // Same single-transaction read-modify-write shape as saveSettingsBackup.
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(SETTINGS_RECORD_KEY);
      getReq.onsuccess = () => {
        const current = getReq.result || {};
        if (!SECRET_SETTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(current, key))) {
          resolve(false);
          return;
        }
        const next = { ...current };
        for (const key of SECRET_SETTING_KEYS) delete next[key];
        store.put(next, SETTINGS_RECORD_KEY);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("Unable to scrub settings backup."));
      tx.onabort = () => reject(tx.error || new Error("Settings backup scrub aborted."));
    });
  } finally {
    db.close();
  }
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
    // One-time cleanups of keys left behind by older builds: the Gemini API
    // key (Gemini is no longer a supported provider) and the v1.10.112-113
    // translation term list (feature removed in v1.10.114 - brand/technical
    // terms are kept in the original by the translation instructions alone).
    await chrome.storage.local.remove(["geminiApiKey", "translationTerms"]);
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

// Runs the recovery at most ONCE per document / service-worker instance and
// shares the in-flight promise between concurrent callers. Every ASK used to
// run it twice (once directly in background.js, once through
// getStoredLanguage() in i18n.js), and every language read in a page re-ran
// it too: each run opened IndexedDB, read the record and issued a
// chrome.storage.local.remove - pure overhead on the request's cold path.
// Once per context is enough for the recovery purpose (the settings can only
// have gone missing while this context was not running): an MV3 service
// worker is recycled within seconds of going idle and every page load gets a
// fresh module instance, so every meaningful boundary re-checks. The raw
// restoreSettingsFromBackup() never rejects (its body is one try/catch), and
// the catch below keeps that contract even if that ever changes.
let restoreRun = null;
export function restoreSettingsFromBackupOnce() {
  restoreRun ??= restoreSettingsFromBackup().catch(() => {});
  return restoreRun;
}
