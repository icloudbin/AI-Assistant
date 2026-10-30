#!/usr/bin/env node
// Real extension-level E2E test: launches local Chrome, loads the unpacked
// extension via the DevTools Protocol `Extensions.loadUnpacked` command (the
// command-line `--load-extension` flag is ignored by branded Chrome builds),
// and drives the actual service worker, side panel, options page, storage,
// content script and FETCH_IMAGE handler.
//
// Requirements: Chrome 125+ with the `Extensions` CDP domain and
// `--enable-unsafe-extension-debugging`; set CHROME_PATH / EXT_TEST_PORT to
// override the defaults, and EXT_ROOT to test an extracted package instead of
// the working tree. Run: node scripts/test-extension-e2e.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// Point EXT_ROOT at an extracted package to validate the shipped artifact
// instead of the working tree.
const ROOT = process.env.EXT_ROOT
  ? path.resolve(process.env.EXT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.EXT_TEST_PORT || 9334);
const manifestInfo = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const extensionIdFromKey = (() => {
  if (!manifestInfo.key) return null;
  const digest = crypto.createHash("sha256").update(Buffer.from(manifestInfo.key, "base64")).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
  return id;
})();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ext-e2e-"));
const results = [];
let failures = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    };
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const c = new Cdp(url);
      c.ws.onopen = () => resolve(c);
      c.ws.onerror = (e) => reject(new Error("CDP websocket error"));
      setTimeout(() => reject(new Error("CDP connect timeout")), 5000);
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

function startServer() {
  const big = "A".repeat(200000) + " PROTON_BODY";
  const nested = "<div>".repeat(600) + "DEEP_TEXT" + "</div>".repeat(600);
  const pages = {
    "/markdown": `<!doctype html><html><head><title>Cookie article</title></head><body>
      <article class="cookie-recipe"><h1>Cookie recipe</h1>
      <p>This is a long enough paragraph to be treated as real article content. It explains how to bake cookies at home with butter, sugar and flour.</p>
      <p>Another paragraph with more useful content for the extraction test, including measurement and baking instructions.</p>
      <div class="cookie-banner">COOKIE_BANNER_TEXT</div>
      <details><summary>Summary line</summary><div>SECRET_DETAIL_TEXT</div></details>
      ${nested}
      </article></body></html>`,
    "/proton": `<!doctype html><html><head><title>Proton</title></head><body>
      <iframe data-testid="content-iframe" src="/email" style="width:800px;height:600px"></iframe>
      </body></html>`,
    "/email": `<!doctype html><html><body><p>Proton mail body ${big}</p></body></html>`,
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/secret.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([0x89,0x50,0x4e,0x47]));
        return;
      }
      const body = pages[u.pathname];
      if (!body) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function waitTarget(predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let targets = []; try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(250); continue; }
    const found = targets.find(predicate);
    if (found) return found;
    await sleep(200);
  }
  return null;
}

