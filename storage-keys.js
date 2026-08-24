// storage-keys.js (root directory)
// chrome.storage.local key names shared between sidepanel.js and
// background.js, so the two can never drift apart on the exact string (both
// now import from here instead of each hard-coding their own copy).
export const HISTORY_STORAGE_KEY = "conversationHistory";
export const CURRENT_CONVERSATION_KEY = "currentConversationId";
