// providers/openai-compatible.js
//
// The three OpenAI-Chat-Completions-compatible providers (DeepSeek, Groq,
// OpenRouter): request construction, the shared SSE reader, and error
// mapping. Moved verbatim from background.js; the request lifecycle
// (port, abort, keep-alive, retry policy) stays in background.js and hands
// each provider a `ctx` ({ port, requestId, signal, lang, translateMode,
// lineTranslator, ... }).

import { t } from "../i18n.js";
import { buildMessages } from "./messages.js";

// Builds the message for a failed provider response. The raw body can be a
// large HTML error page (gateway errors), which used to be dumped whole into
// the chat; keep only a bounded excerpt. JSON bodies (all three providers'
// error format) are unwrapped to their human-readable message so the user
// sees "You have uploaded an unsupported image…" instead of the raw JSON.
async function providerHttpError(resp, lang) {
  let body = "";
  try {
    body = (await resp.text()).replace(/\s+/g, " ").trim();
  } catch {
    // Unreadable body: the status code alone is still useful.
  }
  let message = body;
  if (body.startsWith("{")) {
    try {
      const json = JSON.parse(body);
      const error = json?.error;
      message = typeof error === "string" ? error : String(error?.message || json?.message || body);
    } catch {
      // Not valid JSON after all: fall through to the raw excerpt.
    }
  }
  // A retired model (Groq preview models can be removed at short notice) has
  // its own shapes on both the HTTP path (404 model_not_found JSON) and the
  // OpenRouter free router ("No allowed providers are available..."). One
  // actionable, localized message beats the raw excerpt here.
  if (isModelUnavailableError(body)) return t(lang, "bg_error_modelUnavailable");
  return `HTTP ${resp.status}${message ? ` ${message.slice(0, 500)}${message.length > 500 ? "…" : ""}` : ""}`;
}

// Recognizes every provider shape that means "this model is gone or has no
// active route": Groq's 404 `model_not_found` / `model_decommissioned` codes
// ("The model `x` does not exist or you do not have access to it."), and the
// OpenRouter free router's in-stream failures ("No allowed providers are
// available for the selected model", "No endpoints found for ..."). Deliberately
// NOT matched: rate-limit and quota errors (429 OTPM, TPM/TPD) - those have
// their own, size-related guidance in background.js.
const MODEL_UNAVAILABLE_RE = /\bmodel_not_found\b|\bmodel_decommissioned\b|\bdoes not exist\b|\bno longer (?:exists?|available|supported)\b|\bhas been (?:decommissioned|retired)\b|\bno allowed providers\b|\bno endpoints found\b/i;

export function isModelUnavailableError(text) {
  return typeof text === "string" && MODEL_UNAVAILABLE_RE.test(text);
}

// ---------------------------------------------------------------------------
// Error-text classification for background.js's catch-all advice (F4). One
// combined regex used to send EVERY refusal to the "page too large" hint, but
// Groq's output-token admission limit sends HTTP 429 with a body that BEGINS
// "Request too large ... on output tokens per minute (OTPM)" - shrinking the
// page cannot help there, the model's per-minute OUTPUT budget is the binding
// constraint. Three classes:
//   "rate" - the provider's budget: bare HTTP 429 (OpenRouter free daily
//            quota), "rate limit", quotas, and OUTPUT-token limits (OTPM).
//   "size" - the request itself: HTTP 413, context-window overflow, INPUT
//            tokens-per-minute refusals (a long page inflates the input),
//            explicit "reduce the length".
//    null  - anything else (no hint).
const PROVIDER_OUTPUT_RATE_RE = /\boutput tokens? per (?:minute|day)\b|\bOTPM\b|\bOTPD\b/i;
const PROVIDER_RATE_RE = /^HTTP 429\b|\brate.?limit\b|\bquota\b|\btokens? per day\b|\bTPD\b|resource_exhausted/i;
const PROVIDER_SIZE_RE = /^HTTP 413\b|\btoo large\b|context.?length|maximum context|context window|reduce the length|tokens? per minute|\bTPM\b/i;

