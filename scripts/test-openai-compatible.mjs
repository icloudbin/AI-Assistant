#!/usr/bin/env node
// Unit tests for providers/openai-compatible.js (SSE reader + error mapping
// moved verbatim from background.js). The stream functions themselves are
// integration-tested in the browser; here the shared machinery is driven
// with synthetic Response bodies. Run:  node scripts/test-openai-compatible.mjs
import assert from "node:assert/strict";
import { readSse, openAICompatibleStreamError, providerHttpError, extractOpenAIDelta, fetchWithHeadersTimeout, streamGroq, readBoundedText, isModelUnavailableError, classifyProviderFailure, STREAM_MAX_BYTES, STREAM_MAX_REASONING_CHARS } from "../providers/openai-compatible.js";
import { MODELS, findKnownModel } from "../models.js";
import { t } from "../i18n.js";

const encoder = new TextEncoder();
function sse(chunks) {
  const cancelled = { count: 0 };
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
    cancel() { cancelled.count++; },
  });
  return { resp: { body: stream }, cancelled };
}
function makeCtx() {
  const out = {
    port: { postMessage: () => {} },
    requestId: "t1",
    signal: new AbortController().signal,
    lang: "en",
    translateMode: false,
    lineTranslator: null,
    sendChunk: null,
    sendThinking: null,
    chunks: [],
    thinking: [],
  };
  out.sendChunk = (d) => out.chunks.push(d);
  out.sendThinking = (d) => out.thinking.push(d);
  return out;
}
const delta = (json) => json.choices?.[0]?.delta?.content ?? "";

// ---------- happy path: chunks reassembled, unterminated final line flushed ----------
// v1.10.162 (round-17 #2): [DONE] now ENDS the read - a connection held open
// after the terminal event used to hang until the 90 s idle timeout and then
// report the provably complete answer as a failure. Post-[DONE] content is
// therefore deliberately NOT read anymore; the unterminated-final-line flush
// is pinned with the terminal reason carried on that unterminated line.
{
  const ctx = makeCtx();
  const { resp } = sse([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}',
  ]);
  await readSse(resp, delta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "Hello!", "chunks reassembled; unterminated final line flushed");
}

// ---------- terminal events stop processing later lines in the SAME network chunk (SEC-01) ----------
{
  for (const [terminal, label] of [
    ['data: [DONE]', "[DONE]"],
    ['data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}', "finish_reason"],
  ]) {
    const ctx = makeCtx();
    const trailing = 'data: {"choices":[{"delta":{"content":"INJECTED"}}]}\n\n';
    const first = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n';
    const { resp } = sse([first + terminal + "\n\n" + trailing]);
    await readSse(resp, delta, ctx, openAICompatibleStreamError);
    assert.equal(ctx.chunks.join(""), label === "[DONE]" ? "OK" : "OK!", `${label}: events after terminal marker in same chunk are ignored`);
    assert.ok(!ctx.chunks.join("").includes("INJECTED"), `${label}: post-terminal content never reaches output`);
  }
}

// ---------- readBoundedText enforces its character cap on oversized chunks ----------
{
  const maxChars = 128;
  let cancelled = 0;
  let reads = 0;
  const huge = "x".repeat(2 * 1024 * 1024);
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(encoder.encode(huge));
      // Deliberately leave the stream open; reaching the cap must cancel it.
    },
    cancel() { cancelled++; },
  });
  const result = await readBoundedText({ body }, maxChars);
  assert.equal(result.length, maxChars, "one oversized chunk cannot exceed the configured cap");
  assert.equal(cancelled, 1, "reader is cancelled immediately at the cap");
  assert.equal(reads, 1, "no additional chunks are consumed after reaching the cap");
  const utf8 = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("A😀BC"));
      controller.close();
    },
  });
  const unicode = await readBoundedText({ body: utf8 }, 3);
  assert.equal(unicode, "A😀", "truncation does not split a Unicode surrogate pair");
}

// ---------- [DONE] ends the read even when the connection stays open (v1.10.162) ----------
{
  const ctx = makeCtx();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'));
      // Never closes, never errors: a proxy holding the connection open.
    },
  });
  const started = Date.now();
  await readSse({ body: stream }, delta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "Hi", "the complete answer is delivered");
  assert.ok(Date.now() - started < 5000, `did not wait for the idle timeout (${Date.now() - started}ms)`);
}

