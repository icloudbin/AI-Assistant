// storage-keys.js (root directory)
// chrome.storage.local key names shared between sidepanel.js and
// background.js, so the two can never drift apart on the exact string (both
// now import from here instead of each hard-coding their own copy).
export const HISTORY_STORAGE_KEY = "conversationHistory";
// UI display language (see i18n.js) - independent of MIC_LANG_STORAGE_KEY,
// which only picks the Web Speech recognition language.
export const LANGUAGE_STORAGE_KEY = "languagePreference";
// UI theme: "light" | "dark" | "device".
export const THEME_STORAGE_KEY = "themePreference";
// Privacy: send the current page with ordinary questions. A checkbox value:
// true = read, false = do not. ABSENT reads as checked (the default). A legacy
// "ask" value (a three-state mode that no longer exists) reads as checked.
export const INCLUDE_CONTEXT_STORAGE_KEY = "includeCurrentPageContext";
// One-time notices the user has already seen (booleans). They are shown once,
// before the first microphone use / the first attached image.
export const MIC_CLOUD_NOTICE_STORAGE_KEY = "micCloudNoticeAcknowledged";
export const IMAGE_NOTICE_STORAGE_KEY = "imageNoticeAcknowledged";
// Privacy: attach page screenshots/images to quick actions.
export const PAGE_VISUALS_STORAGE_KEY = "pageVisualsEnabled";
// Privacy filter default-on flag (see privacy/pii-filter.js).
export const PII_FILTER_STORAGE_KEY = "piiFilterEnabled";
// Voice recognition language and the persisted composer height.
export const MIC_LANG_STORAGE_KEY = "micRecognitionLang";
export const COMPOSER_HEIGHT_STORAGE_KEY = "composerHeight";

// Text selected from a webpage for the AI context menu.
// Values live in chrome.storage.session (RAM, wiped when the browser session
// ends): a right-click selection must never persist on disk.
export const PENDING_CONTEXT_ACTION_KEY = "pendingContextAction";
export const PREFERRED_TRANSLATION_LANGUAGE_KEY = "preferredTranslationLanguage";
// "Automatically search the web" (Settings > Web Research). Boolean, ON unless
// explicitly false. Read by background.js, written by options.js.
export const AUTO_WEB_RESEARCH_KEY = "autoWebResearchEnabled";

// Upper bound on saved conversations kept in chrome.storage.local. Shared by
// sidepanel.js (which trims to this on every save) and options.js (which
// merges restored backups up to this many) so a restore can never add more
// conversations than the side panel's next save would silently delete - the
// two previously disagreed (20 vs 100), quietly wiping restored history.
export const MAX_SAVED_CONVERSATIONS = 100;
