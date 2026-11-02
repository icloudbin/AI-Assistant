// scripts/e2e-tabs-permission.mjs
//
// Checks the claim behind S-07 ("with <all_urls> the `tabs` permission is
// redundant") in a real Chromium instead of taking it from the documentation:
// the same extension is loaded twice - as shipped (no `tabs`) and with `tabs`
// added back - and the Tab objects an extension page gets from chrome.tabs are
// compared for the kinds of page the extension actually works on.
//
//   node scripts/e2e-tabs-permission.mjs
//
// Needs Playwright with Chromium.

import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The two variants.
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
assert.ok(!manifest.permissions.includes("tabs"), "the shipped manifest still declares `tabs`");
function variant(name, withTabs) {
  const dir = path.join(tmp, name);
  fs.cpSync(extDir, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}scripts`) });
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  m.permissions = withTabs ? [...new Set([...m.permissions, "tabs"])] : m.permissions.filter((p) => p !== "tabs");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  return dir;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>Local test page</title><h1>hello</h1>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/article`;

async function probe(dir, label) {
  const context = await chromium.launchPersistentContext(path.join(tmp, `profile-${label}`), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--no-proxy-server"],
  });
  try {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(worker.url()).host;
    const web = await context.newPage();
    await web.goto(pageUrl);
    const internal = await context.newPage();
    await internal.goto("chrome://version/").catch(() => {});
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/options/options.html`);
    await sleep(300);
    const tabs = await panel.evaluate(() => chrome.tabs.query({}).then((list) => list.map((t) => ({ url: t.url ?? null, title: t.title ?? null }))));
    const find = (pred) => tabs.find(pred) || null;
    const out = {
      web: find((t) => (t.url || "").startsWith("http://127.0.0.1")) || find((t) => t.title === null && false),
      internal: tabs.find((t) => (t.url || "").startsWith("chrome://")) || null,
      ownPage: find((t) => (t.url || "").startsWith(`chrome-extension://${extId}/options`)),
      count: tabs.length,
    };
    // A tab whose url is hidden shows up with url null.
    out.hiddenCount = tabs.filter((t) => t.url === null).length;
    // The calls the extension makes on the active web tab must work without `tabs` too.
    await web.bringToFront();
    const calls = await panel.evaluate(async (url) => {
      const res = {};
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      const target = (await chrome.tabs.query({ url: "http://127.0.0.1/*" }))[0];
      res.queryByUrlFound = !!target;
      if (target) {
        try {
          const inj = await chrome.scripting.executeScript({ target: { tabId: target.id }, func: () => document.title });
          res.executeScript = inj?.[0]?.result;
        } catch (e) { res.executeScriptError = String(e.message || e); }
        try {
          const shot = await chrome.tabs.captureVisibleTab(target.windowId, { format: "jpeg", quality: 50 });
          res.captureVisibleTab = typeof shot === "string" && shot.startsWith("data:image/jpeg");
        } catch (e) { res.captureError = String(e.message || e); }
        try {
          const created = await chrome.tabs.create({ url: "about:blank", active: false });
          res.tabsCreate = !!created?.id;
          await chrome.tabs.remove(created.id);
        } catch (e) { res.tabsCreateError = String(e.message || e); }
      }
      return res;
    }, pageUrl);
    // The panel refreshes its "which page will be sent" bar from tabs.onUpdated:
    // a title change and a finished navigation must still be reported.
    await panel.evaluate(() => {
      globalThis.__events = [];
      chrome.tabs.onUpdated.addListener((id, info) => globalThis.__events.push({ title: info.title ?? null, status: info.status ?? null }));
    });
    await web.evaluate(() => { document.title = "Changed title"; });
    await sleep(300);
    await web.reload();
    await sleep(500);
    const events = await panel.evaluate(() => globalThis.__events);
    calls.titleEvent = events.some((e) => e.title === "Changed title");
    calls.completeEvent = events.some((e) => e.status === "complete");
    return { out, calls };
  } finally {
    await context.close();
  }
}

let failed = false;
try {
  const shipped = await probe(variant("without-tabs", false), "without");
  const control = await probe(variant("with-tabs", true), "with");
  console.log("shipped (no `tabs`):", JSON.stringify(shipped));
  console.log("control (with `tabs`):", JSON.stringify(control));

  const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed = true; console.log(`FAIL  ${name}\n      ${e.message}`); }
  };
  check("an http(s) tab still shows its real url and title without `tabs` (host permission covers it)", () => {
    assert.equal(shipped.out.web?.url, pageUrl);
    assert.equal(shipped.out.web?.title, "Local test page");
    assert.deepEqual(shipped.out.web, control.out.web);
  });
  check("the calls the panel makes on the active page work without `tabs` (scripting, captureVisibleTab, tabs.create)", () => {
    assert.equal(shipped.calls.executeScript, "Local test page", JSON.stringify(shipped.calls));
    assert.equal(shipped.calls.captureVisibleTab, true, JSON.stringify(shipped.calls));
    assert.equal(shipped.calls.tabsCreate, true, JSON.stringify(shipped.calls));
    assert.equal(control.calls.executeScript, shipped.calls.executeScript);
  });
  check("tabs.onUpdated still reports title changes and finished navigations on a web page without `tabs`", () => {
    assert.equal(shipped.calls.titleEvent, true, JSON.stringify(shipped.calls));
    assert.equal(shipped.calls.completeEvent, true, JSON.stringify(shipped.calls));
  });
  console.log(`INFO  chrome:// page seen by the extension: without \`tabs\` -> ${JSON.stringify(shipped.out.internal)} ; with \`tabs\` -> ${JSON.stringify(control.out.internal)}`);
  console.log("      (the panel treats every non-http(s) tab as 'no readable page' either way - see refreshActivePageContext)");
  console.log(`INFO  the extension's own pages: without \`tabs\` -> ${JSON.stringify(shipped.out.ownPage)} ; with \`tabs\` -> ${JSON.stringify(control.out.ownPage?.url)}`);
  console.log("      (no code reads url/title of its own pages from a Tab object; the runtime's sender.url checks are unaffected)");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