// ---------- bounded response resources (SEC-02) ----------
{
  // The DEFAULT cap (1,000,000 visible characters) with unit-explicit wording.
  // The content arrives as many small SSE events, each under the per-line cap.
  const ctx = makeCtx();
  const chunkBody = "a".repeat(5000);
  const chunks = [];
  for (let i = 0; i < 210; i++) {
    chunks.push(`data: {"choices":[{"delta":{"content":"${chunkBody}"}}]}\n\n`);
  }
  chunks.push("data: [DONE]\n\n");
  const { resp } = sse(chunks);
  await assert.rejects(
    () => readSse(resp, delta, ctx, openAICompatibleStreamError),
    /1,000,000 characters safety limit/i,
    "visible text is capped and its unit is explicit"
  );
  const visible = ctx.chunks.join("");
  assert.ok(visible.length <= 1000000 && visible.length > 990000, `prefix retained: ${visible.length} chars`);
}
{
  // A 4 MiB byte cap, exceeded by many lines that each stay under the
  // per-line cap: the error reports the limit in MiB.
  const ctx = makeCtx();
  ctx.streamMaxBytes = 4 * 1024 * 1024;
  ctx.streamMaxSseLineChars = 256 * 1024;
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`: ${"x".repeat(220 * 1024)}\n\n`);
  const { resp } = sse(lines);
  await assert.rejects(
    () => readSse(resp, delta, ctx, openAICompatibleStreamError),
    /4\.0 MiB safety limit/i,
    "total stream bytes are capped and reported in MiB"
  );
}
{
  const ctx = makeCtx();
  ctx.streamMaxBytes = 1024;
  ctx.streamMaxSseLineChars = 16;
  const { resp } = sse([`: ${"x".repeat(20)}\n\n`]);
  await assert.rejects(
    () => readSse(resp, delta, ctx, openAICompatibleStreamError),
    /16 characters per SSE line safety limit/i,
    "oversized SSE lines are rejected and reported in characters"
  );
}

