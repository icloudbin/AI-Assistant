// scripts/test-stop-streaming.mjs
//
// Regression test for B-02: "Stop" must interrupt a stream that has already
// started. Run with:  node scripts/test-stop-streaming.mjs
//
// A fake provider streams 40 SSE chunks, one every 12 ms. The user's STOP
// (ctx.signal aborting) lands part-way through. Before the fix
// fetchWithHeadersTimeout dropped its link to ctx.signal as soon as the
// response headers arrived and readSse neither listened to the signal nor
// checked it, so the stream kept being read and emitted to the end (40/40
// chunks). The assertions below pin the intended behaviour:
//   * the request ends with an AbortError (not a clean end, not "stream cut");
//   * no chunk is emitted after the abort;
//   * the provider-side stream is cancelled, i.e. the connection is released
//     and the provider stops producing (fewer than 40 chunks produced).
// Cases cover a fetch that honours its signal like the real one, a fetch that
// ignores it (so readSse's own handling is what is being tested), an abort
// inside a multi-line chunk, an abort before the reader starts, and the
// paths that must NOT change (normal completion, idle timeout, first-byte
// timeout).

import assert from "node:assert/strict";
import { t } from "../i18n.js";
import { fetchWithHeadersTimeout, readSse, extractOpenAIDelta, streamDeepSeek } from "../providers/openai-compatible.js";

const TOTAL = 40;
const INTERVAL_MS = 12;
const STOP_AT_MS = 130; // ~10 chunks in
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const sse = (i) => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `c${i} ` } }] })}\n\n`);
const DONE = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);

// A provider whose body is a pull-based stream: one chunk per INTERVAL_MS.
// `stats.produced` counts chunks the "server" generated; `stats.cancelled`
// is set when the consumer cancels the body (= connection released).
function makeProvider({ total = TOTAL, stall = false } = {}) {
  const stats = { produced: 0, cancelled: false };
  let ctrl;
  const body = new ReadableStream({
    start(c) { ctrl = c; },
    async pull(c) {
      await sleep(INTERVAL_MS);
      if (stats.cancelled) return;
      if (stall && stats.produced >= 3) return new Promise(() => {}); // goes silent
      if (stats.produced >= total) {
        c.enqueue(DONE);
        c.close();
        return;
      }
      c.enqueue(sse(stats.produced++));
    },
    cancel() { stats.cancelled = true; },
  });
  const response = () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  return {
    stats,
    body,
    response,
    // What an aborted real fetch() does: the browser tears the connection down
    // itself and errors the body stream (a later reader.cancel() on an already
    // errored stream is a no-op, so it never reaches the source's cancel()).
    error: (reason) => {
      stats.cancelled = true;
      try { ctrl.error(reason); } catch {}
    },
  };
}

function makeCtx(overrides = {}) {
  const ac = new AbortController();
  const events = [];
  const ctx = {
    lang: "en",
    signal: ac.signal,
    abort: () => ac.abort(),
    sendChunk: (d) => events.push({ d, afterAbort: ac.signal.aborted }),
    ...overrides,
  };
  return { ctx, ac, events };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}

const isAbort = (err) => err?.name === "AbortError";

// ---- STOP mid-stream ------------------------------------------------------

for (const cooperative of [true, false]) {
  await test(`STOP mid-stream aborts the stream (fetch ${cooperative ? "honours" : "ignores"} its signal)`, async () => {
    const provider = makeProvider();
    const { ctx, ac, events } = makeCtx();
    // A real fetch() errors the body stream with the signal's reason when its
    // signal aborts; the non-cooperative variant lets readSse's own handling
    // be the only thing that can stop the read.
    globalThis.fetch = async (_url, init) => {
      if (cooperative) init.signal.addEventListener("abort", () => provider.error(init.signal.reason), { once: true });
      return provider.response();
    };
    setTimeout(() => ac.abort(), STOP_AT_MS);

    const resp = await fetchWithHeadersTimeout("https://example.test/v1", { method: "POST" }, ctx);
    let caught = null;
    try {
      await readSse(resp, extractOpenAIDelta, ctx);
    } catch (err) {
      caught = err;
    }
    await sleep(80); // anything still in flight would show up now

    assert.ok(caught, "readSse must not complete normally after STOP");
    assert.ok(isAbort(caught), `expected AbortError, got ${caught?.name}: ${caught?.message}`);
    const late = events.filter((e) => e.afterAbort);
    assert.equal(late.length, 0, `${late.length} chunk(s) were emitted after STOP`);
    assert.ok(events.length > 0 && events.length < TOTAL, `emitted ${events.length} chunks before STOP`);
    assert.ok(provider.stats.cancelled, "the provider stream must be cancelled (connection released)");
    assert.ok(provider.stats.produced < TOTAL, `provider still produced ${provider.stats.produced}/${TOTAL} chunks`);
  });
}

await test("STOP is honoured through the full provider path (streamDeepSeek)", async () => {
  const provider = makeProvider();
  const { ctx, ac, events } = makeCtx();
  globalThis.chrome = { storage: { local: { get: async () => ({ apiKey: "test-key", customPrompt: "" }) } } };
  globalThis.fetch = async (_url, init) => {
    init.signal.addEventListener("abort", () => provider.error(init.signal.reason), { once: true });
    return provider.response();
  };
  setTimeout(() => ac.abort(), STOP_AT_MS);
  let caught = null;
  try {
    await streamDeepSeek({ apiModel: "m" }, "hi", null, [], [], ctx);
  } catch (err) {
    caught = err;
  }
  await sleep(80);
  assert.ok(caught && isAbort(caught), `expected AbortError, got ${caught?.name}: ${caught?.message}`);
  assert.equal(events.filter((e) => e.afterAbort).length, 0, "chunks emitted after STOP");
  assert.ok(provider.stats.produced < TOTAL, `provider produced ${provider.stats.produced}/${TOTAL}`);
  delete globalThis.chrome;
});

await test("STOP inside a multi-line chunk drops the lines that follow it", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: `L${i} ` } }] })}\n`).join("\n") + "\n";
  const resp = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(lines)); c.enqueue(DONE); c.close(); } }), { status: 200 });
  let n = 0;
  const { ctx, ac, events } = makeCtx();
  ctx.sendChunk = (d) => {
    events.push({ d, afterAbort: ac.signal.aborted });
    if (++n === 3) ac.abort(); // STOP arrives while the 3rd line is being handled
  };
  let caught = null;
  try {
    await readSse(resp, extractOpenAIDelta, ctx);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught && isAbort(caught), `expected AbortError, got ${caught?.name}`);
  assert.equal(events.length, 3, `expected exactly 3 chunks, got ${events.length}`);
});