async function main() {
  const { server, port: webPort } = await startServer();
  const args = [
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "--enable-unsafe-extension-debugging",
    "about:blank",
  ];
  const chrome = spawn(CHROME, args, { stdio: "ignore" });
  try {
    let version = null;
    for (let i = 0; i < 40; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
    }
    if (!version) throw new Error("browser endpoint did not start");
    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    const loaded = await browser.send("Extensions.loadUnpacked", { path: ROOT });
    const extId = loaded.id;
    check("extension loaded via CDP", !extensionIdFromKey || extId === extensionIdFromKey, extId);
    let sw = null;
    let manifest = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const swTarget = await waitTarget((t) => t.type === "service_worker" && t.url.includes(`/${extId}/`), 5000);
      if (swTarget) {
        try {
          sw = await Cdp.connect(swTarget.webSocketDebuggerUrl);
          await sw.send("Runtime.enable");
          await sw.send("Log.enable");
          for (let i = 0; i < 20; i++) {
            const hasChrome = await sw.eval("typeof chrome !== 'undefined' && typeof chrome.runtime === 'object'").catch(() => false);
            if (hasChrome) { manifest = await sw.eval("chrome.runtime.getManifest()"); break; }
            await sleep(250);
          }
          if (manifest) break;
        } catch { try { sw?.close(); } catch {} sw = null; }
      }
      await sleep(500);
    }
    if (!sw || !manifest) throw new Error("extension service worker did not become ready");
    check("extension loads and service worker starts", manifest?.version === manifestInfo.version, `version=${manifest?.version}`);
    check("manifest name", manifest?.name === "AI Assistant", manifest?.name);

    const pageTarget = await waitTarget((t) => t.type === "page" && t.url === "about:blank");
    if (!pageTarget) throw new Error("no page target");
    const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Page.enable");
    const sideUrl = `chrome-extension://${extId}/sidepanel/sidepanel.html`;
    await page.send("Page.navigate", { url: sideUrl });
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const ready = await page.eval("document.readyState === 'complete' && !!document.getElementById('includeContextToggle')");
      if (ready) break;
    }
    await sleep(1500);
    check("side panel page loads with real chrome APIs", await page.eval("typeof chrome?.storage?.local?.get === 'function' && document.title.length > 0"));
    check("side panel initialized (send button exists)", await page.eval("!!document.getElementById('sendBtn')"));

    // P2-3 live sync + P2-2 reload with saved opt-out.
    await page.eval("chrome.storage.local.set({ includeCurrentPageContext: true })");
    await sleep(300);
    check("live sync: storage true updates checkbox", await page.eval("document.getElementById('includeContextToggle').checked === true"));
    await page.eval("chrome.storage.local.set({ includeCurrentPageContext: false })");
    await sleep(300);
    check("live sync: storage false updates checkbox", await page.eval("document.getElementById('includeContextToggle').checked === false"));
    await page.send("Page.reload", { ignoreCache: true });
    await sleep(1800);
    check("reload honors saved page-reading opt-out", await page.eval("document.getElementById('includeContextToggle').checked === false"));

    // P3-10 language refresh / P3-22 roles.
    await page.eval("chrome.storage.local.set({ languagePreference: 'zh-CN' })");
    await sleep(500);
    const langState = await page.eval("({ lang: document.documentElement.lang, ph: document.getElementById('questionInput').placeholder, aria: document.getElementById('questionInput').getAttribute('aria-label') })");
    check("language switch updates document language", langState.lang === "zh-CN", JSON.stringify(langState));
    check("language switch updates question placeholder", /问题|输入/.test(langState.ph), langState.ph);
    check("question input has localized aria-label", !!langState.aria && langState.aria !== "Question", langState.aria);
    check("chat log is a live region", await page.eval("document.getElementById('chatLog').getAttribute('role') === 'log' && document.getElementById('chatLog').getAttribute('aria-live') === 'polite'"));
    check("context bar is a status region", await page.eval("document.getElementById('pageContextBar').getAttribute('role') === 'status'"));

    // P3-7 Markdown table in the real extension page.
    const table = await page.eval(`(async () => {
      const { markdownToHtml } = await import(chrome.runtime.getURL('sidepanel/rendering/markdown.js'));
      return markdownToHtml("| A | B |\\n| :--- | ---: |\\n| 1 | 2 | 3 | 4 |");
    })()`);
    check("table keeps extra cells", table.includes("<td>3</td>") && table.includes("<td>4</td>"), table.slice(0, 200));
    check("table preserves alignment", table.includes('align="left"') && table.includes('align="right"'), table.slice(0, 200));

    // P3-8 user bubble newlines + real submit path (no key => ERROR bubble).
    await page.eval("chrome.storage.local.set({ includeCurrentPageContext: false, languagePreference: 'en' })");
    await sleep(300);
    await page.eval(`(() => {
      const q = document.getElementById('questionInput');
      q.value = 'line one\\nline two';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chatForm').requestSubmit();
      return true;
    })()`);
    await sleep(1800);
    const userBubble = await page.eval(`(() => {
      const b = document.querySelector('.bubble.user .bubble-text');
      return b ? { text: b.textContent, whiteSpace: getComputedStyle(b).whiteSpace } : null;
    })()`);
    check("user bubble rendered through real side panel", !!userBubble && userBubble.text.includes("line one"), JSON.stringify(userBubble));
    check("user bubble preserves newlines", userBubble?.whiteSpace === "pre-wrap", JSON.stringify(userBubble));

    // P3-14 context-action queue: queue a translation for this panel tab, reload, claim it.
    const ids = await page.eval("(async () => { const t = await chrome.tabs.getCurrent(); return { tabId: t.id, windowId: t.windowId }; })()");
    await page.eval(`chrome.tabs.update(${ids.tabId}, { active: true })`);
    await page.eval(`chrome.storage.local.set({ pendingContextAction: ${JSON.stringify([{
      action: "translate", text: "hello queue", format: "text", truncated: false,
      tabId: ids.tabId, windowId: ids.windowId, createdAt: Date.now(),
    }])} })`);
    await page.send("Page.reload", { ignoreCache: true });
    await sleep(2200);
    const queueState = await page.eval(`(async () => ({
      pending: await chrome.storage.local.get('pendingContextAction'),
      user: [...document.querySelectorAll('.bubble.user .bubble-text')].map((b) => b.textContent).join('\\n')
    }))()`);
    check("queued context action is claimed and rendered", queueState.user.includes("hello queue"), JSON.stringify(queueState).slice(0, 300));
    check("claim removes the action from storage", queueState.pending.pendingContextAction == null || (Array.isArray(queueState.pending.pendingContextAction) && queueState.pending.pendingContextAction.length === 0), JSON.stringify(queueState.pending));

    // Content script: P3-3 noise/depth/closed details + P3-2 Proton cap.
    async function extract(url, format) {
      const tab = await page.eval(`chrome.tabs.create({ url: ${JSON.stringify(url)} })`);
      await sleep(900);
      await page.eval(`chrome.scripting.executeScript({ target: { tabId: ${tab.id} }, files: ['content.js'] })`);
      const res = await page.eval(`chrome.tabs.sendMessage(${tab.id}, { type: 'EXTRACT_PAGE_CONTENT', format: ${JSON.stringify(format)} }, { frameId: 0 })`);
      await page.eval(`chrome.tabs.remove(${tab.id})`).catch(() => {});
      return res;
    }
    const markdownPage = await extract(`http://127.0.0.1:${webPort}/markdown`, "markdown");
    const mdText = markdownPage?.data?.text || "";
    check("content script markdown extraction returns data", markdownPage?.ok === true && mdText.length > 100, JSON.stringify(markdownPage).slice(0, 250));
    check("P3-3 legitimate cookie-recipe content survives", mdText.includes("Cookie recipe") && mdText.includes("bake cookies"), mdText.slice(0, 300));
    check("P3-3 cookie banner is skipped", !mdText.includes("COOKIE_BANNER_TEXT"), mdText.slice(0, 300));
    check("P3-3 closed details content is skipped", !mdText.includes("SECRET_DETAIL_TEXT"), mdText.slice(0, 300));
    const protonPage = await extract(`http://127.0.0.1:${webPort}/proton`, null);
    check("P3-2 Proton extraction source", protonPage?.data?.source === "proton-mail", JSON.stringify(protonPage?.data?.source));
    check("P3-2 Proton text capped and flagged", protonPage?.data?.text?.length <= 120000 && protonPage?.data?.truncated === true, `len=${protonPage?.data?.text?.length} truncated=${protonPage?.data?.truncated}`);

    // Background SSRF guard through the real service worker.
    const blocked = await page.eval(`chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: 'http://127.0.0.1:${webPort}/secret.png', pageUrl: 'http://example.com/' })`);
    check("FETCH_IMAGE blocks a private host", blocked?.ok === false, JSON.stringify(blocked));

    // Options page with real APIs.
    const optTab = await page.eval(`chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') })`);
    const optTarget = await waitTarget((t) => t.type === "page" && t.url.includes("/options/options.html"));
    if (optTarget) {
      const opt = await Cdp.connect(optTarget.webSocketDebuggerUrl);
      await opt.send("Runtime.enable");
      await opt.send("Log.enable");
      for (let i = 0; i < 30; i++) {
        await sleep(250);
        if (await opt.eval("document.readyState === 'complete' && !!document.getElementById('versionNumber')")) break;
      }
      await sleep(500);
      check("options page loads and reports version", (await opt.eval("document.getElementById('versionNumber').textContent")) === manifestInfo.version);
      opt.close();
    } else {
      check("options page target found", false);
    }
    await page.eval(`chrome.tabs.remove(${optTab.id})`).catch(() => {});

    // Collect unexpected page/SW exceptions.
    const pageExceptions = page.events.filter((e) => e.method === "Runtime.exceptionThrown");
    const swExceptions = sw.events.filter((e) => e.method === "Runtime.exceptionThrown");
    check("no uncaught side-panel exceptions", pageExceptions.length === 0, JSON.stringify(pageExceptions).slice(0, 400));
    check("no uncaught service-worker exceptions", swExceptions.length === 0, JSON.stringify(swExceptions).slice(0, 400));

    page.close();
    sw.close();
    console.log(`\nRESULT ${results.length - failures}/${results.length} passed`);
    if (failures) process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch {}
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error("TEST HARNESS FAILED:", err);
  process.exit(1);
});



