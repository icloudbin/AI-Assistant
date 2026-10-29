// AI model catalog for AI Assistant.

// Hard ceiling, in characters, on the page text carried by one request
// (120,000 characters is roughly 30,000 English tokens). This is the single
// definition used by background.js and sidepanel.js; do not redeclare it.
// content.js is injected as a classic script and cannot import this module, so
// it keeps its own copy (PAGE_CONTEXT_CHAR_LIMIT); scripts/check-package.mjs
// fails if the two values differ.
export const MAX_PAGE_CONTEXT_CHARS = 120000;

// maxPageChars: cap on the current-page text sent with a request (about 4
// characters per token). Free tiers (Groq, OpenRouter free) reject or
// rate-limit large requests, so they get a much smaller budget than DeepSeek.
export const DEFAULT_MAX_PAGE_CHARS = MAX_PAGE_CONTEXT_CHARS;
export const MODELS = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", provider: "deepseek", apiModel: "deepseek-flash", thinking: "enabled", maxPageChars: MAX_PAGE_CONTEXT_CHARS },
  { id: "groq-gpt-oss-120b", label: "Groq: GPT-OSS 120B", provider: "groq", apiModel: "openai/gpt-oss-120b", vision: false, maxPageChars: 24000 },
  { id: "groq-qwen3.8-27b", label: "Groq: Qwen 3.8 27B", provider: "groq", apiModel: "qwen/qwen3.8-27b", vision: false, maxPageChars: 24000 },
  { id: "groq-gpt-oss-20b", label: "Groq: GPT-OSS 20B", provider: "groq", apiModel: "openai/gpt-oss-20b", vision: false, maxPageChars: 24000 },
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
// unless the catalog says `vision: false` (the GPT-OSS models are text-only).
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