// ---------- the byte limit is a BACKSTOP; reasoning has its own limit ----------
// A provider wraps EVERY streamed token in an envelope of ~250-320 bytes, so the
// old 4 MiB cap held only ~13-17k tokens of reasoning AND answer together and
// rejected long answers and reasoning-heavy replies, although the catalog itself
// asks Groq's GPT-OSS models for up to 65,536 output tokens. The envelopes below
// are modelled on the chunk shape each provider documents (one token per event).
const ENVELOPES = {
  deepseek: (d) => ({ id: "3b4c1a7e5d9f2a61c0e8b7d4f1a92c35", object: "chat.completion.chunk", created: 1731660000, model: "deepseek-chat", system_fingerprint: "fp_a49d71b8a1", choices: [{ index: 0, delta: d, logprobs: null, finish_reason: null }] }),
  groq: (d) => ({ id: "chatcmpl-5f0c3a9e-7b1d-4c28-9e44-0d6a1b2c3d4e", object: "chat.completion.chunk", created: 1731660000, model: "openai/gpt-oss-120b", system_fingerprint: "fp_f4ae844694", choices: [{ index: 0, delta: d, logprobs: null, finish_reason: null }], x_groq: { id: "req_01k9zq8d2xfk3b7m5n1p4r6s8t" } }),
};
// A lazily generated stream (nothing is held in memory): `reasoningTokens`
// reasoning events, then `contentTokens` content events, then the terminal
// events. `bytes()` is the number of bytes handed to the reader so far.
function envelopeStream(env, reasoningTokens, contentTokens) {
  const total = reasoningTokens + contentTokens;
  let i = 0;
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      let text = "";
      if (i >= total) {
        text = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      } else {
        for (let n = 0; n < 200 && i < total; n++, i++) {
          const d = i < reasoningTokens ? { content: null, reasoning_content: " think" } : { content: " word" };
          text += `data: ${JSON.stringify(ENVELOPES[env](d))}\n\n`;
        }
      }
      const bytes = encoder.encode(text);
      sent += bytes.length;
      controller.enqueue(bytes);
      if (i >= total && text.includes("[DONE]")) controller.close();
    },
  });
  return { resp: { body: stream, headers: { get: () => "text/event-stream" } }, bytes: () => sent };
}
const reasoningEvent = (text, field = "reasoning_content") => `data: ${JSON.stringify({ choices: [{ delta: { [field]: text } }] })}\n\n`;
{
  // The largest output the catalog itself requests, one token per event.
  const maxTokens = Math.max(...MODELS.map((m) => m.maxOutputTokens || 0));
  assert.ok(maxTokens >= 65536, `catalog sanity: the largest maxOutputTokens is ${maxTokens}`);
  const ctx = makeCtx();
  const { resp, bytes } = envelopeStream("groq", 0, maxTokens);
  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join("").length, maxTokens * " word".length, "a reply of the catalog's largest size is delivered in full");
  assert.ok(bytes() > 16 * 1024 * 1024, `the stream is far beyond the old 4 MiB cap (${bytes()} bytes)`);
  assert.ok(bytes() < STREAM_MAX_BYTES, "and stays inside the backstop (raise STREAM_MAX_BYTES if the catalog ever asks for more output)");
}
{
  // 16k tokens of reasoning before a 3k-token answer (~4.8 MiB on the wire):
  // rejected by the old cap with nothing shown.
  const ctx = makeCtx();
  const { resp } = envelopeStream("deepseek", 16000, 3000);
  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), " word".repeat(3000), "the answer arrives; the reasoning is dropped");
}
{
  // The backstop still exists at its default: events that carry neither content
  // nor reasoning are seen by no other limit.
  const junk = encoder.encode(`: ${"x".repeat(200 * 1024)}\n\n`);
  let sent = 0;
  const body = new ReadableStream({ pull(controller) { sent += junk.length; controller.enqueue(junk); } });
  const ctx = makeCtx();
  await assert.rejects(
    () => readSse({ body, headers: { get: () => "text/event-stream" } }, extractOpenAIDelta, ctx, openAICompatibleStreamError),
    /64\.0 MiB safety limit/i,
    "the default byte backstop still ends a stream that never finishes"
  );
  assert.ok(sent > STREAM_MAX_BYTES && sent < STREAM_MAX_BYTES + 4 * junk.length, `stopped right after the backstop (${sent} bytes read)`);
}
for (const field of ["reasoning_content", "reasoning"]) {
  // Over the reasoning limit: the request ends with its own message (it must
  // not promise a partial reply - none was shown) and the stream is released.
  const ctx = makeCtx();
  ctx.streamMaxReasoningChars = 100;
  const events = Array.from({ length: 6 }, () => reasoningEvent("r".repeat(30), field));
  events.push('data: {"choices":[{"delta":{"content":"never shown"}}]}\n\ndata: [DONE]\n\n');
  const { resp, cancelled } = sse(events);
  await assert.rejects(
    () => readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError),
    (err) => {
      assert.match(err.message, /more than 100 characters of internal reasoning/i, `${field}: unit-explicit reasoning message`);
      assert.doesNotMatch(err.message, /partial reply/i, `${field}: no promise of a partial reply`);
      return true;
    },
    `${field}: an endless reasoning stream is cut off`
  );
  assert.equal(ctx.chunks.length, 0, `${field}: nothing was shown`);
  assert.equal(cancelled.count, 1, `${field}: the connection is released`);
}
{
  // Exactly AT the limit is allowed; one character more is not. Visible text of
  // the same event is never lost to the reasoning limit.
  const run = async (reasoningChars) => {
    const ctx = makeCtx();
    ctx.streamMaxReasoningChars = 100;
    const { resp } = sse([
      reasoningEvent("r".repeat(reasoningChars)),
      'data: {"choices":[{"delta":{"content":"Answer","reasoning_content":"r"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ]);
    const outcome = await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError).then(() => "ok", (e) => e.message);
    return { outcome, shown: ctx.chunks.join("") };
  };
  const atLimit = await run(99);   // 99 + 1 = 100 characters in total
  assert.equal(atLimit.outcome, "ok", "a total exactly at the limit completes");
  assert.equal(atLimit.shown, "Answer", "the reasoning text never reaches the output");
  const over = await run(100);     // 100 + 1 = 101
  assert.match(over.outcome, /internal reasoning/i, "one character over the limit ends the request");
  assert.equal(over.shown, "Answer", "the visible text that shared the event with the last reasoning is kept");
}
{
  // The DEFAULT limit: 10 x 100,000 characters is exactly the limit and still
  // completes; an 11th event crosses it.
  const chunk = reasoningEvent("r".repeat(STREAM_MAX_REASONING_CHARS / 10));
  const tail = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"];
  const ctxOk = makeCtx();
  await readSse(sse([...Array(10).fill(chunk), ...tail]).resp, extractOpenAIDelta, ctxOk, openAICompatibleStreamError);
  assert.equal(ctxOk.chunks.join(""), "ok", "reasoning exactly at the default limit completes");
  const ctxOver = makeCtx();
  await assert.rejects(
    () => readSse(sse([...Array(11).fill(chunk), ...tail]).resp, extractOpenAIDelta, ctxOver, openAICompatibleStreamError),
    /1,000,000 characters of internal reasoning/i,
    "the default reasoning limit is 1,000,000 characters"
  );
}
{
  // A JSON-labelled 200 body is buffered only up to a bound (real error bodies
  // are tiny). Within it the provider's message surfaces as before; text beyond
  // it is not kept, so an oversized body cannot grow the buffer to the backstop.
  const parts = ['{\n', ...Array.from({ length: 20 }, (_, i) => `  "pad${i}": "${"x".repeat(20)}",\n`), '  "error": { "message": "late gateway error" }\n}\n'];
  const run = (cap) => {
    const ctx = makeCtx();
    if (cap) ctx.streamMaxJsonChars = cap;
    const stream = new ReadableStream({ start(c) { for (const part of parts) c.enqueue(encoder.encode(part)); c.close(); } });
    return readSse({ body: stream, headers: { get: () => "application/json" } }, extractOpenAIDelta, ctx, openAICompatibleStreamError);
  };
  await assert.rejects(run(0), /late gateway error/, "within the default bound the error body is read as before");
  await assert.rejects(run(100), /empty response/i, "past the bound the body is no longer buffered (nothing to parse)");
}
{
  // The new message exists, with its {limit}, in all six languages.
  const en = t("en", "bg_error_reasoningTooLarge", { limit: "1,000,000 characters" });
  assert.ok(en.includes("1,000,000 characters") && !en.includes("bg_error_reasoningTooLarge") && !en.includes("{limit}"), "en: resolved and filled in");
  for (const lang of ["zh-CN", "zh-TW", "fr", "ja", "es"]) {
    const msg = t(lang, "bg_error_reasoningTooLarge", { limit: "1,000,000 characters" });
    assert.ok(msg.includes("1,000,000 characters") && !msg.includes("{limit}") && !msg.includes("bg_error_reasoningTooLarge"), `${lang}: resolved and filled in`);
    assert.notEqual(msg, en, `${lang}: translated, not the English fallback`);
  }
}

// ---------- provider error mid-stream: throws AND releases the body ----------
{
  const { resp, cancelled } = sse([
    'data: {"choices":[{"delta":{"content":"partial "}}]}\n\n',
    'data: {"error":{"message":"rate limited"}}\n\n',
    'data: {"choices":[{"delta":{"content":"never delivered"}}]}\n\n',
  ]);
  const ctx = makeCtx();
  await assert.rejects(
    readSse(resp, delta, ctx, openAICompatibleStreamError),
    /rate limited/,
    "in-stream provider error is thrown with its message"
  );
  assert.equal(cancelled.count, 1, "the reader is cancelled so the connection is released");
}

// ---------- empty stream is a failure (never store an empty assistant turn) ----------
{
  const { resp } = sse(["data: [DONE]\n\n"]);
  await assert.rejects(readSse(resp, delta, makeCtx(), openAICompatibleStreamError), /empty response/i);
}

// ---------- finish_reason length is surfaced on the ctx ----------
{
  const ctx = makeCtx();
  const { resp } = sse(['data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']);
  await assert.rejects(readSse(resp, delta, ctx, openAICompatibleStreamError), /empty response/i);
  assert.equal(ctx.truncatedByLength, true, "finish_reason=length marks ctx.truncatedByLength");
}

// ---------- malformed / non-data lines are skipped ----------
{
  const ctx = makeCtx();
  const { resp } = sse(["event: ping\n", ": keepalive\n", "data: not json\n\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
  await readSse(resp, delta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "ok", "event lines, comments and invalid JSON are ignored");
}

// ---------- clean EOF WITHOUT a terminal event = cut stream, not success ----------
// A mid-stream network failure can surface as a clean EOF instead of a read()
// rejection; without the terminal check the truncated reply was completed as
// DONE and shown to the user as a full answer (found by real-browser E2E).
{
  const ctx = makeCtx();
  const { resp } = sse(['data: {"choices":[{"delta":{"content":"partial an"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"swer"}}]}\n\n']);
  await assert.rejects(
    readSse(resp, delta, ctx, openAICompatibleStreamError),
    /ended before the reply was finished/,
    "EOF without [DONE] and without finish_reason throws the stream-cut error"
  );
  assert.equal(ctx.chunks.join(""), "partial answer", "the partial text was already delivered via ctx.sendChunk");
}

// ---------- finish_reason without [DONE] is a valid terminal ----------
{
  const ctx = makeCtx();
  const { resp } = sse(['data: {"choices":[{"delta":{"content":"done"}}]}\n\n', 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']);
  await readSse(resp, delta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "done", "finish_reason=stop without [DONE] completes normally");
}

// ---------- [DONE] followed by EOF completes normally ----------
{
  const ctx = makeCtx();
  const { resp } = sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]);
  await readSse(resp, delta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "hi", "explicit [DONE] marker completes the stream");
}

// ---------- openAICompatibleStreamError mapping ----------
assert.equal(openAICompatibleStreamError({}), "", "no error field -> empty");
assert.equal(openAICompatibleStreamError({ error: "boom" }), "boom", "string error passthrough");
assert.equal(openAICompatibleStreamError({ error: { message: "detail" } }), "detail", "object error -> message");
assert.equal(openAICompatibleStreamError({ error: { code: 500 } }), '{"code":500}', "object without message -> JSON");

// ---------- providerHttpError: bounded, single-line ----------
{
  const resp = { status: 502, text: async () => `<html>${"x".repeat(2000)}</html>` };
  const msg = await providerHttpError(resp);
  assert.match(msg, /^HTTP 502 /);
  assert.ok(msg.length <= "HTTP 502 ".length + 501, "body excerpt capped at ~500 chars");
}
{
  const resp = { status: 401, text: async () => { throw new Error("unreadable"); } };
  assert.equal(await providerHttpError(resp), "HTTP 401", "unreadable body -> status only");
}

// ---------- providerHttpError: JSON bodies are unwrapped to the message ----------
{
  const resp = { status: 400, text: async () => '{"error":{"message":"You have uploaded an unsupported image. Please make sure your image is valid."}}' };
  const msg = await providerHttpError(resp);
  assert.equal(msg, "HTTP 400 You have uploaded an unsupported image. Please make sure your image is valid.", "object error body -> message extracted, no raw JSON");
}
{
  const resp = { status: 403, text: async () => '{"error":"forbidden for this key"}' };
  assert.equal(await providerHttpError(resp), "HTTP 403 forbidden for this key", "string error body extracted");
}
{
  const resp = { status: 400, text: async () => '{"not-the-error-shape":true,"message":"top-level message"}' };
  assert.equal(await providerHttpError(resp), "HTTP 400 top-level message", "top-level message used when error field is absent");
}
{
  const resp = { status: 500, text: async () => '{"broken":"json' };
  assert.match(await providerHttpError(resp), /^HTTP 500 .*broken/, "invalid JSON falls back to the raw excerpt");
}

// ---------- reasoning_content / reasoning stream support ----------
// extractOpenAIDelta still PARSES reasoning fields, but readSse drops them for
// EVERY request (v1.10.126): the conversation box shows only the final result.
{
  assert.deepEqual(
    extractOpenAIDelta({ choices: [{ delta: { reasoning_content: "thinking...", content: "answer" } }] }),
    { content: "answer", reasoning: "thinking..." },
    "extracts content and reasoning_content"
  );
  assert.deepEqual(
    extractOpenAIDelta({ choices: [{ delta: { reasoning: "reasoning..." } }] }),
    { content: "", reasoning: "reasoning..." },
    "extracts fallback reasoning field"
  );

  const ctx = makeCtx();
  const { resp } = sse([
    'data: {"choices":[{"delta":{"reasoning_content":"Let me think."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Done!"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.thinking.length, 0, "reasoning is never routed to ctx.sendThinking");
  assert.equal(ctx.chunks.join(""), "Done!", "content chunks routed to ctx.sendChunk");

  // Reasoning only (no content) IS an empty completion now: nothing was
  // displayed, so the request fails like any other empty reply.
  const ctxReasoningOnly = makeCtx();
  const { resp: respReasoning } = sse([
    'data: {"choices":[{"delta":{"reasoning_content":"only reasoning"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  await assert.rejects(
    () => readSse(respReasoning, extractOpenAIDelta, ctxReasoningOnly, openAICompatibleStreamError),
    /empty/i,
    "reasoning-only response fails as an empty completion"
  );
}

// ---------- NO mode shows the reasoning stream ----------
// A translation must show ONLY the final translated text (pre-1.10.116
// behavior), and since v1.10.126 a chat / fact-check / any other request does
// too: no "Thought process" block anywhere in the conversation box.
{
  const makeTranslateCtx = (translateMode) => {
    const ctx = makeCtx();
    ctx.translateMode = translateMode;
    return ctx;
  };
  const reasoningThenContent = [
    'data: {"choices":[{"delta":{"reasoning_content":"Let me think."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你好世界"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  for (const translateMode of ["free", "lines"]) {
    const ctx = makeTranslateCtx(translateMode);
    const { resp } = sse(reasoningThenContent);
    await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
    assert.equal(ctx.thinking.length, 0, `[${translateMode}] no reasoning reaches the translation box`);
    assert.equal(ctx.chunks.join(""), "你好世界", `[${translateMode}] final translation still streamed`);
  }

  // Chat mode (translateMode false) drops the reasoning stream as well.
  const chatCtx = makeCtx();
  const { resp: chatResp } = sse(reasoningThenContent);
  await readSse(chatResp, extractOpenAIDelta, chatCtx, openAICompatibleStreamError);
  assert.equal(chatCtx.thinking.length, 0, "chat mode drops the reasoning stream too");
  assert.equal(chatCtx.chunks.join(""), "你好世界", "chat mode keeps the content stream");
}

// ---------- first-byte (response headers) watchdog (v1.10.134) ----------
{
  // A provider that accepts the connection and never answers must fail with
  // the no-response error (the user's own STOP still propagates as
  // AbortError). Stub fetch with a promise that never settles.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
  });
  const ctx = makeCtx();
  const t0 = Date.now();
  await assert.rejects(
    () => fetchWithHeadersTimeout("https://api.example.com/x", { method: "POST" }, ctx, 50),
    /did not respond/i,
    "headers timeout rejects with the no-response error"
  );
  globalThis.fetch = originalFetch;
  assert.ok(Date.now() - t0 < 2000, `timeout fired in ${Date.now() - t0}ms`);
  // The user's own STOP keeps the AbortError (the outer handler stays silent).
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
  });
  const stop = new AbortController();
  const ctxStop = makeCtx();
  ctxStop.signal = stop.signal;
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(
    () => fetchWithHeadersTimeout("https://api.example.com/x", { method: "POST" }, ctxStop, 5000),
    (err) => err?.name === "AbortError",
    "user STOP propagates as AbortError"
  );
  globalThis.fetch = originalFetch;
  // An ordinary network failure keeps its own error.
  globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
  await assert.rejects(
    () => fetchWithHeadersTimeout("https://api.example.com/x", { method: "POST" }, makeCtx(), 5000),
    /ECONNREFUSED/,
    "network errors pass through unchanged"
  );
  globalThis.fetch = originalFetch;
}

// ---------- stream timeout ----------
// A provider that accepts the connection and then goes silent must not hold
// the request (and the side panel's composer) open forever.
{
  const ctx = makeCtx();
  ctx.streamIdleTimeoutMs = 25;
  ctx.streamTotalTimeoutMs = 1000;
  let aborted = false;
  ctx.abort = () => { aborted = true; };
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const result = readSse({ body: stream }, extractOpenAIDelta, ctx, openAICompatibleStreamError);
  let timer;
  const testTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("test timed out waiting for the stream timeout")), 2000);
  });
  await Promise.race([
    assert.rejects(result, /stopped responding|timed out|timeout/i),
    testTimeout,
  ]).finally(() => clearTimeout(timer));
  assert.equal(aborted, true, "stream timeout aborts the underlying request");
  try { controller.close(); } catch {}
}

