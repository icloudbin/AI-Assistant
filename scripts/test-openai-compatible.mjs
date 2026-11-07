#!/usr/bin/env node
// Unit tests for providers/openai-compatible.js (SSE reader + error mapping
// moved verbatim from background.js). The stream functions themselves are
// integration-tested in the browser; here the shared machinery is driven
// with synthetic Response bodies. Run:  node scripts/test-openai-compatible.mjs
import assert from "node:assert/strict";
import { readSse, openAICompatibleStreamError, providerHttpError, extractOpenAIDelta, fetchWithHeadersTimeout, streamGroq, isModelUnavailableError, classifyProviderFailure } from "../providers/openai-compatible.js";
import { MODELS, findKnownModel } from "../models.js";

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

// ---------- happy path: chunks reassembled, [DONE] ignored, final line without newline flushed ----------
{
  const ctx = makeCtx();
  const { resp } = sse([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}',
  ]);
  await readSse(resp, delta, ctx, openAICompatibleStreamError);
  assert.equal(ctx.chunks.join(""), "Hello!", "chunks reassembled; unterminated final line flushed; [DONE] ignored");
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
