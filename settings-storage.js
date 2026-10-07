// settings-storage.js
// Persistent second copy of user settings using IndexedDB.
// chrome.storage.local remains the primary store. IndexedDB is used only as
// a recovery layer because extension settings should survive browser restarts
// even if the browser's extension-storage database is unexpectedly reset.

const DB_NAME = "ai-assistant-settings";
const DB_VERSION = 1;
const STORE_NAME = "settings";
const SETTINGS_RECORD_KEY = "user-settings";

export const PERSISTED_SETTING_KEYS = [
  "apiKey",
  "openrouterApiKey",
  "groqApiKey",
  "groqKey",
  "tavilyApiKey",
  "customPrompt",
  "language",
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

export async function getSettingsBackup() {
  return readBackup().catch(() => ({}));
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