// ---------- HTTP 200 JSON error body and array content parts ----------
{
  const ctx = makeCtx();
  const body = new TextEncoder().encode('{"error":{"message":"upstream maintenance"}}');
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(body); controller.close(); },
  });
  const resp = { body: stream, headers: { get: () => "application/json" } };
  await assert.rejects(
    readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError),
    /upstream maintenance/,
    "a 200 JSON error body surfaces the provider error"
  );
}
{
  const ctx = makeCtx();
  const { resp } = sse([
    'data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hel"},{"type":"text","text":"lo"}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
  ]);
  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "Hello!", "content-part arrays are flattened");
}

// ---------- streamGroq request body: max_completion_tokens passthrough ----------
// Live probe 2026-11-07: without the parameter Groq cut replies at per-model
// defaults (3072/2048 tokens, finish_reason "length" mid-essay), while
// qwen3.8-27b's free tier REJECTS any declared cap above 1000 with HTTP 429
// OTPM. So catalog models WITH maxOutputTokens must send it, and models
// WITHOUT it (qwen) must send nothing - both directions are regression-guarded
// here against the request body Groq actually receives.
{
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    const { resp } = sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']);
    // streamGroq checks resp.ok and the content type before reading the body.
    return { ...resp, ok: true, status: 200, headers: { get: () => "text/event-stream" } };
  };
  // streamGroq reads the key from chrome.storage.local (and a legacy fallback
  // name); neither the fetch nor storage exist in Node, so both are stubbed.
  globalThis.chrome = { storage: { local: { get: async () => ({ groqApiKey: " gsk_test_key " }) } } };
  try {
    const groqModels = MODELS.filter((m) => m.provider === "groq");
    assert.equal(groqModels.length, 3, "the three Groq catalog models are exercised");
    for (const model of groqModels) {
      const ctx = makeCtx();
      ctx.safePost = () => {};
      await streamGroq(model, "question", null, [], [], ctx);
      const { url, init } = captured[captured.length - 1];
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions", `[${model.id}] endpoint`);
      assert.equal(init.headers.Authorization, "Bearer gsk_test_key", `[${model.id}] key is trimmed into the header`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, model.apiModel, `[${model.id}] apiModel sent`);
      assert.equal(body.stream, true, `[${model.id}] streams`);
      assert.ok(Array.isArray(body.messages) && body.messages[0].role === "system", `[${model.id}] message list built with a leading system message`);
      if (model.maxOutputTokens) {
        assert.equal(body.max_completion_tokens, model.maxOutputTokens, `[${model.id}] sends its catalog output cap`);
      } else {
        assert.equal(body.max_completion_tokens, undefined, `[${model.id}] must NOT declare max_completion_tokens (free-tier OTPM 1000)`);
      }
      assert.equal("max_tokens" in body, false, `[${model.id}] uses the max_completion_tokens name, not the deprecated max_tokens`);
    }
    assert.equal(findKnownModel("groq-qwen3.8-27b").maxOutputTokens, undefined, "qwen stays uncapped in the catalog");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
}

