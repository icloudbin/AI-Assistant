// sidepanel/sidepanel.js —— Fixed version: no trailing spaces; keeps import "../models.js"; API Key configuration moved to Settings
import { MODELS, MAX_PAGE_CONTEXT_CHARS, findModelById, findKnownModel, resolveModelId, findModelIdByLabel, modelSupportsVision } from "../models.js";
import { HISTORY_STORAGE_KEY, CURRENT_CONVERSATION_KEY, PENDING_CONTEXT_ACTION_KEY, PREFERRED_TRANSLATION_LANGUAGE_KEY, MAX_SAVED_CONVERSATIONS } from "../storage-keys.js";
import { sensitiveHostOf, hostOf } from "../sensitive-sites.js";
import { getStoredLanguage, applyStaticTranslations, t, LANGUAGE_STORAGE_KEY } from "../i18n.js";
// Pure save/merge helpers for the saved-conversation list (DOM-free, tested
// in scripts/test-conversation-store.mjs).
import { mergeConversationLists, sortedByNewest } from "../conversation-store.js";
import { markdownToHtml } from "./rendering/markdown.js";
import { makeTopicTitle, toStoredMessage, compressForQuota } from "./history-manager.js";

// ---------- Theme ----------
const THEME_STORAGE_KEY = "themePreference";
const deviceThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(preference) {
  const normalized = ["light", "dark", "device"].includes(preference) ? preference : "device";
  const resolved = normalized === "device" ? (deviceThemeQuery.matches ? "dark" : "light") : normalized;
  document.documentElement.dataset.theme = resolved;
}

async function loadTheme() {
  const stored = await chrome.storage.local.get(THEME_STORAGE_KEY);
  applyTheme(stored[THEME_STORAGE_KEY] || "device");
}

deviceThemeQuery.addEventListener?.("change", async () => {
  const stored = await chrome.storage.local.get(THEME_STORAGE_KEY);
  if ((stored[THEME_STORAGE_KEY] || "device") === "device") applyTheme("device");
});

// Repaint the history selector when the side panel becomes visible/focused.
// Chromium can restore the side panel DOM from a suspended state without
// rerunning the full initialization sequence.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleHistoryRender();
});
window.addEventListener("focus", scheduleHistoryRender);
window.addEventListener("pageshow", scheduleHistoryRender);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[THEME_STORAGE_KEY]) {
    applyTheme(changes[THEME_STORAGE_KEY].newValue || "device");
  }
});

loadTheme();

// ---------- Language ----------
// Same "read once, then live-sync via chrome.storage.onChanged" pattern as
// Theme above. The language dropdown itself lives on the Settings page
// (options.js), a separate tab/document from this side panel, so this side
// panel needs its own listener to pick up a change immediately - exactly
// like it already does for theme. applyLanguage() re-applies every
// declarative data-i18n[-*] element (via applyStaticTranslations) and then
// refreshes the handful of pieces generated dynamically in JS rather than
// sitting statically in sidepanel.html: history dropdown options, any
// currently-rendered attachment chips, the mic button/badge tooltips, and
// the copy buttons already attached to messages from earlier in this
// session.
let currentLang = "en";

function applyLanguage(lang) {
  currentLang = lang;
  applyStaticTranslations(lang);
  // Set directly, not just via the data-i18n-html sweep above: emptyState
  // is detached from the document whenever a non-empty conversation is
  // showing (renderConversation() replaces chatLog's children wholesale and
  // only re-appends emptyState when the log is empty), so
  // document.querySelectorAll would miss it at those times.
  emptyState.innerHTML = t(lang, "emptyState_html");
  renderHistorySelect();
  renderAttachments();
  refreshMicUiLanguage();
  refreshExistingCopyButtons();
}

async function loadLanguage() {
  applyLanguage(await getStoredLanguage());
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[LANGUAGE_STORAGE_KEY]) {
    applyLanguage(changes[LANGUAGE_STORAGE_KEY].newValue || "en");
  }
});

loadLanguage();


const PORT_NAME = "ai-chat";
const MAX_HISTORY_TURNS = 8;
const NEW_TOPIC_VALUE = "__new__";

const chatLog = document.getElementById("chatLog");
const emptyState = document.getElementById("emptyState");
const chatForm = document.getElementById("chatForm");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const optionsBtn = document.getElementById("optionsBtn");
const includeContextToggle = document.getElementById("includeContextToggle");
// Privacy: reading the current page (text + screenshot, including Proton Mail
// message bodies) is ON by default; once the user turns it off, that explicit
// choice is remembered across sessions. On webmail / banking sites (see
// sensitive-sites.js) ordinary questions never send the page unless the user
// allows that site for this panel session.
const INCLUDE_CONTEXT_STORAGE_KEY = "includeCurrentPageContext";
const PAGE_VISUALS_STORAGE_KEY = "pageVisualsEnabled";
const pageContextBar = document.getElementById("pageContextBar");
const pageContextTitle = document.getElementById("pageContextTitle");
const pageContextAllowBtn = document.getElementById("pageContextAllowBtn");
// Sensitive hosts the user explicitly allowed for ordinary questions during
// this panel session only (never persisted).
const allowedSensitiveHosts = new Set();
// True when an ordinary question would NOT send this page: it is a webmail /
// banking site the user has not allowed. Quick actions are explicit actions
// on the page and are not blocked.
// `source` is the content-script extractor that produced the page text: the
// webmail extractors identify self-hosted mail (e.g. Synology MailPlus) that no
// hostname list can know about.
const MAIL_EXTRACTOR_SOURCES = new Set(["synology-mailplus", "proton-mail"]);
function isBlockedSensitivePage(url, source = "") {
  const sensitive = sensitiveHostOf(url) !== "" || MAIL_EXTRACTOR_SOURCES.has(source);
  return sensitive && !allowedSensitiveHosts.has(hostOf(url));
}
const modelSelect = document.getElementById("modelSelect");
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const attachmentList = document.getElementById("attachmentList");
const historySelect = document.getElementById("historySelect");
const micBtn = document.getElementById("micBtn");
const micLangBtn = document.getElementById("micLangBtn");
const micStatus = document.getElementById("micStatus");
const panelResizeHandle = document.getElementById("panelResizeHandle");
const composer = document.getElementById("chatForm");
const quickSummarizeBtn = document.getElementById("quickSummarizeBtn");
const quickTranslateBtn = document.getElementById("quickTranslateBtn");
const quickExplainBtn = document.getElementById("quickExplainBtn");
const quickKeyPointsBtn = document.getElementById("quickKeyPointsBtn");
const quickFactCheckBtn = document.getElementById("quickFactCheckBtn");
const quickActionButtons = [quickSummarizeBtn, quickTranslateBtn, quickExplainBtn, quickKeyPointsBtn, quickFactCheckBtn].filter(Boolean);

const COMPOSER_HEIGHT_STORAGE_KEY = "composerHeight";
const MIN_COMPOSER_HEIGHT = 92;
const MAX_COMPOSER_HEIGHT_RATIO = 0.70;

function clampComposerHeight(height) {
  const viewportHeight = Math.max(document.documentElement.clientHeight || window.innerHeight || 600, 300);
  const maxHeight = Math.max(MIN_COMPOSER_HEIGHT, Math.floor(viewportHeight * MAX_COMPOSER_HEIGHT_RATIO));
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(maxHeight, Math.round(height)));
}

function setComposerHeight(height, persist = true) {
  const nextHeight = clampComposerHeight(height);
  document.documentElement.style.setProperty("--composer-height", `${nextHeight}px`);
  if (persist) chrome.storage.local.set({ [COMPOSER_HEIGHT_STORAGE_KEY]: nextHeight }).catch(() => {});
}

async function restoreComposerHeight() {
  try {
    const stored = await chrome.storage.local.get(COMPOSER_HEIGHT_STORAGE_KEY);
    const saved = Number(stored[COMPOSER_HEIGHT_STORAGE_KEY]);
    if (Number.isFinite(saved) && saved > 0) setComposerHeight(saved, false);
    else setComposerHeight(132, false);
  } catch {
    setComposerHeight(132, false);
  }
}

let resizePointerId = null;
let resizeStartY = 0;
let resizeStartHeight = 132;

function beginPanelResize(e) {
  if (e.button !== undefined && e.button !== 0) return;
  resizePointerId = e.pointerId ?? "mouse";
  resizeStartY = e.clientY;
  resizeStartHeight = composer.getBoundingClientRect().height;
  panelResizeHandle.setPointerCapture?.(e.pointerId);
  document.body.classList.add("panel-resizing");
  e.preventDefault();
}

function updatePanelResize(e) {
  if (resizePointerId === null) return;
  // Moving the divider upward gives the question box more room; moving it
  // downward gives the conversation box more room.
  setComposerHeight(resizeStartHeight - (e.clientY - resizeStartY), false);
  e.preventDefault();
}

function endPanelResize(e) {
  if (resizePointerId === null) return;
  if (e.pointerId !== undefined && e.pointerId !== resizePointerId) return;
  resizePointerId = null;
  document.body.classList.remove("panel-resizing");
  const finalHeight = composer.getBoundingClientRect().height;
  setComposerHeight(finalHeight, true);
}

panelResizeHandle?.addEventListener("pointerdown", beginPanelResize);
panelResizeHandle?.addEventListener("pointermove", updatePanelResize);
panelResizeHandle?.addEventListener("pointerup", endPanelResize);
panelResizeHandle?.addEventListener("pointercancel", endPanelResize);
panelResizeHandle?.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const delta = e.key === "ArrowUp" ? 20 : -20;
  setComposerHeight(composer.getBoundingClientRect().height + delta);
  e.preventDefault();
});

window.addEventListener("resize", () => {
  const current = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--composer-height"));
  if (Number.isFinite(current)) setComposerHeight(current, false);
});

restoreComposerHeight();

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_CHARS = 180000;
// At most this many TEXT files are read from one ZIP. Only text entries count:
// directories, images and other non-text entries cost nothing, and neither do
// entries skipped by the ignore list below. Text files past the limit are left
// out and reported to the user (see describeZipReport) instead of rejecting the
// whole archive.
const MAX_ZIP_ENTRIES = 80;
// Largest single ZIP entry (uncompressed bytes) that is read. 4 bytes per
// character is the UTF-8 worst case for the character budget above.
const MAX_ZIP_ENTRY_BYTES = MAX_TOTAL_EXTRACTED_CHARS * 4;
// Folders that hold dependencies, version-control data, IDE/cache output or OS
// junk: thousands of files that are never what the user is asking about and
// would use up the whole character budget. Compared in lower case.
const ZIP_IGNORED_DIRS = new Set([
  "node_modules", "bower_components", ".git", ".svn", ".hg", ".idea",
  "__pycache__", ".venv", "venv", ".next", ".nuxt", "__macosx"
]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "json", "xml", "yaml", "yml", "html", "htm",
  "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt", "kts",
  "py", "rb", "go", "rs", "c", "h", "cpp", "hpp", "cs", "php", "sql", "log",
  "properties", "ini", "cfg", "conf", "sh", "bat", "ps1", "toml"
]);
let attachments = [];

let history = [];
let conversations = [];
let currentConversationId = null;
let port = null;
let currentAssistantBubble = null;
// True while the in-flight request is a translation: its reply is rendered as
// plain text (see setBubbleContent) and stored with plain: true.
let pendingPlainReply = false;
let currentAssistantText = "";
let isStreaming = false;
let pendingModelLabel = "";
let pendingModelId = "";
// Identifies the currently in-flight ASK, echoed back by background.js on
// every START/CHUNK/DONE/ERROR for that request. Cleared the moment a STOP
// is sent (see stopActiveRequest below), so handlePortMessage can recognize
// and ignore any message that still arrives for a request this side has
// already abandoned (e.g. a CHUNK already queued on the port before the
// abort signal reached the fetch on the other end).
let currentRequestId = null;

// During streaming, follow the newest translated text automatically until
// the user interacts with the conversation viewport. User interaction stops
// only the automatic scrolling; the background request continues normally.
let autoScrollEnabled = false;
let programmaticScroll = false;

// Initialization gate. init() (bottom of this file) resets the conversation
// and opens the port; nothing that submits a request may run before that is
// done, or startNewTopic() would wipe the new conversation/bubble.
// initCoreDone flips once the blank topic and the port exist; initPromise
// settles when all of init() has finished. Late-arriving events (a CONTEXT_ACTION
// message from the worker) wait on initPromise.
let initCoreDone = false;
let initPromise = Promise.resolve();

// Idempotent: returns the live port, creating it only if there is none. A
// second call (init() after an earlier ensurePort(), say) must not overwrite
// the global and leave the first port alive.
function connectPort() {
  if (port) return port;
  const thisPort = chrome.runtime.connect({ name: PORT_NAME });
  port = thisPort;
  thisPort.onMessage.addListener((message) => {
    // A superseded port can still deliver queued messages; only the current
    // port may drive the UI.
    if (port !== thisPort) return;
    handlePortMessage(message);
  });
  thisPort.onDisconnect.addListener(() => {
    // A stale port's disconnect must not null out (or report a lost
    // connection for) a newer port that is current and possibly streaming.
    if (port !== thisPort) return;
    port = null;
    // The long-lived port drops when the MV3 service worker is recycled
    // (normal after ~30s idle - a slow stream producing fewer chunks than
    // that cannot keep it alive) or when it crashes. If a request was still
    // streaming at that moment, its DONE/ERROR never arrives, which
    // previously left the composer disabled and the bubble stuck in
    // "pending" forever with no explanation. Recover the same way
    // stopActiveRequest() does, but with a visible error bubble; any partial
    // answer already received is kept as a finished assistant turn so text
    // the user was watching stream in is not lost. The next submission
    // reconnects via ensurePort() against a fresh service worker instance.
    if (!isStreaming || currentRequestId === null) return;
    currentRequestId = null;
    // Show the whole received tail before the bubble is finalized: a
    // coalesced render may still be pending (see scheduleStreamingRender).
    flushStreamingRender();
    if (currentAssistantBubble) {
      if (currentAssistantText.trim()) currentAssistantBubble.classList.remove("pending");
      else currentAssistantBubble.remove();
      currentAssistantBubble = null;
    }
    if (currentAssistantText.trim()) {
      history.push({
        role: "assistant",
        content: currentAssistantText,
        displayContent: currentAssistantText,
        modelLabel: pendingModelLabel,
        modelId: pendingModelId,
        plain: pendingPlainReply,
      });
      saveConversations().catch((err) => console.error("[AI Assistant] Unable to save conversation:", err));
    }
    currentAssistantText = "";
    autoScrollEnabled = false;
    setStreaming(false);
    addBubble("error", t(currentLang, "error_connectionLost"));
  });
  return thisPort;
}

