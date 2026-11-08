// scripts/e2e-page-privacy.mjs
//
// Real-browser check for S-05 (what the assistant may read from the page you are
// looking at) and S-08 (what is said before voice input and images, which the
// privacy filter cannot cover).
//
// S-05 is the "Read current page" checkbox in the panel's top bar: checked by
// default, and it decides whether the page goes with an ordinary question. Quick
// actions (Summarize, Translate, ...) operate on the page and ignore it. There are
// no site lists and no per-send confirmations any more.
//
//   node scripts/e2e-page-privacy.mjs [extension-folder]
//   ONLY='quick actions' node scripts/e2e-page-privacy.mjs     (just the matching tests)
//
// Needs Playwright with Chromium and openssl (neither is a dependency of the
// extension itself).
//
// How it works: a local HTTPS server impersonates api.deepseek.com and RECORDS the
// raw request, so every "was the page sent?" question is answered by looking for a
// marker word of that page in what the provider actually received - not by what the
// panel says it did. A second local server plays the website (every
// *.test-site.example name is mapped to it); the panel is opened as a tab next to
// the website's tab and the website's tab is brought to the front, which is what a
// side panel sees: "the page the user is looking at".

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const extDir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

// ---- fake provider -----------------------------------------------------------
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem"),
  "-subj", "/CN=api.deepseek.com", "-addext", "subjectAltName=DNS:api.deepseek.com",
], { stdio: "ignore" });

const provider = { requests: [] };
const providerServer = https.createServer(
  { key: fs.readFileSync(path.join(tmp, "key.pem")), cert: fs.readFileSync(path.join(tmp, "cert.pem")) },
  (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      provider.requests.push(raw);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "default answer" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  },
);
await new Promise((r) => providerServer.listen(0, "127.0.0.1", r));
const apiPort = providerServer.address().port;
// Did the provider receive this marker in its most recent request?
const carries = (marker) => provider.requests.at(-1)?.includes(marker) === true;
// Was the marker attached to the QUESTION that request asks (its last user message)?
// Earlier turns are conversation history: a Translate reply legitimately holds the
// page's text and goes back to the provider with the next question, which says
// nothing about whether the page was attached to that next question.
const questionCarries = (marker, raw = provider.requests.at(-1)) => {
  let messages = [];
  try { messages = JSON.parse(raw || "{}").messages || []; } catch { /* not JSON: no question found */ }
  const last = [...messages].reverse().find((m) => m.role === "user");
  return JSON.stringify(last?.content ?? "").includes(marker);
};

// ---- fake website ------------------------------------------------------------
const HOSTS = {
  plain: "plain.test-site.example", // an ordinary site
};
const PAGE_MARKER = "PLAINMARK";
const sentence = (marker) => `${marker} is the text of this test page, written as several complete sentences so that the page extractor treats it as readable article content.`;
const articleHtml = (marker) => `<!doctype html><html><head><meta charset="utf-8"><title>${marker} Title</title></head><body><main><h1>${marker} Heading</h1>${`<p>${sentence(marker)}</p>`.repeat(6)}</main></body></html>`;
const webServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(articleHtml(PAGE_MARKER));
});
await new Promise((r) => webServer.listen(0, "127.0.0.1", r));
const webPort = webServer.address().port;