export function classifyProviderFailure(errorText) {
  if (typeof errorText !== "string") return null;
  // OUTPUT-rate first: the OTPM message also matches the size patterns
  // ("Request too large", "tokens per minute").
  if (PROVIDER_OUTPUT_RATE_RE.test(errorText) || PROVIDER_RATE_RE.test(errorText)) return "rate";
  if (PROVIDER_SIZE_RE.test(errorText)) return "size";
  return null;
}

// First-byte watchdog: the stream idle/total timers only start once the
// response HEADERS have arrived - a provider (or middlebox) that accepts
// the connection and then never answers used to hang fetch() forever,
// keeping the connection and the service-worker keep-alive alive until
// the user clicked Clear. The user's own STOP still propagates as
// AbortError; the timeout surfaces as a plain, reported error.
//
// ONE AbortController covers the whole request lifecycle - headers AND body.
// Only the first-byte TIMER is torn down when the headers arrive; the link from
// ctx.signal (the user's STOP) to this controller is deliberately kept, so a
// STOP that lands mid-stream still aborts the underlying fetch and its body
// stream. (The link used to be removed in a `finally` as soon as fetch()
// resolved, i.e. at the response headers, so STOP could no longer reach the
// body: the provider kept streaming to completion, burning tokens/quota and
// holding the connection and keep-alive until the stream ended.) The link is
// only dropped when the request fails before a response exists; otherwise it
// lives as long as ctx.signal, which is per request.
export const FIRST_BYTE_TIMEOUT_MS = 60 * 1000;

export async function fetchWithHeadersTimeout(url, init, ctx, timeoutMs = FIRST_BYTE_TIMEOUT_MS) {
  const controller = new AbortController();
  const stop = ctx.signal;
  let onStop = null;
  if (stop) {
    if (stop.aborted) throw new DOMException("Aborted", "AbortError");
    onStop = () => controller.abort(stop.reason);
    stop.addEventListener("abort", onStop, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DOMException("headers timeout", "TimeoutError")), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // No response exists, so there is no body left to stop: drop the link.
    if (onStop) stop.removeEventListener("abort", onStop);
    if (stop?.aborted) throw err; // deliberate STOP: keep the AbortError
    if (err?.name === "TimeoutError") {
      throw new Error(t(ctx.lang, "bg_error_noResponse", { seconds: String(Math.round(timeoutMs / 1000)) }));
    }
    throw err; // ordinary network failure (DNS, refused, TLS ...)
  } finally {
    // Only the first-byte timer ends here - NOT the link to ctx.signal (above).
    clearTimeout(timer);
  }
}

async function streamDeepSeek(model, question, pageContext, history, images, ctx) {
  const stored = await chrome.storage.local.get(["apiKey", "customPrompt"]);
  // Trim: a key imported from a settings file may carry a trailing newline,
  // which is an illegal character in an HTTP header value.
  const apiKey = String(stored.apiKey || "").trim();
  const customPrompt = stored.customPrompt;
  if (!apiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "DeepSeek" }));

  // `deepseek-flash` (DeepSeek-V4.1-Flash) accepts image input directly, so
  // the same `apiModel` is used for both text and image requests - there is
  // no separate vision model to swap in (the old deepseek-v4-*-vision-exp
  // endpoint is retired). See the `deepseek-flash` note in models.js.
  const resp = await fetchWithHeadersTimeout("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang, ctx.translateMode, { boundaryId: ctx.boundaryId, attachments: ctx.attachments }),
      stream: true,
      ...(model.thinking ? { thinking: { type: model.thinking } } : {}),
      ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
    }),
  }, ctx);
  if (!resp.ok) throw new Error(await providerHttpError(resp, ctx.lang));

  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
}

