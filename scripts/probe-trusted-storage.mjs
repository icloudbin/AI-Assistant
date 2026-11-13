#!/usr/bin/env node
// One-off probe (NOT a committed suite): verifies the SEC-03 storage
// isolation behaves as documented in a real extension-loaded Chromium.
//  1. chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})
//     succeeded in the service worker (no rejection).
//  2. A content script's isolated world no longer sees chrome.storage.
//  3. The panel (a trusted extension page) still reads/writes storage fine.
// Run: node scripts/probe-trusted-storage.mjs
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pw = await import("playwright");
const chromium = process.argv[2] === "chrome" ? pw.chromium : pw.chromium; // channel selected below
const CHANNEL = process.argv[2] === "chrome" ? "chrome" : "chromium";

// data: pages are outside <all_urls> (extension URL patterns never match
// data:), so serve the probe page over 127.0.0.1 like the e2e suites do.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><head><title>probe</title></head><body>probe</body></html>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-storage-probe-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: CHANNEL,
  headless: true,
  args: [
    `--disable-extensions-except=${repoRoot}`,
    `--load-extension=${repoRoot}`,
  ],
});
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : " :: " + detail}`); if (!ok) failed++; };

let sw = context.serviceWorkers().find((w) => w.url().endsWith("background.js"));
if (!sw) {
  // Open the panel to wake the worker if needed, then wait again.
  const wake = await context.newPage().catch(() => null);
  if (wake) await wake.goto('about:blank').catch(() => {});
  sw = await context.waitForEvent("serviceworker", { timeout: 30000 }).catch(() => null);
  if (!sw) sw = context.serviceWorkers().find((w) => w.url().endsWith("background.js")) || null;
  if (wake) await wake.close().catch(() => {});
}
check("service worker started", !!sw, "no background.js service worker");

// A page whose content-script world we can inspect.
const page = await context.newPage();
await page.goto(pageUrl);

if (sw) {
  const restricted = await sw.evaluate(async () => {
    const ua = navigator.userAgent;
    const localHas = typeof chrome.storage.local.setAccessLevel;
    const sessionHas = typeof chrome.storage.session?.setAccessLevel;
    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      return { ua, localHas, sessionHas, call: "ok" };
    } catch (err) { return { ua, localHas, sessionHas, call: "threw: " + err.message }; }
  });
  console.log("  [info] UA=" + restricted.ua + " local.setAccessLevel=" + restricted.localHas + " session.setAccessLevel=" + restricted.sessionHas);
  check("setAccessLevel(TRUSTED_CONTEXTS) accepted", restricted.call === "ok", restricted.call);

  const world = await sw.evaluate(async (url) => {
    // chrome.tabs needs no permission for id/url of its OWN extension's tabs?
    // The tabs permission was removed on purpose; query by URL of a data: page
    // still lists tabs but hides url - so find the tab via its title instead.
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url || t.title === "probe") || tabs[0];
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        chromeType: typeof chrome,
        storageType: typeof chrome.storage,
        localGetType: typeof chrome.storage?.local?.get,
        runtimeGetType: typeof chrome.runtime?.getURL,
      }),
    });
    return result;
  }, pageUrl).catch((err) => ({ error: String(err).slice(0, 200) }));
  check("content-script world: chrome object present", world?.chromeType === "object", JSON.stringify(world));
  check("content-script world: chrome.storage is GONE (TRUSTED_CONTEXTS)", world?.storageType === "undefined", JSON.stringify(world));
  check("content-script world: chrome.runtime still present", world?.runtimeGetType === "function", JSON.stringify(world));
}

// The panel is a trusted extension page: storage must keep working.
const panel = await context.newPage();
if (sw) {
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/sidepanel/sidepanel.html`);
  await panel.waitForTimeout(800);
}
const trusted = sw ? await panel.evaluate(async () => {
  try {
    await chrome.storage.local.set({ probeKey: 1 });
    const got = await chrome.storage.local.get("probeKey");
    return got.probeKey === 1 ? "ok" : "no-roundtrip";
  } catch (err) { return "threw: " + err.message; }
}).catch((err) => "page-error: " + String(err).slice(0, 120)) : "no service worker";
check("panel (trusted context) still reads/writes storage", trusted === "ok", trusted);

await context.close();
fs.rmSync(profile, { recursive: true, force: true });
server.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
