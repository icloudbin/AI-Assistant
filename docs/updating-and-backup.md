# Updating to a newer version without losing settings (v1.10.26+)

All user data (API keys, theme, language, custom prompt, saved model choice, conversation history) lives in `chrome.storage.local`, which Chrome persists per **extension ID**. Before v1.10.26, `manifest.json` had no `"key"` field, so for a "Load unpacked" install Chrome derived the extension ID from a hash of the **absolute folder path**. Loading each updated download from a new folder (e.g. `AI-Assistant-main`, then `AI-Assistant-main (2)`, ...) produced a *different* ID, so Chrome treated the update as a brand-new extension with empty storage — which is why every update appeared to reset all settings.

Fix: `manifest.json` now includes a `"key"` field (a base64-encoded RSA public key). With a `key` present, Chrome derives the ID from that key instead of the folder path, so the ID is stable — `jhnjhgicilnghoellcbkiokhlhkpbmjh` — no matter where the folder lives, and loading a new version is a true update: same ID, same storage, settings kept.

**Important: never click "Remove" between versions.** Removing an extension deletes its entire `chrome.storage.local` by design — that is Chrome's behavior for every extension, and no manifest field can change it. Removing and then reinstalling always starts from empty settings, even with the pinned ID. The pinned key only preserves data when the old install is updated *in place*.

Recommended update procedure:
1. Extract the new version's zip somewhere temporary.
2. Copy its contents over your permanent extension folder (the one originally chosen via "Load unpacked"), overwriting the old files.
3. In brave://extensions, click the ⟳ reload icon on the AI Assistant card, then reopen the side panel.

That's it — no removal, no "Load unpacked" again, settings intact. (If you instead extract each version to a new folder and pick it with "Load unpacked", Chrome may refuse with "already loaded", because the pinned key makes every folder produce the same ID — that refusal is protecting your installed copy's data. Update in place as above rather than removing.)

**Settings Backup (v1.10.27):** Settings now also has an "Export settings" button that writes every settings key — API keys, custom prompt, theme, languages, selected model — to a single JSON file, and an "Import settings" button that restores them in one click. Use this as the recovery path for anything a remove/reinstall, a profile reset, or a move to another machine: export first, remove/reinstall, import after. The file contains your API keys in readable plain text, so store it like a password.

**Key management:** the matching RSA private key must never be committed to or shipped inside the extension folder. It is kept outside the project as `ai-assistant-private-key.pem`; it is required to build signed CRX updates or to preserve this same ID when publishing to the Chrome Web Store, so keep a backup of it. If it is ever lost, a new key can be pinned the same way — but that changes the ID and resets storage again.