function ensurePort() {
  return port || connectPort();
}

// Sends a message to the background worker. If the cached port turns out to be
// dead (the service worker was recycled and onDisconnect has not run yet),
// reconnect once and retry instead of throwing and leaving the composer locked.
function postToBackground(message) {
  try {
    ensurePort().postMessage(message);
  } catch {
    // Drop the dead port for good (its handlers ignore events once superseded).
    const dead = port;
    port = null;
    try { dead?.disconnect(); } catch {}
    ensurePort().postMessage(message);
  }
}

function scrollToBottom(force = false) {
  if (!force && !autoScrollEnabled) return;
  programmaticScroll = true;
  chatLog.scrollTop = chatLog.scrollHeight;
  requestAnimationFrame(() => {
    programmaticScroll = false;
  });
}

function pauseAutoScrollFromUserInteraction() {
  autoScrollEnabled = false;
}

// Clicking/dragging/scrolling the conversation viewport gives the user
// control of the reading position. In particular, pointerdown also catches
// dragging the native scrollbar thumb before its scroll event fires.
chatLog.addEventListener("pointerdown", pauseAutoScrollFromUserInteraction);
chatLog.addEventListener("wheel", pauseAutoScrollFromUserInteraction, { passive: true });
chatLog.addEventListener("touchstart", pauseAutoScrollFromUserInteraction, { passive: true });
chatLog.addEventListener("scroll", () => {
  if (!programmaticScroll) pauseAutoScrollFromUserInteraction();
});


const ALLOWED_TAGS = new Set([
  "P", "BR", "STRONG", "EM", "DEL", "CODE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "BLOCKQUOTE", "HR", "A", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "DIV"
]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "class", "src", "alt", "loading", "decoding", "start"]);

const DROP_WITH_CONTENT = new Set([
  "SCRIPT", "STYLE", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "IFRAME", "FRAME", "FRAMESET",
  "OBJECT", "EMBED", "APPLET", "TEXTAREA", "TITLE", "XMP", "NOEMBED", "NOFRAMES", "PLAINTEXT",
  "SELECT", "FORM", "INPUT", "BUTTON", "META", "LINK", "BASE"
]);

function sanitizeRenderedHtml(html) {
  // Parse into doc.body (no id lookup, so DOM clobbering via id="root" is moot).
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  const root = doc.body;
  if (!root) return "";

  // Comments / CDATA / processing instructions are a classic mXSS carrier
  // (attributes hidden in a comment become live after re-serialization).
  const nodeWalker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION);
  const junk = [];
  while (nodeWalker.nextNode()) junk.push(nodeWalker.currentNode);
  junk.forEach((n) => n.remove());

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements = [];
  while (walker.nextNode()) elements.push(walker.currentNode);

  for (const el of elements.reverse()) {
    // Foreign content (svg/math) and raw-text/embedding elements are dropped
    // WITH their content instead of being unwrapped: hoisting their children
    // across a namespace/parsing-mode boundary is what enables mutation XSS.
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP_WITH_CONTENT.has(el.tagName)) {
      el.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(el.tagName)) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      continue;
    }

    for (const attr of [...el.attributes]) {
      if (!ALLOWED_ATTRS.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }

    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") || "";
      try {
        const u = new URL(src, location.href);
        const isHttpImage = ["http:", "https:"].includes(u.protocol);
        const isDataImage = u.protocol === "data:" && /^data:image\/(?:png|jpeg|jpg|gif|webp);/i.test(src);
        if (!isHttpImage && !isDataImage) {
          el.remove();
          continue;
        }
        if (isDataImage) {
          el.setAttribute("src", src);
          el.setAttribute("loading", "lazy");
          el.setAttribute("decoding", "async");
          el.setAttribute("alt", el.getAttribute("alt") || "");
        } else {
          // Remote image: never loaded automatically (see remoteImageNode).
          el.replaceWith(remoteImageNode(doc, u.href, el.getAttribute("alt") || ""));
        }
      } catch {
        el.remove();
      }
      continue;
    }

    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      try {
        const u = new URL(href, location.href);
        if (!["http:", "https:", "mailto:"].includes(u.protocol)) {
          el.replaceWith(document.createTextNode(el.textContent || ""));
          continue;
        }

        // Also handle model/provider output that arrives as an HTML anchor
        // after an earlier Markdown conversion step. If the href has an
        // image filename extension, render it as an IMG instead of a link.
        // SVG is excluded for the same reason as in inlineMarkdownToHtml():
        // the worker never fetches SVG, so such a link must stay a link.
        const isImageUrl = /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(u.pathname);
        if (isImageUrl && (u.protocol === "http:" || u.protocol === "https:")) {
          el.replaceWith(remoteImageNode(doc, u.href, el.textContent || t(currentLang, "imageAltFallback")));
          continue;
        }

        el.setAttribute("href", u.href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      } catch {
        el.replaceWith(document.createTextNode(el.textContent || ""));
      }
    }
  }

  return root.innerHTML;
}

// ---------- Remote images in model replies ----------
// A model reply (which a web page can steer by prompt injection) may contain
// Markdown images. Loading such an image automatically would send a request
// to an arbitrary host - with whatever the injected prompt put in its URL -
// the moment the reply renders, i.e. a silent data-exfiltration channel. So
// remote images are NEVER loaded automatically: the panel's CSP allows only
// 'self' and data: images, and each remote image is shown as a placeholder
// that shows its address. Only when the user clicks it is the image fetched,
// through the background worker (public hosts only, size/type checked), and
// shown as a data URL. Loaded images are remembered so streaming re-renders
// do not turn them back into placeholders.
const loadedRemoteImages = new Map(); // url -> data URL, LRU order: oldest first
// The panel document lives for a whole browsing session and every fetched
// image is a data URL of up to 10 MB (FETCH_IMAGE's cap in background.js),
// so an unbounded map grew without limit. Oldest entries are evicted past
// these caps; an evicted image simply re-fetches through the worker the next
// time the user clicks its placeholder.
const REMOTE_IMAGE_CACHE_MAX_COUNT = 20;
const REMOTE_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let remoteImageCacheBytes = 0;

function rememberRemoteImage(url, dataUrl) {
  const previous = loadedRemoteImages.get(url);
  if (previous !== undefined) {
    loadedRemoteImages.delete(url);
    remoteImageCacheBytes -= dataUrlByteLength(previous);
  }
  loadedRemoteImages.set(url, dataUrl);
  remoteImageCacheBytes += dataUrlByteLength(dataUrl);
  while (
    loadedRemoteImages.size > REMOTE_IMAGE_CACHE_MAX_COUNT ||
    (remoteImageCacheBytes > REMOTE_IMAGE_CACHE_MAX_BYTES && loadedRemoteImages.size > 1)
  ) {
    const oldest = loadedRemoteImages.keys().next().value;
    remoteImageCacheBytes -= dataUrlByteLength(loadedRemoteImages.get(oldest));
    loadedRemoteImages.delete(oldest);
  }
}

function remoteImageNode(doc, url, alt) {
  const cached = loadedRemoteImages.get(url);
  if (cached) {
    // Refresh the LRU position: a re-rendered reply counts as recent use.
    loadedRemoteImages.delete(url);
    loadedRemoteImages.set(url, cached);
    const img = doc.createElement("img");
    img.setAttribute("src", cached);
    img.setAttribute("alt", alt);
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    return img;
  }
  const box = doc.createElement("span");
  box.className = "remote-image";
  box.setAttribute("role", "button");
  box.setAttribute("tabindex", "0");
  box.setAttribute("data-src", url);
  box.setAttribute("data-alt", alt);
  box.setAttribute("title", url);
  box.textContent = `🖼️ ${t(currentLang, "imageRemote_load")}${alt.trim() ? ` - ${alt.trim()}` : ""}`;
  return box;
}

async function loadRemoteImage(box) {
  if (box.dataset.loading === "1") return;
  const src = box.getAttribute("data-src") || "";
  if (!/^https?:\/\//i.test(src)) return;
  box.dataset.loading = "1";
  try {
    // The worker refuses localhost/private-network hosts unless they are the
    // host of the page the user is on; tell it which page. Plain http: is
    // retried over https: only (never fetched in the clear).
    const activeTab = await getCurrentActiveTab().catch(() => null);
    const result = await chrome.runtime.sendMessage({ type: "FETCH_IMAGE", url: src.replace(/^http:/i, "https:"), pageUrl: String(activeTab?.url || "") });
    if (result?.ok && result.dataUrl) {
      rememberRemoteImage(src, result.dataUrl);
      const img = document.createElement("img");
      img.src = result.dataUrl;
      img.alt = box.getAttribute("data-alt") || "";
      box.replaceWith(img);
      return;
    }
  } catch (_) {
    // Fall through to the failure state below.
  }
  box.dataset.loading = "0";
  box.classList.add("failed");
  box.textContent = `🚫 ${t(currentLang, "imageRemote_failed")}`;
  const link = document.createElement("a");
  link.href = src;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t(currentLang, "imageBlockedHttp_open");
  box.append(" ", link);
}

chatLog.addEventListener("click", (event) => {
  const box = event.target?.closest?.(".remote-image");
  if (box && !box.classList.contains("failed")) loadRemoteImage(box);
});
chatLog.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const box = event.target?.closest?.(".remote-image");
  if (box && !box.classList.contains("failed")) { event.preventDefault(); loadRemoteImage(box); }
});

// Copies text to the clipboard, preferring the modern async Clipboard API
// and falling back to the older execCommand technique (an offscreen,
// selected textarea) if that API is unavailable or throws - e.g. some
// permissions-policy configurations. Returns whether it believes the copy
// succeeded; callers use this to decide whether to show success feedback.
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // Fall through to the execCommand fallback below.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed; top:-9999px; left:-9999px;";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

// Briefly swaps a copy button's label to confirm success, then restores it.
// The true original label is cached on first use (in a data attribute, so
// it survives across calls) rather than re-read from a possibly-already-
// swapped button on a fast repeat click.
function showCopyFeedback(button, label) {
  clearTimeout(button._copyResetTimer);
  if (button.dataset.originalLabel === undefined) {
    button.dataset.originalLabel = button.textContent;
  }
  button.textContent = label;
  button.classList.add("copied");
  button._copyResetTimer = setTimeout(() => {
    button.textContent = button.dataset.originalLabel;
    button.classList.remove("copied");
  }, 1500);
}

