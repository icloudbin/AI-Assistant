// scripts/test-translate-replay.mjs
//
// Regression test for B-03: the single-batch translation "replay" path lost the
// document's trailing static lines. Run with:  node scripts/test-translate-replay.mjs
//
// Single-batch translations whose first attempt comes back incomplete are
// replayed off-screen; when the replay is complete its text replaces the first
// attempt (RESET_REPLY + one CHUNK). The replay translator's finish() is what
// emits everything after the last translatable line (closing code fence,
// separator, blank lines), and it ran only AFTER that text had been sent, so
// those lines were appended to an already-sent local string and never reached
// the panel: a 7-line document came back as 2 lines.
//
// The test drives the real background.js ASK handler with a mocked `chrome`
// and a mocked provider (fetch), and rebuilds the reply exactly as the side
// panel does (CHUNK appends, RESET_REPLY clears).

import assert from "node:assert/strict";

// ---- minimal chrome.* surface that background.js touches ------------------
const store = { apiKey: "test-key", piiFilterEnabled: false };
const listeners = { connect: null };
const noopEvent = { addListener() {} };
globalThis.chrome = {
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  contextMenus: {
    removeAll: (cb) => cb?.(),
    create: (_o, cb) => cb?.(),
    onClicked: noopEvent,
  },
  runtime: {
    id: "testid",
    getURL: (p = "") => `chrome-extension://testid/${p}`,
    getPlatformInfo: async () => ({}),
    sendMessage: async () => {},
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onMessage: noopEvent,
    onConnect: { addListener: (fn) => { listeners.connect = fn; } },
  },
  storage: {
    onChanged: noopEvent,
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    },
    session: { get: async () => ({}), set: async () => {} },
  },
};

await import("../background.js");
assert.equal(typeof listeners.connect, "function", "background.js must register an onConnect listener");

// ---- helpers ---------------------------------------------------------------
const enc = new TextEncoder();
function sseResponse(reply) {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

// Runs one ASK through the real handler. `providerReplies` is the sequence of
// raw model replies (a string) or HTTP failures ({ status }) for successive
// provider calls. Returns the reply as the side panel would show it.
async function runTranslation(source, providerReplies) {
  let call = 0;
  globalThis.fetch = async () => {
    const reply = providerReplies[Math.min(call++, providerReplies.length - 1)];
    if (typeof reply === "object") return new Response(JSON.stringify({ error: { message: "boom" } }), { status: reply.status });
    return sseResponse(reply);
  };
  const posted = [];
  let onMessage = null;
  const port = {
    name: "ai-chat",
    sender: { id: "testid", url: "chrome-extension://testid/sidepanel/sidepanel.html" },
    postMessage: (m) => posted.push(m),
    disconnect() {},
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    onDisconnect: noopEvent,
  };
  listeners.connect(port);
  await onMessage({
    type: "ASK",
    payload: {
      requestId: "r1",
      question: "Translate to French",
      pageContext: null,
      includePageContext: false,
      history: [],
      modelId: "deepseek-flash",
      translateMode: true,
      translateSource: source,
      noWebResearch: true,
    },
  });
  let reply = "";
  for (const m of posted) {
    if (m.type === "CHUNK") reply += m.delta;
    else if (m.type === "RESET_REPLY") reply = "";
  }
  return {
    reply,
    calls: call,
    notices: posted.filter((m) => m.type === "NOTICE"),
    error: posted.find((m) => m.type === "ERROR"),
    done: posted.some((m) => m.type === "DONE"),
  };
}

// 7 lines; only the first two are translatable, the last five are static
// (blank line, code fence with code, closing fence, separator).
const SOURCE = ["Hello world.", "Second line here.", "", "```js", "let a = 1;", "```", "---"].join("\n");
const TRANSLATED = ["Bonjour le monde.", "Deuxieme ligne ici.", "", "```js", "let a = 1;", "```", "---"].join("\n");
const COMPLETE_REPLY = "[1] Bonjour le monde.\n[2] Deuxieme ligne ici.";
// The model skips the tag of line 1 -> an incomplete first attempt -> replay.
const INCOMPLETE_REPLY = "[2] Deuxieme ligne ici.";

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

await test("complete first attempt: all 7 lines (baseline, no replay)", async () => {
  const r = await runTranslation(SOURCE, [COMPLETE_REPLY]);
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.calls, 1);
  assert.equal(r.reply, TRANSLATED);
});

await test("replayed translation keeps the trailing static lines (B-03)", async () => {
  const r = await runTranslation(SOURCE, [INCOMPLETE_REPLY, COMPLETE_REPLY]);
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.calls, 2, "the incomplete first attempt must be replayed once");
  assert.equal(r.reply.split("\n").length, 7, `expected 7 lines, got:\n${JSON.stringify(r.reply)}`);
  assert.equal(r.reply, TRANSLATED);
  assert.equal(r.notices.length, 0, "a complete replay needs no missing-lines notice");
});

await test("replay of a document that ENDS in a static line still delivers it", async () => {
  const src = ["Hello world.", "Second line here.", "", "---", ""].join("\n"); // ends in a blank line
  const r = await runTranslation(src, [INCOMPLETE_REPLY, COMPLETE_REPLY]);
  assert.ok(r.done);
  assert.equal(r.reply, ["Bonjour le monde.", "Deuxieme ligne ici.", "", "---", ""].join("\n"));
});

await test("failed replay keeps the first attempt, complete and with the notice", async () => {
  const r = await runTranslation(SOURCE, [INCOMPLETE_REPLY, { status: 500 }]);
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  // line 1 falls back to its original text; the static tail must still arrive
  assert.equal(r.reply, ["Hello world.", "Deuxieme ligne ici.", "", "```js", "let a = 1;", "```", "---"].join("\n"));
  assert.equal(r.notices.length, 1, "the missing-lines notice is still shown");
});

await test("replay that is incomplete too keeps the first attempt", async () => {
  const r = await runTranslation(SOURCE, [INCOMPLETE_REPLY, INCOMPLETE_REPLY]);
  assert.ok(r.done);
  assert.equal(r.reply.split("\n").length, 7);
  assert.equal(r.notices.length, 1);
});

// A correct model hands names, acronyms and commands back unchanged. That is a
// COMPLETE translation: such an echo used to count as a missing line, which
// replayed the whole request (the echo was judged missing again) and then
// announced "N lines were not translated" (round-18 #18).
await test("names / commands / acronyms returned unchanged are not missing lines: no replay, no notice", async () => {
  const src = ["GitHub", "npm install", "OK", "Second line here."].join("\n");
  const reply = "[1] GitHub\n[2] npm install\n[3] OK\n[4] Deuxieme ligne ici.";
  const r = await runTranslation(src, [reply, reply]);
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.calls, 1, "an unchanged name must not trigger the replay request");
  assert.equal(r.reply, ["GitHub", "npm install", "OK", "Deuxieme ligne ici."].join("\n"));
  assert.equal(r.notices.length, 0, "no missing-lines notice for a complete translation");
});

await test("a whole SENTENCE echoed back is still a missing line (replayed once, notice if it stays)", async () => {
  const src = ["Hello world.", "Second line here."].join("\n");
  const echoReply = "[1] Hello world.\n[2] Deuxieme ligne ici.";
  const r = await runTranslation(src, [echoReply, echoReply]);
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.calls, 2, "an echoed sentence is replayed once");
  assert.equal(r.reply, ["Hello world.", "Deuxieme ligne ici."].join("\n"));
  assert.equal(r.notices.length, 1, "the replay echoed it too, so the missing-lines notice stays");
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