// ---------- custom prompt: the filtered ctx.customPrompt wins over the raw stored value ----------
{
  const originalFetch = globalThis.fetch;
  let lastBody = "";
  globalThis.fetch = async (url, init) => {
    lastBody = init.body;
    const { resp } = sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']);
    return { ...resp, ok: true, status: 200, headers: { get: () => "text/event-stream" } };
  };
  globalThis.chrome = { storage: { local: { get: async () => ({ groqApiKey: "gsk_k", apiKey: "k", openrouterApiKey: "k", customPrompt: "RAW-SECRET jane@example.com" }) } } };
  try {
    const groq = MODELS.find((m) => m.provider === "groq");
    const ctx = makeCtx();
    ctx.safePost = () => {};
    ctx.customPrompt = "FILTERED [EMAIL#1]";
    await streamGroq(groq, "question", null, [], [], ctx);
    assert.ok(lastBody.includes("FILTERED [EMAIL#1]") && !lastBody.includes("RAW-SECRET"), "the redacted custom prompt is sent, never the raw stored one");
    const ctx2 = makeCtx();
    ctx2.safePost = () => {};
    ctx2.customPrompt = "";
    await streamGroq(groq, "question", null, [], [], ctx2);
    assert.ok(!lastBody.includes("RAW-SECRET"), "an empty filtered prompt does not fall back to the raw stored value");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
}

// ---------- retired-model errors map to one actionable, localized message ----------
// Groq can retire preview models at short notice (qwen3.8-27b IS one), and the
// OpenRouter free router fails in-stream with "No allowed providers...". All
// such shapes become bg_error_modelUnavailable; ordinary errors keep their raw
// (bounded) form.
{
  // isModelUnavailableError: the recognized shapes...
  assert.equal(isModelUnavailableError('The model `qwen/qwen3.8-27b` does not exist or you do not have access to it.'), true, "Groq 404 message shape");
  assert.equal(isModelUnavailableError("model_decommissioned"), true, "Groq decommissioned code");
  assert.equal(isModelUnavailableError("No allowed providers are available for the selected model."), true, "OpenRouter free-router in-stream shape");
  assert.equal(isModelUnavailableError("No endpoints found for openrouter/free."), true, "OpenRouter no-endpoint shape");
  assert.equal(isModelUnavailableError("model_not_found"), true, "bare model_not_found code");
  // ...and what must stay untouched: rate limits, quotas, ordinary failures.
  assert.equal(isModelUnavailableError("Request too large for model `qwen/qwen3.8-27b` ... on output tokens per minute (OTPM): Limit 1000"), false, "OTPM 429 is NOT a retirement");
  assert.equal(isModelUnavailableError("Rate limit reached for model `openai/gpt-oss-120b`"), false, "plain rate limit is NOT a retirement");
  assert.equal(isModelUnavailableError("upstream maintenance"), false, "ordinary stream error is NOT a retirement");
  assert.equal(isModelUnavailableError(undefined), false, "non-string is not a retirement");

  // providerHttpError: the Groq 404 model_not_found JSON body (raw body must
  // be inspected, because unwrapping keeps only the human message)...
  const groq404 = { status: 404, text: async () => '{"error":{"message":"The model `qwen/qwen3.8-27b` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}' };
  assert.match(await providerHttpError(groq404, "en"), /currently unavailable/i, "Groq 404 model_not_found maps to the localized unavailable error");
  assert.doesNotMatch(await providerHttpError(groq404, "en"), /HTTP 404/, "the raw excerpt is replaced, not prefixed");
  // ...an ordinary HTTP error keeps the raw form (lang optional, as called by tests).
  assert.match(await providerHttpError({ status: 502, text: async () => "bad gateway" }), /^HTTP 502 bad gateway$/, "ordinary HTTP error keeps the raw form");

  // readSse: the OpenRouter free router reports the failure in-stream on HTTP 200.
  {
    const ctx = makeCtx();
    const { resp } = sse(['data: {"error":{"message":"No allowed providers are available for the selected model."}}\n\n']);
    await assert.rejects(
      readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError),
      /currently unavailable/i,
      "in-stream no-providers error maps to the localized unavailable error"
    );
  }
  // readSse: the same router can also return a 200 JSON error body.
  {
    const ctx = makeCtx();
    const body = new TextEncoder().encode('{"error":{"message":"No endpoints found for openrouter/free."}}');
    const stream = new ReadableStream({ start(c) { c.enqueue(body); c.close(); } });
    const resp = { body: stream, headers: { get: () => "application/json" } };
    await assert.rejects(
      readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError),
      /currently unavailable/i,
      "a 200 JSON no-endpoints error body maps to the localized unavailable error"
    );
  }
  // readSse: an ordinary in-stream error is NOT rewritten.
  {
    const ctx = makeCtx();
    const { resp } = sse(['data: {"error":{"message":"rate limited"}}\n\n']);
    await assert.rejects(readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError), /^(Error: )?rate limited$/, "ordinary in-stream errors pass through unchanged");
  }
}

