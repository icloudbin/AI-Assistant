// sidepanel/sidepanel.js —— Fixed version: no trailing spaces; keeps import "../models.js"; API Key configuration moved to Settings
import { MODELS, findModelById } from "../models.js";
import { HISTORY_STORAGE_KEY, CURRENT_CONVERSATION_KEY, PENDING_CONTEXT_ACTION_KEY, PREFERRED_TRANSLATION_LANGUAGE_KEY } from "../storage-keys.js";
import { getStoredLanguage, applyStaticTranslations, t, LANGUAGE_STORAGE_KEY } from "../i18n.js";

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
const MAX_SAVED_CONVERSATIONS = 20;

const chatLog = document.getElementById("chatLog");
const emptyState = document.getElementById("emptyState");
const chatForm = document.getElementById("chatForm");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const optionsBtn = document.getElementById("optionsBtn");
const includeContextToggle = document.getElementById("includeContextToggle");
const pageContextBar = document.getElementById("pageContextBar");
const pageContextTitle = document.getElementById("pageContextTitle");
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
const quickActionButtons = [quickSummarizeBtn, quickTranslateBtn, quickExplainBtn, quickKeyPointsBtn].filter(Boolean);

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
const MAX_ZIP_ENTRIES = 80;
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

function connectPort() {
  port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => { port = null; });
}

function ensurePort() {
  if (!port) connectPort();
  return port;
}

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdownToHtml(text) {
  let s = escapeHtml(text);
  const codeSpans = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `@@INLINECODE${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  // Some models return image Markdown in a nested/escaped form such as:
  // ![image]([https://example.com/image.png](https://example.com/image.png))
  // or ![image]\(https://example.com/image.png\).
  // Normalize these common variants before parsing standard Markdown images.
  s = s.replace(
    /!\[([^\]]*)\]\(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\)/gi,
    (_, alt, _displayUrl, realUrl) => `![${alt}](${realUrl})`
  );
  s = s.replace(
    /!\[([^\]]*)\]\\\((https?:\/\/[^\s)]+)\\\)/gi,
    (_, alt, src) => `![${alt}](${src})`
  );

  // Markdown images. Process images before normal Markdown links so that
  // ![alt](url) is not accidentally consumed as [alt](url). Only allow
  // remote HTTP(S) images and image data URLs.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
    const rawSrc = src.replace(/&amp;/g, "&");
    try {
      const u = new URL(rawSrc, location.href);
      const isHttpImage = ["http:", "https:"].includes(u.protocol);
      const isDataImage = u.protocol === "data:" && /^data:image\/(?:png|jpeg|jpg|gif|webp);/i.test(rawSrc);
      if (!isHttpImage && !isDataImage) return `![${alt}](${src})`;
      const safeSrc = escapeHtml(isDataImage ? rawSrc : u.href);
      const safeAlt = escapeHtml(alt);
      return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async">`;
    } catch {
      return `![${alt}](${src})`;
    }
  });

  // Markdown links: only permit safe navigable protocols.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const rawHref = href.replace(/&amp;/g, "&");
    try {
      const u = new URL(rawHref, location.href);
      if (!["http:", "https:", "mailto:"].includes(u.protocol)) return label;

      // Some models ignore the requested Markdown-image syntax and return
      // [image](https://host/path/file.webp) instead. Treat links whose URL
      // clearly points to an image as images, so the conversation UI still
      // renders the requested image rather than showing a clickable "image"
      // link.
      const imagePath = u.pathname.toLowerCase();
      const isImageUrl = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(imagePath);
      if (isImageUrl && (u.protocol === "http:" || u.protocol === "https:")) {
        const safeSrc = escapeHtml(u.href);
        const safeAlt = escapeHtml(label);
        return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async">`;
      }

      const safeHref = escapeHtml(u.href);
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } catch {
      return label;
    }
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  for (let i = 0; i < codeSpans.length; i++) {
    s = s.replace(`@@INLINECODE${i}@@`, codeSpans[i]);
  }
  return s;
}

