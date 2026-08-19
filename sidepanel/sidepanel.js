// sidepanel/sidepanel.js —— Fixed version: no trailing spaces; keeps import "../models.js"; API Key configuration moved to Settings
import { MODELS, findModelById } from "../models.js";

const PORT_NAME = "deepseek-chat";
const MAX_HISTORY_TURNS = 8;

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
  const textEl = document.createElement("span");
  textEl.className = "bubble-text";
  textEl.textContent = text;
  wrap.appendChild(textEl);
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
}

async function getActivePageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE_CONTENT" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      resolve(response.data);
    });
  });
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
        getBubbleTextEl(currentAssistantBubble).textContent = currentAssistantText;
        scrollToBottom();
      }
      break;
    }
    case "DONE": {
      if (currentAssistantBubble) {
        currentAssistantBubble.classList.remove("pending");
      }
      history.push({ role: "assistant", content: currentAssistantText });
      trimHistory();
      currentAssistantBubble = null;
      setStreaming(false);
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

function trimHistory() {
  if (history.length > MAX_HISTORY_TURNS * 2) {
    history = history.slice(-MAX_HISTORY_TURNS * 2);
  }
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

async function handleSubmit(e) {
  e.preventDefault();
  const question = questionInput.value.trim();
  const attachmentText = attachmentContextText();
  if ((!question && !attachmentText) || isStreaming) return;

  const selectedModel = getSelectedModel();
  pendingModelLabel = selectedModel.label;

  questionInput.value = "";
  const displayQuestion = question || "Attached files";
  addBubble("user", attachmentText ? `${displayQuestion}\n\n📎 ${attachments.filter((a) => a.status === "ready").map((a) => a.name).join(", ")}` : displayQuestion);
  const questionForApi = `${question || "Please analyze the attached files."}${attachmentText}`;
  history.push({ role: "user", content: questionForApi });
  trimHistory();
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
      history: history.slice(0, -1),
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

clearBtn.addEventListener("click", () => {
  history = [];
  attachments = [];
  renderAttachments();
  chatLog.innerHTML = "";
  chatLog.appendChild(emptyState);
  emptyState.hidden = false;
});

includeContextToggle.addEventListener("change", async () => {
  if (includeContextToggle.checked) {
    const ctx = await getActivePageContext();
    updateContextBar(ctx);
  } else {
    updateContextBar(null);
  }
});

(async function init() {
  populateModelSelect();
  await restoreSelectedModel();
  connectPort();
  if (includeContextToggle.checked) {
    const ctx = await getActivePageContext();
    updateContextBar(ctx);
  }
})();