// ---------- classifyProviderFailure: rate vs size (background.js hint) ----------
// One combined hint regex used to send every refusal to the "page too large"
// advice; Groq's OTPM 429 BEGINS "Request too large" and a bare OpenRouter
// quota 429 has nothing to do with the page, so the classes are split.
{
  assert.equal(
    classifyProviderFailure('HTTP 429 Request too large for model `qwen/qwen3.8-27b` in organization `o` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 2048.'),
    "rate",
    "Groq OTPM 429 is a rate failure (NOT page size, despite beginning with 'Request too large')"
  );
  assert.equal(classifyProviderFailure("HTTP 429 Rate limit exceeded"), "rate", "bare provider 429");
  assert.equal(classifyProviderFailure("HTTP 429 You have exceeded your monthly quota"), "rate", "quota wording");
  assert.equal(classifyProviderFailure("HTTP 413 Request too large for model `x` on tokens per minute (TPM): Limit 6000, Requested 12000"), "size", "Groq INPUT-TPM refusal keeps the page-size advice");
  assert.equal(classifyProviderFailure("HTTP 413 Request Entity Too Large"), "size", "plain 413");
  assert.equal(classifyProviderFailure("This model's maximum context length is 8192 tokens, however 9000 tokens were requested"), "size", "context-length overflow");
  assert.equal(classifyProviderFailure("Please reduce the length of the messages"), "size", "explicit reduce-the-length");
  assert.equal(classifyProviderFailure("HTTP 500 internal server error"), null, "server errors get no hint");
  assert.equal(classifyProviderFailure(undefined), null, "non-string gets no hint");
  // The localized unavailable message is self-contained: no extra hint on top.
  assert.equal(classifyProviderFailure("The selected model is currently unavailable - the provider may have retired it."), null, "already-actionable unavailable text gets no extra hint");
}

