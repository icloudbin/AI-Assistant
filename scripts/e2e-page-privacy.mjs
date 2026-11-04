// scripts/e2e-page-privacy.mjs
//
// Real-browser check for S-05 (what the assistant may read from the page you are
// looking at) and S-08 (what is said before voice input and images, which the
// privacy filter cannot cover).
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
// panel says it did. A second local server plays the websites (every
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

// ---- fake websites -----------------------------------------------------------
const HOSTS = {
  plain: "plain.test-site.example", // an ordinary site
  other: "other.test-site.example", // another ordinary site
  mail: "mail.test-site.example", // a webmail-looking name: protected by the built-in rules
  never: "never.test-site.example", // goes on the user's never-send list
  webapp: "webapp.test-site.example", // an ordinary name that renders a Proton Mail message
};
const MARKERS = { [HOSTS.plain]: "PLAINMARK", [HOSTS.other]: "OTHERMARK", [HOSTS.mail]: "MAILMARK", [HOSTS.never]: "NEVERMARK" };
const sentence = (marker) => `${marker} is the text of this test page, written as several complete sentences so that the page extractor treats it as readable article content.`;
const articleHtml = (marker) => `<!doctype html><html><head><meta charset="utf-8"><title>${marker} Title</title></head><body><main><h1>${marker} Heading</h1>${`<p>${sentence(marker)}</p>`.repeat(6)}</main></body></html>`;
// content.js recognises a Proton Mail message by this iframe and reports source "proton-mail"
// whatever the site is called - a webmail that no host list can know about.
const webappHtml = () => `<!doctype html><html><head><meta charset="utf-8"><title>WEBAPPMARK Title</title></head><body><main><h1>WEBAPPMARK Heading</h1><iframe data-testid="content-iframe" data-subject="Subject line" srcdoc="<p>PROTONMARK is the body of a private message that was opened in this web app.</p>"></iframe></main></body></html>`;
const webServer = http.createServer((req, res) => {
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(host === HOSTS.webapp ? webappHtml() : articleHtml(MARKERS[host] || "UNKNOWNMARK"));
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
  const history = async () => (await stored("conversationHistory")).conversationHistory ?? [];
  const historyText = async () => JSON.stringify(await history());

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

  // Fresh storage, the given websites open, the panel next to them, and the main
  // site's tab in front (it is "the page the user is looking at").
  async function scenario({ seed = {}, web = null, also = [], speech = false }, body) {
    provider.requests = [];
    await reset(seed);
    const opened = [];
    const sites = {};
    const open = async (host) => {
      const page = await context.newPage();
      await page.goto(`http://${host}:${webPort}/`);
      opened.push(page);
      sites[host] = page;
      return page;
    };
    for (const host of also) await open(host);
    if (web) await open(web);
    const panel = await openPanel({ speech });
    opened.push(panel);
    try {
      if (web) {
        await sites[web].bringToFront();
        await waitFor(async () => {
          const url = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url || "");
          return url.includes(web);
        }, `the ${web} tab to be the active tab`);
      }
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
  const modeShown = (panel) => panel.$eval("#includeContextSelect", (s) => s.value);
  const bar = (panel) => panel.evaluate(() => {
    const el = document.getElementById("pageContextBar");
    return el.hidden ? "" : document.getElementById("pageContextTitle").textContent;
  });
  const waitBar = (panel, needle) => waitFor(async () => (await bar(panel)).includes(needle), `the context bar to show ${needle}`);
  const bubbleCount = (panel, cls) => panel.$$eval(`.bubble.${cls}`, (els) => els.length);
  const bubbleTexts = (panel, cls) => panel.$$eval(`.bubble.${cls} .bubble-text`, (els) => els.map((e) => e.textContent.trim()));
  async function ask(panel, text) {
    await panel.fill("#questionInput", text);
    await panel.click("#sendBtn");
  }
  async function answered(panel, n) {
    await waitFor(async () => (await bubbleCount(panel, "assistant")) >= n, `assistant reply #${n}`);
    await waitFor(() => sendEnabled(panel), "the composer to unlock");
  }
  async function noRequestYet(panel, ms = 600) {
    await sleep(ms);
    assert.equal(provider.requests.length, 0, "a request reached the provider");
    assert.equal(await bubbleCount(panel, "user"), 0, "a question bubble was left in the chat");
  }

  // ============================== S-05: page reading ==============================

  await test("first run: the panel asks before reading any page; Esc leaves it undecided and nothing is sent", async () => {
    await scenario({ web: HOSTS.plain }, async ({ panel }) => {
      await waitDialog(panel, "pageChoiceDialog");
      assert.equal(await modeShown(panel), "", "the control must say 'not set'");
      assert.equal(await focusedId(panel), "pageChoice_ask", "the focus starts on 'Ask each time'");
      assert.deepEqual(
        await panel.$$eval("#pageChoiceDialog .ai-choice-btn", (els) => els.map((e) => e.id)),
        ["pageChoice_off", "pageChoice_ask", "pageChoice_on"],
      );
      await panel.keyboard.press("Escape");
      await waitNoDialog(panel, "pageChoiceDialog");
      assert.equal((await stored("includeCurrentPageContext")).includeCurrentPageContext, undefined, "Esc must not choose for the user");
      // Undecided behaves like "off": a typed question carries no page.
      await ask(panel, "hello there");
      await answered(panel, 1);
      assert.equal(provider.requests.length, 1);
      assert.ok(!carries("PLAINMARK"), "a page was sent before the user had chosen");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false);
      // Not decided: the question comes back the next time a panel is opened.
      const second = await openPanel();
      try {
        await waitDialog(second, "pageChoiceDialog");
      } finally {
        await second.close();
      }
    });
  });

  await test("first run: a choice is stored, and the selector can change it later", async () => {
    await scenario({ web: HOSTS.plain }, async ({ panel }) => {
      await waitDialog(panel, "pageChoiceDialog");
      await panel.click("#pageChoice_ask");
      await waitNoDialog(panel, "pageChoiceDialog");
      await waitFor(async () => (await stored("includeCurrentPageContext")).includeCurrentPageContext === "ask", "'ask' to be stored");
      assert.equal(await modeShown(panel), "ask");
      for (const [mode, value] of [["on", true], ["off", false], ["ask", "ask"]]) {
        await panel.selectOption("#includeContextSelect", mode);
        await waitFor(async () => (await stored("includeCurrentPageContext")).includeCurrentPageContext === value, `${mode} to be stored`);
        assert.equal(await modeShown(panel), mode);
      }
    });
  });

  await test("a choice made elsewhere (another window, an import) closes the open question", async () => {
    await scenario({ web: HOSTS.plain }, async ({ panel }) => {
      await waitDialog(panel, "pageChoiceDialog");
      await inWorker(() => chrome.storage.local.set({ includeCurrentPageContext: false }));
      await waitNoDialog(panel, "pageChoiceDialog");
      assert.equal(await modeShown(panel), "off");
    });
  });

  await test("ask each time: Cancel sends nothing, saves nothing and keeps the draft", async () => {
    await scenario({ seed: { includeCurrentPageContext: "ask" }, web: HOSTS.plain }, async ({ panel }) => {
      await panel.fill("#questionInput", "my draft question");
      await panel.click("#sendBtn");
      await waitDialog(panel, "pageConfirmDialog");
      const text = await panel.$eval("#pageConfirmDialog", (d) => d.textContent);
      assert.ok(text.includes(HOSTS.plain), `the question does not name the site: ${text}`);
      assert.ok(text.includes("PLAINMARK Title"), `the question does not name the page: ${text}`);
      assert.equal(await panel.$("#pageConfirmDialog .ai-dialog-warning"), null, "an ordinary site got the sensitive-site wording");
      assert.equal(await focusedId(panel), "pageConfirmCancel", "the safe button must be the one with the focus");
      await panel.click("#pageConfirmCancel");
      await waitNoDialog(panel, "pageConfirmDialog");
      await waitFor(() => sendEnabled(panel), "the composer to unlock");
      assert.equal(await panel.$eval("#questionInput", (e) => e.value), "my draft question", "the draft was lost");
      await noRequestYet(panel);
      assert.ok(!(await historyText()).includes("my draft question"), "the cancelled question was saved");
    });
  });

  await test("ask each time: 'Send without page' and 'Send page' do what they say; 'don't ask again' is per site and per panel session", async () => {
    await scenario({ seed: { includeCurrentPageContext: "ask" }, web: HOSTS.plain, also: [HOSTS.other] }, async ({ panel, sites }) => {
      await ask(panel, "question one");
      await waitDialog(panel, "pageConfirmDialog");
      await panel.click("#pageConfirmWithout");
      await answered(panel, 1);
      assert.equal(provider.requests.length, 1);
      assert.ok(!carries("PLAINMARK"), "'Send without page' sent the page");

      await ask(panel, "question two");
      await waitDialog(panel, "pageConfirmDialog");
      await panel.click("#pageConfirmSend");
      await answered(panel, 2);
      assert.ok(carries("PLAINMARK"), "'Send page' did not send the page");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false);

      await ask(panel, "question three");
      await waitDialog(panel, "pageConfirmDialog");
      await panel.check("#pageConfirmRemember");
      await panel.click("#pageConfirmSend");
      await answered(panel, 3);
      assert.ok(carries("PLAINMARK"));

      // Remembered: this site no longer asks (the request would never leave if it did).
      await ask(panel, "question four");
      await answered(panel, 4);
      assert.ok(carries("PLAINMARK"), "the remembered site did not send its page");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false);

      // Another site still asks.
      await sites[HOSTS.other].bringToFront();
      await waitBar(panel, HOSTS.other);
      await ask(panel, "question five");
      await waitDialog(panel, "pageConfirmDialog");
      await panel.click("#pageConfirmCancel");
      await waitNoDialog(panel, "pageConfirmDialog");
      assert.equal(provider.requests.length, 4);
      assert.equal((await stored("pageAlwaysAllowHosts")).pageAlwaysAllowHosts, undefined, "'don't ask again' must not edit the user's lists");
    });
  });

  await test("ask each time on a sensitive site: stronger wording, and the page goes only after 'Send page'", async () => {
    await scenario({ seed: { includeCurrentPageContext: "ask" }, web: HOSTS.mail }, async ({ panel }) => {
      await ask(panel, "who wrote to me?");
      await waitDialog(panel, "pageConfirmDialog");
      assert.ok(await panel.$("#pageConfirmDialog .ai-dialog-warning"), "no sensitive-site warning");
      assert.ok((await panel.$eval("#pageConfirmDialog", (d) => d.textContent)).includes(HOSTS.mail));
      assert.equal(await focusedId(panel), "pageConfirmCancel");
      assert.equal(provider.requests.length, 0, "the question left before the user answered");
      await panel.click("#pageConfirmSend");
      await answered(panel, 1);
      assert.ok(carries("MAILMARK"));
    });
  });

  await test("always read + sensitive site: the page is NOT sent, the bar says why, and 'Allow' opens it for this session", async () => {
    await scenario({ seed: { includeCurrentPageContext: true }, web: HOSTS.mail }, async ({ panel }) => {
      await waitBar(panel, "🔒");
      assert.equal(await panel.$eval("#pageContextAllowBtn", (b) => b.hidden), false, "no way to allow the site");
      await ask(panel, "what does it say?");
      await answered(panel, 1);
      assert.ok(!carries("MAILMARK"), "a webmail page was sent without anyone allowing it");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false);

      await panel.click("#pageContextAllowBtn");
      await waitFor(async () => !(await bar(panel)).includes("🔒"), "the bar to stop saying 'blocked'");
      await ask(panel, "and now?");
      await answered(panel, 2);
      assert.ok(carries("MAILMARK"), "an allowed site's page was not sent");
      assert.equal((await stored("pageAlwaysAllowHosts")).pageAlwaysAllowHosts, undefined, "Allow must not edit the user's lists");
    });
  });

  await test("always read + ordinary site: the page is sent without a question (positive control)", async () => {
    await scenario({ seed: { includeCurrentPageContext: true }, web: HOSTS.plain }, async ({ panel }) => {
      await waitBar(panel, "📄");
      await ask(panel, "what is this page about?");
      await answered(panel, 1);
      assert.ok(carries("PLAINMARK"), "the page was not sent, so every 'not sent' check above proves nothing");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false);
    });
  });

  await test("quick actions work in every mode; on a sensitive site they ask first, and Cancel leaves nothing behind", async () => {
    await scenario({ seed: { includeCurrentPageContext: false }, web: HOSTS.plain }, async ({ panel }) => {
      await panel.click("#quickSummarizeBtn");
      await answered(panel, 1);
      assert.ok(carries("PLAINMARK"), "Summarize did not send the page while the mode is 'off'");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false, "an ordinary site asked");
    });
    await scenario({ seed: { includeCurrentPageContext: false }, web: HOSTS.mail }, async ({ panel }) => {
      await panel.click("#quickSummarizeBtn");
      await waitDialog(panel, "pageConfirmDialog");
      assert.ok(await panel.$("#pageConfirmDialog .ai-dialog-warning"), "no sensitive-site warning");
      assert.equal(await panel.$("#pageConfirmWithout"), null, "a page action cannot be sent without the page");
      assert.equal(provider.requests.length, 0, "the page left before the user answered");
      await panel.click("#pageConfirmCancel");
      await waitNoDialog(panel, "pageConfirmDialog");
      await waitFor(() => sendEnabled(panel), "the composer to unlock");
      await noRequestYet(panel);
      assert.deepEqual(await history(), [], "a cancelled quick action was saved");
      // The same action, confirmed.
      await panel.click("#quickSummarizeBtn");
      await waitDialog(panel, "pageConfirmDialog");
      await panel.click("#pageConfirmSend");
      await answered(panel, 1);
      assert.ok(carries("MAILMARK"));
    });
  });

  await test("never-send list: nothing from that site goes out - not even by a quick action", async () => {
    await scenario({ seed: { includeCurrentPageContext: true, pageNeverSendHosts: [HOSTS.never] }, web: HOSTS.never }, async ({ panel }) => {
      await waitBar(panel, "🚫");
      await ask(panel, "read this to me");
      await answered(panel, 1);
      assert.ok(!carries("NEVERMARK"), "a never-send site's page was sent");
      await panel.click("#quickSummarizeBtn");
      await waitFor(async () => (await bubbleCount(panel, "notice")) >= 1, "the notice that the action was refused");
      assert.ok((await bubbleTexts(panel, "notice")).join(" ").includes(HOSTS.never), "the notice does not name the site");
      await waitFor(() => sendEnabled(panel), "the composer to unlock");
      assert.equal(provider.requests.length, 1, "the refused quick action reached the provider");
      assert.equal(await bubbleCount(panel, "user"), 1, "the refused action left a question bubble");
    });
  });

  await test("always-allow list: a listed site skips the sensitive-site rule and the question; never-send still wins", async () => {
    await scenario({ seed: { includeCurrentPageContext: "ask", pageAlwaysAllowHosts: [HOSTS.mail] }, web: HOSTS.mail }, async ({ panel }) => {
      await ask(panel, "summarize my inbox");
      await answered(panel, 1);
      assert.ok(carries("MAILMARK"), "an always-allowed site's page was not sent");
      assert.equal(await dialogOpen(panel, "pageConfirmDialog"), false, "an always-allowed site asked");
    });
    await scenario({ seed: { includeCurrentPageContext: true, pageAlwaysAllowHosts: [HOSTS.mail], pageNeverSendHosts: [HOSTS.mail] }, web: HOSTS.mail }, async ({ panel }) => {
      await ask(panel, "summarize my inbox");
      await answered(panel, 1);
      assert.ok(!carries("MAILMARK"), "the always-allow list overrode the never-send list");
    });
  });

  await test("lists edited in Settings reach an open panel at once (bar) and apply to the very next send", async () => {
    await scenario({ seed: { includeCurrentPageContext: true }, web: HOSTS.mail }, async ({ panel }) => {
      await waitBar(panel, "🔒");
      await inWorker((h) => chrome.storage.local.set({ pageAlwaysAllowHosts: [h] }), HOSTS.mail);
      await waitFor(async () => !(await bar(panel)).includes("🔒"), "the bar to follow the edited list");
      await inWorker((h) => chrome.storage.local.set({ pageNeverSendHosts: [h] }), HOSTS.mail);
      await waitBar(panel, "🚫");
      await ask(panel, "anything");
      await answered(panel, 1);
      assert.ok(!carries("MAILMARK"));
    });
  });

  await test("a tab switch while the question is open: nothing is sent, the user is told, the draft stays", async () => {
    await scenario({ seed: { includeCurrentPageContext: "ask" }, web: HOSTS.plain, also: [HOSTS.other] }, async ({ panel, sites }) => {
      await ask(panel, "tell me about it");
      await waitDialog(panel, "pageConfirmDialog");
      await sites[HOSTS.other].bringToFront(); // the user looks at something else...
      await sleep(300);
      await panel.click("#pageConfirmSend"); // ...and then says yes to the question about the first page
      await waitNoDialog(panel, "pageConfirmDialog");
      await waitFor(async () => (await bubbleCount(panel, "notice")) >= 1, "the notice about the tab change");
      await waitFor(() => sendEnabled(panel), "the composer to unlock");
      assert.equal(provider.requests.length, 0, "a page was sent after the tab had changed");
      assert.equal(await panel.$eval("#questionInput", (e) => e.value), "tell me about it", "the draft was lost");
      assert.equal(await bubbleCount(panel, "user"), 0);
      assert.deepEqual(await history(), [], "the abandoned question was saved");
    });
  });

  await test("a page that only the extractor recognises as webmail is protected too (always read)", async () => {
    await scenario({ seed: { includeCurrentPageContext: true }, web: HOSTS.webapp }, async ({ panel }) => {
      await ask(panel, "what is this?");
      await answered(panel, 1);
      assert.equal(provider.requests.length, 1, "the question itself should still be answered");
      assert.ok(!carries("PROTONMARK"), "a webmail message was sent because its site name looked ordinary");
      assert.ok(!carries("WEBAPPMARK"));
    });
  });

  await test("ask each time + extractor-detected webmail: asked again, and Cancel takes the question back everywhere", async () => {
    await scenario({ seed: { includeCurrentPageContext: "ask" }, web: HOSTS.webapp }, async ({ panel }) => {
      await ask(panel, "keep this question private");
      await waitDialog(panel, "pageConfirmDialog");
      assert.equal(await panel.$("#pageConfirmDialog .ai-dialog-warning"), null, "the first question is about an ordinary-looking site");
      await panel.click("#pageConfirmSend");
      // The page has now been read and turns out to be a webmail message: ask once more, strongly.
      await waitFor(async () => (await panel.$("#pageConfirmDialog .ai-dialog-warning")) !== null, "the second, sensitive question");
      // The question was already saved at this moment - the case the rollback has to clean up.
      assert.ok((await historyText()).includes("keep this question private"), "the scenario no longer saves the question before the page is read");
      assert.equal(provider.requests.length, 0);
      await panel.click("#pageConfirmCancel");
      await waitNoDialog(panel, "pageConfirmDialog");
      await waitFor(() => sendEnabled(panel), "the composer to unlock");
      assert.equal(await panel.$eval("#questionInput", (e) => e.value), "keep this question private", "the text was not given back");
      assert.equal(await bubbleCount(panel, "user"), 0);
      await waitFor(async () => !(await historyText()).includes("keep this question private"), "the cancelled question to disappear from the saved history");
      await noRequestYet(panel);
      // ...and the same question, confirmed twice, goes out with the page.
      await panel.click("#sendBtn");
      await waitDialog(panel, "pageConfirmDialog");
      await panel.click("#pageConfirmSend");
      await waitFor(async () => (await panel.$("#pageConfirmDialog .ai-dialog-warning")) !== null, "the second question again");
      await panel.click("#pageConfirmSend");
      await answered(panel, 1);
      assert.ok(carries("PROTONMARK"), "the confirmed webmail page was not sent");
      assert.ok((await historyText()).includes("keep this question private"));
    });
  });

  await test("Settings: the two site lists are cleaned up on save, and what was not a site is reported", async () => {
    await reset({});
    const options = await context.newPage();
    options.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      await options.goto(`chrome-extension://${extId}/options/options.html`);
      await options.waitForSelector("#neverHostsInput");
      await options.fill("#neverHostsInput", " Bank.Example.com ,\nhttps://foo.example/path?x=1\nnot a host!");
      await options.fill("#allowHostsInput", "mail.test-site.example");
      await options.click("#saveHostLists");
      await waitFor(async () => (await stored("pageNeverSendHosts")).pageNeverSendHosts !== undefined, "the lists to be stored");
      const values = await stored(["pageNeverSendHosts", "pageAlwaysAllowHosts"]);
      assert.deepEqual(values.pageNeverSendHosts, ["bank.example.com", "foo.example"]);
      assert.deepEqual(values.pageAlwaysAllowHosts, ["mail.test-site.example"]);
      assert.equal(await options.$eval("#neverHostsInput", (e) => e.value), "bank.example.com\nfoo.example");
      assert.match(await options.$eval("#hostListsMsg", (e) => e.textContent), /not a host/, "the entry that is not a site was dropped silently");
    } finally {
      await options.close();
    }
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