// Adds a small copy button to every fenced code block inside container that
// doesn't already have one. Called after every markdown render (including
// once per streamed chunk, since setBubbleContent replaces bubble-text's
// innerHTML wholesale each time - any button added to a previous chunk's
// DOM is gone once that happens, so this re-adds them each time rather than
// assuming they persist).
function enhanceCodeBlocks(container) {
  for (const block of container.querySelectorAll(".code-block")) {
    if (block.querySelector(":scope > .code-copy-btn")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.textContent = "📋";
    btn.title = t(currentLang, "copyCode_title");
    btn.setAttribute("aria-label", t(currentLang, "copyCode_title"));
    btn.addEventListener("click", async () => {
      const code = block.querySelector("code");
      const ok = await copyTextToClipboard(code ? code.textContent : block.textContent);
      if (ok) showCopyFeedback(btn, "✓");
    });
    block.appendChild(btn);
  }
}

// Refreshes the title/aria-label (and, where not mid-"copied" feedback, the
// visible label) of every copy button already attached to messages/code
// blocks rendered earlier in this session, so switching languages doesn't
// leave stale-language tooltips/labels on them. Buttons created after the
// switch already pick up the current language directly from addBubble/
// enhanceCodeBlocks above.
function refreshExistingCopyButtons() {
  chatLog.querySelectorAll(".copy-btn").forEach((btn) => {
    const label = t(currentLang, "copyMessage_title");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    const defaultText = t(currentLang, "copyMessage_button");
    if (!btn.classList.contains("copied")) btn.textContent = defaultText;
    if (btn.dataset.originalLabel) btn.dataset.originalLabel = defaultText;
  });
  chatLog.querySelectorAll(".code-copy-btn").forEach((btn) => {
    const label = t(currentLang, "copyCode_title");
    btn.title = label;
    btn.setAttribute("aria-label", label);
  });
}

function setBubbleContent(bubbleEl, text, role, plain = false) {
  const textEl = getBubbleTextEl(bubbleEl);
  if (!textEl) return;
  if (role === "assistant" && plain) {
    // Translations are shown as PLAIN TEXT (white-space: pre-wrap), never run
    // through the Markdown renderer: Markdown would renumber lists, merge
    // consecutive lines, drop indentation and turn *, _, #, > and | in the
    // source into formatting - i.e. change the original layout.
    textEl.classList.add("plain-text");
    textEl.textContent = text;
  } else if (role === "assistant") {
    textEl.innerHTML = sanitizeRenderedHtml(markdownToHtml(text));
    enhanceCodeBlocks(textEl);
  } else {
    textEl.textContent = text;
  }
}

function addBubble(role, text, modelLabel, plain = false, beforeEl = null) {
  emptyState.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}`;

  const textEl = document.createElement("div");
  textEl.className = "bubble-text";

  // The user's own typed messages don't need a copy button - they're
  // already sitting in the input the user just typed them into. Only
  // non-user content (assistant replies, error notices) gets one, in a
  // header row above the text rather than below it. This lives in
  // .bubble-header, a sibling of .bubble-text rather than a child of it,
  // specifically so setBubbleContent reassigning bubble-text's
  // innerHTML/textContent on every streamed chunk (see above) never
  // touches or removes it - it's added exactly once, here.
  if (role !== "user") {
    const header = document.createElement("div");
    header.className = "bubble-header";
    if (role === "assistant" && modelLabel) {
      const tag = document.createElement("div");
      tag.className = "model-tag";
      tag.textContent = modelLabel;
      header.appendChild(tag);
    }
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = t(currentLang, "copyMessage_button");
    copyBtn.title = t(currentLang, "copyMessage_title");
    copyBtn.setAttribute("aria-label", t(currentLang, "copyMessage_title"));
    copyBtn.addEventListener("click", async () => {
      // Read live at click time (innerText, not a cached string) so this is
      // correct whether the message is complete or still streaming in.
      const ok = await copyTextToClipboard(textEl.innerText);
      if (ok) showCopyFeedback(copyBtn, t(currentLang, "copyMessage_copiedFeedback"));
    });
    header.appendChild(copyBtn);
    wrap.appendChild(header);
  }

  wrap.appendChild(textEl);
  setBubbleContent(wrap, text, role, plain);

  if (beforeEl && beforeEl.parentNode === chatLog) chatLog.insertBefore(wrap, beforeEl);
  else chatLog.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function getBubbleTextEl(bubbleEl) {
  return bubbleEl.querySelector(".bubble-text");
}

function populateModelSelect() {
  modelSelect.innerHTML = "";
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
}

async function restoreSelectedModel() {
  const { selectedModelId } = await chrome.storage.local.get("selectedModelId");
  const resolvedModelId = resolveModelId(selectedModelId);
  if (resolvedModelId) {
    modelSelect.value = resolvedModelId;
    // Persist the canonical ID once so future requests are not dependent on
    // legacy aliases.
    if (resolvedModelId !== selectedModelId) {
      await chrome.storage.local.set({ selectedModelId: resolvedModelId });
    }
  }
}

modelSelect.addEventListener("change", () => {
  chrome.storage.local.set({ selectedModelId: modelSelect.value }).catch(() => {});
});

function getSelectedModel() {
  return findModelById(modelSelect.value);
}

// Finds which model actually answered a conversation, searching from the
// most recent message backward so a conversation where the user switched
// models mid-way restores the latest one used. Only assistant turns carry
// model info. Messages saved before per-message modelId tracking only have
// a modelLabel string, so those are matched by label against the current
// MODELS list as a fallback; if neither matches anything in the current
// list (e.g. a model was removed from models.js since), null is returned
// and the model dropdown is left untouched.
function findConversationModelId(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const knownId = findKnownModel(m.modelId)?.id;
    if (knownId) return knownId;
    const byLabelId = findModelIdByLabel(m.modelLabel);
    if (byLabelId) return byLabelId;
  }
  return null;
}

// Syncs the model dropdown (and the globally-remembered last-used model) to
// match a conversation that was just loaded. No-ops on an unknown/missing
// id so loading a conversation with no recoverable model info leaves
// whatever was already selected in place instead of resetting it.
function applyModelSelection(modelId) {
  if (!modelId || !MODELS.some((m) => m.id === modelId) || modelSelect.value === modelId) return;
  modelSelect.value = modelId;
  chrome.storage.local.set({ selectedModelId: modelId }).catch(() => {});
}

// ---------- Open settings page ----------
optionsBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (err) {
    console.error("[AI Assistant] Unable to open settings page:", err);
    // Fallback for browsers/versions that do not implement openOptionsPage.
    await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
  }
});

// ---------- Streaming message handling ----------
function setStreaming(streaming) {
  isStreaming = streaming;
  sendBtn.disabled = streaming;
  questionInput.disabled = streaming;
  quickActionButtons.forEach((button) => { button.disabled = streaming; });
  modelSelect.disabled = streaming;
  uploadBtn.disabled = streaming;
  if (SpeechRecognitionCtor) {
    micBtn.disabled = streaming;
    micLangBtn.disabled = streaming;
  }
  if (streaming && isListening) {
    userStoppedMic = true;
    stopMic();
  }
  // A disabled textarea loses focus; give it back when the request finishes so
  // the user can keep typing without clicking into the box.
  if (!streaming && document.hasFocus() && !document.activeElement?.matches?.("select, input, textarea, button")) {
    questionInput.focus();
  }
}

// Escapes a hung or unwanted in-flight request: tells background.js to
// abort the underlying fetch (best-effort - see the STOP handling in
// background.js), then immediately resets this side's UI regardless of
// whether that abort actually lands in time, since the request being
// unresponsive is exactly the situation this exists to recover from.
// Called from the "Clear" button and from picking anything in the history
// dropdown (including "New Topic") while isStreaming is true, so neither of
// those - previously the only two ways to leave a conversation - stayed
// blocked for the whole duration of a request that never completes.
function stopActiveRequest() {
  if (!isStreaming) return;
  const stoppedRequestId = currentRequestId;
  // Cleared before anything else so handlePortMessage ignores any
  // START/CHUNK/DONE/ERROR that might still arrive for this request (e.g.
  // a chunk already queued on the port before the abort signal reaches the
  // fetch on the other end).
  currentRequestId = null;
  if (port) {
    try {
      port.postMessage({ type: "STOP", requestId: stoppedRequestId });
    } catch {}
  }
  if (currentAssistantBubble) {
    currentAssistantBubble.remove();
    currentAssistantBubble = null;
  }
  currentAssistantText = "";
  autoScrollEnabled = false;
  setStreaming(false);
}

// MAX_PAGE_CONTEXT_CHARS (imported from models.js, shared with background.js)
// must stay equal to content.js's PAGE_CONTEXT_CHAR_LIMIT, so the panel never
// reintroduces a smaller truncation after the content script has already
// captured the full readable page. scripts/check-package.mjs enforces this.
const MAX_AUTO_PAGE_IMAGE_URLS = 8;
const PAGE_SCREENSHOT_MAX_DIMENSION = 1600;
const PAGE_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

// The id of the browser window that owns THIS side panel document. There is
// one panel per window, so every page read (text, screenshot, image pageUrl)
// must come from this window's active tab - never from whichever window
// happens to have focus when the request is submitted. Otherwise, with panels
// open in windows A and B, submitting from A while B is focused would read,
// display, screenshot and send B's page to the provider (a correctness and a
// privacy bug).
//
// Resolved once and then cached. A failed lookup is NOT cached, so a transient
// error cannot permanently downgrade this panel to the focused-window fallback;
// the next call simply tries again. The in-flight promise is shared so that
// concurrent callers (init, tab listeners, a submit) trigger a single lookup.
let panelWindowId = null;
let panelWindowIdLookup = null;

function getPanelWindowId() {
  if (panelWindowId !== null) return Promise.resolve(panelWindowId);
  if (!panelWindowIdLookup) {
    panelWindowIdLookup = (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        if (Number.isInteger(win?.id) && win.id !== chrome.windows.WINDOW_ID_NONE) {
          panelWindowId = win.id;
        }
      } catch (err) {
        console.debug("[AI Assistant] Unable to resolve this panel's window:", err);
      }
      return panelWindowId;
    })().finally(() => {
      panelWindowIdLookup = null;
    });
  }
  return panelWindowIdLookup;
}

// True when a tab/window event belongs to this panel's window. When the
// panel's own window is unknown (lookup failed) every event is treated as
// relevant, which is the pre-existing behaviour.
async function isOwnWindowEvent(windowId) {
  const own = await getPanelWindowId();
  return own === null || windowId === own;
}

async function getCurrentActiveTab() {
  // A side panel can remain alive while the user changes tabs, so the tab is
  // never cached: it is re-queried each time, but always inside the panel's
  // own window.
  const ownWindowId = await getPanelWindowId();
  if (ownWindowId !== null) {
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId: ownWindowId });
      return tabs?.[0]?.id ? tabs[0] : null;
    } catch (err) {
      // Deliberately no fallback to another window here: a failure must never
      // turn into reading a different window's page.
      console.debug("[AI Assistant] Unable to query this window's active tab:", err);
      return null;
    }
  }
  // The panel's own window could not be determined. Deliberately NO
  // cross-window fallback: guessing "the focused window" could read, display
  // and send a DIFFERENT window's page - with panels open in two windows and
  // this one unfocused, that was the wrong page every time. Reading nothing
  // is safe; the lookup is retried on the next call (failures are not
  // cached), and the next submission then sees the right window again.
  console.debug("[AI Assistant] This panel's window is unknown; not reading any page.");
  return null;
}

async function getActivePageContext(retryCount = 0, format = null) {
  const tab = await getCurrentActiveTab();
  if (!tab?.id) return null;
  const initialTabId = tab.id;
  const initialUrl = String(tab.url || "");

  const hasExtractedPageContent = (data) => Boolean(
    data?.text?.trim() ||
    (Array.isArray(data?.imageUrls) && data.imageUrls.some((url) => typeof url === "string" && /^https?:\/\//i.test(url)))
  );

  const makeContext = (data) => {
    const text = String(data?.text || "").trim();
    const imageUrls = Array.isArray(data?.imageUrls)
      ? [...new Set(data.imageUrls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)))].slice(0, MAX_AUTO_PAGE_IMAGE_URLS)
      : [];
    if (!text && !imageUrls.length) return null;
    return {
      tabId: initialTabId,
      title: String(data?.title || tab.title || ""),
      url: String(data?.url || initialUrl || ""),
      text: text.slice(0, MAX_PAGE_CONTEXT_CHARS),
      // "markdown" when the structure-preserving extractor produced the text.
      format: data?.format === "markdown" ? "markdown" : "text",
      source: String(data?.source || ""),
      imageUrls,
      // The extractor cut the page text at its size limit (see content.js).
      truncated: data?.truncated === true,
    };
  };

  // The content script answers from an idle slot; a HIDDEN tab defers that
  // (the content script's timer fallback bounds it, but a frozen renderer
  // suspends timers entirely). Never wait forever: on timeout the capture
  // simply failed, the caller's captureFailed sentinel tells the model the
  // page could not be read, and the composer is never left stuck.
  const EXTRACTOR_TIMEOUT_MS = 10000;
  const askExtractor = () => new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), EXTRACTOR_TIMEOUT_MS);
    // frameId: 0 - the TOP frame only. chrome.tabs.sendMessage without a
    // frame option delivers to every frame that has a listener, and the first
    // sendResponse wins. After a context-menu translation inside an iframe
    // (readSelectionMarkdown in background.js injects content.js into that
    // frame), two frames were listening: the iframe's (usually empty)
    // extraction could answer first, making every later page read of that
    // tab fail its hasExtractedPageContent check and end as "capture failed".
    chrome.tabs.sendMessage(initialTabId, { type: "EXTRACT_PAGE_CONTENT", format }, { frameId: 0 }, (value) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { settle(null); return; }
      settle(value || null);
    });
  });

  const extractOnce = async () => {
    let response = await askExtractor();
    if (!(response?.ok && hasExtractedPageContent(response.data))) {
      // No reachable content script (or it found neither readable text nor a
      // usable image). Re-inject content.js and ask once more - content.js is
      // written to be safely re-injectable, see its file-header note.
      if (!/^https?:\/\//i.test(initialUrl)) return null;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: initialTabId },
          files: ["content.js"],
        });
      } catch (err) {
        console.debug("[AI Assistant] Unable to inject page extractor:", err);
        return null;
      }
      response = await askExtractor();
    }
    return response?.ok && hasExtractedPageContent(response.data) ? response.data : null;
  };

  try {
    const data = await extractOnce();
    if (data) {
      const currentTab = await getCurrentActiveTab();
      // Never return context captured from a page that is no longer the
      // active page. This prevents a slow content-script response from a
      // previous tab/navigation being attached to the next request.
      if (currentTab?.id !== initialTabId || String(currentTab.url || "") !== initialUrl) {
        return retryCount < 2 ? getActivePageContext(retryCount + 1, format) : null;
      }
      return makeContext(data);
    }
    // Empty or absent extraction on an http(s) page. The content script
    // registers at document_idle, and document.body (plus any app-rendered
    // text) may not exist yet, so a quick action fired right after opening
    // a page previously returned null here - and the model then answered
    // from stale conversation history (e.g. re-translating the PREVIOUS
    // article). While the document is still loading, wait briefly and
    // retry; a fully loaded page with no text is genuinely unreadable and
    // falls through immediately.
    let readyState = "";
    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId: initialTabId },
        func: () => document.readyState,
      });
      readyState = String(probe?.[0]?.result || "");
    } catch (err) {
      console.debug("[AI Assistant] Unable to probe page readiness:", err);
    }
    if (readyState && readyState !== "complete" && retryCount < 2) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return getActivePageContext(retryCount + 1, format);
    }
  } catch (err) {
    console.debug("[AI Assistant] Content script unavailable:", err);
  }
  return null;
}

async function fetchPageImages(imageUrls, pageUrl = "") {
  if (!Array.isArray(imageUrls) || !imageUrls.length) return [];
  try {
    const result = await chrome.runtime.sendMessage({ type: "FETCH_PAGE_IMAGES", urls: imageUrls, pageUrl });
    if (!result?.ok || !Array.isArray(result.images)) return [];
    return result.images.filter((img) => img && typeof img.dataUrl === "string" && /^data:image\/(jpeg|png|gif|webp);base64,/i.test(img.dataUrl));
  } catch (err) {
    console.debug("[AI Assistant] Unable to collect webpage images:", err);
    return [];
  }
}

function dataUrlByteLength(dataUrl) {
  const encoded = String(dataUrl || "").split(",", 2)[1] || "";
  return Math.floor((encoded.length * 3) / 4);
}

// URL-based extraction cannot cover CSS backgrounds, blob: URLs, or hosts
// that reject an extension-origin download. A bounded screenshot of the
// visible page gives quick actions a reliable visual input in those cases.
async function compressPageScreenshot(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) { resolve(null); return; }
        const scale = Math.min(1, PAGE_SCREENSHOT_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) { resolve(null); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.82, 0.7, 0.58]) {
          const compressed = canvas.toDataURL("image/jpeg", quality);
          if (dataUrlByteLength(compressed) <= PAGE_SCREENSHOT_MAX_BYTES) {
            resolve(compressed);
            return;
          }
        }
      } catch {
        // The original URL/image can fail to decode. Treat the screenshot as
        // optional so the user's requested operation still continues.
      }
      resolve(null);
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

async function captureVisiblePageScreenshot(expectedTabId, expectedUrl) {
  if (!expectedTabId || !expectedUrl) return null;
  try {
    const beforeCapture = await getCurrentActiveTab();
    if (beforeCapture?.id !== expectedTabId || String(beforeCapture?.url || "") !== expectedUrl) return null;
    const screenshot = await chrome.tabs.captureVisibleTab(beforeCapture.windowId, { format: "jpeg", quality: 82 });
    const afterCapture = await getCurrentActiveTab();
    if (afterCapture?.id !== expectedTabId || String(afterCapture?.url || "") !== expectedUrl) return null;
    const dataUrl = await compressPageScreenshot(screenshot);
    return dataUrl ? { name: "Current page viewport", dataUrl } : null;
  } catch (err) {
    console.debug("[AI Assistant] Unable to capture webpage screenshot:", err);
    return null;
  }
}
function updateContextBar(pageContext) {
  pageContextAllowBtn.hidden = true;
  if (!pageContext) {
    pageContextBar.hidden = true;
    return;
  }
  pageContextBar.hidden = false;
  const host = hostOf(pageContext.url);
  if (isBlockedSensitivePage(pageContext.url, pageContext.source)) {
    // Webmail / banking: make it unmistakable that nothing is sent.
    pageContextTitle.textContent = `🔒 ${t(currentLang, "contextBar_sensitiveBlocked_template", { host })}`;
    pageContextAllowBtn.textContent = t(currentLang, "contextBar_allowSensitive");
    pageContextAllowBtn.hidden = false;
    return;
  }
  pageContextTitle.textContent = `📄 ${t(currentLang, "contextBar_willSend_template", { title: pageContext.title || pageContext.url, host })}`;
}

// Shown when a request asked for page context but the capture failed. The
// bar used to be silently hidden in this case, which read as if the title
// the user had just seen (from the tab-info display) had been lost; keeping
// it visible with an explicit warning makes the outcome unambiguous.
function updateContextBarUnavailable() {
  pageContextBar.hidden = false;
  pageContextTitle.textContent = `⚠️ ${t(currentLang, "contextBar_captureFailed")}`;
}

// ---------- Streaming render coalescing ----------
// A long reply arrives as hundreds of CHUNK messages, and each one used to
// re-run the full Markdown render + sanitize over the ENTIRE accumulated
// text (O(n^2) work overall; see setBubbleContent). Renders are now
// coalesced: while streaming, at most one repaint every
// STREAM_RENDER_MIN_INTERVAL_MS, requested from requestAnimationFrame so it
// lands just before a paint. Every terminal path (DONE, ERROR, worker
// recycle, STOP) flushes synchronously via flushStreamingRender(), so the
// tail of a reply is never left unrendered.
const STREAM_RENDER_MIN_INTERVAL_MS = 100;
let streamRenderQueued = false;
let streamRenderTimer = null;
let streamRenderLastAt = 0;

// Repaint the streaming bubble from currentAssistantText right now, dropping
// any pending coalesced render. Also a clean no-op once the bubble is gone
// (STOP, or a superseded request): the queued flags are cleared first, so a
// late rAF/timer callback can never resurrect a render or touch a newer
// request's bubble with stale content.
function renderStreamingBubble() {
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }
  streamRenderQueued = false;
  streamRenderLastAt = performance.now();
  if (!currentAssistantBubble) return;
  setBubbleContent(currentAssistantBubble, currentAssistantText, "assistant", pendingPlainReply);
  scrollToBottom();
}

function scheduleStreamingRender() {
  if (!currentAssistantBubble || streamRenderQueued) return;
  streamRenderQueued = true;
  const run = () => {
    const wait = STREAM_RENDER_MIN_INTERVAL_MS - (performance.now() - streamRenderLastAt);
    if (wait <= 0) {
      renderStreamingBubble();
      return;
    }
    // Still inside the interval since the last repaint: hold the render until
    // it expires. setTimeout (not another rAF) so a hidden document, where
    // rAF is suspended, cannot delay the backstop forever.
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = null;
      renderStreamingBubble();
    }, wait);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}

// Terminal repaint used by DONE / ERROR / the worker-recycle recovery in
// connectPort(): synchronous, so the coalescer can never swallow the end of
// a reply.
function flushStreamingRender() {
  renderStreamingBubble();
}

function handlePortMessage(msg) {
  // Ignore anything that isn't for the request this side is currently
  // tracking - either a stray message for a request already stopped via
  // stopActiveRequest() (see the clearBtn/history-dropdown handlers below),
  // or, in principle, a message that arrived after a newer ASK was already
  // sent on the same port.
  if (msg.requestId !== currentRequestId) return;
  switch (msg.type) {
    case "START": {
      currentAssistantText = "";
      currentAssistantBubble = addBubble("assistant", "", pendingModelLabel, pendingPlainReply);
      currentAssistantBubble.classList.add("pending");
      break;
    }
    case "CHUNK": {
      currentAssistantText += msg.delta;
      scheduleStreamingRender();
      break;
    }
    case "DONE": {
      flushStreamingRender();
      if (!currentAssistantText.trim()) {
        // Defensive: background.js reports an empty reply as an ERROR, but never
        // store an empty assistant turn - providers reject empty assistant
        // messages, which would break every later request in this conversation.
        currentAssistantBubble?.remove();
        currentAssistantBubble = null;
        currentAssistantText = "";
        autoScrollEnabled = false;
        setStreaming(false);
        break;
      }
      if (currentAssistantBubble) {
        currentAssistantBubble.classList.remove("pending");
      }
      history.push({ role: "assistant", content: currentAssistantText, displayContent: currentAssistantText, modelLabel: pendingModelLabel, modelId: pendingModelId, plain: pendingPlainReply });
      currentAssistantBubble = null;
      autoScrollEnabled = false;
      setStreaming(false);
      saveConversations().catch((err) => console.error("[AI Assistant] Unable to save conversation:", err));
      break;
    }
    case "NOTICE": {
      // Non-fatal note from the worker (e.g. the page text was shortened).
      // While a reply is streaming in, insert BEFORE the streaming bubble so
      // the reading order stays user message -> notice -> answer; appending
      // put the notice after the (still growing) reply it belongs to.
      if (msg.text) addBubble("notice", msg.text, null, false, currentAssistantBubble);
      break;
    }
    case "ERROR": {
      flushStreamingRender();
      // A mid-stream failure (e.g. OpenRouter's in-stream {"error":...}) can
      // arrive after visible text has already streamed in. Keep that partial
      // reply as a finished assistant turn - exactly what the worker-recycle
      // recovery in connectPort()'s onDisconnect does - instead of deleting
      // text the user was watching arrive. (The user turn is already in
      // history; background.js folds an unanswered user turn into the next
      // request, so this shape is expected there.)
      if (currentAssistantBubble) {
        if (currentAssistantText.trim()) currentAssistantBubble.classList.remove("pending");
        else currentAssistantBubble.remove();
        currentAssistantBubble = null;
      }
      if (currentAssistantText.trim()) {
        history.push({
          role: "assistant",
          content: currentAssistantText,
          displayContent: currentAssistantText,
          modelLabel: pendingModelLabel,
          modelId: pendingModelId,
          plain: pendingPlainReply,
        });
        saveConversations().catch((err) => console.error("[AI Assistant] Unable to save conversation:", err));
      }
      currentAssistantText = "";
      autoScrollEnabled = false;
      addBubble("error", t(currentLang, "error_withMessage_template", { message: msg.error }));
      setStreaming(false);
      break;
    }
  }
}

function getApiHistory() {
  return history.slice(-(MAX_HISTORY_TURNS * 2));
}

function createConversation() {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    title: "",
    messages: [],
    updatedAt: Date.now(),
  };
}


function currentConversation() {
  return conversations.find((c) => c.id === currentConversationId) || null;
}

function syncCurrentConversationFromHistory() {
  let convo = currentConversation();
  if (!convo && currentConversationId) {
    convo = { id: currentConversationId, title: "", messages: [], updatedAt: Date.now() };
    conversations.unshift(convo);
    conversations = conversations.slice(0, MAX_SAVED_CONVERSATIONS);
  }
  if (!convo) return;
  convo.messages = history.map(toStoredMessage);
  if (!convo.title) convo.title = makeTopicTitle(convo.messages, t(currentLang, "historySelect_newTopic"));
  convo.updatedAt = Date.now();
}

// Two side panels (two windows) share one chrome.storage.local history key.
// Writing this panel's whole in-memory array would let a stale copy silently
// delete the other panel's conversations (this panel's onChanged handler
// returns early while it streams, so it never sees the other panel's saves).
// So every save (1) runs one at a time through a promise queue, (2) re-reads
// storage and merges by conversation id, and (3) only then trims and writes.
let saveQueue = Promise.resolve();

function saveConversations() {
  const run = saveConversationsNow();
  // Keep the queue alive after a failed save; the caller still sees the error.
  saveQueue = run.catch(() => {});
  return run;
}


async function saveConversationsNow() {
  await saveQueue;
  const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
  // Snapshot the live history only after the read, so the freshest copy of
  // the current conversation is what gets merged and written.
  syncCurrentConversationFromHistory();
  let merged = sortedByNewest(
    mergeConversationLists(stored[HISTORY_STORAGE_KEY], conversations, currentConversationId)
  ).slice(0, MAX_SAVED_CONVERSATIONS);
  // Storage-quota escalation, most gentle first: (1) write as-is, (2) shrink
  // attachment previews and drop display-only copies (every conversation
  // kept), (3) only then drop the OLDEST conversations - half per attempt -
  // and tell the user how many were lost instead of dropping them silently.
  let quotaDropped = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.storage.local.set({
        [HISTORY_STORAGE_KEY]: merged,
        [CURRENT_CONVERSATION_KEY]: currentConversationId || "",
      });
      break;
    } catch (err) {
      if (attempt === 0) {
        merged = compressForQuota(merged);
        continue;
      }
      if (attempt >= 4 || merged.length <= 1) throw err;
      const kept = Math.max(1, Math.floor(merged.length / 2));
      quotaDropped += merged.length - kept;
      merged = merged.slice(0, kept);
    }
  }
  conversations = merged;
  renderHistorySelect();
  scheduleHistoryRender();
  if (quotaDropped > 0) {
    addBubble("notice", t(currentLang, "history_quotaDropped_template", { count: String(quotaDropped) }));
  }
}

let historyRenderQueued = false;

function renderHistorySelect() {
  if (!historySelect || !document.documentElement.isConnected) return;
  const previous = historySelect.value;
  historySelect.innerHTML = "";
  const newOpt = document.createElement("option");
  newOpt.value = NEW_TOPIC_VALUE;
  newOpt.textContent = t(currentLang, "historySelect_newTopic");
  historySelect.appendChild(newOpt);

  const items = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const convo of items) {
    if (!convo.messages?.length) continue;
    const opt = document.createElement("option");
    opt.value = convo.id;
    opt.textContent = convo.title || makeTopicTitle(convo.messages, t(currentLang, "historySelect_newTopic")) || t(currentLang, "untitledConversation");
    historySelect.appendChild(opt);
  }
  if (currentConversationId && items.some((c) => c.id === currentConversationId && c.messages?.length)) {
    historySelect.value = currentConversationId;
  } else if (previous && [...historySelect.options].some((o) => o.value === previous)) {
    historySelect.value = previous;
  } else {
    historySelect.value = NEW_TOPIC_VALUE;
  }
}

// Side-panel controls can be laid out before asynchronous storage/model
// initialization has completed. Queue one render after the browser has had a
// chance to finish layout/paint; this prevents the history selector from
// occasionally remaining visually empty until the panel is reopened.
function scheduleHistoryRender() {
  if (historyRenderQueued) return;
  historyRenderQueued = true;
  const run = () => {
    historyRenderQueued = false;
    renderHistorySelect();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}


function renderConversation(messages) {
  chatLog.innerHTML = "";
  if (!messages.length) {
    chatLog.appendChild(emptyState);
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    addBubble(message.role, message.displayContent || message.content, message.role === "assistant" ? message.modelLabel : undefined, message.role === "assistant" && message.plain === true);
  }
  // Force-scroll: opening a past conversation must show its LATEST messages.
  // autoScrollEnabled is false outside an active stream (it is only set on
  // submit), so the plain scrollToBottom() call here was a no-op and every
  // restored conversation opened scrolled to the very top.
  scrollToBottom(true);
}

function startNewTopic() {
  history = [];
  attachments = [];
  currentConversationId = null;
  renderAttachments();
  renderConversation([]);
  questionInput.value = "";
  historySelect.value = NEW_TOPIC_VALUE;
  chrome.storage.local.set({ [CURRENT_CONVERSATION_KEY]: "" }).catch(() => {});
  refreshContextBarAfterConversationSwitch();
}

async function loadConversations({ activate = true, syncModel = true } = {}) {
  const stored = await chrome.storage.local.get([HISTORY_STORAGE_KEY, CURRENT_CONVERSATION_KEY]);
  conversations = Array.isArray(stored[HISTORY_STORAGE_KEY]) ? stored[HISTORY_STORAGE_KEY] : [];
  // Keep at most MAX_SAVED_CONVERSATIONS saved conversations. Conversations are
  // ordered newest-first whenever they are saved, so entries beyond the limit
  // are the oldest ones.
  conversations = conversations
    .filter((c) => c && c.messages?.length)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SAVED_CONVERSATIONS);

  if (activate) {
    currentConversationId = stored[CURRENT_CONVERSATION_KEY] || null;
    if (currentConversationId) {
      const convo = conversations.find((c) => c.id === currentConversationId);
      if (convo?.messages?.length) {
        history = convo.messages.map((m) => ({ ...m }));
        renderConversation(history);
        if (syncModel) applyModelSelection(findConversationModelId(history));
        renderHistorySelect();
        historySelect.value = currentConversationId;
        return;
      }
    }
  }
  renderHistorySelect();
  scheduleHistoryRender();
}

async function selectConversation(id) {
  if (id === NEW_TOPIC_VALUE) {
    // Picking "New Topic" while a request is in flight stops it rather than
    // being blocked (see stopActiveRequest) - this, and "Clear" below, are
    // the user's way out of a hung/unresponsive request.
    stopActiveRequest();

    // New Topic is a fresh conversation (whichever provider the selected
    // model uses): discard the active conversation state, clear the composer,
    // and leave the API ready for the user's first message. The new conversation is persisted only when that
    // first message is actually sent.
    startNewTopic();
    renderHistorySelect();
    questionInput.focus();
    return;
  }
  const convo = conversations.find((c) => c.id === id);
  if (!convo) return;
  // Same reasoning as the New Topic branch above: switching to a different
  // past conversation while a request is in flight stops it instead of
  // being blocked, for consistency (there's no good reason New Topic would
  // escape a hang but switching to an older conversation wouldn't).
  stopActiveRequest();
  currentConversationId = convo.id;
  history = (convo.messages || []).map((m) => ({ ...m }));
  attachments = [];
  renderAttachments();
  questionInput.value = "";
  renderConversation(history);
  applyModelSelection(findConversationModelId(history));
  await chrome.storage.local.set({ [CURRENT_CONVERSATION_KEY]: currentConversationId });
  renderHistorySelect();
  refreshContextBarAfterConversationSwitch();
}

// Switching or starting a conversation used to leave the context bar showing
// state from the PREVIOUS conversation's request (the capture-failed warning,
// or a sensitive-site bar with its session-allow button). Re-derive it from
// the tab the user is on now, exactly like the include-context toggle's own
// change handler does.
function refreshContextBarAfterConversationSwitch() {
  if (includeContextToggle.checked) {
    refreshActivePageContext().catch(() => {});
  } else {
    updateContextBar(null);
  }
}

function attachmentContextText() {
  const usable = attachments.filter((a) => a.status === "ready");
  if (!usable.length) return "";
  const textParts = [];
  const imageParts = [];
  for (const a of usable) {
    if (a.kind === "image") {
      imageParts.push(`- ${a.name} (image attachment; image data is included in the current request)`);
    } else if (a.text) {
      textParts.push(`\n===== FILE: ${a.name} =====\n${a.text}`);
    }
  }
  return [
    "\n\n[ATTACHMENTS]",
    imageParts.length ? `Images attached (image data sent with this request):\n${imageParts.join("\n")}` : "",
    textParts.length ? `Text-based attachment contents:${textParts.join("\n")}` : "",
    "[/ATTACHMENTS]"
  ].filter(Boolean).join("\n");
}

function fileExtension(name) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /^image\//.test(file.type);
}

function isZipFile(file) {
  return file.type === "application/zip" || file.type === "application/x-zip-compressed" || /\.(zip|winzip)$/i.test(file.name);
}

function isTextFile(file) {
  const ext = fileExtension(file.name);
  return file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext);
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Decodes the bytes of a text attachment. UTF-8 comes first; U+FFFD in the
// result usually means the bytes are not valid UTF-8, which for Chinese users is
// almost always a GBK/GB18030 file (the default of Windows Notepad and of Excel's CSV
// export), so the bytes are decoded again as GB18030 (a superset of GBK).
// Two guards keep UTF-8 files from being "fixed" by mistake: bytes that ARE
// valid UTF-8 keep that reading even if they contain a real U+FFFD character,
// and the GB18030 reading is used only if it decodes the whole file without an
// error. Anything else keeps the old lenient UTF-8 result.
function decodeTextBytes(bytes) {
  const utf8 = decodeUtf8(bytes);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return utf8;
  } catch { /* not valid UTF-8 */ }
  try {
    const gb = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    // GB18030 accepts almost any byte sequence, so a green decode alone does
    // not mean the file is Chinese text: random binary also "decodes", into
    // mojibake. Require the result to plausibly be CJK text - a solid share
    // of ordinary (BMP) CJK characters among the non-ASCII ones, at least a
    // few of them (a single short line like 中文测试第一行 has 7), and almost
    // no control characters. Otherwise keep the lenient UTF-8 reading, which
    // shows the damage as U+FFFD instead of handing the model pages of
    // mojibake.
    let cjk = 0;
    let nonAscii = 0;
    let control = 0;
    for (const ch of gb) {
      const code = ch.codePointAt(0);
      if (code < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t") control++;
      else if (code >= 0x80) {
        nonAscii++;
        if (code >= 0x3400 && code <= 0x9fff) cjk++;
      }
    }
    const total = Math.max(gb.length, 1);
    const plausible = cjk >= 4 && cjk / Math.max(nonAscii, 1) >= 0.5 && control / total <= 0.01;
    return plausible ? gb : utf8;
  } catch { /* not valid GB18030 either (or the decoder is unavailable) */ }
  return utf8;
}

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(t(currentLang, "sp_zip_error_decompressionUnsupported"));
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  // Read incrementally and stop at a hard cap: the uncompressed size declared
  // in a ZIP header is attacker-controlled, so a small "zip bomb" could
  // otherwise expand to gigabytes in memory.
  const limit = MAX_ZIP_ENTRY_BYTES;
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

// What extractZipText() leaves out is reported to the user, never dropped
// silently. For each category of left-out text files the report keeps the count
// and only the first few names, so a ZIP with thousands of entries cannot bloat
// the tooltip or the note sent to the model.
const ZIP_REPORT_MAX_NAMES = 10;

function newZipBucket() {
  return { count: 0, names: [] };
}

function addToZipBucket(bucket, name) {
  bucket.count++;
  // One bounded line: the name ends up in a tooltip and in the model note.
  if (bucket.names.length < ZIP_REPORT_MAX_NAMES) {
    bucket.names.push(String(name).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 120));
  }
}

// Why a text entry is skipped by the ignore list ("" = keep it). The label is
// shown to the user as it is, so it is language-neutral: a folder name, a glob
// or a file name.
function zipIgnoreReason(name) {
  const parts = name.replace(/\\/g, "/").split("/");
  const base = parts.pop();
  const dir = parts.find((part) => ZIP_IGNORED_DIRS.has(part.toLowerCase()));
  if (dir) return `${dir}/`;
  // Minified bundles are one huge line each; lock files are machine-generated.
  const minified = base.match(/\.min\.(js|mjs|cjs|css)$/i);
  if (minified) return `*.min.${minified[1].toLowerCase()}`;
  if (/\.lock$|-lock\.(?:json|ya?ml)$|^(?:npm-shrinkwrap\.json|go\.sum)$/i.test(base)) return base;
  return "";
}

// Returns { text, report }: the text of the entries that were read, and what was
// left out of it (see describeZipReport).
async function extractZipText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (i >= 0 && readU32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(t(currentLang, "sp_zip_error_invalidFile"));

  const entryCount = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  // A ZIP64 archive writes 0xFFFF / 0xFFFFFFFF into each of these fields whose real
  // value does not fit, and keeps it in a ZIP64 record that this reader does not
  // parse. Say so here: left to the range check below, a saturated offset or size is
  // reported as an "invalid central directory" (misleading), and a saturated entry
  // count would silently read only the first 65,535 entries.
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error(t(currentLang, "sp_zip_error_zip64Unsupported"));
  }
  if (centralOffset + centralSize > bytes.length) throw new Error(t(currentLang, "sp_zip_error_invalidCentralDir"));

  let offset = centralOffset;
  let totalChars = 0;
  const parts = [];
  let entriesRead = 0;
  // Text entries read so far, and whether more may still be read. Once the entry
  // or the character limit is hit the loop keeps walking the directory only to
  // count and name the text files that are left out.
  let textEntriesRead = 0;
  let limitReached = false;
  const report = {
    truncated: newZipBucket(),
    overLimit: newZipBucket(),
    tooLarge: newZipBucket(),
    unreadable: newZipBucket(),
    ignored: newZipBucket(),
    ignoredReasons: new Set() // which rules matched (node_modules/ ...), not file names
  };

  while (offset + 46 <= bytes.length && entriesRead < entryCount) {
    if (readU32(view, offset) !== 0x02014b50) break;
    const flags = readU16(view, offset + 8);
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const uncompressedSize = readU32(view, offset + 24);
    const nameLen = readU16(view, offset + 28);
    const extraLen = readU16(view, offset + 30);
    const commentLen = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
    const name = decodeUtf8(nameBytes);
    offset += 46 + nameLen + extraLen + commentLen;
    entriesRead++;

    if (!name || name.endsWith("/")) continue;
    const lowerName = name.toLowerCase();
    const ext = fileExtension(name);
    const looksText = TEXT_EXTENSIONS.has(ext) || lowerName.endsWith(".html") || lowerName.endsWith(".htm");
    // Images, binaries and the like are not text entries: not counted, not reported.
    if (!looksText) continue;
    const ignoreReason = zipIgnoreReason(name);
    if (ignoreReason) {
      addToZipBucket(report.ignored, name);
      report.ignoredReasons.add(ignoreReason);
      continue;
    }
    // From here on the entry is a text file the user may want, so whenever it is
    // not read in full below it ends up in the report.
    if (limitReached) { addToZipBucket(report.overLimit, name); continue; }
    // The general-purpose bit 0 marks the entry as password-encrypted, which
    // this reader cannot decrypt - inflating it would yield garbage bytes
    // that decode to mojibake rather than real text. Fail with a clear
    // message instead.
    if (flags & 1) throw new Error(t(currentLang, "sp_zip_error_encrypted"));
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) { addToZipBucket(report.tooLarge, name); continue; }
    if (localOffset + 30 > bytes.length || readU32(view, localOffset) !== 0x04034b50) { addToZipBucket(report.unreadable, name); continue; }

    const localNameLen = readU16(view, localOffset + 26);
    const localExtraLen = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    // Only "stored" (0) and "deflate" (8) entries can be read.
    if (dataEnd > bytes.length || (method !== 0 && method !== 8)) { addToZipBucket(report.unreadable, name); continue; }

    textEntriesRead++;
    if (textEntriesRead >= MAX_ZIP_ENTRIES) limitReached = true; // the last entry that gets read
    const compressed = bytes.slice(dataStart, dataEnd);
    let content;
    try {
      content = method === 0 ? compressed : await inflateRaw(compressed);
    } catch (err) {
      // No DecompressionStream at all is a limit of the browser, not damage to this
      // entry: that still fails the attachment, with its own message.
      if (typeof DecompressionStream === "undefined") throw err;
      // Damaged Deflate data makes the stream throw. Only this entry is lost: report
      // it as unreadable and go on with the rest of the archive.
      addToZipBucket(report.unreadable, name);
      continue;
    }
    if (!content) { addToZipBucket(report.tooLarge, name); continue; } // grew past the size cap while inflating

    const text = decodeTextBytes(content);
    if (!text.trim()) continue;
    // totalChars is below the budget here: limitReached is set the moment it is used up.
    const remain = MAX_TOTAL_EXTRACTED_CHARS - totalChars;
    const kept = text.length > remain ? text.slice(0, remain) : text;
    if (kept.length < text.length) addToZipBucket(report.truncated, name);
    parts.push(`\n===== ZIP ENTRY: ${name} =====\n${kept}`);
    totalChars += kept.length;
    if (totalChars >= MAX_TOTAL_EXTRACTED_CHARS) limitReached = true;
  }

  return { text: parts.join("\n"), report };
}

// Describes what extractZipText() left out, as `items` (one line for the
// attachment chip), `detail` (the tooltip, with file names) and `forModel` (an
// English note that goes first in the attachment text, so the model does not
// mistake a partial ZIP for the whole archive). Returns null if nothing was left out.
function describeZipReport(report) {
  const kb = Math.round(MAX_ZIP_ENTRY_BYTES / 1000);
  // `list` is what is shown (file names), `more` how many are not shown.
  const fromBucket = (key, model, bucket) => ({ label: t(currentLang, key), model, count: bucket.count, list: bucket.names, more: bucket.count - bucket.names.length });
  const rules = [...report.ignoredReasons];
  const rows = [
    fromBucket("attachment_note_truncated", "cut at the character limit", report.truncated),
    fromBucket("attachment_note_overLimit", "not read, file or character limit reached", report.overLimit),
    fromBucket("attachment_note_tooLarge", `too large, over ${kb} KB`, report.tooLarge),
    fromBucket("attachment_note_unreadable", "unreadable", report.unreadable),
    // For ignored files the list holds the rules that matched, not every file name.
    { label: t(currentLang, "attachment_note_ignored"), model: "ignored by rule", count: report.ignored.count, list: rules.slice(0, ZIP_REPORT_MAX_NAMES), more: Math.max(0, rules.length - ZIP_REPORT_MAX_NAMES), rules: true }
  ].filter((row) => row.count > 0);
  if (!rows.length) return null;

  const listed = (row) => `${row.list.join(", ")}${row.more > 0 ? ` … +${row.more}` : ""}`;
  return {
    items: rows.map((row) => `${row.label} ${row.count}${row.rules ? ` (${listed(row)})` : ""}`).join(" · "),
    detail: [
      ...rows.map((row) => `${row.label}: ${listed(row)}`),
      "",
      t(currentLang, "attachment_note_limits_template", { entries: MAX_ZIP_ENTRIES, chars: MAX_TOTAL_EXTRACTED_CHARS, kb })
    ].join("\n"),
    forModel: `\n===== ZIP NOTE =====\nNot every file of this ZIP is included below. Left out - ${rows.map((row) => `${row.model}: ${row.count} (${listed(row)})`).join("; ")}.`
  };
}

// The same three texts for a plain text file that was cut at the character limit.
function describeTextTruncation(totalChars) {
  const kept = MAX_TOTAL_EXTRACTED_CHARS;
  return {
    items: t(currentLang, "attachment_note_truncatedChars_template", { kept, total: totalChars }),
    detail: "",
    forModel: `[NOTE: this file is cut after the first ${kept} of ${totalChars} characters.]`
  };
}

function setAttachmentStatus(item, status, message = "") {
  item.status = status;
  const state = item.el?.querySelector(".attachment-state");
  if (state) {
    state.textContent = message || (status === "ready" ? t(currentLang, "attachment_ready") : status === "reading" ? t(currentLang, "attachment_reading") : t(currentLang, "attachment_error"));
    state.classList.toggle("error", status === "error");
  }
}

// A second line on the attachment chip telling the user what was left out of a
// ZIP or cut from a long text file. `note` is the raw data ({ report } or
// { totalChars }), not text, so renderAttachments() can build it again in the
// current language when the interface language changes.
function buildAttachmentNote(note) {
  const text = note.report ? describeZipReport(note.report) : describeTextTruncation(note.totalChars);
  const el = document.createElement("div");
  el.className = "attachment-note";
  el.textContent = `⚠️ ${t(currentLang, "attachment_note_heading")} — ${text.items}`;
  if (text.detail) el.title = text.detail;
  return el;
}

function setAttachmentNote(item, note) {
  item.note = note || null;
  if (!item.el) return;
  item.el.querySelector(".attachment-note")?.remove();
  item.el.classList.toggle("has-note", !!item.note);
  if (item.note) item.el.appendChild(buildAttachmentNote(item.note));
}

function renderAttachments() {
  attachmentList.innerHTML = "";
  attachmentList.hidden = attachments.length === 0;
  for (const item of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment";
    const icon = document.createElement("span");
    icon.textContent = item.kind === "image" ? "🖼️" : item.kind === "zip" ? "🗜️" : "📄";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = item.name;
    const state = document.createElement("span");
    state.className = "attachment-state";
    state.textContent = item.status === "ready" ? t(currentLang, "attachment_ready") : item.status === "reading" ? t(currentLang, "attachment_reading") : t(currentLang, "attachment_error");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.title = t(currentLang, "attachment_remove_title_template", { name: item.name });
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      attachments = attachments.filter((a) => a.id !== item.id);
      renderAttachments();
    });
    chip.append(icon, name, state, remove);
    if (item.note) {
      chip.classList.add("has-note");
      chip.appendChild(buildAttachmentNote(item.note));
    }
    item.el = chip;
    attachmentList.appendChild(chip);
  }
}

async function processFile(file) {
  const item = { id: `${Date.now()}-${Math.random()}`, name: file.name, status: "reading", kind: "file", text: "" };
  attachments.push(item);
  renderAttachments();
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(t(currentLang, "attachment_error_tooLarge"));
    if (isImageFile(file)) {
      if (!/^image\/(jpeg|png|gif|webp)$/i.test(file.type)) {
        throw new Error(t(currentLang, "attachment_error_unsupportedImage"));
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(t(currentLang, "attachment_error_unableToReadImage")));
        reader.readAsDataURL(file);
      });
      if (!dataUrl.startsWith("data:image/")) throw new Error(t(currentLang, "attachment_error_unableToEncodeImage"));
      item.kind = "image";
      item.text = "";
      item.dataUrl = dataUrl;
      setAttachmentStatus(item, "ready", t(currentLang, "attachment_ready"));
      return;
    }
    if (isTextFile(file)) {
      item.text = decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
      if (!item.text.trim()) throw new Error(t(currentLang, "attachment_error_emptyFile"));
      let cutFrom = 0;
      if (item.text.length > MAX_TOTAL_EXTRACTED_CHARS) {
        cutFrom = item.text.length;
        item.text = `${describeTextTruncation(cutFrom).forModel}\n${item.text.slice(0, MAX_TOTAL_EXTRACTED_CHARS)}`;
      }
      item.kind = "text";
      setAttachmentStatus(item, "ready", t(currentLang, "attachment_ready"));
      setAttachmentNote(item, cutFrom ? { totalChars: cutFrom } : null);
      return;
    }
    if (isZipFile(file)) {
      const { text, report } = await extractZipText(file);
      const note = describeZipReport(report);
      if (!text.trim()) {
        // Nothing was read. If text files were left out (ignored, too large ...) say so: "no text files" alone would be wrong.
        const reason = t(currentLang, "attachment_error_noZipText");
        throw new Error(note ? `${reason} — ${note.items}` : reason);
      }
      item.text = note ? `${note.forModel}\n${text}` : text;
      item.kind = "zip";
      setAttachmentStatus(item, "ready", t(currentLang, "attachment_ready"));
      setAttachmentNote(item, note ? { report } : null);
      return;
    }
    throw new Error(t(currentLang, "attachment_error_unsupportedType"));
  } catch (err) {
    setAttachmentStatus(item, "error", err?.message || t(currentLang, "attachment_error_unableToRead"));
  }
}

uploadBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  for (const file of files) await processFile(file);
});

// ---------- Voice input (speech-to-text) ----------
// Browser note: this uses the standard Web Speech API (SpeechRecognition).
// Chrome supports it out of the box. Brave has a long-standing, documented
// issue where its cloud speech backend returns a "network" error and its
// newer on-device recognizer can fail to install, so voice input may not
// work in Brave depending on the installed version - see the onerror
// handling below, which surfaces this clearly instead of failing silently.
const MIC_LANG_STORAGE_KEY = "micRecognitionLang";
const MIC_LANG_OPTIONS = [
  { code: "en-US", label: "EN", nameKey: "micLangName_en", joiner: " " },
  { code: "zh-CN", label: "中", nameKey: "micLangName_zhCN", joiner: "" },
];
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let isListening = false;
let userStoppedMic = false;
// Set when onerror stopped the recognizer (not the user). onend must NOT
// clear the mic status line in that case - it would erase the just-shown
// error message (with its 6s auto-hide) within milliseconds.
let micStoppedByError = false;
let micLangIndex = 0;
let micBaseText = "";
let micFinalText = "";
let micStatusTimer = null;

function currentMicLang() {
  return MIC_LANG_OPTIONS[micLangIndex];
}

// currentMicLang().name held a fixed English string; the speech-recognition
// language names are now translated like everything else, so this resolves
// the display name for the *current* UI language each time it's needed
// instead of baking one in at MIC_LANG_OPTIONS's module-load time.
function micLangDisplayName(lang) {
  return t(currentLang, lang.nameKey);
}

function setMicStatus(message, isError = false, autoHideMs = 0) {
  clearTimeout(micStatusTimer);
  micStatus.classList.toggle("error", isError);
  micStatus.textContent = message || "";
  micStatus.hidden = !message;
  if (message && autoHideMs > 0) {
    micStatusTimer = setTimeout(() => setMicStatus(""), autoHideMs);
  }
}

function updateMicLangUI() {
  const lang = currentMicLang();
  const name = micLangDisplayName(lang);
  micLangBtn.textContent = lang.label;
  micLangBtn.title = t(currentLang, "micLang_title_template", { name });
  micBtn.title = isListening
    ? t(currentLang, "mic_stop_title_template", { name })
    : t(currentLang, "mic_start_title_template", { name });
}

// Called from applyLanguage() on every language switch. Speech-recognition
// support itself doesn't change at runtime, but the tooltip text
// reflecting it does, so this picks the right refresh for whichever branch
// setupMic (below) already committed to.
function refreshMicUiLanguage() {
  if (SpeechRecognitionCtor) {
    updateMicLangUI();
  } else {
    micBtn.title = t(currentLang, "mic_unsupported_title");
  }
}

async function restoreMicLang() {
  try {
    const stored = await chrome.storage.local.get(MIC_LANG_STORAGE_KEY);
    const idx = MIC_LANG_OPTIONS.findIndex((l) => l.code === stored[MIC_LANG_STORAGE_KEY]);
    if (idx !== -1) {
      micLangIndex = idx;
      updateMicLangUI();
      return;
    }
  } catch (err) {
    console.debug("[AI Assistant] Unable to restore voice input language:", err);
  }
  // First run: guess a sensible starting language from the system/browser locale.
  micLangIndex = (navigator.language || "en-US").toLowerCase().startsWith("zh") ? 1 : 0;
  updateMicLangUI();
}

function joinMicText(base, finalText, interim) {
  const lang = currentMicLang();
  const pieces = [base.trim(), finalText.trim(), interim.trim()].filter(Boolean);
  return pieces.join(lang.joiner || " ");
}

function buildRecognition() {
  const rec = new SpeechRecognitionCtor();
  rec.lang = currentMicLang().code;
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (event) => {
    // Ignore results from a recognizer that has been replaced (e.g. after
    // switching the voice language while listening).
    if (rec !== recognition) return;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const lang = currentMicLang();
        micFinalText = micFinalText ? `${micFinalText}${lang.joiner || " "}${transcript.trim()}` : transcript.trim();
      } else {
        interim += transcript;
      }
    }
    questionInput.value = joinMicText(micBaseText, micFinalText, interim);
  };

  rec.onerror = (event) => {
    if (rec !== recognition) return;
    const err = event.error;
    console.debug("[AI Assistant] Voice input error:", err);
    if (err === "no-speech" || err === "aborted") return; // benign; onend decides what happens next
    userStoppedMic = true; // suppress the auto-restart in onend...
    micStoppedByError = true; // ...but keep the error message it just showed visible
    const messageKeys = {
      "not-allowed": "mic_notAllowed",
      "service-not-allowed": "mic_notAllowed",
      "audio-capture": "mic_audioCapture",
      network: "mic_network",
    };
    const message = messageKeys[err]
      ? t(currentLang, messageKeys[err])
      : t(currentLang, "mic_genericError_template", { err });
    setMicStatus(message, true, err === "network" ? 0 : 6000);
  };

  rec.onend = () => {
    // A recognizer that was stopped to be replaced (language switch) fires
    // onend AFTER startMic() has already reset userStoppedMic, so without this
    // check the old recognizer restarted itself and two recognizers wrote into
    // the question box at once (duplicated text, wrong language).
    if (rec !== recognition) return;
    isListening = false;
    micBtn.classList.remove("active");
    micBtn.setAttribute("aria-pressed", "false");
    if (userStoppedMic) {
      // Only a deliberate stop clears the status line. After an onerror stop
      // (micStoppedByError) the error message shown there must survive this
      // onend, which fires immediately after onerror.
      if (!micStoppedByError) setMicStatus("");
      updateMicLangUI();
      return;
    }
    // The engine stopped itself (e.g. a brief-silence timeout) but the user
    // hasn't clicked off: pick dictation back up automatically.
    micBaseText = questionInput.value;
    micFinalText = "";
    try {
      rec.start();
      isListening = true;
      micBtn.classList.add("active");
      micBtn.setAttribute("aria-pressed", "true");
    } catch (err) {
      console.debug("[AI Assistant] Unable to auto-restart voice input:", err);
    }
    updateMicLangUI();
  };

  return rec;
}

async function ensureMicPermission() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state;
  } catch {
    return "unknown";
  }
}

// Side panels have a known Chromium quirk where the getUserMedia permission
// prompt can fail to appear ("permission dismissed"). Opening the request in
// a full tab, where the prompt reliably shows, works around it.
function openMicPermissionTab() {
  return new Promise((resolve) => {
    // Settles exactly once and always cleans up both waits: the tab-close
    // listener and a 2-minute give-up timer. Previously only the listener
    // existed, so if the user left the tab open the listener leaked, the
    // promise never resolved, and micStarting stayed true - silently
    // ignoring every later mic click until the browser restarted. After the
    // timeout, startMic() re-checks permission and reports the result
    // normally.
    let tabId = null;
    let settled = false;
    let giveUpTimer = null;
    function onTabRemoved(closedId) {
      if (closedId === tabId) settle();
    }
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(giveUpTimer);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
      resolve();
    }
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    giveUpTimer = setTimeout(settle, 120000);
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/mic-permission.html") }, (tab) => {
      tabId = tab?.id;
      if (!tabId) settle();
    });
  });
}

let micStarting = false;

async function startMic() {
  if (!SpeechRecognitionCtor || isStreaming || micStarting) return;
  micStarting = true;
  userStoppedMic = false;
  micStoppedByError = false;
  try {
    const permState = await ensureMicPermission();
    if (permState !== "granted") {
      setMicStatus(
        permState === "denied"
          ? t(currentLang, "mic_blockedForExtension")
          : t(currentLang, "mic_requestingPermission")
      );
      await openMicPermissionTab();
      const recheck = await ensureMicPermission();
      if (recheck !== "granted") {
        setMicStatus(t(currentLang, "mic_permissionDenied"), true, 6000);
        return;
      }
    }

    // The permission round-trip above can keep this function suspended for
    // minutes (the permission tab stays open until acted on). The user may
    // have sent a request meanwhile - setStreaming() disabled the mic buttons,
    // but that says nothing about this already-running call. Dictating into
    // the disabled composer while a request streams must not start.
    if (isStreaming) return;

    micBaseText = questionInput.value;
    micFinalText = "";
    recognition = buildRecognition();
    try {
      recognition.start();
      isListening = true;
      micBtn.classList.add("active");
      micBtn.setAttribute("aria-pressed", "true");
      updateMicLangUI();
      setMicStatus(t(currentLang, "mic_listening_template", { name: micLangDisplayName(currentMicLang()) }));
    } catch (err) {
      console.error("[AI Assistant] Unable to start voice input:", err);
      setMicStatus(t(currentLang, "mic_unableToStart"), true, 6000);
    }
  } finally {
    micStarting = false;
  }
}

function stopMic() {
  isListening = false;
  micBtn.classList.remove("active");
  micBtn.setAttribute("aria-pressed", "false");
  updateMicLangUI();
  setMicStatus("");
  if (recognition) {
    try { recognition.stop(); } catch { /* already stopped */ }
  }
}

if (!SpeechRecognitionCtor) {
  micBtn.disabled = true;
  micLangBtn.hidden = true;
  micBtn.title = t(currentLang, "mic_unsupported_title");
} else {
  restoreMicLang();

  micBtn.addEventListener("click", () => {
    if (isListening) {
      userStoppedMic = true;
      stopMic();
    } else {
      startMic();
    }
  });

  micLangBtn.addEventListener("click", async () => {
    const wasListening = isListening;
    if (isListening) {
      userStoppedMic = true;
      stopMic();
    }
    micLangIndex = (micLangIndex + 1) % MIC_LANG_OPTIONS.length;
    updateMicLangUI();
    chrome.storage.local.set({ [MIC_LANG_STORAGE_KEY]: currentMicLang().code });
    if (wasListening) await startMic();
  });
}

async function handleSubmit(e, forcedQuestion = null, forcedIncludePageContext = null, forcedDisplayQuestion = null, factCheck = false, factCheckSelectedText = "", noWebResearch = false, includePageImages = false, forceWebResearch = false, translateMode = false, translateSource = null, translateSourceFormat = "text", translateSourceTruncated = false) {
  e?.preventDefault?.();
  const question = forcedQuestion !== null ? String(forcedQuestion).trim() : questionInput.value.trim();
  const attachmentText = attachmentContextText();
  if ((!question && !attachmentText) || isStreaming) return;
  // Not before init() has reset the topic and opened the port.
  if (!initCoreDone) return;

  const selectedModel = getSelectedModel();
  // Text-only models (GPT-OSS) reject any request containing an image part with
  // an HTTP 400. Say so up front, before anything is cleared or locked, so the
  // draft and attachments are kept and the user can switch model or remove them.
  if (!modelSupportsVision(selectedModel) && attachments.some((a) => a.status === "ready" && a.kind === "image")) {
    addBubble("error", t(currentLang, "error_modelNoImages_template", { model: selectedModel.label }));
    return;
  }
  pendingModelLabel = selectedModel.label;
  pendingModelId = selectedModel.id;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  currentRequestId = requestId;
  // Lock the composer right away. Setting this only after the awaited storage
  // write below left a window in which a second submit passed the isStreaming
  // guard above.
  setStreaming(true);
  // True once Clear / New Topic / another conversation (stopActiveRequest) has
  // abandoned this request while it was still gathering page context.
  const isCancelled = () => currentRequestId !== requestId;

  // From here on anything can throw (storage, tab queries, page capture,
  // screenshots, rendering). setStreaming(true) above has locked the composer,
  // so an unexpected exception must unlock it and tell the user; otherwise the
  // panel stays disabled until it is reopened. `posted` marks the point where
  // the request is in flight and the background worker owns the unlock (DONE /
  // ERROR / STOP), so an error after that must not unlock a live request.
  let posted = false;
  try {

    // Only clear the composer when the submission came from it. Quick actions
    // and context-menu actions pass a forcedQuestion; wiping the input then
    // would destroy a draft the user typed but had not sent yet.
    if (forcedQuestion === null) questionInput.value = "";
    autoScrollEnabled = true;
    const displayQuestion = forcedDisplayQuestion !== null
      ? String(forcedDisplayQuestion).trim()
      : (question || t(currentLang, "attachedFilesFallback"));
    const readyAttachments = attachments.filter((a) => a.status === "ready");
    const displayContent = attachmentText
      ? `${displayQuestion}\n\n📎 ${readyAttachments.map((a) => a.name).join(", ")}`
      : displayQuestion;
    addBubble("user", displayContent);
    const baseQuestionForApi = `${question || "Please analyze the attached files."}${attachmentText}`;
    history.push({ role: "user", content: baseQuestionForApi, displayContent, modelLabel: "" });
    if (!currentConversationId) {
      currentConversationId = createConversation().id;
    }
    let convo = currentConversation();
    if (!convo) {
      convo = { id: currentConversationId, title: "", messages: [], updatedAt: Date.now() };
      conversations.unshift(convo);
    }
    convo.title = convo.title || makeTopicTitle(history, t(currentLang, "historySelect_newTopic"));
    renderHistorySelect();
    try {
      await saveConversations();
    } catch (err) {
      // A storage failure must not leave the composer locked or block the answer.
      console.error("[AI Assistant] Unable to save conversation:", err);
    }
    if (isCancelled()) return;

    let pageContext = null;
    const shouldIncludePageContext = forcedIncludePageContext === null
      ? includeContextToggle.checked === true
      : forcedIncludePageContext === true;
    // Webmail / banking: an ordinary question must not send the page unless the
    // user allowed this site. Checked against the tab's URL before capture and
    // again on the captured page below (the tab can change in between).
    let sensitiveBlocked = false;
    if (shouldIncludePageContext && forcedIncludePageContext === null) {
      const tabNow = await getCurrentActiveTab();
      if (isBlockedSensitivePage(tabNow?.url)) {
        sensitiveBlocked = true;
        updateContextBar({ title: String(tabNow?.title || ""), url: String(tabNow?.url || "") });
      }
    }
    if (shouldIncludePageContext && !sensitiveBlocked) {
      // Capture the page at the moment the user submits the request. The API
      // request must never reuse the page context shown or captured earlier.
      pageContext = await getActivePageContext(0, translateMode === true && !translateSource ? "markdown" : null);
      if (isCancelled()) return;
      if (pageContext && forcedIncludePageContext === null && isBlockedSensitivePage(pageContext.url, pageContext.source)) {
        sensitiveBlocked = true;
        updateContextBar({ title: pageContext.title, url: pageContext.url, source: pageContext.source });
        pageContext = null;
      } else if (pageContext) {
        updateContextBar(pageContext);
      } else {
        // Capture failed - the page may still be loading, or may not be a
        // readable web page (new tab, PDF viewer, browser-internal pages).
        // Keep the bar visible with a warning, and send a {captureFailed}
        // sentinel instead of null so background.js instructs the model NOT
        // to reuse page content from earlier turns - without it, quick
        // actions translated/summarized the PREVIOUS article out of history.
        updateContextBarUnavailable();
        pageContext = { captureFailed: true };
      }
    }

    const pageContextValid = !!pageContext && !pageContext.captureFailed;
    let automaticPageImages = [];
    let pageScreenshot = null;
    // Page images/screenshots are optional extra context. Text-only models (the
    // GPT-OSS models) reject requests that contain image parts, which would make
    // every quick action fail on them, so the visuals are skipped for those.
    // Page screenshots/images are NOT covered by the text privacy filter, so
    // they are sent only when the user has switched "Send page screenshot and
    // images" on in Settings (off by default). Images the user attaches
    // themselves are unaffected.
    let pageVisualsAllowed = false;
    if (includePageImages) {
      try {
        pageVisualsAllowed = (await chrome.storage.local.get(PAGE_VISUALS_STORAGE_KEY))[PAGE_VISUALS_STORAGE_KEY] === true;
      } catch {
        pageVisualsAllowed = false;
      }
    }
    const attachPageVisuals = includePageImages && pageVisualsAllowed && modelSupportsVision(selectedModel);
    if (attachPageVisuals && pageContextValid) {
      automaticPageImages = await fetchPageImages(pageContext.imageUrls, pageContext.url);
      const currentTab = await getCurrentActiveTab();
      if (currentTab?.id !== pageContext.tabId || String(currentTab?.url || "") !== pageContext.url) {
        automaticPageImages = [];
      }
    }
    if (attachPageVisuals) {
      // Capture a visible-page image in addition to individually fetched <img>
      // elements. This also covers pages whose text extraction failed but whose
      // visible content is an image or canvas.
      const screenshotTab = pageContextValid
        ? { id: pageContext.tabId, url: pageContext.url }
        : await getCurrentActiveTab();
      pageScreenshot = await captureVisiblePageScreenshot(screenshotTab?.id, String(screenshotTab?.url || ""));
    }
    if (isCancelled()) return;
    const pageVisualInputCount = automaticPageImages.length + (pageScreenshot ? 1 : 0);
    // A visual input in the provider payload is not always enough to make a
    // text-focused quick action discuss it. State explicitly that the attached
    // current-page images are part of the requested analysis.
    const questionForApi = pageVisualInputCount
      ? `${baseQuestionForApi}\n\n[CURRENT PAGE VISUALS]\n${pageVisualInputCount} current-page visual input${pageVisualInputCount === 1 ? " is" : "s are"} attached. Analyze and incorporate the visible page images when they are relevant to the requested summary, translation, explanation, key points, or fact check. Do not describe images from earlier conversation turns.\n[/CURRENT PAGE VISUALS]`
      : baseQuestionForApi;

    // Tell the model explicitly when the page has changed since its last
    // answer in this conversation. history[].pageContext (title/url only, set
    // below and persisted via toStoredMessage) records which page, if any, was
    // used for each earlier user message; find the most recent one before this
    // request. A plain "ignore old page content" reminder is easy for a model
    // to under-weight against a conversation history full of the previous
    // page's actual content - naming the specific earlier page and contrasting
    // it with the current one (in pageContextInstruction(), background.js) is
    // a much harder signal to miss. Only attached when a change is actually
    // detected (different URL), so a same-page follow-up ("tell me more")
    // isn't cluttered with an irrelevant note.
    const previousPageContext = history
      .slice(0, -1)
      .reverse()
      .find((h) => h.role === "user" && h.pageContext)?.pageContext || null;
    history[history.length - 1].pageContext = pageContextValid ? { title: pageContext.title, url: pageContext.url } : null;
    if (pageContextValid && previousPageContext && previousPageContext.url !== pageContext.url) {
      pageContext = { ...pageContext, previousPage: previousPageContext };
    }

    // Markdown sources are shown rendered (headings, lists, tables, links);
    // plain sources keep their exact whitespace.
    pendingPlainReply = translateMode === true && !(translateSource ? translateSourceFormat === "markdown" : pageContextValid && pageContext.format === "markdown");
    const askMessage = {
      type: "ASK",
      payload: {
        requestId,
        question: questionForApi,
        // Defense in depth: the background worker also receives an explicit
        // flag so an unchecked "Read current page" can never be interpreted as
        // a request to use/send page content, even if pageContext were ever
        // non-null here by mistake. This is independent of attached images
        // (below), which are unrelated to this toggle and always sent when
        // present.
        includePageContext: shouldIncludePageContext && !sensitiveBlocked,
        pageContext: shouldIncludePageContext && !sensitiveBlocked ? pageContext : null,
        // When the user changes pages, do not send the previous page's
        // conversation turns to the model. The UI history remains intact, but
        // old assistant answers can themselves contain facts from Page B and
        // therefore act as stale page context even when the new Page C text is
        // supplied correctly. A page change starts a fresh model context; normal
        // follow-up questions on the same page retain conversation history.
        history: (pageContextValid && previousPageContext && pageContext.url !== previousPageContext.url)
          ? []
          : getApiHistory().slice(0, -1),
        images: [
          ...readyAttachments.filter((a) => a.kind === "image" && a.dataUrl).map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
          ...automaticPageImages,
          ...(pageScreenshot ? [pageScreenshot] : []),
        ],
        // Send the exact model selected at submit time.
        modelId: selectedModel.id,
        factCheck: factCheck ? { enabled: true, selectedText: factCheckSelectedText } : null,
        // Summarize, Translate, and Key Points remain page-only transforms.
        // Explain explicitly opts into Tavily research, while Fact Check uses
        // its dedicated claim-verification research path.
        noWebResearch,
        forceWebResearch,
        // Translation requests must reproduce the source's exact formatting.
        translateMode: translateMode === true,
        // Exact selected text for the context-menu translation (page text is
        // used for the quick action when this is null).
        translateSource: translateMode === true && typeof translateSource === "string" ? translateSource : null,
        // The selection was already cut by the extractor (see content.js).
        translateSourceTruncated: translateMode === true && translateSourceTruncated === true,
      },
    };
    try {
      postToBackground(askMessage);
      posted = true;
    } catch (err) {
      console.error("[AI Assistant] Unable to send request:", err);
      if (!isCancelled()) {
        currentRequestId = null;
        autoScrollEnabled = false;
        addBubble("error", t(currentLang, "error_withMessage_template", { message: err?.message || String(err) }));
        setStreaming(false);
      }
      return;
    }

    // Attachments are one-shot. Everything this request needed was captured
    // above (readyAttachments / attachmentText), the user bubble already lists
    // the file names, and the assistant reply will be appended to the same
    // conversation - so the chips are removed now. Previously they stayed,
    // silently re-uploading every attached image with each follow-up message
    // (and re-inlining the attachment text block) until the user removed every
    // chip by hand.
    attachments = [];
    renderAttachments();
  } catch (err) {
    console.error("[AI Assistant] Request failed before it could be sent:", err);
    if (!posted && !isCancelled()) {
      currentRequestId = null;
      autoScrollEnabled = false;
      addBubble("error", t(currentLang, "error_withMessage_template", { message: err?.message || String(err) }));
      setStreaming(false);
      // Give the user their text back: it was cleared from the composer on submit.
      if (forcedQuestion === null && !questionInput.value) questionInput.value = question;
    }
  }
}



// Target language for translations: the "Preferred Translation Language"
// setting (default English). Shared by the right-click menu and the quick
// Translate button.
const TRANSLATION_LANGUAGE_NAME_KEYS = {
  "en": "contextAction_language_en",
  "zh-CN": "contextAction_language_zhCN",
  "zh-TW": "contextAction_language_zhTW",
  "fr": "contextAction_language_fr",
  "ja": "contextAction_language_ja",
  "es": "contextAction_language_es",
};

async function getPreferredTranslationLanguage() {
  const stored = await chrome.storage.local.get(PREFERRED_TRANSLATION_LANGUAGE_KEY);
  const code = TRANSLATION_LANGUAGE_NAME_KEYS[stored[PREFERRED_TRANSLATION_LANGUAGE_KEY]] ? stored[PREFERRED_TRANSLATION_LANGUAGE_KEY] : "en";
  return { code, nameKey: TRANSLATION_LANGUAGE_NAME_KEYS[code] };
}

async function processContextAction(pending) {
  if (!pending?.action || !pending?.text) return;
  if (isStreaming) stopActiveRequest();

  const lang = currentLang || await getStoredLanguage();
  let instruction;
  switch (pending.action) {
    case "summarize":
      instruction = t(lang, "contextAction_summarize_prefix");
      break;
    case "translate": {
      const target = await getPreferredTranslationLanguage();
      instruction = t(lang, "contextAction_translate_prefix", { language: t(lang, target.nameKey) });
      break;
    }
    case "explain":
      instruction = t(lang, "contextAction_explain_prefix");
      break;
    case "fact-check":
      instruction = t(lang, "contextAction_factCheck_prefix");
      break;
    default:
      return;
  }

  // A context-menu operation is scoped to the highlighted text. Do not add
  // the whole webpage as hidden context, even if "Read current page" is on.
  // The visible instruction prefix follows the language selected in Settings.
  const isTranslation = pending.action === "translate";
  const prompt = isTranslation
    ? instruction.replace(/[:：]\s*$/, "")
    : `${instruction}\n\n${t(lang, "contextAction_highlightedText_label")}:\n${pending.text}`;
  // Show a compact preview in the user bubble (the instruction plus the start
  // of the selection) instead of the entire raw prompt, matching how quick
  // actions display a short prompt rather than their full API wording.
  const preview = pending.text.length > 120 ? `${pending.text.slice(0, 120).trimEnd()}…` : pending.text;
  const displayQuestion = isTranslation
    ? `${instruction}\n\n${preview}`
    : `${instruction}\n${t(lang, "contextAction_highlightedText_label")}:\n${preview}`;
  await handleSubmit(null, prompt, false, displayQuestion, pending.action === "fact-check", pending.action === "fact-check" ? pending.text : "", pending.action !== "fact-check", false, false, isTranslation, isTranslation ? pending.text : null, pending.format === "markdown" ? "markdown" : "text", pending.truncated === true);
}

// The createdAt timestamp of the context-menu action most recently claimed by
// this panel document - see consumePendingContextAction below.
let claimedContextActionAt = null;

async function consumePendingContextAction(pending = null) {
  // Always re-read storage, even when a payload arrived via the
  // CONTEXT_ACTION runtime message: the stored record is the single source
  // of truth for whether this action still needs processing.
  const stored = await chrome.storage.local.get(PENDING_CONTEXT_ACTION_KEY);
  const storedAction = stored[PENDING_CONTEXT_ACTION_KEY] || null;
  const action = pending || storedAction;
  if (!action) return;
  // Ignore a stale menu action after 2 minutes, or one that was created for a
  // different active tab. This prevents an old selection from being reused.
  if (!action.createdAt || Date.now() - action.createdAt > 120000) {
    await chrome.storage.local.set({ [PENDING_CONTEXT_ACTION_KEY]: null });
    return;
  }
  // Only the panel in the window the selection was made in may process the
  // action. chrome.runtime.sendMessage reaches every extension page -
  // including side panels open in OTHER browser windows - so without this
  // scoping a second panel could claim the same action and submit the same
  // prompt in parallel with the intended one. Skipping (instead of claiming
  // and clearing) leaves the record for the window it belongs to.
  // (If this panel's window cannot be determined, fall through and process as
  // before.)
  const thisWindowId = await getPanelWindowId();
  if (action.windowId && thisWindowId !== null && action.windowId !== thisWindowId) return;
  // Claim the record BEFORE processing it. background.js delivers a context
  // action through two independent channels - the storage record (consumed
  // here when a freshly opened panel initializes) and a delayed
  // CONTEXT_ACTION runtime message (for a panel that is already open) - so a
  // single menu click could previously submit the same prompt twice: the
  // message path acted on its payload directly, without noticing the record
  // had already been consumed. Processing now starts only when the stored
  // record still matches this action. The in-memory timestamp guard below is
  // checked and set synchronously (no await in between), so two racing paths
  // within this same document cannot both claim it; the storage comparison
  // covers a second panel document (another browser window) racing this one.
  if (action.createdAt === claimedContextActionAt) return;
  const stillStored =
    storedAction &&
    storedAction.createdAt === action.createdAt &&
    storedAction.action === action.action &&
    storedAction.text === action.text;
  if (!stillStored) return;
  claimedContextActionAt = action.createdAt;
  await chrome.storage.local.set({ [PENDING_CONTEXT_ACTION_KEY]: null });
  const activeTab = await getCurrentActiveTab();
  if (action.tabId && activeTab?.id && action.tabId !== activeTab.id) return;
  await processContextAction(action);
}

// Only the extension's own worker may drive the panel. Content scripts share
// this extension's id but run inside web pages: their sender carries a `tab`
// and a web-page URL, so both are rejected here.
function isTrustedExtensionSender(sender) {
  return (
    Boolean(sender) &&
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isTrustedExtensionSender(sender)) return false;
  if (message?.type === "CONTEXT_ACTION") {
    // Queue behind initialization: init() itself consumes the stored record
    // once it is ready, and the claim logic below de-duplicates the two paths.
    initPromise.then(() => consumePendingContextAction(message.pending)).catch((err) => console.debug("[AI Assistant] Context action failed:", err));
  }
});

chatForm.addEventListener("submit", handleSubmit);

// Quick actions always operate on the page that is active at the moment the
// button is clicked. They deliberately force page context on, so they still
// work when the manual "Read current page" toggle is unchecked.
async function runQuickPageAction(apiPromptKey, displayPromptKey, factCheck = false, forceWebResearch = false, translateMode = false) {
  if (isStreaming) return;
  const lang = currentLang || await getStoredLanguage();
  // The Translate button targets the "Preferred Translation Language" setting;
  // the API prompt names the language in English, the visible bubble in the UI language.
  const vars = translateMode ? await getPreferredTranslationLanguage().then((l) => ({ api: { language: t("en", l.nameKey) }, display: { language: t(lang, l.nameKey) } })) : {};
  const apiPrompt = t("en", apiPromptKey, vars.api);
  const displayPrompt = t(lang, displayPromptKey, vars.display);
  // Fact Check keeps its dedicated Tavily path. Explain performs Tavily
  // research for supporting context; the remaining quick actions stay local.
  await handleSubmit(null, apiPrompt, true, displayPrompt, factCheck, "", !factCheck && !forceWebResearch, true, forceWebResearch, translateMode);
}

quickSummarizeBtn?.addEventListener("click", () => {
  runQuickPageAction("quickSummarize_prompt", "quickSummarize_prompt");
});

quickTranslateBtn?.addEventListener("click", () => {
  runQuickPageAction("quickTranslate_prompt", "quickTranslate_prompt", false, false, true);
});

quickExplainBtn?.addEventListener("click", () => {
  runQuickPageAction("quickExplain_prompt", "quickExplain_prompt", false, true);
});

quickKeyPointsBtn?.addEventListener("click", () => {
  runQuickPageAction("quickKeyPoints_prompt", "quickKeyPoints_prompt");
});

quickFactCheckBtn?.addEventListener("click", () => {
  // Full detailed prompt goes to the API; the short `quickFactCheck_display`
  // string is what the user sees in the chat bubble, in the display language.
  runQuickPageAction("quickFactCheck_prompt", "quickFactCheck_display", true);
});

questionInput.addEventListener("keydown", (e) => {
  // The Enter that commits an IME composition (Chinese/Japanese/Korean input)
  // also arrives as keydown with isComposing=true / keyCode 229. Without this
  // guard, confirming a pinyin conversion submitted the half-composed text.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

clearBtn.addEventListener("click", async () => {
  if (isListening) {
    userStoppedMic = true;
    stopMic();
  }
  // Stops a hung/unwanted in-flight request instead of silently ignoring
  // the click (see stopActiveRequest) - a no-op here previously left no way
  // out of a request that never completes.
  stopActiveRequest();
  startNewTopic();
  renderHistorySelect();
});

historySelect.addEventListener("change", async () => {
  if (isListening) {
    userStoppedMic = true;
    stopMic();
  }
  await selectConversation(historySelect.value);
});

pageContextAllowBtn.addEventListener("click", async () => {
  const tab = await getCurrentActiveTab().catch(() => null);
  const host = hostOf(tab?.url);
  if (host) allowedSensitiveHosts.add(host);
  await refreshActivePageContext();
});

includeContextToggle.addEventListener("change", async () => {
  try { await chrome.storage.local.set({ [INCLUDE_CONTEXT_STORAGE_KEY]: includeContextToggle.checked }); } catch {}
  if (includeContextToggle.checked) {
    await refreshActivePageContext();
  } else {
    updateContextBar(null);
  }
});

// Keep the displayed page context synchronized with the browser tab the user
// is currently viewing. This does not send anything to the AI provider; the
// refreshed context is used only when the next message is submitted.
let pageContextRefreshToken = 0;
let lastPageContextTabId = null;

async function refreshActivePageContext() {
  if (!includeContextToggle.checked) return;
  const token = ++pageContextRefreshToken;
  try {
    const tab = await getCurrentActiveTab();
    if (!tab?.id) {
      updateContextBar(null);
      return;
    }
    lastPageContextTabId = tab.id;
    // Ignore a slower result if the user has already switched tabs again.
    if (token !== pageContextRefreshToken) return;
    // Display-only refresh: show which page the next message would use,
    // from the tab's own title/URL. This used to run the full content-script
    // extraction (cloning and stripping document.body on large pages) on
    // every tab switch, navigation commit, and title change, just to render
    // this one line. Extraction now happens only where its result is
    // actually consumed, at submit time (handleSubmit ->
    // getActivePageContext, which hides this bar itself when the page
    // yields no text). chrome:// and other non-web pages can never yield
    // context, so the bar stays hidden for them too.
    if (!/^https?:/i.test(String(tab.url || ""))) {
      updateContextBar(null);
      return;
    }
    updateContextBar({ title: String(tab.title || ""), url: String(tab.url || "") });
  } catch (err) {
    console.debug("[AI Assistant] Unable to refresh page context:", err);
    if (token === pageContextRefreshToken) updateContextBar(null);
  }
}

// Every listener below ignores events from other browser windows: this panel
// only ever shows (and sends) the active tab of its OWN window, so a tab switch
// or focus change elsewhere cannot affect it.
chrome.tabs.onActivated.addListener((activeInfo) => {
  (async () => {
    if (!(await isOwnWindowEvent(activeInfo?.windowId))) return;
    await refreshActivePageContext();
  })().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!includeContextToggle.checked || tabId !== lastPageContextTabId) return;
  // Refresh after navigation commits or when the document title changes.
  if (changeInfo.status === "complete" || changeInfo.title) {
    (async () => {
      // `tab` is absent in some browsers; the tabId check above still applies.
      if (tab && !(await isOwnWindowEvent(tab.windowId))) return;
      await refreshActivePageContext();
    })().catch(() => {});
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  (async () => {
    // Focus moving to another window does not change this panel's page; only
    // refresh when focus comes back to this panel's own window.
    if (!(await isOwnWindowEvent(windowId))) return;
    await refreshActivePageContext();
  })().catch(() => {});
});

// Lock the composer until initialization has reset the topic and opened the
// port (setStreaming(false) re-enables everything afterwards).
function setInitLocked() {
  sendBtn.disabled = true;
  questionInput.disabled = true;
  quickActionButtons.forEach((button) => { button.disabled = true; });
  modelSelect.disabled = true;
  uploadBtn.disabled = true;
  if (SpeechRecognitionCtor) {
    micBtn.disabled = true;
    micLangBtn.disabled = true;
  }
}

async function init() {
  populateModelSelect();
  // Render the selector immediately so the control is never dependent on the
  // timing of asynchronous model/storage initialization.
  renderHistorySelect();
  scheduleHistoryRender();
  await restoreSelectedModel();
  // Load the saved conversation list (so the history dropdown is populated
  // and past conversations stay one click away), but do not activate/display
  // whichever one happened to be open last time (activate:false) - every
  // fresh open of the side panel (after it was closed, or after a browser
  // restart) should start on a blank New Topic instead of silently resuming
  // the previous session. Explicitly clears the persisted "current
  // conversation" pointer too, so it doesn't linger and get picked up by a
  // later reactive refresh (see the chrome.storage.onChanged listener below).
  await loadConversations({ activate: false });
  startNewTopic();
  renderHistorySelect();
  scheduleHistoryRender();
  ensurePort();
  initCoreDone = true;
  if (!isStreaming) setStreaming(false);
  try {
    // "Read current page" defaults to ON, but an explicit opt-out is
    // remembered across sessions (it used to be reset to ON on every open).
    const saved = (await chrome.storage.local.get(INCLUDE_CONTEXT_STORAGE_KEY))[INCLUDE_CONTEXT_STORAGE_KEY];
    includeContextToggle.checked = saved !== false;
  } catch {}
  await consumePendingContextAction();
  if (includeContextToggle.checked) {
    await refreshActivePageContext();
  }
}

setInitLocked();
initPromise = init().catch((err) => {
  console.error("[AI Assistant] Initialization failed:", err);
  // Do not leave the composer locked forever if a late init step threw.
  if (!initCoreDone) {
    initCoreDone = true;
    if (!isStreaming) setStreaming(false);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[HISTORY_STORAGE_KEY]) return;
  // Settings > Delete All History removes the key outright, so the change has
  // no newValue (this panel's own saves and Settings > Restore always write an
  // array). The displayed conversation would otherwise live on in memory and
  // be written straight back by the next send, making "deleted" untrue. Reset
  // to a blank New Topic exactly as the Clear button does, stopping an
  // in-flight request first so its reply cannot re-save the conversation. The
  // refresh below then empties the in-memory list and the history dropdown.
  if (changes[HISTORY_STORAGE_KEY].newValue === undefined) {
    if (isListening) {
      userStoppedMic = true;
      stopMic();
    }
    stopActiveRequest();
    startNewTopic();
  }
  // chrome.storage.onChanged fires for every write to this key, including
  // this same panel's own writes - not just Settings > Restore History.
  // handleSubmit() itself calls saveConversations() before the reply comes
  // back, so this listener fires mid-request with the conversation's most
  // recent *assistant* turn still the model used BEFORE the user's latest
  // dropdown change (the new reply isn't pushed until DONE). Two guards:
  // 1. Skip entirely while a request from this panel is in flight: besides
  //    the stale-model problem above, reloading `history` and re-rendering
  //    the chat log here would also fight the live streaming bubble, which
  //    only exists in memory (currentAssistantBubble) until DONE saves it.
  // 2. activate:false - refresh only the saved-conversation LIST and the
  //    history dropdown. Previously the default (activate:true) re-read the
  //    persisted current-conversation pointer and, when it matched, reloaded
  //    history and rebuilt the whole chat log after every completed save:
  //    that wiped any text the user was selecting, restarted lazy-loaded
  //    images in past bubbles, and - with side panels open in two windows -
  //    let one panel's save switch the other panel to a different
  //    conversation. The displayed conversation is only ever changed by
  //    explicit navigation (the history dropdown), this panel's own
  //    submissions, or Settings > Delete All History (handled above); if the
  //    displayed conversation is merely replaced by Settings > Restore, it
  //    stays visible from memory and is re-persisted on its next send.
  //    syncModel:false keeps the dropdown from following the model of an
  //    incidental background sync.
  if (isStreaming) return;
  loadConversations({ activate: false, syncModel: false })
    .catch((err) => console.error("[AI Assistant] Unable to refresh restored history:", err));
});