// ---------- streamGroq: OTPM 429 on a declared cap falls back ONCE, uncapped ----------
// A declared max_completion_tokens is itself admission-checked against the
// account's OTPM; on an account whose limit is below the catalog cap every
// request would 429 where the uncapped default passed (probe: qwen, declared
// 2048 vs OTPM 1000; uncapped, the same request ran to 2048 real tokens).
{
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const calls = [];
  const okSse = () => {
    const { resp } = sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']);
    return { ...resp, ok: true, status: 200, headers: { get: () => "text/event-stream" } };
  };
  globalThis.chrome = { storage: { local: { get: async () => ({ groqApiKey: "gsk_test_key" }) } } };
  try {
    // OTPM 429: exactly one uncapped retry, then success.
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return { ok: false, status: 429, headers: { get: () => "application/json" }, text: async () => '{"error":{"message":"Request too large for model `openai/gpt-oss-120b` in organization `o` service tier `on_demand` on output tokens per minute (OTPM): Limit 30000, Requested 65536. The request\'s expected output tokens exceed the enforced limit; reduce max_tokens (or the request\'s expected output) and try again."}}' };
      }
      return okSse();
    };
    const ctx = makeCtx();
    await streamGroq(findKnownModel("groq-gpt-oss-120b"), "question", null, [], [], ctx);
    assert.equal(calls.length, 2, "OTPM 429 retried exactly once");
    assert.equal(calls[0].max_completion_tokens, 65536, "first attempt declares the catalog cap");
    assert.equal(calls[1].max_completion_tokens, undefined, "the fallback drops the cap");
    // A plain rate-limit 429 (input TPM) does NOT retry - dropping the cap
    // cannot help, so the error surfaces immediately.
    calls.length = 0;
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 429, headers: { get: () => "application/json" }, text: async () => '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 6000, Requested 12000."}}' };
    };
    await assert.rejects(
      () => streamGroq(findKnownModel("groq-gpt-oss-120b"), "question", null, [], [], makeCtx()),
      /HTTP 429 Rate limit reached for model `openai\/gpt-oss-120b` on tokens per minute/,
      "a plain rate-limit 429 is not retried and keeps its body detail"
    );
    assert.equal(calls.length, 1, "no retry for a non-OTPM 429");
    // qwen declares no cap, so there is nothing to drop: an OTPM 429 on it is
    // surfaced as-is (its free tier genuinely cannot serve a larger output).
    calls.length = 0;
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 429, headers: { get: () => "application/json" }, text: async () => '{"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in organization `o` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 2048. The request\'s expected output tokens exceed the enforced limit; reduce max_tokens and try again."}}' };
    };
    await assert.rejects(
      () => streamGroq(findKnownModel("groq-qwen3.8-27b"), "question", null, [], [], makeCtx()),
      /HTTP 429/,
      "a capless model (qwen) is not retried even on an OTPM 429"
    );
    assert.equal(calls.length, 1, "no retry when no cap was declared");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
}

console.log("OK: openai-compatible — SSE reassembly, in-stream error release, empty-stream guard, stream-cut detection, stream timeout, JSON error body, content-part arrays, error mapping, Groq output-cap passthrough, retired-model error mapping, failure classification, OTPM cap fallback.");
process.exit(0);
