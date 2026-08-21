// sidepanel/sidepanel.js —— Fixed version: no trailing spaces; keeps import "../models.js"; API Key configuration moved to Settings
import { MODELS, findModelById } from "../models.js";


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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[THEME_STORAGE_KEY]) {
    applyTheme(changes[THEME_STORAGE_KEY].newValue || "device");
  }
});

loadTheme();


const PORT_NAME = "deepseek-chat";
const MAX_HISTORY_TURNS = 8;
const HISTORY_STORAGE_KEY = "conversationHistory";
const CURRENT_CONVERSATION_KEY = "currentConversationId";
const NEW_TOPIC_VALUE = "__new__";
const MAX_SAVED_CONVERSATIONS = 100;

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
    const token = `@@INLINE_CODE_${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  // Markdown links: only permit safe navigable protocols.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    try {
      const u = new URL(href, location.href);
      if (!["http:", "https:", "mailto:"].includes(u.protocol)) return label;
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
    s = s.replace(`@@INLINE_CODE_${i}@@`, codeSpans[i]);
  }
  return s;
}

function isTableSeparator(line) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
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
      flushList();
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
      out.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
  "UL", "OL", "LI", "BLOCKQUOTE", "HR", "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "DIV"
]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "class"]);

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

    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      try {
        const u = new URL(href, location.href);
        if (!["http:", "https:", "mailto:"].includes(u.protocol)) {
          el.replaceWith(document.createTextNode(el.textContent || ""));
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

function setBubbleContent(bubbleEl, text, role) {
  const textEl = getBubbleTextEl(bubbleEl);
  if (!textEl) return;
  if (role === "assistant") {
    textEl.innerHTML = sanitizeRenderedHtml(markdownToHtml(text));
  } else {
    textEl.textContent = text;
  }
}

function addBubble(role, text, modelLabel) {
  emptyState.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}`;
  if (role === "assistant" && modelLabel) {
    const tag = document.createElement("div");
    tag.className = "model-tag";
    tag.textContent = modelLabel;
    wrap.appendChild(tag);
  }
  const textEl = document.createElement("div");
  textEl.className = "bubble-text";
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

// ---------- Open settings page ----------
optionsBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (err) {
    console.error("[Brave AI Assistant] Unable to open settings page:", err);
    // Fallback for browsers/versions that do not implement openOptionsPage.
    await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
  }
});

// ---------- Streaming message handling ----------
function setStreaming(streaming) {
  isStreaming = streaming;
  sendBtn.disabled = streaming;
  questionInput.disabled = streaming;
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

async function getActivePageContext() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) return null;

  try {
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE_CONTENT" }, (value) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(value || null);
      });
    });
    if (response?.ok && response.data?.text?.trim()) {
      return {
        title: String(response.data.title || tab.title || ""),
        url: String(response.data.url || tab.url || ""),
        text: String(response.data.text).slice(0, 20000),
      };
    }
  } catch (err) {
    console.debug("[Brave AI Assistant] Content script unavailable:", err);
  }

  try {
    if (!/^https?:\/\//i.test(String(tab.url || ""))) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: location.href,
        text: document.body?.innerText || document.documentElement?.innerText || "",
      }),
    });
    const data = results?.[0]?.result;
    const text = String(data?.text || "").trim();
    if (!text) return null;
    return {
      title: String(data?.title || tab.title || ""),
      url: String(data?.url || tab.url || ""),
      text: text.slice(0, 20000),
    };
  } catch (err) {
    console.warn("[Brave AI Assistant] Unable to read current page:", err);
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
      history.push({ role: "assistant", content: currentAssistantText, displayContent: currentAssistantText, modelLabel: pendingModelLabel });
      currentAssistantBubble = null;
      setStreaming(false);
      saveConversations().catch((err) => console.error("[Brave AI Assistant] Unable to save conversation:", err));
      break;
    }
    case "ERROR": {
      if (currentAssistantBubble) {
        currentAssistantBubble.remove();
        currentAssistantBubble = null;
      }
      addBubble("error", `Error:${msg.error}`);
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
  return words.slice(0, 10).join(" ") || "New Topic";
}

