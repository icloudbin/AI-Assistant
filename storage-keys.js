// storage-keys.js (root directory)
// chrome.storage.local key names shared between sidepanel.js and
// background.js, so the two can never drift apart on the exact string (both
// now import from here instead of each hard-coding their own copy).
export const HISTORY_STORAGE_KEY = "conversationHistory";
export const CURRENT_CONVERSATION_KEY = "currentConversationId";
// UI display language (see i18n.js) - independent of MIC_LANG_STORAGE_KEY in
// sidepanel.js, which only picks the Web Speech recognition language.
export const LANGUAGE_STORAGE_KEY = "languagePreference";

// Text selected from a webpage for the AI context menu.
export const PENDING_CONTEXT_ACTION_KEY = "pendingContextAction";
export const PREFERRED_TRANSLATION_LANGUAGE_KEY = "preferredTranslationLanguage";

// Upper bound on saved conversations kept in chrome.storage.local. Shared by
// sidepanel.js (which trims to this on every save) and options.js (which
// merges restored backups up to this many) so a restore can never add more
// conversations than the side panel's next save would silently delete - the
// two previously disagreed (20 vs 100), quietly wiping restored history.
export const MAX_SAVED_CONVERSATIONS = 100;
