// scripts/e2e-two-windows.mjs
//
// Real-browser check for B-04: two side panels (two windows) that both have the
// SAME conversation open and each continue it. Before the fix the saved
// conversation came out scrambled:
//   * window A's Q2/A2 was put AFTER window B's Q3/A3;
//   * identical messages (the same "continue" sent from both windows, answered
//     identically) were folded into one, so a turn silently disappeared.
//
// Needs Playwright with Chromium and openssl (neither is a dependency of the
// extension itself):   node scripts/e2e-two-windows.mjs [folder]
// `[folder]` runs the same test against another copy of the extension (for
// example the original package) as a control: it is expected to FAIL there.
//
// How it works: a local HTTPS server impersonates api.deepseek.com (same trick
// as e2e-chat-flow.mjs). Two panel pages open the same stored conversation, each
// asks a question, and the fake provider holds every answer back for a moment, so
// the two requests overlap in time - exactly the case where ordering single
// messages by time (instead of whole turns) would break user/assistant alternation.

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

const extDir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 20000) {
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

// Every answer is held back by `delayMs`, then streamed. `answers` maps a
// substring of the question to the answer; the request log lets the test see
// what was asked.
const provider = { delayMs: 700, answers: [], requests: [] };
const lastUserText = (body) => {
  const m = (body?.messages || []).filter((x) => x.role === "user").at(-1);
  return !m ? "" : typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("");
};
const server = https.createServer(
  { key: fs.readFileSync(path.join(tmp, "key.pem")), cert: fs.readFileSync(path.join(tmp, "cert.pem")) },
  (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* ignored */ }
      const question = lastUserText(body);
      provider.requests.push(question);
      const hit = provider.answers.find(([needle]) => question.includes(needle));
      const answer = hit ? hit[1] : "default answer";
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      }, provider.delayMs);
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
  const pageErrors = [];

  // A conversation saved by the OLD format (no ids, no times): both windows
  // load it, so this also covers the deterministic migration.
  const OLD = [
    { role: "user", content: "Q1", modelLabel: "", modelId: "" },
    { role: "assistant", content: "A1", modelLabel: "DeepSeek V4.1 Flash", modelId: "deepseek-flash" },
  ];
  await worker.evaluate((old) => chrome.storage.local.set({
    apiKey: "test-key",
    includeCurrentPageContext: false,
    piiFilterEnabled: false,
    conversationHistory: [{ id: "shared", title: "Shared conversation", updatedAt: Date.now() - 60000, messages: old }],
  }), OLD);

  async function openPanel() {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await page.waitForSelector("#chatForm");
    await page.waitForFunction(() => !document.getElementById("sendBtn").disabled, null, { timeout: 15000 });
    return page;
  }
  const bubbles = (page) => page.evaluate(() => [...document.querySelectorAll(".bubble.user .bubble-text, .bubble.assistant .bubble-text")]
    .map((b) => `${b.closest(".bubble").classList.contains("user") ? "U" : "A"}:${b.textContent.trim()}`));
  async function openShared(page) {
    await page.selectOption("#historySelect", "shared");
    await waitFor(async () => (await bubbles(page)).length >= 2, "the shared conversation to open");
  }
  const send = async (page, text) => {
    await page.fill("#questionInput", text);
    await page.click("#sendBtn");
  };
  const idle = (page) => page.evaluate(() => !document.getElementById("sendBtn").disabled);
  const stored = async () => (await worker.evaluate(async () => (await chrome.storage.local.get("conversationHistory")).conversationHistory)).find((c) => c.id === "shared");
  const shape = (messages) => messages.map((m) => `${m.role === "user" ? "U" : "A"}:${m.content}`);
  const alternates = (messages) => messages.every((m, i) => m.role !== "assistant" || (i > 0 && messages[i - 1].role === "user"));

  const panelA = await openPanel();
  const panelB = await openPanel();
  await openShared(panelA);
  await openShared(panelB);

  await test("overlapping questions from two windows: both turns are saved, each question stays with its own answer, in the order asked", async () => {
    Object.assign(provider, { delayMs: 900, requests: [], answers: [["Q2-from-A", "A2-for-A"], ["Q3-from-B", "A3-for-B"]] });
    await send(panelA, "Q2-from-A");
    await sleep(250); // B asks while A's answer is still on its way
    await send(panelB, "Q3-from-B");
    await waitFor(async () => (await idle(panelA)) && (await idle(panelB)) && provider.requests.length === 2, "both answers to arrive", 30000);
    await sleep(400); // let the last save finish
    const convo = await stored();
    assert.deepEqual(shape(convo.messages), ["U:Q1", "A:A1", "U:Q2-from-A", "A:A2-for-A", "U:Q3-from-B", "A:A3-for-B"]);
    assert.ok(alternates(convo.messages), "an answer lost its question");
    // Every message has an id and they are all different; new ones carry a creation time.
    const ids = convo.messages.map((m) => m.id);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0), `missing ids: ${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids[0].startsWith("legacy-") && ids[1].startsWith("legacy-"), "old messages get deterministic ids");
    assert.ok(convo.messages.slice(2).every((m) => Number.isFinite(m.createdAt) && m.createdAt > 0), "new messages carry createdAt");
    assert.ok(convo.messages[2].createdAt < convo.messages[4].createdAt, "A asked before B");
  });

  await test("the same text sent from both windows (and answered identically) is two turns, not one", async () => {
    Object.assign(provider, { delayMs: 900, requests: [], answers: [["continue", "same answer"]] });
    await send(panelA, "continue");
    await sleep(250);
    await send(panelB, "continue");
    await waitFor(async () => (await idle(panelA)) && (await idle(panelB)) && provider.requests.length === 2, "both answers to arrive", 30000);
    await sleep(400);
    const convo = await stored();
    assert.deepEqual(shape(convo.messages), [
      "U:Q1", "A:A1", "U:Q2-from-A", "A:A2-for-A", "U:Q3-from-B", "A:A3-for-B",
      "U:continue", "A:same answer", "U:continue", "A:same answer",
    ]);
    assert.ok(alternates(convo.messages));
  });

  await test("a window opened afterwards shows the merged conversation in that same order", async () => {
    const fresh = await openPanel();
    await openShared(fresh);
    assert.deepEqual(await bubbles(fresh), [
      "U:Q1", "A:A1", "U:Q2-from-A", "A:A2-for-A", "U:Q3-from-B", "A:A3-for-B",
      "U:continue", "A:same answer", "U:continue", "A:same answer",
    ]);
    await fresh.close();
  });

  await test("a restart of the panel keeps working: another question appends after everything, no duplicates", async () => {
    const again = await openPanel();
    await openShared(again);
    Object.assign(provider, { delayMs: 50, requests: [], answers: [["Q9", "A9"]] });
    await send(again, "Q9");
    await waitFor(async () => (await idle(again)) && provider.requests.length === 1, "the answer", 20000);
    await sleep(300);
    const convo = await stored();
    assert.deepEqual(shape(convo.messages).slice(-2), ["U:Q9", "A:A9"]);
    assert.equal(convo.messages.length, 12);
    assert.equal(new Set(convo.messages.map((m) => m.id)).size, 12);
    await again.close();
  });

  assert.deepEqual(pageErrors, [], `uncaught errors in the panels: ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