function toStoredMessage(message) {
  return {
    role: message.role,
    content: message.content,
    displayContent: message.displayContent || message.content,
    modelLabel: message.modelLabel || "",
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
}

function renderHistorySelect() {
  const previous = historySelect.value;
  historySelect.innerHTML = "";
  const newOpt = document.createElement("option");
  newOpt.value = NEW_TOPIC_VALUE;
  newOpt.textContent = "New Topic";
  historySelect.appendChild(newOpt);

  const items = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const convo of items) {
    if (!convo.messages?.length) continue;
    const opt = document.createElement("option");
    opt.value = convo.id;
    opt.textContent = convo.title || makeTopicTitle(convo.messages) || "Untitled conversation";
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

async function loadConversations() {
  const stored = await chrome.storage.local.get([HISTORY_STORAGE_KEY, CURRENT_CONVERSATION_KEY]);
  conversations = Array.isArray(stored[HISTORY_STORAGE_KEY]) ? stored[HISTORY_STORAGE_KEY] : [];
  currentConversationId = stored[CURRENT_CONVERSATION_KEY] || null;

  if (currentConversationId) {
    const convo = conversations.find((c) => c.id === currentConversationId);
    if (convo?.messages?.length) {
      history = convo.messages.map((m) => ({ ...m }));
      renderConversation(history);
      renderHistorySelect();
      historySelect.value = currentConversationId;
      return;
    }
  }
  renderHistorySelect();
}

async function selectConversation(id) {
  if (id === NEW_TOPIC_VALUE) {
    if (isStreaming) {
      historySelect.value = currentConversationId || NEW_TOPIC_VALUE;
      return;
    }

    // New Topic is a fresh DeepSeek conversation: discard the active
    // conversation state, clear the composer, and leave the API ready for
    // the user's first message. The new conversation is persisted only
    // when that first message is actually sent.
    startNewTopic();
    renderHistorySelect();
    questionInput.focus();
    return;
  }
  const convo = conversations.find((c) => c.id === id);
  if (!convo) return;
  if (isStreaming) {
    historySelect.value = currentConversationId || NEW_TOPIC_VALUE;
    return;
  }
  currentConversationId = convo.id;
  history = (convo.messages || []).map((m) => ({ ...m }));
  attachments = [];
  renderAttachments();
  questionInput.value = "";
  renderConversation(history);
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
      imageParts.push(`- ${a.name} (image attachment; current DeepSeek API does not accept image input directly)`);
    } else if (a.text) {
      textParts.push(`\n===== FILE: ${a.name} =====\n${a.text}`);
    }
  }
  return [
    "\n\n[ATTACHMENTS]",
    imageParts.length ? `Images attached (not sent as image data):\n${imageParts.join("\n")}` : "",
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
    throw new Error("This browser does not support ZIP decompression");
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
  if (eocd < 0) throw new Error("Invalid ZIP file");

  const entryCount = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`ZIP contains too many files (max ${MAX_ZIP_ENTRIES})`);
  if (centralOffset + centralSize > bytes.length) throw new Error("Invalid ZIP central directory");

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
    state.textContent = message || (status === "ready" ? "Ready" : status === "reading" ? "Reading…" : "Error");
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
    state.textContent = item.status === "ready" ? "Ready" : item.status === "reading" ? "Reading…" : "Error";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.title = `Remove ${item.name}`;
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
    if (file.size > MAX_FILE_BYTES) throw new Error("File is larger than 12 MB");
    if (isImageFile(file)) {
      item.kind = "image";
      item.text = "";
      setAttachmentStatus(item, "ready", "Attached");
      return;
    }
    if (isTextFile(file)) {
      item.text = await file.text();
      if (!item.text.trim()) throw new Error("File is empty");
      if (item.text.length > MAX_TOTAL_EXTRACTED_CHARS) item.text = item.text.slice(0, MAX_TOTAL_EXTRACTED_CHARS);
      item.kind = "text";
      setAttachmentStatus(item, "ready", "Ready");
      return;
    }
    if (isZipFile(file)) {
      item.text = await extractZipText(file);
      if (!item.text.trim()) throw new Error("No supported text/HTML files found in ZIP");
      item.kind = "zip";
      setAttachmentStatus(item, "ready", "Ready");
      return;
    }
    throw new Error("Unsupported file type");
  } catch (err) {
    setAttachmentStatus(item, "error", err?.message || "Unable to read");
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
  { code: "en-US", label: "EN", name: "English", joiner: " " },
  { code: "zh-CN", label: "中", name: "Mandarin Chinese", joiner: "" },
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
  micLangBtn.textContent = lang.label;
  micLangBtn.title = `Voice input language: ${lang.name}. Click to switch.`;
  micBtn.title = isListening ? `Stop voice input (${lang.name})` : `Start voice input (${lang.name})`;
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
    console.debug("[Brave AI Assistant] Unable to restore voice input language:", err);
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
    console.debug("[Brave AI Assistant] Voice input error:", err);
    if (err === "no-speech" || err === "aborted") return; // benign; onend decides what happens next
    userStoppedMic = true;
    const messages = {
      "not-allowed": "Microphone access is blocked. Click the mic again to grant permission.",
      "service-not-allowed": "Microphone access is blocked. Click the mic again to grant permission.",
      "audio-capture": "No microphone was found. Check that one is connected.",
      network:
        "Voice input needs an online recognition service that Brave currently blocks or breaks for most users. This usually works in Chrome; Brave support depends on your version.",
    };
    setMicStatus(messages[err] || `Voice input error: ${err}`, true, err === "network" ? 0 : 6000);
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
      console.debug("[Brave AI Assistant] Unable to auto-restart voice input:", err);
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
          ? "Microphone is blocked for this extension. Allow it in the tab that just opened, then try again."
          : "Requesting microphone permission in a new tab…"
      );
      await openMicPermissionTab();
      const recheck = await ensureMicPermission();
      if (recheck !== "granted") {
        setMicStatus("Microphone permission was not granted, so voice input can't start.", true, 6000);
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
      setMicStatus(`Listening… (${currentMicLang().name})`);
    } catch (err) {
      console.error("[Brave AI Assistant] Unable to start voice input:", err);
      setMicStatus("Unable to start voice input.", true, 6000);
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
  micBtn.title = "Voice input is not supported in this browser";
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

async function handleSubmit(e) {
  e.preventDefault();
  const question = questionInput.value.trim();
  const attachmentText = attachmentContextText();
  if ((!question && !attachmentText) || isStreaming) return;

  const selectedModel = getSelectedModel();
  pendingModelLabel = selectedModel.label;

  questionInput.value = "";
  const displayQuestion = question || "Attached files";
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
  if (includeContextToggle.checked) {
    pageContext = await getActivePageContext();
    updateContextBar(pageContext);
  }

  ensurePort().postMessage({
    type: "ASK",
    payload: {
      question: questionForApi,
      pageContext,
      history: getApiHistory().slice(0, -1),
      modelId: selectedModel.id,
    },
  });
}

chatForm.addEventListener("submit", handleSubmit);

questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

clearBtn.addEventListener("click", async () => {
  if (isStreaming) return;
  if (isListening) {
    userStoppedMic = true;
    stopMic();
  }
  startNewTopic();
  renderHistorySelect();
});

historySelect.addEventListener("change", async () => {
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
// is currently viewing. This does not send anything to DeepSeek; the refreshed
// context is used only when the next message is submitted.
let pageContextRefreshToken = 0;
let lastPageContextTabId = null;

async function refreshActivePageContext() {
  if (!includeContextToggle.checked) return;
  const token = ++pageContextRefreshToken;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs?.[0];
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
    console.debug("[Brave AI Assistant] Unable to refresh page context:", err);
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
  await restoreSelectedModel();
  await loadConversations();
  renderHistorySelect();
  connectPort();
  if (includeContextToggle.checked) {
    await refreshActivePageContext();
  }
})();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[HISTORY_STORAGE_KEY]) return;
  // Settings > Restore History updates storage from a separate page. Refresh
  // the dropdown and keep the user on the current conversation unless it no
  // longer exists.
  loadConversations().catch((err) => console.error("[Brave AI Assistant] Unable to refresh restored history:", err));
});
