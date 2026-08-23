// options.js — Settings page for Brave AI Assistant
const apiKeyInput = document.getElementById("apiKey");
const geminiApiKeyInput = document.getElementById("geminiApiKey");
const claudeApiKeyInput = document.getElementById("claudeApiKey");
const customPromptInput = document.getElementById("customPrompt");
const msgEl = document.getElementById("msg");
const backupHistoryBtn = document.getElementById("backupHistory");
const restoreHistoryBtn = document.getElementById("restoreHistory");
const restoreHistoryFile = document.getElementById("restoreHistoryFile");
const deleteHistoryBtn = document.getElementById("deleteHistory");
const deleteConfirm = document.getElementById("deleteConfirm");
const confirmYes = document.getElementById("confirmYes");
const confirmNo = document.getElementById("confirmNo");

chrome.storage.local.get(
  ["apiKey", "geminiApiKey", "claudeApiKey", "customPrompt"],
  ({ apiKey, geminiApiKey, claudeApiKey, customPrompt }) => {
    if (apiKey) apiKeyInput.value = apiKey;
    if (geminiApiKey) geminiApiKeyInput.value = geminiApiKey;
    if (claudeApiKey) claudeApiKeyInput.value = claudeApiKey;
    if (customPrompt) customPromptInput.value = customPrompt;
  }
);

document.getElementById("save").addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  const geminiKey = geminiApiKeyInput.value.trim();
  const claudeKey = claudeApiKeyInput.value.trim();
  const customPrompt = customPromptInput.value.trim();
  if (!key && !geminiKey && !claudeKey) {
    msgEl.style.color = "#f55b5b";
    msgEl.textContent = "Enter at least one API key (DeepSeek, Gemini, or Claude)";
    return;
  }
  await chrome.storage.local.set({ apiKey: key, geminiApiKey: geminiKey, claudeApiKey: claudeKey, customPrompt });
  msgEl.style.color = "#4ade80";
  msgEl.textContent = "Saved ✓";
  setTimeout(() => (msgEl.textContent = ""), 1500);
});

const HISTORY_STORAGE_KEY = "conversationHistory";

function sanitizeFilePart(text) {
  return String(text || "Untitled")
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Untitled";
}

function formatDate(timestamp) {
  if (!timestamp) return "Unknown date";
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? "Unknown date" : d.toISOString();
}

function conversationToText(conversation, index) {
  const lines = [
    `Conversation ${index + 1}`,
    `Topic: ${conversation.title || "Untitled conversation"}`,
    `Created/Updated: ${formatDate(conversation.updatedAt)}`,
    `ID: ${conversation.id || ""}`,
    "",
    "=".repeat(72),
    "",
  ];

  for (const message of conversation.messages || []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role === "user" ? "USER" : "ASSISTANT";
    const content = message.displayContent || message.content || "";
    lines.push(`[${role}]`);
    lines.push(content);
    lines.push("", "-".repeat(72), "");
  }
  return lines.join("\n");
}

function u16le(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32le(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

let crcTable = null;
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(bytes) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Creates a standards-compliant ZIP archive using the "stored" method (no compression).
// It is intentionally dependency-free so the extension can export backups offline.
function createZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const localHeader = concatBytes(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16le(20),           // version needed to extract
      u16le(0x0800),       // UTF-8 filenames
      u16le(0),            // stored, no compression
      u16le(0),            // time
      u16le(0),            // date
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(nameBytes.length),
      u16le(0),
      nameBytes,
      data
    );
    localParts.push(localHeader);

    const centralHeader = concatBytes(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16le(20),             // version made by
      u16le(20),             // version needed
      u16le(0x0800),         // UTF-8 filenames
      u16le(0),              // stored
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(nameBytes.length),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(0),
      u32le(localOffset),
      nameBytes
    );
    centralParts.push(centralHeader);
    localOffset += localHeader.length;
  }

  const localData = concatBytes(...localParts);
  const centralData = concatBytes(...centralParts);
  const end = concatBytes(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(centralData.length),
    u32le(localData.length),
    u16le(0)
  );

  return concatBytes(localData, centralData, end);
}


