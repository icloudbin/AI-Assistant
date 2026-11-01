// scripts/e2e-chat-flow.mjs
//
// Real-browser, real-network-stack check of the chat flow:
//   * B-02: "Stop" must interrupt a stream that has already started;
//   * a normal send/receive round trip (reply shown and saved to history);
//   * E-04: the context-menu "Translate selected text" action still works end
//     to end after the dead summarize/explain/fact-check branches were removed.
//
// Needs Playwright with Chromium and openssl (neither is a dependency of the
// extension itself):   node scripts/e2e-chat-flow.mjs
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

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

  // Only the message body (.bubble-text): the bubble also holds the model tag and the copy button.
  const lastReply = () => page.evaluate(() => [...document.querySelectorAll(".bubble.assistant .bubble-text")].pop()?.textContent?.trim() || "");
  const errorBubbles = () => page.evaluate(() => [...document.querySelectorAll(".bubble.error .bubble-text")].map((b) => b.textContent.trim()));
  async function ask(question) {
    await page.fill("#questionInput", question);
    await page.click("#sendBtn");
  }
  const sendEnabled = () => page.evaluate(() => !document.getElementById("sendBtn").disabled);

  await test("normal round trip: the whole streamed reply is shown and saved", async () => {
    Object.assign(provider, { chunks: 8, intervalMs: 40, prefix: "w", reply: null, requests: [] });
    await ask("hello");
    const expected = Array.from({ length: 8 }, (_, i) => `w${i}`).join(" ");
    await waitFor(async () => (await lastReply()).includes("w7"), "the last chunk to render");
    await waitFor(sendEnabled, "the composer to unlock after DONE");
    assert.equal((await lastReply()).replace(/\s+/g, " "), expected);
    assert.deepEqual(await errorBubbles(), []);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].finished, true);
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get("conversationHistory")).conversationHistory);
    const assistant = saved?.[0]?.messages?.find((m) => m.role === "assistant");
    assert.equal(assistant?.content?.replace(/\s+/g, " ").trim(), expected, "the reply must be saved to history unchanged");
    // the pointer that was removed (E-04) must not be written any more
    const pointer = await worker.evaluate(async () => (await chrome.storage.local.get("currentConversationId")).currentConversationId);
    assert.equal(pointer, undefined, "currentConversationId must not be written any more");
  });

  await test("STOP mid-stream closes the provider connection right away (B-02)", async () => {
    await page.click("#clearBtn"); // new topic
    Object.assign(provider, { chunks: 100, intervalMs: 40, prefix: "s", reply: null, requests: [] }); // would run ~4 s
    await ask("a long answer please");
    await waitFor(async () => (await lastReply()).includes("s3"), "the stream to be under way");
    const stopAt = Date.now();
    await page.click("#clearBtn"); // this is the user's STOP
    const rec = provider.requests[0];
    await waitFor(() => rec.closedByClientAt || rec.finished, "the server to see the connection end", 6000);
    const lag = rec.closedByClientAt ? rec.closedByClientAt - stopAt : Infinity;
    await sleep(500); // anything still being produced would show up now
    assert.equal(rec.finished, false, `the provider streamed to completion (${rec.written}/${rec.total} chunks) after STOP`);
    assert.ok(lag < 1000, `connection closed ${lag} ms after STOP`);
    assert.ok(rec.written < 60, `provider wrote ${rec.written}/${rec.total} chunks`);
    assert.deepEqual(await errorBubbles(), [], "STOP is not an error");
    assert.equal(await sendEnabled(), true, "the composer is usable again");
  });

  await test("re-asking right after STOP: only the new reply streams (no parallel old stream)", async () => {
    await page.click("#clearBtn");
    Object.assign(provider, { chunks: 100, intervalMs: 40, prefix: "old", reply: null, requests: [] });
    await ask("first question");
    await waitFor(async () => (await lastReply()).includes("old2"), "the first stream to be under way");
    await page.click("#clearBtn"); // STOP
    Object.assign(provider, { chunks: 5, intervalMs: 30, prefix: "new" });
    await ask("second question");
    await waitFor(async () => (await lastReply()).includes("new4"), "the second reply");
    await waitFor(sendEnabled, "the composer to unlock");
    await sleep(400);
    const [first, second] = provider.requests;
    assert.equal(first.finished, false, "the first stream must have been cut");
    assert.ok(first.closedByClientAt, "the first connection must be closed, not left running next to the new one");
    assert.ok(first.written < 40, `the first stream kept producing (${first.written}/${first.total} chunks)`);
    assert.equal(second.finished, true);
    assert.equal((await lastReply()).replace(/\s+/g, " "), "new0 new1 new2 new3 new4");
    assert.deepEqual(await errorBubbles(), []);
  });

  await test("context-menu 'Translate selected text' still works end to end (E-04)", async () => {
    await page.click("#clearBtn");
    Object.assign(provider, { chunks: 8, intervalMs: 20, prefix: "x", reply: "[1] Bonjour le monde.\n", requests: [] });
    // Exactly what background.js's contextMenus.onClicked handler broadcasts.
    await worker.evaluate(() => chrome.runtime.sendMessage({
      type: "CONTEXT_ACTION",
      pending: { action: "translate", text: "Hello world.", format: "text", truncated: false, createdAt: Date.now() },
    }));
    await waitFor(async () => (await lastReply()).includes("Bonjour"), "the translation to render");
    await waitFor(sendEnabled, "the composer to unlock");
    assert.equal(await lastReply(), "Bonjour le monde.");
    assert.deepEqual(await errorBubbles(), []);
    assert.equal(provider.requests.length, 1, "exactly one provider request");
    const userMessages = provider.requests[0].body.messages.filter((m) => m.role === "user");
    const prompt = userMessages.at(-1).content;
    const text = typeof prompt === "string" ? prompt : prompt.map((p) => p.text || "").join("");
    const userBubble = await page.evaluate(() => [...document.querySelectorAll(".bubble.user .bubble-text")].pop()?.textContent || "");
    // SHOW_PROMPT=1 dumps both, to diff two builds of the extension byte for byte.
    if (process.env.SHOW_PROMPT) console.log(`PROMPT=${JSON.stringify(text)}\nBUBBLE=${JSON.stringify(userBubble)}`);
    // The extension's own instruction preamble comes first; the user's part is
    // the translate instruction followed by the numbered source line - no page
    // context, no fact-check wording.
    assert.ok(text.endsWith("Translate the following highlighted text into English\n\n[1] Hello world."), text.slice(-120));
    assert.ok(!/Fact-check the following/i.test(text), "a fact-check instruction leaked into a translation");
    assert.ok(!/CURRENT PAGE CONTEXT/.test(text.split("[END INSTRUCTIONS FOR THIS REQUEST]")[1] || ""), "page context leaked into a selection translation");
    // the user bubble shows the instruction plus a preview of the selection
    assert.equal(userBubble, "Translate the following highlighted text into English:\n\nHello world.");
  });

  assert.deepEqual(pageErrors, [], `uncaught errors in the panel: ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
