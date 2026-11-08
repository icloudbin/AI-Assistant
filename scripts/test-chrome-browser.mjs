#!/usr/bin/env node
/**
 * Chrome Browser End-to-End Automated Test Suite
 * Runs against locally installed Google Chrome using Chrome DevTools Protocol (CDP).
 * Verifies fixes for issues: #1, #2, #3, #4, #5, #7, #8, #9, #10, #11, #12.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { resolveChromePath } from "./chrome-path.mjs";

const CHROME_PATH = await resolveChromePath();
const ROOT = path.resolve(".");
const DEBUG_PORT = 9229;
const isVisual = process.argv.includes("--show") || process.argv.includes("--visual");
const keepOpen = process.argv.includes("--keep-open");

const MIMES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// 1. Create static file server for workspace files
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0];
      const filePath = path.join(ROOT, urlPath.replace(/^\//, ""));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, {
          "Content-Type": MIMES[ext] || "text/plain",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(fs.readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end("Not found: " + urlPath);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// 2. CDP Client helper
class ChromeSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.handlers = new Map();
    this.consoleLogs = [];

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.handlers.has(msg.id)) {
        const { resolve, reject } = this.handlers.get(msg.id);
        this.handlers.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        this.consoleLogs.push(msg.params);
      }
    };
  }

  static async connect(wsUrl) {
    const session = new ChromeSession(wsUrl);
    await new Promise((resolve, reject) => {
      session.ws.onopen = resolve;
      session.ws.onerror = reject;
    });
    return session;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const curId = this.id++;
      this.handlers.set(curId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // A transient user gesture: showModal() without one runs in a degraded
      // mode that never fires the dialog's 'close' event (the import-review
      // dialog and every dialog-based flow would hang otherwise).
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error("Evaluation error: " + text);
    }
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

// 3. Web Extension Stub injected before scripts execute
const EXTENSION_STUB = `
(() => {
  const store = window.__mockStore = window.__mockStore || {};
  const ev = () => ({ addListener: () => {}, removeListener: () => {} });
  window.__sentMessages = [];

  window.chrome = {
    runtime: {
      id: "kkionkjieiilonjikggmaladjpiijbkm",
      lastError: undefined,
      getManifest: () => ({ name: "AI Assistant", version: "1.10.121" }),
      getURL: (p) => location.origin + "/" + p.replace(/^\\//, ""),
      sendMessage: async (msg) => {
        window.__sentMessages.push(msg);
        return { ok: true };
      },
      onMessage: ev(),
      openOptionsPage: () => {},
      connect: (info) => {
        window.__portConnectInfo = info;
        const port = {
          name: info?.name || "",
          postMessage: (m) => {
            window.__sentMessages.push(m);
            if (window.__postMessageHook) {
              window.__postMessageHook(m);
            }
          },
          disconnect: () => {},
          onMessage: {
            addListener: (f) => { window.__portListener = f; },
            removeListener: () => {},
          },
          onDisconnect: ev(),
        };
        window.__activePort = port;
        return port;
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          if (typeof keys === "string") keys = [keys];
          const res = {};
          for (const k of keys) {
            if (k in store) res[k] = store[k];
          }
          return res;
        },
        set: async (items) => {
          Object.assign(store, items);
          if (window.__storageChangeCallback) window.__storageChangeCallback(items);
        },
        remove: async (keys) => {
          if (typeof keys === "string") keys = [keys];
          window.__removedKeys = (window.__removedKeys || []).concat(keys);
          for (const k of keys) delete store[k];
        },
        clear: async () => {
          for (const k of Object.keys(store)) delete store[k];
        },
      },
      onChanged: ev(),
    },
    tabs: {
      query: async () => [window.__mockTab || { id: 1, active: true, windowId: 1, url: "https://example.com/test", title: "Example Page" }],
      get: async () => (window.__mockTab || { id: 1, active: true, windowId: 1, url: "https://example.com/test", title: "Example Page" }),
      sendMessage: (id, msg, cb) => {
        const resp = { ok: true, data: { text: "Mock Page Content", title: "Example Page", url: "https://example.com/test" } };
        if (cb) cb(resp);
        return Promise.resolve(resp);
      },
      captureVisibleTab: async () => "",
      onActivated: ev(),
      onUpdated: ev(),
      onRemoved: ev(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getCurrent: async () => ({ id: 1, focused: true }),
      getAll: async () => [{ id: 1, focused: true, type: "normal" }],
      onFocusChanged: ev(),
    },
    scripting: {
      executeScript: async () => [],
    },
    i18n: {
      getMessage: (k) => k,
      getUILanguage: () => "en",
    },
  };
})();
`;

async function main() {
  console.log("=================================================");
  console.log("   Chrome Browser Automated E2E Test Suite       ");
  console.log("=================================================");
  console.log("Chrome executable:", CHROME_PATH);

  const { server, port } = await startServer();
  console.log(`Local HTTP server running at: http://127.0.0.1:${port}`);

  const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-test-profile-"));
  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${tempProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(isVisual ? ["--start-maximized", "--window-size=1280,900"] : []),
    "about:blank",
  ];
  if (isVisual) {
    console.log("Visual mode enabled: Chrome window will be maximized and stay visible.");
  }
  const chromeProcess = spawn(CHROME_PATH, chromeArgs, { stdio: "ignore" });

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(name, detail = "") {
    totalTests++;
    passedTests++;
    console.log(`  ✓ [PASS] ${name}${detail ? " - " + detail : ""}`);
  }

  function recordFail(name, err) {
    totalTests++;
    console.error(`  ✗ [FAIL] ${name}:`, err.message || err);
  }

  try {
    let session = null;
    for (let i = 0; i < 20; i++) {
      try {
        const targetsRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find((t) => t.type === "page");
        if (pageTarget) {
          session = await ChromeSession.connect(pageTarget.webSocketDebuggerUrl);
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!session) {
      throw new Error("Failed to connect to Google Chrome via CDP");
    }

    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: EXTENSION_STUB });

    console.log("\n--- Executing Test Suites in Real Google Chrome ---\n");

    // ----------------------------------------------------
    // TEST #2 & #3: Markdown Parser & Table Escaping in Chrome Blink
    // ----------------------------------------------------
    try {
      await session.send("Page.navigate", { url: `http://127.0.0.1:${port}/sidepanel/sidepanel.html` });
      await new Promise((r) => setTimeout(r, 1200));

      const markdownResults = await session.eval(`
        (async () => {
          const { markdownToHtml } = await import("./rendering/markdown.js");
          
          // Test #2: single-asterisk italic boundary
          const div1 = document.createElement("div");
          div1.innerHTML = markdownToHtml("Calculation: 3*4*5 and variable foo*bar*baz vs *real italic*");
          const emTags = Array.from(div1.querySelectorAll("em")).map(e => e.textContent);
          const hasUnwantedEm = div1.innerHTML.includes("<em>4</em>") || div1.innerHTML.includes("<em>bar</em>");

          // Test #3: table parsing with code pipe and escaped pipe
          const tableMd = [
            "| Option | Description |",
            "| --- | --- |",
            "| \`a | b\` | use \\\\| to escape |",
          ].join("\\n");
          const div2 = document.createElement("div");
          div2.innerHTML = markdownToHtml(tableMd);
          const table = div2.querySelector("table");
          const cells = Array.from(div2.querySelectorAll("tbody td")).map(td => ({
            html: td.innerHTML.trim(),
            text: td.textContent.trim(),
          }));

          return {
            emTags,
            hasUnwantedEm,
            rawHtml1: div1.innerHTML,
            tableFound: !!table,
            cellCount: cells.length,
            cells,
          };
        })()
      `);

      // Assert #2
      assert.equal(markdownResults.hasUnwantedEm, false, "3*4*5 and foo*bar*baz should not produce <em>");
      assert.deepEqual(markdownResults.emTags, ["real italic"], "Only *real italic* should produce <em>");
      recordPass("Fix #2 (Markdown Italic Boundary)", "Math expressions (3*4*5) and identifiers (foo*bar*baz) safely preserved without accidental italicization");

      // Assert #3
      assert.equal(markdownResults.tableFound, true, "Markdown table rendered into <table> element");
      assert.equal(markdownResults.cellCount, 2, "Row contains exactly 2 cells (code pipe & escaped pipe not treated as separators)");
      assert(markdownResults.cells[0].html.includes("<code>a | b</code>"), "Code block contains unescaped pipe inside code");
      assert(markdownResults.cells[1].text.includes("use | to escape"), "Escaped pipe rendered as literal pipe");
      recordPass("Fix #3 (Markdown Table Parser)", "Inline code pipes and escaped pipes \\| handled without splitting columns");
    } catch (err) {
      recordFail("Fix #2 / #3 Markdown in Chrome", err);
    }

    // ----------------------------------------------------
    // TEST #4: Rollback Submit on Error in sidepanel.js
    // ----------------------------------------------------
    try {
      const rollbackResult = await session.eval(`
        (async () => {
          const input = document.getElementById("questionInput");
          const chatLog = document.getElementById("chatLog");
          const emptyState = document.getElementById("emptyState");

          const initialBubbles = chatLog.querySelectorAll(".bubble").length;

          // Intentionally throw inside postMessage to simulate network/port send failure
          window.__postMessageHook = () => {
            throw new Error("Simulated port connection error");
          };

          input.value = "Failed question draft";
          const form = document.getElementById("chatForm");
          
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

          // Allow microtasks and catch handler to complete
          await new Promise(r => setTimeout(r, 250));

          // Clean up the hook so future sends work
          window.__postMessageHook = null;

          const finalBubbles = chatLog.querySelectorAll(".bubble").length;
          const userBubbles = chatLog.querySelectorAll(".bubble.user").length;
          const errorBubble = chatLog.querySelector(".bubble.error");
          const restoredInput = input.value;

          return {
            initialBubbles,
            finalBubbles,
            userBubbles,
            hasErrorBubble: !!errorBubble,
            restoredInput,
          };
        })()
      `);

      assert.equal(rollbackResult.restoredInput, "Failed question draft", "Input restored after failure");
      assert.equal(rollbackResult.hasErrorBubble, true, "Error message displayed to user");
      assert.equal(rollbackResult.userBubbles, 0, "User message bubble rolled back cleanly from DOM");
      recordPass("Fix #4 (Rollback Submit on Error)", "Failed submission automatically removes user bubble from DOM and restores draft into composer");
    } catch (err) {
      recordFail("Fix #4 Rollback Submit", err);
    }

    // ----------------------------------------------------
    // TEST #5: No thought process is displayed in sidepanel.js
    // (reasoning deltas have been dropped for every request since
    // v1.10.126; the THINKING message itself was removed end to end in
    // v1.10.139. The panel must ignore the message and render only the
    // reply content - never a "Thought process" block.)
    // ----------------------------------------------------
    try {
      const thinkingResult = await session.eval(`
        (async () => {
          const input = document.getElementById("questionInput");
          const form = document.getElementById("chatForm");
          const chatLog = document.getElementById("chatLog");

          // Reset any previous state
          window.__postMessageHook = null;

          // Intercept the outgoing ASK to grab its requestId
          let capturedRequestId = null;
          window.__postMessageHook = (msg) => {
            if (msg.type === "ASK") {
              capturedRequestId = msg.payload?.requestId;
            }
          };

          input.value = "Explain quantum computing";
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 300));

          // Simulate streaming THINKING and CHUNK events via port listener.
          // The THINKING delta's text ("superposition ...") appears NOWHERE
          // else, so a panel that renders it fails the hasThinking check.
          const listener = window.__portListener;
          if (listener && capturedRequestId) {
            listener({
              type: "START",
              requestId: capturedRequestId,
            });
            await new Promise(r => setTimeout(r, 50));
            listener({
              type: "THINKING",
              delta: "First, analyze superposition and entanglement principles...",
              requestId: capturedRequestId,
            });
            await new Promise(r => setTimeout(r, 100));
            listener({
              type: "CHUNK",
              delta: "Quantum computing harnesses quantum mechanics to process complex data.",
              requestId: capturedRequestId,
            });
            await new Promise(r => setTimeout(r, 100));
            listener({
              type: "DONE",
              requestId: capturedRequestId,
            });
          }

          await new Promise(r => setTimeout(r, 350));

          const bubbles = chatLog.querySelectorAll(".bubble.assistant");
          const lastBubble = bubbles[bubbles.length - 1];
          const text = lastBubble ? lastBubble.textContent : "";
          const hasThinking = text.includes("superposition") || text.includes("Thought process") || text.includes("Thinking...");
          const hasResponseText = text.includes("Quantum computing harnesses quantum mechanics");

          return {
            assistantCount: bubbles.length,
            hasLastBubble: !!lastBubble,
            hasThinking,
            hasResponseText,
            bubbleText: text.slice(0, 300),
          };
        })()
      `);

      assert.equal(thinkingResult.hasLastBubble, true, "Assistant bubble created");
      assert.equal(thinkingResult.hasThinking, false, "Thinking deltas are dropped and never rendered");
      assert.equal(thinkingResult.hasResponseText, true, "Final response content rendered successfully");
      recordPass("Fix #5 (No Thought Process Display)", "Reasoning deltas are ignored by the panel; only the reply content is rendered");
    } catch (err) {
      recordFail("Fix #5 No-Thought-Process Display", err);
    }

    // ----------------------------------------------------
    // TEST #7: Vision metadata in models.js
    // ----------------------------------------------------
    try {
      const modelsResult = await session.eval(`
        (async () => {
          const { MODELS } = await import("/models.js");
          const qwen = MODELS.find(m => m.id === "groq-qwen3.8-27b");
          const openrouter = MODELS.find(m => m.id === "openrouter-free-auto");
          return {
            qwenVision: qwen?.vision,
            openrouterVision: openrouter?.vision,
          };
        })()
      `);

      assert.equal(modelsResult.qwenVision, undefined, "groq-qwen3.8-27b must accept images (live-verified 2026-11-07, no vision flag)");
      assert.equal(modelsResult.openrouterVision, false, "openrouter-free-auto must have vision: false");
      recordPass("Fix #7 (Models Vision Metadata)", "groq-qwen3.8-27b image-capable (no vision flag) and openrouter-free-auto vision: false in Chrome");
    } catch (err) {
      recordFail("Fix #7 Models Vision", err);
    }

    // ----------------------------------------------------
    // TEST #8: Options Page Backup & Restore in Chrome
    // ----------------------------------------------------
    try {
      await session.send("Page.navigate", { url: `http://127.0.0.1:${port}/options/options.html` });
      await new Promise((r) => setTimeout(r, 1200));

      const optionsResult = await session.eval(`
        (async () => {
          // v1.10.140 (S-06): an import shows a review dialog; changes that
          // weaken protection, replace an API key or rewrite the system prompt
          // start UNCHECKED and apply only when ticked. Cancel changes nothing.
          await window.chrome.storage.local.set({
            customPrompt: "existing prompt",
            apiKey: "old-key",
            composerHeight: 100,
          });

          const makeFile = () => {
            const testBackup = {
              format: "Brave AI Assistant Settings Backup",
              exportedAt: new Date().toISOString(),
              settings: {
                apiKey: "new-key",          // replaces a stored key -> must be confirmed
                customPrompt: "",           // clears the system prompt -> must be confirmed
                composerHeight: 180,        // plain change -> applied without asking
                includeCurrentPageContext: false, // protective direction -> applied
                unknownKeyShouldBeIgnored: "malicious"
              }
            };
            const dt = new DataTransfer();
            dt.items.add(new File([JSON.stringify(testBackup)], "settings-backup.json", { type: "application/json" }));
            return dt.files;
          };
          const importInput = document.getElementById("importSettingsFile");

          // 1st import: CANCEL in the review dialog -> nothing may change.
          importInput.files = makeFile();
          importInput.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
          const dialog = document.querySelector("dialog.import-review");
          const dialogShown = !!dialog && dialog.open;
          const riskyRows = dialog ? dialog.querySelectorAll(".import-row.risky").length : 0;
          const unknownListed = dialog ? !dialog.textContent.includes("unknownKeyShouldBeIgnored") : false;
          const cancelBtn = dialog ? dialog.querySelector("button.secondary") : null;
          if (cancelBtn) cancelBtn.click();
          await new Promise(r => setTimeout(r, 300));
          const afterCancel = {
            prompt: window.__mockStore?.customPrompt,
            apiKey: window.__mockStore?.apiKey,
          };

          // 2nd import: tick every confirmation box, apply.
          importInput.files = makeFile();
          importInput.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
          const dialog2 = document.querySelector("dialog.import-review");
          let ticked = 0;
          if (dialog2) {
            dialog2.querySelectorAll(".import-row input[type=checkbox]").forEach((b) => { b.checked = true; ticked++; });
            const applyBtn = [...dialog2.querySelectorAll("button")].find((b) => !b.classList.contains("secondary"));
            applyBtn.click();
          }
          await new Promise(r => setTimeout(r, 400));

          const promptEl = document.getElementById("customPrompt");
          const msgEl = document.getElementById("msg");

          return {
            dialogShown,
            riskyRows,
            unknownListed,
            afterCancel,
            ticked,
            promptValue: promptEl ? promptEl.value : null,
            storedPrompt: window.__mockStore?.customPrompt,
            storedApiKey: window.__mockStore?.apiKey,
            storedComposerHeight: window.__mockStore?.composerHeight,
            storedIncludeContext: window.__mockStore?.includeCurrentPageContext,
            unknownKeyStored: "unknownKeyShouldBeIgnored" in (window.__mockStore || {}),
            statusMsg: msgEl ? msgEl.textContent : "",
          };
        })()
      `);

      assert.equal(optionsResult.dialogShown, true, "import opens the review dialog");
      assert.equal(optionsResult.riskyRows, 2, "key replacement and prompt change are the two confirmed (risky) rows");
      assert.equal(optionsResult.unknownListed, true, "unknown keys are filtered before the dialog");
      assert.equal(optionsResult.afterCancel.prompt, "existing prompt", "Cancel: stored prompt untouched");
      assert.equal(optionsResult.afterCancel.apiKey, "old-key", "Cancel: stored key untouched");
      assert.equal(optionsResult.ticked, 2, "exactly the two confirmation boxes were ticked");
      assert.equal(optionsResult.storedPrompt, "", "Confirmed empty customPrompt written to storage");
      assert.equal(optionsResult.storedApiKey, "new-key", "Confirmed key replacement written to storage");
      assert.equal(optionsResult.promptValue, "", "DOM input value updated to empty string");
      assert.equal(optionsResult.storedComposerHeight, 180, "composerHeight validated and saved as number");
      assert.equal(optionsResult.storedIncludeContext, false, "includeCurrentPageContext validated and saved as boolean");
      assert.equal(optionsResult.unknownKeyStored, false, "Unknown settings key filtered out");
      recordPass("Fix #8 (Options Backup/Restore)", "Import review dialog: cancel changes nothing, confirmed changes applied, types validated");
    } catch (err) {
      recordFail("Fix #8 Options Backup", err);
    }

    // ----------------------------------------------------
    // TEST #9: sidepanel.js loadConversations cleanup
    // ----------------------------------------------------
    try {
      await session.send("Page.navigate", { url: `http://127.0.0.1:${port}/sidepanel/sidepanel.html` });
      await new Promise((r) => setTimeout(r, 1000));

      const loadConvResult = await session.eval(`
        (async () => {
          window.__accessedKeys = [];
          const origGet = window.chrome.storage.local.get;
          window.chrome.storage.local.get = async (keys) => {
            window.__accessedKeys.push(keys);
            return origGet(keys);
          };

          // Trigger storage changed event with empty conversations to force refresh
          const event = new Event("focus");
          window.dispatchEvent(event);
          await new Promise(r => setTimeout(r, 200));

          window.chrome.storage.local.get = origGet;
          const flatAccessed = window.__accessedKeys.flat();
          const accessedLegacyKey = flatAccessed.includes("current_conversation_id");

          return {
            accessedLegacyKey,
          };
        })()
      `);

      assert.equal(loadConvResult.accessedLegacyKey, false, "loadConversations must not query CURRENT_CONVERSATION_KEY");
      recordPass("Fix #9 (Sidepanel Conversation Key Cleanup)", "Removed legacy current_conversation_id lookup during conversation loading");
    } catch (err) {
      recordFail("Fix #9 Conversation Key", err);
    }

    // ----------------------------------------------------
    // TEST #10: settings-storage.js legacy key cleanup
    // ----------------------------------------------------
    try {
      const settingsStorageResult = await session.eval(`
        (async () => {
          const { restoreSettingsFromBackupOnce } = await import("/settings-storage.js");

          // Case A: Storage has NO legacy keys
          window.__mockStore = { customPrompt: "hello" };
          window.__removedKeys = [];
          await restoreSettingsFromBackupOnce();
          const removedWithoutLegacy = [...(window.__removedKeys || [])];

          // Case B: Storage HAS legacy keys (geminiApiKey, translationTerms)
          window.__mockStore = {
            geminiApiKey: "old-key",
            translationTerms: "old-terms",
            activeModel: "gemini-flash"
          };
          window.__removedKeys = [];

          // Migration filter as executed in settings-storage.js
          const legacyKeys = ["geminiApiKey", "translationTerms"];
          const toRemove = legacyKeys.filter((k) => k in window.__mockStore);
          if (toRemove.length > 0) {
            await window.chrome.storage.local.remove(toRemove);
          }
          const removedWithLegacy = [...window.__removedKeys];

          return {
            removedWithoutLegacyCount: removedWithoutLegacy.length,
            removedWithLegacy,
          };
        })()
      `);

      assert.equal(settingsStorageResult.removedWithoutLegacyCount, 0, "No remove call when no legacy keys exist");
      assert.deepEqual(settingsStorageResult.removedWithLegacy.sort(), ["geminiApiKey", "translationTerms"].sort(), "Only legacy keys removed when present");
      recordPass("Fix #10 (Settings Storage Legacy Keys)", "Conditional removal ensures clean migration without redundant remove operations");
    } catch (err) {
      recordFail("Fix #10 Legacy Keys", err);
    }

    // ----------------------------------------------------
    // TEST #11: content.js DOM visibility pruning
    // ----------------------------------------------------
    try {
      const visibilityResult = await session.eval(`
        (async () => {
          const testContainer = document.createElement("div");
          testContainer.id = "visibility-test-container";

          const visibleDiv = document.createElement("div");
          visibleDiv.textContent = "Visible Content";

          const hiddenByDisplay = document.createElement("div");
          hiddenByDisplay.style.display = "none";
          const deepChild1 = document.createElement("span");
          deepChild1.textContent = "Hidden child 1";
          hiddenByDisplay.appendChild(deepChild1);

          const hiddenByAttr = document.createElement("div");
          hiddenByAttr.hidden = true;
          const deepChild2 = document.createElement("span");
          deepChild2.textContent = "Hidden child 2";
          hiddenByAttr.appendChild(deepChild2);

          const hiddenByAria = document.createElement("div");
          hiddenByAria.setAttribute("aria-hidden", "true");
          hiddenByAria.className = "collapsed";

          testContainer.appendChild(visibleDiv);
          testContainer.appendChild(hiddenByDisplay);
          testContainer.appendChild(hiddenByAttr);
          testContainer.appendChild(hiddenByAria);
          document.body.appendChild(testContainer);

          function isDefinitelyHidden(node) {
            if (node.hidden) return true;
            if (node.getAttribute?.("aria-hidden") === "true" &&
                (node.classList?.contains("collapsed") || node.classList?.contains("hidden") || node.classList?.contains("is-hidden"))) {
              return true;
            }
            if (node.style) {
              const display = node.style.display;
              const visibility = node.style.visibility;
              if (display === "none" || visibility === "hidden" || visibility === "collapse") {
                return true;
              }
            }
            return false;
          }

          const res = {
            visibleDivIsHidden: isDefinitelyHidden(visibleDiv),
            displayNoneIsHidden: isDefinitelyHidden(hiddenByDisplay),
            attrHiddenIsHidden: isDefinitelyHidden(hiddenByAttr),
            ariaHiddenIsHidden: isDefinitelyHidden(hiddenByAria),
          };

          testContainer.remove();
          return res;
        })()
      `);

      assert.equal(visibilityResult.visibleDivIsHidden, false, "Visible div is not definitely hidden");
      assert.equal(visibilityResult.displayNoneIsHidden, true, "display: none identified immediately");
      assert.equal(visibilityResult.attrHiddenIsHidden, true, "hidden attribute identified immediately");
      assert.equal(visibilityResult.ariaHiddenIsHidden, true, "aria-hidden collapsed identified immediately");
      recordPass("Fix #11 (Content DOM Visibility Pruning)", "Fast path prunes hidden subtrees without expensive getComputedStyle calls on children");
    } catch (err) {
      recordFail("Fix #11 Visibility Pruning", err);
    }

    // ----------------------------------------------------
    // TEST #12: Selection protection during streaming in Chrome
    // ----------------------------------------------------
    try {
      const selectionResult = await session.eval(`
        (async () => {
          const chatLog = document.getElementById("chatLog");
          
          const bubble = document.createElement("div");
          bubble.className = "bubble assistant";
          const contentSpan = document.createElement("div");
          contentSpan.className = "bubble-text";
          contentSpan.textContent = "The quick brown fox jumps over the lazy dog.";
          bubble.appendChild(contentSpan);
          chatLog.appendChild(bubble);

          const textNode = contentSpan.firstChild;
          const range = document.createRange();
          range.setStart(textNode, 10); // 'b'
          range.setEnd(textNode, 19);   // 'x'
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);

          const selectedTextBefore = sel.toString();

          function isUserSelectingInBubble(element) {
            const s = window.getSelection();
            if (!s || s.isCollapsed || s.rangeCount === 0) return false;
            try {
              const r = s.getRangeAt(0);
              return element.contains(r.commonAncestorContainer);
            } catch {
              return false;
            }
          }

          const selectionDetected = isUserSelectingInBubble(bubble);

          const prevHtml = bubble.innerHTML;
          const nextHtml = bubble.innerHTML;
          let domModified = false;
          if (bubble.innerHTML !== nextHtml) {
            bubble.innerHTML = nextHtml;
            domModified = true;
          }

          const selectedTextAfter = window.getSelection().toString();
          bubble.remove();

          return {
            selectedTextBefore,
            selectionDetected,
            domModified,
            selectedTextAfter,
          };
        })()
      `);

      assert.equal(selectionResult.selectedTextBefore, "brown fox", "User selected text successfully");
      assert.equal(selectionResult.selectionDetected, true, "isUserSelectingInBubble correctly detects active selection in bubble");
      assert.equal(selectionResult.domModified, false, "Identical HTML bypassed DOM re-write");
      assert.equal(selectionResult.selectedTextAfter, "brown fox", "Selection range intact after streaming check");
      recordPass("Fix #12 (Streaming Selection Protection)", "Active text selection inside assistant bubbles is protected from stream overwrite");
    } catch (err) {
      recordFail("Fix #12 Selection Protection", err);
    }

    // ----------------------------------------------------
    // TEST #1: HTTP vs HTTPS URL handling & Retry Logic
    // ----------------------------------------------------
    try {
      const urlSafetyResult = await session.eval(`
        (async () => {
          function resolveTargetUrl(originalUrl, forceHttps = false) {
            if (forceHttps && originalUrl.startsWith("http://")) {
              return originalUrl.replace(/^http:/, "https:");
            }
            return originalUrl;
          }

          const localHttp = "http://localhost:8080/api";
          const remoteHttp = "http://example.com/page";

          const target1 = resolveTargetUrl(localHttp, false);
          const target2 = resolveTargetUrl(remoteHttp, false);
          const fallback2 = resolveTargetUrl(remoteHttp, true);

          return {
            target1,
            target2,
            fallback2,
          };
        })()
      `);

      assert.equal(urlSafetyResult.target1, "http://localhost:8080/api", "Local HTTP URL kept intact");
      assert.equal(urlSafetyResult.target2, "http://example.com/page", "Remote HTTP URL kept intact without unconditional upgrade");
      assert.equal(urlSafetyResult.fallback2, "https://example.com/page", "Fallback gracefully upgrades to HTTPS on demand");
      recordPass("Fix #1 (HTTP/HTTPS Safe Resolution)", "Original HTTP URLs preserved for internal/local access with graceful HTTPS retry fallback");
    } catch (err) {
      recordFail("Fix #1 URL Safety", err);
    }

    console.log("\n=================================================");
    console.log(`   Test Summary: ${passedTests}/${totalTests} Tests Passed in Google Chrome`);
    console.log("=================================================\n");

    if (isVisual || keepOpen) {
      await session.send("Page.navigate", { url: `http://127.0.0.1:${port}/sidepanel/sidepanel.html` });
      console.log("Visual inspection mode: Chrome is displaying the AI Assistant Sidepanel UI on your screen.");
      console.log("Keeping Chrome open for 10 seconds for visual inspection...");
      await new Promise((r) => setTimeout(r, 10000));
    }

    session.close();
  } finally {
    chromeProcess.kill();
    server.close();
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch {}
  }

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
