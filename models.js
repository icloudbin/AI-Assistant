// AI model catalog for AI Assistant.

// Hard ceiling, in characters, on the page text carried by one request
// (120,000 characters is roughly 30,000 English tokens). This is the single
// definition used by background.js and sidepanel.js; do not redeclare it.
// content.js is injected as a classic script and cannot import this module, so
// it keeps its own copy (PAGE_CONTEXT_CHAR_LIMIT); scripts/check-package.mjs
// fails if the two values differ.
export const MAX_PAGE_CONTEXT_CHARS = 120000;
// The custom prompt is sent to the model as a SYSTEM instruction on every request;
// settings import refuses a longer one and the request builder never sends more.
export const MAX_CUSTOM_PROMPT_CHARS = 8000;

// UTF-16 slice() can cut an emoji / astral character in half. Every text cap
// goes through this helper so the result never ends with a lone surrogate.
export function cutAtCodePointBoundary(text, max) {
  const value = String(text ?? "");
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (value.length <= limit) return value;
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end);
}

// maxPageChars: cap on the current-page text sent with a request (about 4
// characters per token). Free tiers (Groq, OpenRouter free) reject or
// rate-limit large requests, so they get a much smaller budget than DeepSeek.
//
// maxOutputTokens: sent to Groq as max_completion_tokens (streamGroq). Without
// it Groq caps a reply at a small per-model default and cuts it off mid-answer:
// probed live 2026-11-07, a "write 2000 words" request stopped with
// finish_reason "length" at 3072 completion tokens (gpt-oss-120b) and 2048
// (qwen3.8-27b, gpt-oss-20b). 65536 is the accepted maximum for both GPT-OSS
// models (named by Groq's own 400 for a larger value, then confirmed accepted
// by a real request). Qwen 3.8 27B deliberately declares NO cap: this key's
// free tier enforces an output-tokens-per-minute admission limit of 1000 for
// that preview model and REJECTS (HTTP 429 OTPM) every request that declares
// more, while without the parameter the default 2048 goes through. Revisit
// only for a key known to allow more.
export const DEFAULT_MAX_PAGE_CHARS = MAX_PAGE_CONTEXT_CHARS;
export const MODELS = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", provider: "deepseek", apiModel: "deepseek-flash", thinking: "enabled", maxPageChars: MAX_PAGE_CONTEXT_CHARS },
  { id: "groq-gpt-oss-120b", label: "Groq: GPT-OSS 120B", provider: "groq", apiModel: "openai/gpt-oss-120b", vision: false, maxOutputTokens: 65536, maxPageChars: 24000 },
  // Preview model (Groq docs: evaluation only, can be changed or removed at
  // short notice). `preview: true` labels it in the dropdown, and a retirement
  // (404 model_not_found / model_decommissioned, or the free router's
  // "no allowed providers") maps to an actionable localized error instead of
  // the raw HTTP excerpt - see isModelUnavailableError() in
  // providers/openai-compatible.js. The default model is production, so an
  // unknown ID never silently lands here.
  { id: "groq-qwen3.8-27b", label: "Groq: Qwen 3.8 27B", provider: "groq", apiModel: "qwen/qwen3.8-27b", preview: true, maxPageChars: 24000 },
  { id: "groq-gpt-oss-20b", label: "Groq: GPT-OSS 20B", provider: "groq", apiModel: "openai/gpt-oss-20b", vision: false, maxOutputTokens: 65536, maxPageChars: 24000 },
  { id: "openrouter-free-auto", label: "OpenRouter: Free Model (Auto)", provider: "openrouter", apiModel: "openrouter/free", vision: false, maxPageChars: 24000 },
];

// UI helper: tolerant lookup. Resolves legacy IDs and falls back to the default
// model so the side panel's dropdown always has something to show.
export function findModelById(id) {
  return MODELS.find((m) => m.id === resolveModelId(id)) || MODELS[0];
}

// Strict lookup used by the background worker before sending anything to a
// provider: legacy IDs are resolved, but an unknown ID returns undefined
// instead of silently routing the request (and the user's data) to the
// default provider.
export function findKnownModel(id) {
  if (!id) return undefined;
  const resolved = MODEL_ALIASES[id] || id;
  return MODELS.find((m) => m.id === resolved);
}

// Whether the model accepts image input. Models are assumed to support it
// unless the catalog says `vision: false` (both GPT-OSS models and the
// OpenRouter free model are text-only - GPT-OSS rejects multipart content
// with HTTP 400 "messages[0].content must be a string"). Qwen 3.8 27B is
// natively multimodal: verified live 2026-11-07, a data-URL image_url part
// came back HTTP 200 and was read correctly, so it has no vision flag.
export function modelSupportsVision(model) {
  return model?.vision !== false;
}

// Keep compatibility with sidepanel.js and restored conversations from older builds.
const MODEL_ALIASES = {
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "openrouter-free": "openrouter-free-auto",
};
export function resolveModelId(id) {
  if (!id) return MODELS[0].id;
  const resolved = MODEL_ALIASES[id] || id;
  return MODELS.some((m) => m.id === resolved) ? resolved : MODELS[0].id;
}
export function findModelIdByLabel(label) {
  if (!label) return null;
  const model = MODELS.find((m) => m.label === label);
  return model ? model.id : null;
}
