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
// provider calls - or a function (requestBody, callIndex) => reply for tests
// whose reply depends on the request (one reply per numbered batch).
// `opts` overrides parts of the payload (history, translateMode, question,
// pageContext). Returns the reply as the side panel would show it, plus the
// parsed body of every provider request (`requests`).
async function runTranslation(source, providerReplies, opts = {}) {
  let call = 0;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    let body = null;
    try { body = JSON.parse(init.body); } catch { /* not a JSON provider call */ }
    requests.push(body);
    const index = call++;
    const reply = typeof providerReplies === "function"
      ? providerReplies(body, index)
      : providerReplies[Math.min(index, providerReplies.length - 1)];
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
      question: opts.question ?? "Translate to French",
      pageContext: opts.pageContext ?? null,
      includePageContext: !!opts.pageContext,
      history: opts.history ?? [],
      modelId: "deepseek-flash",
      translateMode: opts.translateMode ?? true,
      translateSource: source,
      // The language being translated INTO, as the side panel sends it (omitted
      // by tests that do not name one).
      ...("translateTarget" in opts ? { translateTarget: opts.translateTarget } : {}),
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
    requests,
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

// ---------------------------------------------------------------------------
// A translation request carries NO conversation history. Every numbered batch
// (and the off-screen replay of an incomplete one) used to re-send the earlier
// turns - the stored reply of one previous page translation is tens of
// thousands of characters, so a 15-batch page paid for it 15 times and crossed
// the token-per-minute budget of the free tiers. The text to translate is in
// the request itself; no earlier turn changes how it must be translated.
// ---------------------------------------------------------------------------
const HISTORY = [
  { role: "user", content: "HISTORY-MARKER-USER: summarize this page" },
  { role: "assistant", content: `HISTORY-MARKER-ASSISTANT ${"an earlier, long reply. ".repeat(400)}` },
];
const carriesHistory = (requests) => requests.some((b) => JSON.stringify(b).includes("HISTORY-MARKER"));
// A model stand-in that answers every "[n] text" line of the request it
// receives, so a multi-batch translation can be driven end to end.
const answerNumberedLines = (body) => {
  const last = body?.messages?.[body.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : (last?.content || []).map((p) => p.text || "").join("");
  return [...text.matchAll(/^\[(\d+)\] (.+)$/gm)].map((m) => `[${m[1]}] FR ${m[2]}`).join("\n");
};
// ~28k characters of translatable lines: several 8000-character batches.
const LONG_LINES = Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.`);
const LONG_SOURCE = LONG_LINES.join("\n");
const LONG_TRANSLATED = LONG_LINES.map((l) => `FR ${l}`).join("\n");

await test("single-batch translation sends no history (and the control question still does)", async () => {
  const r = await runTranslation(SOURCE, [COMPLETE_REPLY], { history: HISTORY });
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.reply, TRANSLATED);
  assert.equal(r.requests.length, 1);
  assert.ok(!carriesHistory(r.requests), "earlier turns must not ride along with a translation");
  assert.deepEqual(r.requests[0].messages.map((m) => m.role), ["system", "user"], "exactly the system prompt and the translation request");

  // Control: the SAME history on an ordinary question is still sent - the test
  // above would pass vacuously if the harness could never see the history.
  const ctl = await runTranslation(null, ["Plain answer."], { history: HISTORY, translateMode: false, question: "What did we discuss?" });
  assert.ok(ctl.done, `control request did not finish: ${JSON.stringify(ctl.error)}`);
  assert.deepEqual(ctl.requests[0].messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.ok(carriesHistory(ctl.requests), "an ordinary follow-up question keeps its history");
});

await test("every batch of a long selection translation is free of history", async () => {
  const r = await runTranslation(LONG_SOURCE, answerNumberedLines, { history: HISTORY });
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.ok(r.requests.length >= 3, `expected a multi-batch translation, got ${r.requests.length} request(s)`);
  assert.ok(!carriesHistory(r.requests), "no batch may carry earlier turns");
  assert.ok(r.requests.every((b) => b.messages.length === 2), "each batch is [system, user]");
  assert.equal(r.reply, LONG_TRANSLATED, "all 400 lines are translated, in order");
  assert.equal(r.notices.length, 0);
});

await test("every batch of a long PAGE translation is free of history", async () => {
  const page = { title: "Doc", url: "https://example.com/doc", text: LONG_SOURCE };
  const r = await runTranslation(null, answerNumberedLines, { history: HISTORY, pageContext: page });
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.ok(r.requests.length >= 3, `expected a multi-batch translation, got ${r.requests.length} request(s)`);
  assert.ok(!carriesHistory(r.requests), "no batch may carry earlier turns");
  assert.equal(r.reply, LONG_TRANSLATED);
});

await test("the off-screen replay of an incomplete batch is free of history too", async () => {
  const r = await runTranslation(SOURCE, [INCOMPLETE_REPLY, COMPLETE_REPLY], { history: HISTORY });
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.calls, 2, "the incomplete first attempt is replayed once");
  assert.ok(!carriesHistory(r.requests), "neither the first attempt nor the replay carries earlier turns");
  assert.equal(r.reply, TRANSLATED);
});

// ---------------------------------------------------------------------------
// A line the model leaves alone because it is ALREADY in the language being
// translated into (a Chinese line on a page translated into Chinese) is a
// finished line, not a skipped one. Only Latin-script echoes (names, commands)
// were accepted, so every such line counted as missing: the whole request was
// replayed - and echoed again - and the panel announced "N lines were not
// translated" for a translation that was complete. The side panel now sends
// the target language with the request (#5).
// ---------------------------------------------------------------------------
const BILINGUAL = [
  "Welcome to the product page.",
  "欢迎来到产品页面。",
  "Please read the manual carefully.",
  "请仔细阅读使用说明。",
  "Contact us for support.",
].join("\n");
// What a correct model returns for the target Chinese: the English lines
// translated, the Chinese lines handed back as they are.
const BILINGUAL_REPLY = [
  "[1] 欢迎访问产品页面。",
  "[2] 欢迎来到产品页面。",
  "[3] 请仔细阅读手册。",
  "[4] 请仔细阅读使用说明。",
  "[5] 如需支持，请联系我们。",
].join("\n");
const BILINGUAL_OUT = ["欢迎访问产品页面。", "欢迎来到产品页面。", "请仔细阅读手册。", "请仔细阅读使用说明。", "如需支持，请联系我们。"].join("\n");

await test("a Chinese line left alone in a translation INTO Chinese is finished: no replay, no notice (#5)", async () => {
  const r = await runTranslation(BILINGUAL, [BILINGUAL_REPLY, BILINGUAL_REPLY], { question: "Translate to Chinese", translateTarget: "zh-CN" });
  assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
  assert.equal(r.calls, 1, "nothing is missing, so the request must not be replayed");
  assert.equal(r.reply, BILINGUAL_OUT);
  assert.equal(r.notices.length, 0, "no missing-lines notice for a complete translation");
});

await test("the same holds for zh-TW, and for a Japanese target with a kanji heading (#5)", async () => {
  const tw = await runTranslation(BILINGUAL, [BILINGUAL_REPLY, BILINGUAL_REPLY], { question: "Translate to Chinese", translateTarget: "zh-TW" });
  assert.ok(tw.done);
  assert.equal(tw.calls, 1);
  assert.equal(tw.notices.length, 0);

  const ja = ["The conference is held in Tokyo.", "東京", "Registration opens in May."].join("\n");
  const jaReply = "[1] 会議は東京で開催されます。\n[2] 東京\n[3] 登録は5月に始まります。";
  const r = await runTranslation(ja, [jaReply, jaReply], { question: "Translate to Japanese", translateTarget: "ja" });
  assert.ok(r.done);
  assert.equal(r.calls, 1, "an echoed kanji label is not a skipped line");
  assert.equal(r.reply, ["会議は東京で開催されます。", "東京", "登録は5月に始まります。"].join("\n"));
  assert.equal(r.notices.length, 0);
});

await test("a request that names no target (or another one) keeps the old accounting (control for the tests above)", async () => {
  for (const opts of [{}, { translateTarget: "en" }, { translateTarget: null }]) {
    const r = await runTranslation(BILINGUAL, [BILINGUAL_REPLY, BILINGUAL_REPLY], { question: "Translate to Chinese", ...opts });
    assert.ok(r.done);
    assert.equal(r.reply, BILINGUAL_OUT, "the text shown is the same whichever way the lines are counted");
    assert.equal(r.calls, 2, `${JSON.stringify(opts)}: two echoed Chinese lines are missing lines, so the request is replayed once`);
    assert.equal(r.notices.length, 1, `${JSON.stringify(opts)}: and the notice stays`);
  }
});

await test("a lazy echo of the ENGLISH lines is still caught when the target is Chinese (#5)", async () => {
  const lazy = "[1] Welcome to the product page.\n[2] 欢迎来到产品页面。\n[3] Please read the manual carefully.\n[4] 请仔细阅读使用说明。\n[5] Contact us for support.";
  const r = await runTranslation(BILINGUAL, [lazy, lazy], { question: "Translate to Chinese", translateTarget: "zh-CN" });
  assert.ok(r.done);
  assert.equal(r.calls, 2, "three echoed English sentences are missing lines: replayed once");
  assert.equal(r.notices.length, 1, "and the notice stays when the replay echoes them too");
  assert.match(r.notices[0].text, /^3 of 5 lines were not translated/, "the notice counts the three English lines, not the two Chinese ones");
});

await test("a malformed target is ignored, and the privacy filter does not change how the target is read (#5)", async () => {
  for (const translateTarget of ["zh-CN\n[1] x", "zh CN", 42, { zh: true }, ["zh-CN"], "z".repeat(200)]) {
    const r = await runTranslation(BILINGUAL, [BILINGUAL_REPLY, BILINGUAL_REPLY], { question: "Translate to Chinese", translateTarget });
    assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
    assert.equal(r.calls, 2, `${JSON.stringify(translateTarget)}: not a language code, so it names no target`);
  }
  // The filter is on by default; with it on the target must still arrive intact.
  const saved = store.piiFilterEnabled;
  delete store.piiFilterEnabled;
  try {
    const r = await runTranslation(BILINGUAL, [BILINGUAL_REPLY, BILINGUAL_REPLY], { question: "Translate to Chinese", translateTarget: "zh-CN" });
    assert.ok(r.done, `request did not finish: ${JSON.stringify(r.error)}`);
    assert.equal(r.calls, 1, "privacy filter on: the target still reaches the translator");
    assert.equal(r.notices.length, 0);
    // ... and it is not sent to the provider: it is for the local line accounting only.
    assert.ok(!JSON.stringify(r.requests).includes("translateTarget"), "the field name must not leak into the provider request");
  } finally {
    store.piiFilterEnabled = saved;
  }
});

await test("a multi-batch translation into Chinese counts the echoed Chinese lines as done (#5)", async () => {
  // 200 English lines and 200 Chinese ones, alternating: several 8000-character batches.
  const lines = Array.from({ length: 400 }, (_, i) => (i % 2 === 0
    ? `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.`
    : `第${i + 1}段：敏捷的棕色狐狸跳过了那只懒狗，一次又一次。`));
  const source = lines.join("\n");
  // The stand-in model translates English lines and hands Chinese ones back.
  const model = (body) => {
    const last = body?.messages?.[body.messages.length - 1];
    const text = typeof last?.content === "string" ? last.content : (last?.content || []).map((p) => p.text || "").join("");
    return [...text.matchAll(/^\[(\d+)\] (.+)$/gm)]
      .map((m) => `[${m[1]}] ${/\p{Script=Han}/u.test(m[2]) ? m[2] : `译：${m[2]}`}`)
      .join("\n");
  };
  const expected = lines.map((l) => (/\p{Script=Han}/u.test(l) ? l : `译：${l}`)).join("\n");

  const withTarget = await runTranslation(source, model, { question: "Translate to Chinese", translateTarget: "zh-CN" });
  assert.ok(withTarget.done, `request did not finish: ${JSON.stringify(withTarget.error)}`);
  assert.ok(withTarget.requests.length >= 3, `expected a multi-batch translation, got ${withTarget.requests.length} request(s)`);
  assert.equal(withTarget.reply, expected);
  assert.equal(withTarget.notices.length, 0, "every line is done, so there is nothing to announce");

  const without = await runTranslation(source, model, { question: "Translate to Chinese" });
  assert.equal(without.reply, expected);
  assert.equal(without.notices.length, 1, "control: without the target the 200 Chinese lines are announced as not translated");
  assert.match(without.notices[0].text, /^200 of 400 lines were not translated/);
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