// Reads standard ZIP backups offline, including Deflate-compressed WinZip archives.
// The exporter still writes uncompressed entries, while restore accepts both
// ZIP methods 0 (stored) and 8 (Deflate).
function readU16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32le(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

async function extractZipEntries(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries = new Map();

  // Find the End of Central Directory record. This lets us correctly handle
  // normal WinZip/Deflate archives, including archives that use data descriptors.
  const EOCD = 0x06054b50;
  let eocd = -1;
  const min = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (readU32le(bytes, i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Invalid ZIP file: end of central directory not found");

  const entryCount = readU16le(bytes, eocd + 10);
  const centralSize = readU32le(bytes, eocd + 12);
  const centralOffset = readU32le(bytes, eocd + 16);
  if (entryCount > 200) throw new Error("Backup contains too many ZIP entries");
  if (centralOffset + centralSize > bytes.length) throw new Error("Invalid ZIP central directory");

  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || readU32le(bytes, offset) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const flags = readU16le(bytes, offset + 8);
    const method = readU16le(bytes, offset + 10);
    const compressedSize = readU32le(bytes, offset + 20);
    const uncompressedSize = readU32le(bytes, offset + 24);
    const nameLength = readU16le(bytes, offset + 28);
    const extraLength = readU16le(bytes, offset + 30);
    const commentLength = readU16le(bytes, offset + 32);
    const localOffset = readU32le(bytes, offset + 42);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));

    // ZIP64 is intentionally rejected rather than silently misreading sizes.
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 backups are not supported");
    }

    if (localOffset + 30 > bytes.length || readU32le(bytes, localOffset) !== 0x04034b50) {
      throw new Error("Invalid ZIP local header");
    }
    const localNameLength = readU16le(bytes, localOffset + 26);
    const localExtraLength = readU16le(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > bytes.length || dataEnd > bytes.length) throw new Error("ZIP entry exceeds file size");

    const compressed = bytes.slice(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser does not support ZIP Deflate decompression");
      }
      try {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (err) {
        throw new Error(`Unable to decompress ZIP entry "${name}": ${err?.message || "invalid Deflate data"}`);
      }
    } else {
      throw new Error(`Unsupported ZIP compression method ${method}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`Invalid ZIP entry size for "${name}"`);
    }
    entries.set(name, decoder.decode(data));
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function readBackupFile(file) {
  if (!file) throw new Error("No backup file selected");
  if (file.size > 50 * 1024 * 1024) throw new Error("Backup file is too large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await extractZipEntries(bytes);
  const jsonText = entries.get("conversation-history.json");
  if (!jsonText) throw new Error("This ZIP is not a Brave AI Assistant history backup");

  let backup;
  try {
    backup = JSON.parse(jsonText);
  } catch {
    throw new Error("The backup's conversation-history.json is invalid");
  }

  if (
    !backup ||
    backup.format !== "Brave AI Assistant Conversation History Backup" ||
    !Array.isArray(backup.conversations)
  ) {
    throw new Error("Unsupported Brave AI Assistant backup format");
  }

  return backup.conversations;
}

function normalizeRestoredConversation(conversation, index) {
  if (!conversation || typeof conversation !== "object") return null;
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({
          role: m.role,
          content: String(m.content || ""),
          displayContent: String(m.displayContent || m.content || ""),
          modelLabel: String(m.modelLabel || ""),
          modelId: String(m.modelId || ""),
        }))
    : [];

  if (!messages.length) return null;

  const fallbackId = `restored-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: String(conversation.id || fallbackId),
    title: String(conversation.title || "").trim() || makeRestoredTopicTitle(messages),
    messages,
    updatedAt: Number.isFinite(Number(conversation.updatedAt))
      ? Number(conversation.updatedAt)
      : Date.now(),
  };
}

function makeRestoredTopicTitle(messages) {
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => cleanForTopic(m.displayContent || m.content))
    .filter(Boolean);
  if (!userTexts.length) return "Restored Conversation";
  const words = userTexts.join(" ").split(/\s+/).filter(Boolean);
  const title = words.slice(0, 10).join(" ");
  return title || "Restored Conversation";
}

function makeBackupEntries(conversations) {
  const sorted = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const exportedAt = new Date().toISOString();
  const backup = {
    format: "Brave AI Assistant Conversation History Backup",
    version: 1,
    exportedAt,
    conversationCount: sorted.length,
    conversations: sorted,
  };

  const entries = [
    {
      name: "conversation-history.json",
      data: JSON.stringify(backup, null, 2),
    },
    {
      name: "README.txt",
      data: [
        "Brave AI Assistant Conversation History Backup",
        "",
        `Exported: ${exportedAt}`,
        `Conversations: ${sorted.length}`,
        "",
        "This backup contains conversation history only.",
        "API keys and custom prompts are not included.",
        "",
      ].join("\n"),
    },
  ];

  const usedNames = new Set();
  sorted.forEach((conversation, index) => {
    const base = sanitizeFilePart(conversation.title || `Conversation ${index + 1}`);
    let filename = `conversations/${String(index + 1).padStart(3, "0")}-${base}.txt`;
    let suffix = 2;
    while (usedNames.has(filename) || filename === "conversation-history.json" || filename === "README.txt") {
      filename = `conversations/${String(index + 1).padStart(3, "0")}-${base}-${suffix++}.txt`;
    }
    usedNames.add(filename);
    entries.push({ name: filename, data: conversationToText(conversation, index) });
  });
  return entries;
}


