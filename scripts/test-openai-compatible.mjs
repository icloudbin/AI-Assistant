#!/usr/bin/env node
// Unit tests for providers/openai-compatible.js (SSE reader + error mapping
// moved verbatim from background.js). The stream functions themselves are
// integration-tested in the browser; here the shared machinery is driven
// with synthetic Response bodies. Run:  node scripts/test-openai-compatible.mjs
import assert from "node:assert/strict";
import { readSse, openAICompatibleStreamError, providerHttpError, extractOpenAIDelta } from "../providers/openai-compatible.js";

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
  assert.equal(ctx.thinking.join(""), "Let me think.", "thinking chunks routed to ctx.sendThinking");
  assert.equal(ctx.chunks.join(""), "Done!", "content chunks routed to ctx.sendChunk");

  // Reasoning only (no content) does NOT throw empty response error
  const ctxReasoningOnly = makeCtx();
  const { resp: respReasoning } = sse([
    'data: {"choices":[{"delta":{"reasoning_content":"only reasoning"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  await readSse(respReasoning, extractOpenAIDelta, ctxReasoningOnly, openAICompatibleStreamError);
  assert.ok(ctxReasoningOnly.thinking.length > 0, "reasoning-only response does not throw empty error");
}

// ---------- translation mode drops the reasoning stream ----------
// A translation must show ONLY the final translated text (the pre-1.10.116
// behavior): no "Thought process" block in the translation box.
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

  // Chat mode (translateMode false) still receives the reasoning stream.
  const chatCtx = makeCtx();
  const { resp: chatResp } = sse(reasoningThenContent);
  await readSse(chatResp, extractOpenAIDelta, chatCtx, openAICompatibleStreamError);
  assert.equal(chatCtx.thinking.join(""), "Let me think.", "chat mode keeps the reasoning stream");
  assert.equal(chatCtx.chunks.join(""), "你好世界", "chat mode keeps the content stream");
}

console.log("OK: openai-compatible — SSE reassembly, in-stream error release, empty-stream guard, stream-cut detection, error mapping.");
process.exit(0);