const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${apiPort},MAP *.test-site.example 127.0.0.1`,
    "--ignore-certificate-errors",
    "--no-proxy-server",
  ],
});

const results = [];
// ONLY=<regex> runs just the tests whose name matches (handy while changing one rule).
const only = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}

// The chrome.storage.local key behind the "Read current page" checkbox (storage-keys.js).
const PAGE_READING_KEY = "includeCurrentPageContext";

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// A stand-in for the browser's speech recognition: nothing is recorded or sent
// anywhere; the page only counts how often recognition was started.
const SPEECH_STUB = `(() => {
  class FakeRecognition {
    start() { window.__recognitionStarts = (window.__recognitionStarts || 0) + 1; }
    stop() { setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const realQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor) => descriptor && descriptor.name === "microphone" ? Promise.resolve({ state: "granted" }) : realQuery(descriptor);
})();`;

try {
  let firstWorker = context.serviceWorkers()[0];
  firstWorker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(firstWorker.url()).host;
  const pageErrors = [];

  // ---- helpers ---------------------------------------------------------------
  // The service worker can be stopped and restarted by the browser between steps.
  async function inWorker(fn, arg) {
    let w = context.serviceWorkers()[0];
    if (!w) {
      const wake = await context.newPage();
      try {
        await wake.goto(`chrome-extension://${extId}/options/options.html`);
        w = await waitFor(() => context.serviceWorkers()[0], "the service worker");
      } finally {
        await wake.close();
      }
    }
    return w.evaluate(fn, arg);
  }
  const stored = (keys) => inWorker((k) => chrome.storage.local.get(k), keys);

  // Back to a brand-new install: no settings, and no IndexedDB recovery copy that
  // would put the page-reading choice back.
  async function reset(values = {}) {
    await inWorker(async (v) => {
      await chrome.storage.local.clear();
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase("ai-assistant-settings");
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      await chrome.storage.local.set(v);
    }, { apiKey: "test-key", piiFilterEnabled: false, ...values });
  }

  async function openPanel({ speech = false } = {}) {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    if (speech) await page.addInitScript(SPEECH_STUB);
    await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await page.waitForSelector("#chatForm");
    await page.waitForFunction(() => !document.getElementById("sendBtn").disabled, null, { timeout: 15000 });
    return page;
  }

  // The website's tab in front, as the user looking at it would have it, and the
  // panel told so: wait until the panel itself sees that site as the active tab.
  async function showSite(panel, sitePage, host) {
    await sitePage.bringToFront();
    await waitFor(async () => {
      const url = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url || "");
      return url.includes(host);
    }, `the ${host} tab to be the active tab`);
  }

  // Fresh storage, the website open, the panel next to it, and the website's tab
  // in front (it is "the page the user is looking at").
  async function scenario({ seed = {}, web = null, speech = false }, body) {
    provider.requests = [];
    await reset(seed);
    const opened = [];
    const sites = {};
    if (web) {
      const site = await context.newPage();
      await site.goto(`http://${web}:${webPort}/`);
      opened.push(site);
      sites[web] = site;
    }
    const panel = await openPanel({ speech });
    opened.push(panel);
    try {
      if (web) await showSite(panel, sites[web], web);
      return await body({ panel, sites });
    } finally {
      for (const page of opened) await page.close().catch(() => {});
    }
  }

  const sendEnabled = (panel) => panel.evaluate(() => !document.getElementById("sendBtn").disabled);
  const dialogOpen = (panel, id) => panel.evaluate((i) => Boolean(document.getElementById(i)?.open), id);
  const waitDialog = (panel, id) => waitFor(() => dialogOpen(panel, id), `the #${id} dialog`);
  const waitNoDialog = (panel, id) => waitFor(async () => !(await dialogOpen(panel, id)), `the #${id} dialog to close`);
  const focusedId = (panel) => panel.evaluate(() => document.activeElement?.id || "");
  // The "Read current page" checkbox: what the user sees, and what is stored.
  const CHECKBOX = "#includeContextCheckbox";
  const boxChecked = (panel) => panel.isChecked(CHECKBOX);
  const storedChoice = async () => (await stored(PAGE_READING_KEY))[PAGE_READING_KEY];
  const bar = (panel) => panel.evaluate(() => {
    const el = document.getElementById("pageContextBar");
    return el.hidden ? "" : document.getElementById("pageContextTitle").textContent;
  });
  const waitBar = (panel, needle) => waitFor(async () => (await bar(panel)).includes(needle), `the context bar to show ${needle}`);
  const bubbleCount = (panel, cls) => panel.$$eval(`.bubble.${cls}`, (els) => els.length);
  async function answered(panel, n) {
    await waitFor(async () => (await bubbleCount(panel, "assistant")) >= n, `assistant reply #${n}`);
    await waitFor(() => sendEnabled(panel), "the composer to unlock");
  }
  // Counting from what this panel already shows: a re-opened panel restores the
  // earlier conversation, so "reply #1" would be satisfied before anything was sent.
  async function send(panel, text) {
    const before = await bubbleCount(panel, "assistant");
    await panel.fill("#questionInput", text);
    await panel.click("#sendBtn");
    await answered(panel, before + 1);
  }
  async function quickAction(panel, buttonId) {
    const before = await bubbleCount(panel, "assistant");
    await panel.click(buttonId);
    await answered(panel, before + 1);
  }

  // ============================== S-05: page reading ==============================

  await test("Read current page is checked by default: a fresh install sends the page with an ordinary question, and asks nothing first", async () => {
    await scenario({ web: HOSTS.plain }, async ({ panel }) => {
      assert.equal(await boxChecked(panel), true, "a fresh install must start with the box checked");
      await waitBar(panel, `${PAGE_MARKER} Title`);
      assert.ok((await bar(panel)).includes(HOSTS.plain), "the bar does not name the site whose page will be sent");
      await send(panel, "what is this page about?");
      assert.equal(provider.requests.length, 1);
      assert.ok(carries(PAGE_MARKER), "the page was not sent, so every 'not sent' check below proves nothing");
      assert.equal(await panel.$("dialog"), null, "a question or dialog stood between the user and the send");
    });
  });

  await test("unchecking Read current page: the question goes without the page, the choice is stored and shared, and it survives a re-opened panel", async () => {
    await scenario({ web: HOSTS.plain }, async ({ panel, sites }) => {
      await waitBar(panel, `${PAGE_MARKER} Title`);
      await panel.uncheck(CHECKBOX);
      await waitFor(async () => (await storedChoice()) === false, "the unchecked choice to be stored");
      await waitFor(async () => (await bar(panel)) === "", "the bar to stop announcing the page");
      await send(panel, "hello there");
      assert.equal(provider.requests.length, 1, "the question itself must still be answered");
      assert.ok(!carries(PAGE_MARKER), "the page was sent although the box is unchecked");

      // A panel opened later reads the stored choice: still unchecked, still no page.
      const second = await openPanel();
      try {
        await showSite(second, sites[HOSTS.plain], HOSTS.plain);
        assert.equal(await boxChecked(second), false, "the choice was not kept for the next panel");
        await send(second, "and again");
        assert.equal(provider.requests.length, 2);
        assert.ok(!carries(PAGE_MARKER), "a re-opened panel sent the page against the stored choice");

        // Checking it again turns the page back on (positive control: the page IS readable here)...
        await second.check(CHECKBOX);
        await waitFor(async () => (await storedChoice()) === true, "the checked choice to be stored");
        await waitBar(second, `${PAGE_MARKER} Title`);
        await send(second, "now with the page");
        assert.equal(provider.requests.length, 3);
        assert.ok(carries(PAGE_MARKER), "checking the box again did not send the page");
        // ...and the first panel, still open, follows at once instead of sending on its old choice.
        await waitFor(() => boxChecked(panel), "the first panel's box to follow the change made in the second");
      } finally {
        await second.close();
      }
    });
  });

  await test("quick actions ignore the checkbox: with Read current page unchecked, Summarize, Translate and Key Points still send the page and leave the choice alone", async () => {
    await scenario({ seed: { [PAGE_READING_KEY]: false }, web: HOSTS.plain }, async ({ panel }) => {
      assert.equal(await boxChecked(panel), false, "the seeded choice was not shown");
      // Control: an ordinary question really does go without the page in this state.
      await send(panel, "just a question");
      assert.equal(provider.requests.length, 1);
      assert.ok(!carries(PAGE_MARKER), "an ordinary question carried the page while the box is unchecked");

      for (const [id, name] of [["#quickSummarizeBtn", "Summarize"], ["#quickTranslateBtn", "Translate"], ["#quickKeyPointsBtn", "Key Points"]]) {
        const before = provider.requests.length;
        await quickAction(panel, id);
        // Translate may legitimately send a second request (it replays a reply that lost
        // lines, and the fake provider answers with one line), so look at every request
        // this action made rather than counting them.
        const made = provider.requests.slice(before);
        assert.ok(made.length >= 1, `${name} did not reach the provider`);
        assert.ok(made.every((raw) => raw.includes(PAGE_MARKER)), `${name} did not send the page while the box is unchecked`);
        // Control for questionCarries() below: it does see a page that is attached to a question.
        assert.ok(questionCarries(PAGE_MARKER, made[0]), `${name}: the page was not attached to the action's own request`);
      }

      // A quick action is one request, not a change of the user's choice.
      assert.equal(await boxChecked(panel), false, "a quick action ticked the box");
      assert.equal(await storedChoice(), false, "a quick action changed the stored choice");
      // The next ordinary question goes without the page again. (The Translate reply above is
      // still in the conversation history, so only this question's own message is checked.)
      await send(panel, "one more question");
      assert.ok(!questionCarries(PAGE_MARKER), "after a quick action an ordinary question carried the page");
    });
  });

  // ============================== S-08: one-time notices ==============================

  await test("voice input: the cloud-recognition notice comes before the first use; Cancel starts nothing; once agreed it is not shown again", async () => {
    await scenario({ speech: true, seed: { includeCurrentPageContext: false } }, async ({ panel }) => {
      const starts = () => panel.evaluate(() => window.__recognitionStarts || 0);
      await panel.click("#micBtn");
      await waitDialog(panel, "micNoticeDialog");
      assert.equal(await focusedId(panel), "micNoticeDialogCancel", "the safe button must be the one with the focus");
      await panel.click("#micNoticeDialogCancel");
      await waitNoDialog(panel, "micNoticeDialog");
      await sleep(300);
      assert.equal(await starts(), 0, "recognition started although the user cancelled");
      assert.equal((await stored("micCloudNoticeAcknowledged")).micCloudNoticeAcknowledged, undefined, "Cancel must not count as agreeing");

      await panel.click("#micBtn");
      await waitDialog(panel, "micNoticeDialog");
      await panel.click("#micNoticeDialogConfirm");
      await waitFor(async () => (await starts()) === 1, "recognition to start after 'Continue'");
      assert.equal((await stored("micCloudNoticeAcknowledged")).micCloudNoticeAcknowledged, true);

      await panel.click("#micBtn"); // stop
      await waitFor(() => panel.evaluate(() => !document.getElementById("micBtn").classList.contains("active")), "voice input to stop");
      await panel.click("#micBtn"); // start again: no notice this time
      await waitFor(async () => (await starts()) === 2, "recognition to start again");
      assert.equal(await dialogOpen(panel, "micNoticeDialog"), false, "the notice was shown a second time");
    });
  });

  await test("images: the 'not filtered' notice comes once, before the first image is attached; text files are not affected", async () => {
    await scenario({ seed: { includeCurrentPageContext: false } }, async ({ panel }) => {
      const chips = () => panel.$$eval("#attachmentList > *", (els) => els.length);
      await panel.setInputFiles("#fileInput", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("just some text") });
      await waitFor(async () => (await chips()) === 1, "the text file to be attached");
      assert.equal(await dialogOpen(panel, "imageNoticeDialog"), false, "a text file triggered the image notice");

      await panel.setInputFiles("#fileInput", { name: "pixel.png", mimeType: "image/png", buffer: PNG });
      await waitDialog(panel, "imageNoticeDialog");
      assert.equal(await focusedId(panel), "imageNoticeDialogCancel");
      assert.equal(await chips(), 1, "the image was attached before the notice was answered");
      await panel.click("#imageNoticeDialogCancel");
      await waitNoDialog(panel, "imageNoticeDialog");
      await sleep(300);
      assert.equal(await chips(), 1, "the image was attached although the user cancelled");
      assert.equal((await stored("imageNoticeAcknowledged")).imageNoticeAcknowledged, undefined);

      await panel.setInputFiles("#fileInput", { name: "pixel.png", mimeType: "image/png", buffer: PNG });
      await waitDialog(panel, "imageNoticeDialog");
      await panel.click("#imageNoticeDialogConfirm");
      await waitFor(async () => (await chips()) === 2, "the image to be attached after the user agreed");
      assert.equal((await stored("imageNoticeAcknowledged")).imageNoticeAcknowledged, true);

      await panel.setInputFiles("#fileInput", { name: "pixel2.png", mimeType: "image/png", buffer: PNG });
      await waitFor(async () => (await chips()) === 3, "the second image to be attached");
      assert.equal(await dialogOpen(panel, "imageNoticeDialog"), false, "the notice was shown a second time");
    });
  });

  assert.deepEqual(pageErrors, [], `uncaught errors in the pages: ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  webServer.closeAllConnections?.();
  providerServer.closeAllConnections?.();
  webServer.close();
  providerServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