function isTableSeparator(line) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join("\n").trim();
    if (text) out.push(`<p>${inlineMarkdownToHtml(text).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) return;
    out.push(`<${listType}>${listItems.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join("")}</${listType}>`);
    listType = null;
    listItems = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      // A blank line ends the list UNLESS the list continues right after it.
      // Markdown (and real LLM output especially) commonly writes "loose"
      // lists with a blank line between items, particularly once an item's
      // text gets long - that's still one list, not a new one for every
      // item. Skip past any run of blank lines to the next real line; only
      // flush if that line isn't another item of the SAME list type
      // (switching from ordered to unordered, or ending the list entirely,
      // still correctly flushes).
      if (listType) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nextTrimmed = j < lines.length ? lines[j].trim() : "";
        const continuesSameList =
          (listType === "ol" && /^\d+[.)]\s+/.test(nextTrimmed)) || (listType === "ul" && /^[-+*]\s+/.test(nextTrimmed));
        if (!continuesSameList) flushList();
      }
      i++;
      continue;
    }

    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      flushParagraph();
      flushList();
      const fence = trimmed.slice(0, 3);
      const language = trimmed.slice(3).trim().split(/\s+/)[0] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const langClass = language ? ` class="language-${escapeHtml(language.replace(/[^a-zA-Z0-9_-]/g, ""))}"` : "";
      // Wrapped in .code-block (same idea as .table-wrap below, for a table)
      // so a copy button can be anchored to a container that doesn't itself
      // scroll horizontally - <pre> does, via overflow-x, so a button
      // positioned against <pre> directly would scroll out of view with
      // long lines.
      out.push(`<div class="code-block"><pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push("<hr>");
      i++;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inlineMarkdownToHtml(quoteLines.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }

    // GFM-style tables.
    if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const headHtml = headers.map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`).join("");
      const bodyHtml = rows.map((row) => `<tr>${headers.map((_, idx) => `<td>${inlineMarkdownToHtml(row[idx] || "")}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const unordered = trimmed.match(/^[-+*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((ordered || unordered)[1]);
      i++;
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }

  flushParagraph();
  flushList();
  return out.join("");
}

const ALLOWED_TAGS = new Set([
  "P", "BR", "STRONG", "EM", "DEL", "CODE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "BLOCKQUOTE", "HR", "A", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "DIV"
]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "class", "src", "alt", "loading", "decoding"]);

function sanitizeRenderedHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  if (!root) return "";

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements = [];
  while (walker.nextNode()) elements.push(walker.currentNode);

  for (const el of elements.reverse()) {
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
        el.setAttribute("src", isDataImage ? src : u.href);
        el.setAttribute("loading", "lazy");
        el.setAttribute("decoding", "async");
        el.setAttribute("alt", el.getAttribute("alt") || "");
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
        const isImageUrl = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(u.pathname);
        if (isImageUrl && (u.protocol === "http:" || u.protocol === "https:")) {
          const img = document.createElement("img");
          img.setAttribute("src", u.href);
          img.setAttribute("alt", el.textContent || t(currentLang, "imageAltFallback"));
          img.setAttribute("loading", "lazy");
          img.setAttribute("decoding", "async");
          el.replaceWith(img);
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

async function fallbackRemoteImage(img) {
  if (!(img instanceof HTMLImageElement) || img.dataset.remoteFallbackAttempted === "1") return;
  const src = img.getAttribute("src") || "";
  if (!/^https?:\/\//i.test(src)) return;

  img.dataset.remoteFallbackAttempted = "1";
  try {
    const result = await chrome.runtime.sendMessage({ type: "FETCH_IMAGE", url: src });
    if (result?.ok && result.dataUrl) {
      img.src = result.dataUrl;
    }
  } catch (_) {
    // Keep the browser's normal broken-image state if the fallback fails.
  }
}

// Direct cross-origin image loading is preferred. If the remote host blocks
// extension-origin requests, retry through the extension service worker.
chatLog.addEventListener("error", (event) => {
  if (event.target?.tagName === "IMG") fallbackRemoteImage(event.target);
}, true);

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

function setBubbleContent(bubbleEl, text, role) {
  const textEl = getBubbleTextEl(bubbleEl);
  if (!textEl) return;
  if (role === "assistant") {
    textEl.innerHTML = sanitizeRenderedHtml(markdownToHtml(text));
    enhanceCodeBlocks(textEl);
  } else {
    textEl.textContent = text;
  }
}

function addBubble(role, text, modelLabel) {
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
  setBubbleContent(wrap, text, role);

  chatLog.appendChild(wrap);
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
  if (selectedModelId && MODELS.some((m) => m.id === selectedModelId)) {
    modelSelect.value = selectedModelId;
  }
}

modelSelect.addEventListener("change", () => {
  chrome.storage.local.set({ selectedModelId: modelSelect.value });
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
    if (m.modelId && MODELS.some((model) => model.id === m.modelId)) return m.modelId;
    if (m.modelLabel) {
      const byLabel = MODELS.find((model) => model.label === m.modelLabel);
      if (byLabel) return byLabel.id;
    }
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
  chrome.storage.local.set({ selectedModelId: modelId });
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
  setStreaming(false);
}

async function getCurrentActiveTab() {
  // A side panel can remain alive while the user changes tabs. Do not use the
  // panel's window or a cached tab. Query all active tabs and select the active
  // tab belonging to the currently focused NORMAL browser window. This is more
  // reliable in Brave than lastFocusedWindow alone, which can occasionally
  // retain the tab that was active when the panel was opened.
  try {
    const [windows, activeTabs] = await Promise.all([
      chrome.windows.getAll({ populate: false }),
      chrome.tabs.query({ active: true }),
    ]);
    const focusedNormal = windows.find(
      (w) => w.focused && w.type === "normal"
    );
    if (focusedNormal) {
      const tab = activeTabs.find((t) => t.windowId === focusedNormal.id);
      if (tab?.id) return tab;
    }
    // If the focused-window lookup is temporarily unavailable, prefer a tab
    // from any focused window before falling back to the legacy query.
    const focusedWindow = windows.find((w) => w.focused);
    if (focusedWindow) {
      const tab = activeTabs.find((t) => t.windowId === focusedWindow.id);
      if (tab?.id) return tab;
    }
  } catch (err) {
    console.debug("[AI Assistant] Unable to resolve active browser tab:", err);
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs?.[0] || null;
  } catch (err) {
    console.debug("[AI Assistant] Unable to query active tab:", err);
    return null;
  }
}

async function getActivePageContext(retryCount = 0) {
  const tab = await getCurrentActiveTab();
  if (!tab?.id) return null;
  const initialTabId = tab.id;
  const initialUrl = String(tab.url || "");

  const makeContext = (data) => {
    const text = String(data?.text || "").trim();
    if (!text) return null;
    return {
      tabId: initialTabId,
      title: String(data?.title || tab.title || ""),
      url: String(data?.url || initialUrl || ""),
      text: text.slice(0, 20000),
    };
  };

  try {
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(initialTabId, { type: "EXTRACT_PAGE_CONTENT" }, (value) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(value || null);
      });
    });
    if (response?.ok && response.data?.text?.trim()) {
      const currentTab = await getCurrentActiveTab();
      // Never return context captured from a page that is no longer the
      // active page. This prevents a slow content-script response from a
      // previous tab/navigation being attached to the next request.
      if (currentTab?.id !== initialTabId || String(currentTab.url || "") !== initialUrl) {
        // The user switched tabs/navigated while extraction was in progress.
        // Retry against the tab that is active now, but never recurse forever.
        return retryCount < 2 ? getActivePageContext(retryCount + 1) : null;
      }
      return makeContext(response.data);
    }
  } catch (err) {
    console.debug("[AI Assistant] Content script unavailable:", err);
  }

  try {
    if (!/^https?:\/\//i.test(initialUrl)) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: initialTabId },
      func: () => ({
        title: document.title,
        url: location.href,
        text: document.body?.innerText || document.documentElement?.innerText || "",
      }),
    });
    const data = results?.[0]?.result;
    const currentTab = await getCurrentActiveTab();
    if (currentTab?.id !== initialTabId || String(currentTab.url || "") !== initialUrl) {
      return retryCount < 2 ? getActivePageContext(retryCount + 1) : null;
    }
    return makeContext(data);
  } catch (err) {
    console.warn("[AI Assistant] Unable to read current page:", err);
    return null;
  }
}
function updateContextBar(pageContext) {
  if (!pageContext) {
    pageContextBar.hidden = true;
    return;
  }
  pageContextBar.hidden = false;
  pageContextTitle.textContent = `📄 ${pageContext.title || pageContext.url}`;
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
      currentAssistantBubble = addBubble("assistant", "", pendingModelLabel);
      currentAssistantBubble.classList.add("pending");
      break;
    }
    case "CHUNK": {
      currentAssistantText += msg.delta;
      if (currentAssistantBubble) {
        setBubbleContent(currentAssistantBubble, currentAssistantText, "assistant");
        scrollToBottom();
      }
      break;
    }
    case "DONE": {
      if (currentAssistantBubble) {
        currentAssistantBubble.classList.remove("pending");
      }
      history.push({ role: "assistant", content: currentAssistantText, displayContent: currentAssistantText, modelLabel: pendingModelLabel, modelId: pendingModelId });
      currentAssistantBubble = null;
      setStreaming(false);
      saveConversations().catch((err) => console.error("[AI Assistant] Unable to save conversation:", err));
      break;
    }
    case "ERROR": {
      if (currentAssistantBubble) {
        currentAssistantBubble.remove();
        currentAssistantBubble = null;
      }
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

function cleanForTopic(text) {
  return String(text || "")
    .replace(/\[ATTACHMENTS\][\s\S]*?\[\/ATTACHMENTS\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeTopicTitle(messages) {
  const userTexts = (messages || [])
    .filter((m) => m.role === "user")
    .map((m) => cleanForTopic(m.displayContent || m.content))
    .filter(Boolean);
  if (!userTexts.length) return "";
  const summarySource = userTexts.join(" ");
  const words = summarySource.split(/\s+/).filter(Boolean);
  return words.slice(0, 10).join(" ") || t(currentLang, "historySelect_newTopic");
}

function toStoredMessage(message) {
  return {
    role: message.role,
    content: message.content,
    displayContent: message.displayContent || message.content,
    modelLabel: message.modelLabel || "",
    modelId: message.modelId || "",
    // Which page (title/url only - never the page text itself) was used for
    // this message, if any. Read back on the next submission to tell the
    // model explicitly when the page has changed - see handleSubmit() below.
    pageContext: message.pageContext || null,
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
  if (!convo.title) convo.title = makeTopicTitle(convo.messages);
  convo.updatedAt = Date.now();
}

async function saveConversations() {
  syncCurrentConversationFromHistory();
  conversations = conversations
    .filter((c) => c.messages?.length)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SAVED_CONVERSATIONS);
  await chrome.storage.local.set({
    [HISTORY_STORAGE_KEY]: conversations,
    [CURRENT_CONVERSATION_KEY]: currentConversationId || "",
  });
  renderHistorySelect();
  scheduleHistoryRender();
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
    opt.textContent = convo.title || makeTopicTitle(convo.messages) || t(currentLang, "untitledConversation");
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
    addBubble(message.role, message.displayContent || message.content, message.role === "assistant" ? message.modelLabel : undefined);
  }
  scrollToBottom();
}

function startNewTopic() {
  history = [];
  attachments = [];
  currentConversationId = null;
  renderAttachments();
  renderConversation([]);
  questionInput.value = "";
  historySelect.value = NEW_TOPIC_VALUE;
  chrome.storage.local.set({ [CURRENT_CONVERSATION_KEY]: "" });
}

async function loadConversations({ activate = true, syncModel = true } = {}) {
  const stored = await chrome.storage.local.get([HISTORY_STORAGE_KEY, CURRENT_CONVERSATION_KEY]);
  conversations = Array.isArray(stored[HISTORY_STORAGE_KEY]) ? stored[HISTORY_STORAGE_KEY] : [];
  // Keep at most 20 saved conversations. Conversations are ordered newest-first
  // whenever they are saved, so entries beyond the limit are the oldest ones.
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

    // New Topic is a fresh conversation (DeepSeek, Gemini, Claude, ChatGPT,
    // or OpenRouter, depending on the selected model): discard the active conversation
    // state, clear the composer, and leave the API ready for the user's
    // first message. The new conversation is persisted only when that
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

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(t(currentLang, "sp_zip_error_decompressionUnsupported"));
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error(t(currentLang, "sp_zip_error_tooManyFiles_template", { max: MAX_ZIP_ENTRIES }));
  if (centralOffset + centralSize > bytes.length) throw new Error(t(currentLang, "sp_zip_error_invalidCentralDir"));

  let offset = centralOffset;
  let totalChars = 0;
  const parts = [];
  let entriesRead = 0;

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
    if (!looksText) continue;
    if (uncompressedSize > MAX_TOTAL_EXTRACTED_CHARS * 4) continue;
    if (localOffset + 30 > bytes.length || readU32(view, localOffset) !== 0x04034b50) continue;

    const localNameLen = readU16(view, localOffset + 26);
    const localExtraLen = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) continue;

    const compressed = bytes.slice(dataStart, dataEnd);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = await inflateRaw(compressed);
    else continue;

    const text = decodeUtf8(content);
    if (!text.trim()) continue;
    if (totalChars + text.length > MAX_TOTAL_EXTRACTED_CHARS) {
      const remain = Math.max(0, MAX_TOTAL_EXTRACTED_CHARS - totalChars);
      if (remain > 0) parts.push(`\n===== ZIP ENTRY: ${name} =====\n${text.slice(0, remain)}`);
      totalChars = MAX_TOTAL_EXTRACTED_CHARS;
      break;
    }
    parts.push(`\n===== ZIP ENTRY: ${name} =====\n${text}`);
    totalChars += text.length;
  }

  return parts.join("\n");
}

function setAttachmentStatus(item, status, message = "") {
  item.status = status;
  const state = item.el?.querySelector(".attachment-state");
  if (state) {
    state.textContent = message || (status === "ready" ? t(currentLang, "attachment_ready") : status === "reading" ? t(currentLang, "attachment_reading") : t(currentLang, "attachment_error"));
    state.classList.toggle("error", status === "error");
  }
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
      item.text = await file.text();
      if (!item.text.trim()) throw new Error(t(currentLang, "attachment_error_emptyFile"));
      if (item.text.length > MAX_TOTAL_EXTRACTED_CHARS) item.text = item.text.slice(0, MAX_TOTAL_EXTRACTED_CHARS);
      item.kind = "text";
      setAttachmentStatus(item, "ready", t(currentLang, "attachment_ready"));
      return;
    }
    if (isZipFile(file)) {
      item.text = await extractZipText(file);
      if (!item.text.trim()) throw new Error(t(currentLang, "attachment_error_noZipText"));
      item.kind = "zip";
      setAttachmentStatus(item, "ready", t(currentLang, "attachment_ready"));
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
    const err = event.error;
    console.debug("[AI Assistant] Voice input error:", err);
    if (err === "no-speech" || err === "aborted") return; // benign; onend decides what happens next
    userStoppedMic = true;
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
    isListening = false;
    micBtn.classList.remove("active");
    micBtn.setAttribute("aria-pressed", "false");
    if (userStoppedMic) {
      setMicStatus("");
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
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/mic-permission.html") }, (tab) => {
      const tabId = tab?.id;
      if (!tabId) { resolve(); return; }
      chrome.tabs.onRemoved.addListener(function listener(closedId) {
        if (closedId === tabId) {
          chrome.tabs.onRemoved.removeListener(listener);
          resolve();
        }
      });
    });
  });
}

let micStarting = false;

async function startMic() {
  if (!SpeechRecognitionCtor || isStreaming || micStarting) return;
  micStarting = true;
  userStoppedMic = false;
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

async function handleSubmit(e, forcedQuestion = null, forcedIncludePageContext = null, forcedDisplayQuestion = null) {
  e?.preventDefault?.();
  const question = forcedQuestion !== null ? String(forcedQuestion).trim() : questionInput.value.trim();
  const attachmentText = attachmentContextText();
  if ((!question && !attachmentText) || isStreaming) return;

  const selectedModel = getSelectedModel();
  pendingModelLabel = selectedModel.label;
  pendingModelId = selectedModel.id;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  currentRequestId = requestId;

  questionInput.value = "";
  const displayQuestion = forcedDisplayQuestion !== null
    ? String(forcedDisplayQuestion).trim()
    : (question || t(currentLang, "attachedFilesFallback"));
  const readyAttachments = attachments.filter((a) => a.status === "ready");
  const displayContent = attachmentText
    ? `${displayQuestion}\n\n📎 ${readyAttachments.map((a) => a.name).join(", ")}`
    : displayQuestion;
  addBubble("user", displayContent);
  const questionForApi = `${question || "Please analyze the attached files."}${attachmentText}`;
  history.push({ role: "user", content: questionForApi, displayContent, modelLabel: "" });
  if (!currentConversationId) {
    currentConversationId = createConversation().id;
  }
  let convo = currentConversation();
  if (!convo) {
    convo = { id: currentConversationId, title: "", messages: [], updatedAt: Date.now() };
    conversations.unshift(convo);
  }
  convo.title = convo.title || makeTopicTitle(history);
  renderHistorySelect();
  await saveConversations();
  setStreaming(true);

  let pageContext = null;
  const shouldIncludePageContext = forcedIncludePageContext === null
    ? includeContextToggle.checked === true
    : forcedIncludePageContext === true;
  if (shouldIncludePageContext) {
    // Capture the page at the moment the user submits the request. The API
    // request must never reuse the page context shown or captured earlier.
    pageContext = await getActivePageContext();
    updateContextBar(pageContext);
  }

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
  history[history.length - 1].pageContext = pageContext ? { title: pageContext.title, url: pageContext.url } : null;
  if (pageContext && previousPageContext && previousPageContext.url !== pageContext.url) {
    pageContext = { ...pageContext, previousPage: previousPageContext };
  }

  ensurePort().postMessage({
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
      includePageContext: shouldIncludePageContext,
      pageContext: shouldIncludePageContext ? pageContext : null,
      // When the user changes pages, do not send the previous page's
      // conversation turns to the model. The UI history remains intact, but
      // old assistant answers can themselves contain facts from Page B and
      // therefore act as stale page context even when the new Page C text is
      // supplied correctly. A page change starts a fresh model context; normal
      // follow-up questions on the same page retain conversation history.
      history: (pageContext && previousPageContext && pageContext.url !== previousPageContext.url)
        ? []
        : getApiHistory().slice(0, -1),
      images: readyAttachments.filter((a) => a.kind === "image" && a.dataUrl).map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
      // Send the exact model selected at submit time.
      modelId: selectedModel.id,
      provider: selectedModel.provider,
      apiModel: selectedModel.apiModel,
      thinking: selectedModel.thinking,
    },
  });
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
      const stored = await chrome.storage.local.get(PREFERRED_TRANSLATION_LANGUAGE_KEY);
      const code = stored[PREFERRED_TRANSLATION_LANGUAGE_KEY] || "en";
      const languageKey = {
        "en": "contextAction_language_en",
        "zh-CN": "contextAction_language_zhCN",
        "zh-TW": "contextAction_language_zhTW",
        "fr": "contextAction_language_fr",
        "ja": "contextAction_language_ja",
        "es": "contextAction_language_es",
      }[code] || "contextAction_language_en";
      instruction = t(lang, "contextAction_translate_prefix", { language: t(lang, languageKey) });
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
  const prompt = `${instruction}\n\n${t(lang, "contextAction_highlightedText_label")}:\n${pending.text}`;
  await handleSubmit(null, prompt, false);
  await chrome.storage.local.set({ [PENDING_CONTEXT_ACTION_KEY]: null });
}

async function consumePendingContextAction(pending = null) {
  let action = pending;
  if (!action) {
    const stored = await chrome.storage.local.get(PENDING_CONTEXT_ACTION_KEY);
    action = stored[PENDING_CONTEXT_ACTION_KEY];
  }
  if (!action) return;
  // Ignore a stale menu action after 2 minutes, or one that was created for a
  // different active tab. This prevents an old selection from being reused.
  if (!action.createdAt || Date.now() - action.createdAt > 120000) {
    await chrome.storage.local.set({ [PENDING_CONTEXT_ACTION_KEY]: null });
    return;
  }
  const activeTab = await getCurrentActiveTab();
  if (action.tabId && activeTab?.id && action.tabId !== activeTab.id) return;
  await processContextAction(action);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CONTEXT_ACTION") {
    consumePendingContextAction(message.pending).catch((err) => console.debug("[AI Assistant] Context action failed:", err));
  }
});

chatForm.addEventListener("submit", handleSubmit);

// Quick actions always operate on the page that is active at the moment the
// button is clicked. They deliberately force page context on, so they still
// work when the manual "Read current page" toggle is unchecked.
async function runQuickPageAction(apiPromptKey, displayPromptKey) {
  if (isStreaming) return;
  const lang = currentLang || await getStoredLanguage();
  const apiPrompt = t("en", apiPromptKey);
  const displayPrompt = t(lang, displayPromptKey);
  await handleSubmit(null, apiPrompt, true, displayPrompt);
}

quickSummarizeBtn?.addEventListener("click", () => {
  runQuickPageAction("quickSummarize_prompt", "quickSummarize_prompt");
});

quickTranslateBtn?.addEventListener("click", () => {
  runQuickPageAction("quickTranslate_prompt", "quickTranslate_prompt");
});

quickExplainBtn?.addEventListener("click", () => {
  runQuickPageAction("quickExplain_prompt", "quickExplain_prompt");
});

quickKeyPointsBtn?.addEventListener("click", () => {
  runQuickPageAction("quickKeyPoints_prompt", "quickKeyPoints_prompt");
});

questionInput.addEventListener("keydown", (e) => {
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

includeContextToggle.addEventListener("change", async () => {
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
    const ctx = await getActivePageContext();
    // Ignore a slower read if the user has already switched tabs again.
    if (token !== pageContextRefreshToken) return;
    updateContextBar(ctx);
  } catch (err) {
    console.debug("[AI Assistant] Unable to refresh page context:", err);
    if (token === pageContextRefreshToken) updateContextBar(null);
  }
}

chrome.tabs.onActivated.addListener(() => {
  refreshActivePageContext().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!includeContextToggle.checked || tabId !== lastPageContextTabId) return;
  // Refresh after navigation commits or when the document title changes.
  if (changeInfo.status === "complete" || changeInfo.title) {
    refreshActivePageContext().catch(() => {});
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    refreshActivePageContext().catch(() => {});
  }
});

(async function init() {
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
  connectPort();
  await consumePendingContextAction();
  if (includeContextToggle.checked) {
    await refreshActivePageContext();
  }
})();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[HISTORY_STORAGE_KEY]) return;
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
  // 2. Even outside a live request, never let this reactive refresh touch
  //    the model dropdown (syncModel:false) - it should only follow
  //    explicit navigation (selecting a conversation, or the initial
  //    restore in init()), not an incidental background sync.
  if (isStreaming) return;
  loadConversations({ syncModel: false })
    .then(() => scheduleHistoryRender())
    .catch((err) => console.error("[AI Assistant] Unable to refresh restored history:", err));
});