async function restoreHistory() {
  restoreHistoryBtn.disabled = true;
  backupHistoryBtn.disabled = true;
  msgEl.style.color = "#8b91a3";
  msgEl.textContent = "Restoring history…";

  try {
    const restored = await readBackupFile(restoreHistoryFile.files?.[0]);
    const normalized = restored
      .map(normalizeRestoredConversation)
      .filter(Boolean)
      .slice(0, 100);

    if (!normalized.length) {
      throw new Error("The backup contains no usable conversations");
    }

    const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const existing = Array.isArray(stored[HISTORY_STORAGE_KEY]) ? stored[HISTORY_STORAGE_KEY] : [];

    // Merge by conversation ID. Imported copies replace matching IDs, while
    // conversations created after the backup remain untouched.
    const byId = new Map();
    for (const convo of existing) {
      if (convo?.id) byId.set(String(convo.id), convo);
    }
    for (const convo of normalized) {
      byId.set(String(convo.id), convo);
    }

    const merged = [...byId.values()]
      .filter((c) => c?.messages?.length)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 100);

    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: merged });

    msgEl.style.color = "#4ade80";
    msgEl.textContent = `History restored (${normalized.length} conversation${normalized.length === 1 ? "" : "s"})`;
    restoreHistoryFile.value = "";
    setTimeout(() => (msgEl.textContent = ""), 3000);
  } catch (err) {
    console.error("[Brave AI Assistant] Unable to restore history:", err);
    msgEl.style.color = "#f55b5b";
    msgEl.textContent = `Restore failed: ${err?.message || "Unknown error"}`;
    restoreHistoryFile.value = "";
  } finally {
    backupHistoryBtn.disabled = false;
    restoreHistoryBtn.disabled = false;
  }
}

async function backupHistory() {
  backupHistoryBtn.disabled = true;
  msgEl.style.color = "#8b91a3";
  msgEl.textContent = "Preparing backup…";
  try {
    const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const conversations = Array.isArray(stored[HISTORY_STORAGE_KEY]) ? stored[HISTORY_STORAGE_KEY] : [];
    if (!conversations.length) {
      msgEl.style.color = "#f5c451";
      msgEl.textContent = "No conversation history to back up";
      return;
    }

    const entries = makeBackupEntries(conversations);
    const zipBytes = createZip(entries);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `brave-ai-assistant-history-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    msgEl.style.color = "#4ade80";
    msgEl.textContent = `Backup created (${conversations.length} conversation${conversations.length === 1 ? "" : "s"})`;
    setTimeout(() => (msgEl.textContent = ""), 2500);
  } catch (err) {
    console.error("[Brave AI Assistant] Unable to back up history:", err);
    msgEl.style.color = "#f55b5b";
    msgEl.textContent = `Backup failed: ${err?.message || "Unknown error"}`;
  } finally {
    backupHistoryBtn.disabled = false;
  }
}

backupHistoryBtn.addEventListener("click", backupHistory);


restoreHistoryBtn.addEventListener("click", () => restoreHistoryFile.click());
restoreHistoryFile.addEventListener("change", restoreHistory);


function openDeleteConfirmation() {
  deleteConfirm.classList.add("show");
  confirmNo.focus();
}

function closeDeleteConfirmation() {
  deleteConfirm.classList.remove("show");
}

async function deleteAllHistory() {
  deleteHistoryBtn.disabled = true;
  backupHistoryBtn.disabled = true;
  restoreHistoryBtn.disabled = true;
  closeDeleteConfirmation();
  msgEl.style.color = "#8b91a3";
  msgEl.textContent = "Deleting history…";

  try {
    await chrome.storage.local.remove(HISTORY_STORAGE_KEY);
    msgEl.style.color = "#4ade80";
    msgEl.textContent = "All history deleted";
    setTimeout(() => (msgEl.textContent = ""), 2500);
  } catch (err) {
    console.error("[Brave AI Assistant] Unable to delete history:", err);
    msgEl.style.color = "#f55b5b";
    msgEl.textContent = `Delete failed: ${err?.message || "Unknown error"}`;
  } finally {
    deleteHistoryBtn.disabled = false;
    backupHistoryBtn.disabled = false;
    restoreHistoryBtn.disabled = false;
  }
}

deleteHistoryBtn.addEventListener("click", openDeleteConfirmation);
confirmNo.addEventListener("click", closeDeleteConfirmation);
confirmYes.addEventListener("click", deleteAllHistory);
deleteConfirm.addEventListener("click", (event) => {
  if (event.target === deleteConfirm) closeDeleteConfirmation();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && deleteConfirm.classList.contains("show")) closeDeleteConfirmation();
});

// ---------- Theme ----------
const THEME_STORAGE_KEY = "themePreference";
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
const deviceThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function getResolvedTheme(preference) {
  return preference === "device" ? (deviceThemeQuery.matches ? "dark" : "light") : preference;
}

function applyTheme(preference) {
  const normalized = ["light", "dark", "device"].includes(preference) ? preference : "device";
  document.documentElement.dataset.theme = getResolvedTheme(normalized);
  themeButtons.forEach((button) => {
    const active = button.dataset.themeChoice === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function loadTheme() {
  const stored = await chrome.storage.local.get(THEME_STORAGE_KEY);
  applyTheme(stored[THEME_STORAGE_KEY] || "device");
}

themeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const preference = button.dataset.themeChoice;
    await chrome.storage.local.set({ [THEME_STORAGE_KEY]: preference });
    applyTheme(preference);
  });
});

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