// Groq OpenAI-compatible Chat Completions API.
async function streamGroq(model, question, pageContext, history, images, ctx) {
  // Read the current Groq key directly from extension storage. The legacy
  // groqKey fallback keeps keys saved by an intermediate build usable after
  // the provider was standardized on the groqApiKey storage name.
  const stored = await chrome.storage.local.get(["groqApiKey", "groqKey", "customPrompt"]);
  const groqApiKey = String(stored.groqApiKey || stored.groqKey || "").trim();
  const customPrompt = stored.customPrompt || "";
  if (!groqApiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "Groq" }));

  const body = {
    model: model.apiModel,
    messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang, ctx.translateMode, { boundaryId: ctx.boundaryId, attachments: ctx.attachments }),
    stream: true,
    // Catalog-level output cap (see maxOutputTokens in models.js): without
    // it Groq stops the reply at its small per-model default (probed live
    // 2026-11-07: 2048-3072 tokens, finish_reason "length" mid-essay).
    // Models without the field (qwen3.8-27b) must send NOTHING here - its
    // free tier rejects any declared cap above 1000 with HTTP 429 OTPM.
    ...(model.maxOutputTokens ? { max_completion_tokens: model.maxOutputTokens } : {}),
  };
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
  };
  let resp = await fetchWithHeadersTimeout("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify(body) }, ctx);
  // A DECLARED output cap is itself admission-checked against the account's
  // output-tokens-per-minute limit (Groq OTPM): on an account whose limit is
  // below the catalog cap, EVERY request would 429 where the uncapped default
  // passed (probe: qwen with a declared 2048 vs an OTPM of 1000; uncapped, the
  // same request ran to 2048 actual output tokens). Fall back ONCE to the
  // uncapped body - the reply may then stop at Groq's small default cap
  // (finish_reason "length", surfaced as usual), which still beats refusing
  // outright. A plain rate-limit 429 and capless models never retry here.
  if (!resp.ok && resp.status === 429 && body.max_completion_tokens) {
    const text = await resp.text().catch(() => "");
    if (PROVIDER_OUTPUT_RATE_RE.test(text)) {
      const uncapped = { ...body };
      delete uncapped.max_completion_tokens;
      resp = await fetchWithHeadersTimeout("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify(uncapped) }, ctx);
    }
  }
  if (!resp.ok) throw new Error(await providerHttpError(resp, ctx.lang));

  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
}

// OpenRouter (https://openrouter.ai) is a third-party router, not a model's
// own native API. The extension uses OpenRouter's Free Models Router via
// `openrouter/free`, which automatically selects an available free model.
// The endpoint is OpenAI-Chat-Completions-compatible, so the request shape
// and SSE response handling below stay unchanged.
async function streamOpenRouter(model, question, pageContext, history, images, ctx) {
  const stored = await chrome.storage.local.get(["openrouterApiKey", "customPrompt"]);
  // Trim: see streamDeepSeek() - a newline in an imported key breaks the header.
  const openrouterApiKey = String(stored.openrouterApiKey || "").trim();
  const customPrompt = stored.customPrompt;
  if (!openrouterApiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "OpenRouter" }));

  const resp = await fetchWithHeadersTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterApiKey}`,
      "HTTP-Referer": chrome.runtime.getURL(""),
      "X-OpenRouter-Title": "AI Assistant",
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang, ctx.translateMode, { boundaryId: ctx.boundaryId, attachments: ctx.attachments }),
      stream: true,
    }),
  }, ctx);
  if (!resp.ok) throw new Error(await providerHttpError(resp, ctx.lang));

  await readSse(resp, extractOpenAIDelta, ctx, openAICompatibleStreamError);
}

// Extracts content and optional reasoning/thinking deltas from an OpenAI-compatible chunk.
export function extractOpenAIDelta(json) {
  const choice = json?.choices?.[0];
  const delta = choice?.delta;
  const content = delta?.content ?? "";
  const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? "";
  return { content, reasoning };
}

// Shared SSE reader: DeepSeek, Groq and OpenRouter all send
// "data: {...}\n\n"
// lines (any named "event:" line is ignored since this reader only inspects
// lines starting with "data:"); `extractDelta` picks the text out of each
// parsed chunk. `ctx` (added alongside the STOP/abort
// mechanism) carries the port to post CHUNKs to and the requestId to tag
// them with, so sidepanel.js can tell a chunk belonging to a since-aborted
// request apart from the current one if any are still in flight when a STOP
// lands (see stopActiveRequest() in sidepanel.js).
//
// STOP handling is explicit and does not rely on the fetch plumbing alone:
// this reader listens to ctx.signal and cancels the stream the moment it
// aborts (releasing the connection), and it re-checks ctx.signal after every
// read() and for every line. A cancelled reader resolves a pending read() as
// `done` rather than rejecting, so without the explicit check an aborted stream
// would look like a clean (or cut) end instead of an AbortError.
// A stream that stops producing bytes must not hold the request (and the side
// panel's composer) open forever. The idle timer resets on every chunk; the
// total deadline bounds a provider that keeps dribbling bytes but never ends.
const STREAM_IDLE_TIMEOUT_MS = 90 * 1000;
const STREAM_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;

async function readSse(resp, extractDelta, ctx, extractError = null) {
  const reader = resp.body.getReader();
  const signal = ctx.signal;
  const abortError = () => new DOMException("Aborted", "AbortError");
  // The user's STOP: no further chunk may be processed or emitted.
  const throwIfStopped = () => {
    if (signal?.aborted) throw abortError();
  };
  if (signal?.aborted) {
    reader.cancel().catch(() => {});
    throw abortError();
  }
  const decoder = new TextDecoder();
  const isJsonResponse = /application\/json/i.test(resp.headers?.get?.("content-type") || "");
  let jsonText = isJsonResponse ? "" : null;
  let buffer = "";
  let emitted = false;
  // A well-formed OpenAI-compatible stream always ends with an explicit
  // terminal event: the "data: [DONE]" marker and/or a chunk carrying
  // finish_reason. A network failure mid-stream (connection reset, offline)
  // can surface to the reader as a CLEAN EOF instead of a read() rejection -
  // without this flag such a cut stream was completed as if the model had
  // finished, silently presenting a truncated answer as complete (caught by
  // a real-browser E2E: offline mid-stream left no error at all).
  let sawTerminal = false;
  const idleMs = Number.isFinite(ctx.streamIdleTimeoutMs) && ctx.streamIdleTimeoutMs > 0
    ? ctx.streamIdleTimeoutMs
    : STREAM_IDLE_TIMEOUT_MS;
  const totalMs = Number.isFinite(ctx.streamTotalTimeoutMs) && ctx.streamTotalTimeoutMs > 0
    ? ctx.streamTotalTimeoutMs
    : STREAM_TOTAL_TIMEOUT_MS;
  let timedOut = false;
  let idleTimer = null;
  let totalTimer = null;
  const timeoutError = () => new Error(t(ctx.lang, "bg_error_streamTimeout"));
  const abortForTimeout = () => {
    if (timedOut) return;
    timedOut = true;
    // Cancel the reader first: a custom stream may not react to ctx.signal.
    try { reader.cancel().catch(() => {}); } catch {}
    try { ctx.abort?.(); } catch {}
  };
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(abortForTimeout, idleMs);
  };
  totalTimer = setTimeout(abortForTimeout, totalMs);
  armIdleTimer();

  // Handles one complete SSE line; throws on a provider-reported error.
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      sawTerminal = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const streamError = extractError?.(json);
    if (streamError) {
      throw new Error(isModelUnavailableError(streamError) ? t(ctx.lang, "bg_error_modelUnavailable") : streamError);
    }
    // finish_reason "length" = the reply hit the output-token limit and was cut
    // off by the server. Without this the answer just stops mid-sentence.
    if (json?.choices?.[0]?.finish_reason === "length") ctx.truncatedByLength = true;
    // Any finish_reason (stop/length/content_filter/…) is itself an explicit
    // termination by the provider, even if the trailing [DONE] marker were
    // missing.
    if (json?.choices?.[0]?.finish_reason) sawTerminal = true;
    const delta = extractDelta(json);
    const rawContent = typeof delta === "string" ? delta : (delta?.content ?? "");
    // OpenAI-compatible providers normally return a string. Some return a
    // content-part array; flatten it rather than passing an array to the panel
    // (which would stringify it).
    const content = Array.isArray(rawContent)
      ? rawContent.map((part) => (typeof part === "string" ? part : part?.text || "")).join("")
      : (typeof rawContent === "string" ? rawContent : "");
    // Only the final result is ever displayed: the model's reasoning stream is
    // dropped for EVERY request (translations since v1.10.118, everything else
    // since v1.10.126) - the conversation box shows no "Thought process" block.
    // A stream that produced reasoning but no content therefore counts as an
    // empty completion and fails below, exactly like the translation behavior.
    if (content) {
      emitted = true;
      if (ctx.lineTranslator) ctx.lineTranslator.push(content);
      else ctx.sendChunk(content);
    }
  };

  // STOP: cancel the stream right away so the connection to the provider is
  // released instead of being drained to the end. The checks below turn the
  // resulting `done` (or a rejected read) into an AbortError.
  const onAbort = () => {
    try { reader.cancel(signal.reason).catch(() => {}); } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // A provider-reported error thrown by handleLine below (or a transport
  // failure in read()) must release the response body: the reader keeps the
  // connection to the provider open until the service worker is recycled
  // otherwise. After an abort or a failed read() the stream is already
  // cancelled/errored, which makes this cancel() a harmless no-op.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw timeoutError();
      throwIfStopped();
      if (done) break;
      armIdleTimer();
      const decoded = decoder.decode(value, { stream: true });
      if (jsonText !== null) jsonText += decoded;
      buffer += decoded;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        throwIfStopped();
        handleLine(line);
      }
    }
    if (timedOut) throw timeoutError();
    throwIfStopped();
    // Flush whatever is left: a final "data:" line that is not newline-terminated
    // used to be dropped, silently truncating the end of the answer.
    const tail = decoder.decode();
    if (jsonText !== null) jsonText += tail;
    buffer += tail;
    if (buffer.trim()) handleLine(buffer);
  } catch (err) {
    reader.cancel().catch(() => {});
    if (timedOut) throw timeoutError();
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onAbort);
  }

  // A provider can return HTTP 200 with a JSON error body instead of an SSE
  // stream (gateway/maintenance responses). Without this it looked like an
  // empty completion and hid the real error.
  if (jsonText !== null && !emitted) {
    let parsed = null;
    try { parsed = JSON.parse(jsonText); } catch {}
    const jsonError = parsed ? (extractError?.(parsed) || "") : "";
    if (jsonError) {
      throw new Error(isModelUnavailableError(jsonError) ? t(ctx.lang, "bg_error_modelUnavailable") : jsonError);
    }
  }

  // A stream that ended without a single visible character (empty completion,
  // or reasoning that consumed the whole budget) is a failure, not an answer:
  // saving an empty assistant turn breaks later requests, because providers
  // reject empty assistant messages in the history.
  if (!emitted) throw new Error(t(ctx.lang, "bg_error_emptyResponse"));
  // EOF without [DONE] and without any finish_reason: the connection was cut
  // mid-stream, not ended by the provider. Throwing routes the request through
  // the ERROR path, which keeps the partial reply and shows the user that the
  // answer is incomplete - instead of presenting it as a complete answer.
  if (!sawTerminal) throw new Error(t(ctx.lang, "bg_error_streamCut"));
}

// OpenAI-compatible providers (DeepSeek, Groq, OpenRouter) can report a failure
// in the middle of an HTTP 200 stream as {"error": {...}}. OpenRouter's free
// router does this regularly; without this check such a request just ended with
// an empty answer and no explanation.
function openAICompatibleStreamError(json) {
  const error = json?.error;
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.message || JSON.stringify(error));
}

export { providerHttpError, streamDeepSeek, streamGroq, streamOpenRouter, readSse, openAICompatibleStreamError };