await test("STOP before the reader starts: nothing is read or emitted", async () => {
  const provider = makeProvider();
  const { ctx, ac, events } = makeCtx();
  ac.abort();
  let caught = null;
  try {
    await readSse(provider.response(), extractOpenAIDelta, ctx);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught && isAbort(caught), `expected AbortError, got ${caught?.name}`);
  assert.equal(events.length, 0);
  assert.ok(provider.stats.cancelled, "body must be cancelled");
});

await test("STOP before fetch(): AbortError and no request is made", async () => {
  const { ctx, ac } = makeCtx();
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("x"); };
  ac.abort();
  await assert.rejects(() => fetchWithHeadersTimeout("https://example.test", {}, ctx), isAbort);
  assert.equal(called, false);
});

await test("readSse leaves no abort listener behind after a normal finish", async () => {
  const provider = makeProvider({ total: 3 });
  const { ctx } = makeCtx();
  let added = 0;
  let removed = 0;
  const add = ctx.signal.addEventListener.bind(ctx.signal);
  const rem = ctx.signal.removeEventListener.bind(ctx.signal);
  ctx.signal.addEventListener = (type, ...rest) => { if (type === "abort") added++; return add(type, ...rest); };
  ctx.signal.removeEventListener = (type, ...rest) => { if (type === "abort") removed++; return rem(type, ...rest); };
  await readSse(provider.response(), extractOpenAIDelta, ctx);
  assert.equal(added, 1);
  assert.equal(removed, added, "every listener readSse adds must be removed");
});

// ---- behaviour that must NOT change --------------------------------------

await test("normal completion still delivers every chunk and no error", async () => {
  const provider = makeProvider({ total: 10 });
  const { ctx, events } = makeCtx();
  globalThis.fetch = async () => provider.response();
  const resp = await fetchWithHeadersTimeout("https://example.test", {}, ctx);
  await readSse(resp, extractOpenAIDelta, ctx);
  assert.equal(events.length, 10);
  assert.equal(events.map((e) => e.d).join(""), Array.from({ length: 10 }, (_, i) => `c${i} `).join(""));
});

await test("idle timeout is still a reported error (not an AbortError)", async () => {
  const provider = makeProvider({ stall: true });
  const { ctx } = makeCtx({ streamIdleTimeoutMs: 80 });
  globalThis.fetch = async () => provider.response();
  const resp = await fetchWithHeadersTimeout("https://example.test", {}, ctx);
  let caught = null;
  try {
    await readSse(resp, extractOpenAIDelta, ctx);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "must fail");
  assert.ok(!isAbort(caught), "a stalled stream is a timeout error, not a user STOP");
  assert.equal(caught.message, t("en", "bg_error_streamTimeout"));
  assert.ok(provider.stats.cancelled);
});

await test("first-byte timeout is still a reported error; later STOP unaffected", async () => {
  const { ctx } = makeCtx();
  globalThis.fetch = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(init.signal.reason), { once: true });
  });
  let caught = null;
  try {
    await fetchWithHeadersTimeout("https://example.test", {}, ctx, 60);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught && !isAbort(caught));
  assert.equal(caught.message, t("en", "bg_error_noResponse", { seconds: "0" }));
});

await test("the first-byte timer does not fire after the headers arrived", async () => {
  const provider = makeProvider({ total: 8 }); // ~100 ms body, longer than the 40 ms timer
  const { ctx, events } = makeCtx();
  globalThis.fetch = async (_url, init) => {
    init.signal.addEventListener("abort", () => provider.error(init.signal.reason), { once: true });
    return provider.response();
  };
  const resp = await fetchWithHeadersTimeout("https://example.test", {}, ctx, 40);
  await readSse(resp, extractOpenAIDelta, ctx);
  assert.equal(events.length, 8, "the body must not be killed by the headers timer");
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
