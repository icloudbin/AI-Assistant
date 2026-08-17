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

// ---------- Write the reply back to the web page ----------
function flashButton(btn, label, ok) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.title = label;
  btn.classList.add(ok ? "mini-btn-ok" : "mini-btn-error");
  const duration = label.length > 8 ? 2600 : 1600;
  setTimeout(() => {
    btn.textContent = original;
    btn.title = "";
    btn.classList.remove("mini-btn-ok", "mini-btn-error");
  }, duration);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashButton(btn, "Copied ✓", true);
  } catch (err) {
    flashButton(btn, "Copy failed", false);
  }
}

async function insertIntoPage(text, mode, btn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    flashButton(btn, "No tab found", false);
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "INSERT_TEXT", text, mode }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("[Brave AI Assistant] Could not connect to the web page. Original error:", chrome.runtime.lastError.message);
      flashButton(btn, "Refresh the web page and try again", false);
      return;
    }
    if (!response?.ok) {
      console.warn("[Brave AI Assistant] Insert failed：", response?.error);
      flashButton(btn, response?.error || "Insert failed", false);
      return;
    }
    flashButton(btn, "Inserted ✓", true);
  });
}

function addMessageActions(bubbleEl, text) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  const cursorBtn = document.createElement("button");
  cursorBtn.type = "button";
  cursorBtn.className = "mini-btn";
  cursorBtn.textContent = "Insert at cursor";
  cursorBtn.addEventListener("click", () => insertIntoPage(text, "cursor", cursorBtn));

  const replaceBtn = document.createElement("button");
  replaceBtn.type = "button";
  replaceBtn.className = "mini-btn";
  replaceBtn.textContent = "Replace all content";
  replaceBtn.addEventListener("click", () => insertIntoPage(text, "replace", replaceBtn));

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "mini-btn";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => copyToClipboard(text, copyBtn));

  bar.append(cursorBtn, replaceBtn, copyBtn);
  bubbleEl.appendChild(bar);
}

// ---------- Streaming message handling ----------
function setStreaming(streaming) {
  isStreaming = streaming;
  sendBtn.disabled = streaming;
  questionInput.disabled = streaming;
  modelSelect.disabled = streaming;
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
        addMessageActions(currentAssistantBubble, currentAssistantText);
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

async function handleSubmit(e) {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question || isStreaming) return;

  const selectedModel = getSelectedModel();
  pendingModelLabel = selectedModel.label;

  questionInput.value = "";
  addBubble("user", question);
  history.push({ role: "user", content: question });
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
      question,
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