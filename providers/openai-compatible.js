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
async function providerHttpError(resp) {
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
  return `HTTP ${resp.status}${message ? ` ${message.slice(0, 500)}${message.length > 500 ? "…" : ""}` : ""}`;
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
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang, ctx.translateMode),
      stream: true,
      ...(model.thinking ? { thinking: { type: model.thinking } } : {}),
      ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(await providerHttpError(resp));

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

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang, ctx.translateMode),
      stream: true,
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(await providerHttpError(resp));

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

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterApiKey}`,
      "HTTP-Referer": chrome.runtime.getURL(""),
      "X-OpenRouter-Title": "AI Assistant",
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang, ctx.translateMode),
      stream: true,
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(await providerHttpError(resp));

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
// lands (see stopActiveRequest() in sidepanel.js) - reader.read() itself
// also naturally rejects once ctx.signal aborts, ending this loop via the
// same AbortError path the initial fetch() would take.
async function readSse(resp, extractDelta, ctx, extractError = null) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
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
    if (streamError) throw new Error(streamError);
    // finish_reason "length" = the reply hit the output-token limit and was cut
    // off by the server. Without this the answer just stops mid-sentence.
    if (json?.choices?.[0]?.finish_reason === "length") ctx.truncatedByLength = true;
    // Any finish_reason (stop/length/content_filter/…) is itself an explicit
    // termination by the provider, even if the trailing [DONE] marker were
    // missing.
    if (json?.choices?.[0]?.finish_reason) sawTerminal = true;
    const delta = extractDelta(json);
    const content = typeof delta === "string" ? delta : (delta?.content ?? "");
    const reasoning = typeof delta === "object" ? (delta?.reasoning ?? "") : "";
    // A translation shows only the final translated text: the model's
    // reasoning stream is dropped there (ctx.translateMode is "free"/"lines"),
    // exactly the pre-thinking-display behavior. The ASK/chat panel keeps
    // rendering it under "Thought process".
    if (reasoning && !ctx.translateMode) {
      emitted = true;
      ctx.sendThinking?.(reasoning);
    }
    if (content) {
      emitted = true;
      if (ctx.lineTranslator) ctx.lineTranslator.push(content);
      else ctx.sendChunk(content);
    }
  };

  // A provider-reported error thrown by handleLine below (or a transport
  // failure in read()) must release the response body: the reader keeps the
  // connection to the provider open until the service worker is recycled
  // otherwise. read() rejecting on abort makes cancel() a harmless no-op.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }
    // Flush whatever is left: a final "data:" line that is not newline-terminated
    // used to be dropped, silently truncating the end of the answer.
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
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
