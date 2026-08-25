// models.js（root directory）
// DeepSeek retired the legacy `deepseek-chat` / `deepseek-reasoner` API model
// names in favor of explicit `deepseek-v4-flash` / `deepseek-v4-pro` names
// (announced 2026-04-24, legacy names slated for removal 2026-07-24 — see
// https://api-docs.deepseek.com/updates). `id` is kept as-is below purely as
// the internal/storage key (so anyone's previously saved model choice still
// matches); `apiModel` and `thinking` are what actually get sent to the API.
// Thinking mode now defaults to "enabled" on both V4 models, so it has to be
// explicitly turned off to reproduce the old deepseek-chat (non-thinking)
// behavior - see https://api-docs.deepseek.com/guides/thinking_mode.
//
// `provider` picks which branch of background.js handles the request:
// "deepseek" -> DeepSeek Chat Completions API, "gemini" -> Google's Gemini
// streamGenerateContent API, "claude" -> Anthropic's Messages API. Existing
// DeepSeek entries default to "deepseek" implicitly in code that predates
// this field, but it is listed explicitly below for clarity.
//
// Gemini entries added 2026-08. apiModel values per
// https://ai.google.dev/gemini-api/docs/models (checked 2026-08-22; page
// last updated 2026-08-14).
// gemini-3.1-pro-preview is Preview-tier — Google can change preview model
// IDs with as little as two weeks' notice, and its apiModel string carries
// the "-preview" suffix Google currently requires for it; it is included
// here anyway at explicit user request in favor of gemini-3.5-flash-lite,
// which was dropped as redundant with gemini-3.7-flash. If Google promotes
// this model to Stable under a different ID, apiModel below will need
// updating. Gemini's own "thinking" (extended reasoning) is left at each
// model's default and thought summaries are not requested, so no `thinking`
// field is set for these entries.
//
// Claude entries added 2026-08. apiModel values per
// https://platform.claude.com/docs/en/about-claude/models/overview (checked
// 2026-08-23). `id` differs from `apiModel` only for Haiku 4.5: Anthropic
// publishes both a dateless alias (`claude-haiku-4-5`) and the pinned dated
// snapshot it currently resolves to (`claude-haiku-4-5-20251001`); the
// pinned dated ID is sent as `apiModel` so behavior can't silently change if
// Anthropic later repoints the alias, matching Anthropic's own production
// guidance, while `id` keeps the short form as the storage key. Fable 5,
// Opus 5, and Sonnet 5 use the dateless model-ID format introduced with the
// 4.6 generation, where the bare ID is already a pinned snapshot (not an
// evergreen alias), so `id` and `apiModel` are identical for those three.
// Claude Opus 5 is listed rather than Opus 4.8: the overview page's "Latest
// models comparison" table names Opus 5 as the current flagship ("start
// with Claude Opus 5 for complex agentic coding and enterprise work"),
// with Opus 4.8 kept on only as a still-supported earlier snapshot. Claude
// Mythos 5 is deliberately omitted - it is invitation-only under Project
// Glasswing (https://anthropic.com/glasswing) and not reachable with a
// self-serve API key. Unlike DeepSeek's explicit `thinking` flag, Claude's
// "adaptive thinking" on Fable 5 / Opus 5 / Sonnet 5 is not a simple on/off
// request parameter, so - as with Gemini - no `thinking` field is set here
// and each model's default is used.
// OpenAI (ChatGPT) entries added 2026-08. apiModel values per
// https://developers.openai.com/api/docs/models and
// https://developers.openai.com/api/docs/guides/latest-model (checked
// 2026-08-24): GPT-5.6 is the current flagship generation and introduced an
// explicit three-tier naming scheme - gpt-5.6-sol (flagship, complex
// reasoning/coding), gpt-5.6-terra (balances intelligence and cost), and
// gpt-5.6-luna (cost-sensitive, high-volume) - superseding the GPT-5.2/5.3/
// 5.4/5.5 line the same way Claude Opus 5 superseded Opus 4.8 above. A bare
// "gpt-5.6" alias also exists and currently resolves to gpt-5.6-sol, but the
// explicit tier id is used as apiModel for the same reason Claude Haiku 4.5
// uses its dated snapshot above: an alias can be silently repointed later.
// provider "openai" is handled by background.js via the Responses API
// (https://api.openai.com/v1/responses, NOT the older /v1/chat/completions
// endpoint), which takes an `input` array instead of `messages` and a
// top-level `instructions` string instead of a system-role message - see
// the comment on streamOpenAI in background.js for the streaming-format and
// CORS notes, including one point (whether OpenAI's API accepts a direct
// call from this extension's background service worker) that could not be
// verified from this sandbox and needs a live check. As with Gemini and
// Claude, no reasoning/thinking field is set here and each model's default
// effort is used.
// OpenRouter entry added 2026-08. OpenRouter (https://openrouter.ai) is a
// third-party router/aggregator, not a model's own native API - it exposes
// an OpenAI-Chat-Completions-compatible endpoint
// (https://openrouter.ai/api/v1/chat/completions, confirmed against
// OpenRouter's own docs at https://openrouter.ai/docs/quickstart, checked
// 2026-08-24) that forwards to whichever underlying provider/model the
// `model` slug names. "Ox Alpha" (stealth/ox-alpha) is a stealth/anonymous
// model OpenRouter itself listed on 2026-08-20
// (https://openrouter.ai/stealth/ox-alpha): the underlying provider has
// chosen to stay anonymous during this preview, OpenRouter is only routing
// to it, pricing is currently $0/$0 but explicitly preview-only and could
// change or disappear, and - per OpenRouter's own stealth-model terms -
// prompts/completions are retained by that anonymous provider (not used
// for training, but not the same data-handling posture as calling
// Anthropic/OpenAI/Google directly). provider "openai" is handled by
// background.js via api.openai.com and its own hard cutover to the
// Responses API; OpenRouter's endpoint uses the OLDER, still-current
// Chat-Completions request/response shape (messages array, system role
// sent inline, choices[0].delta.content while streaming) - the exact same
// shape DeepSeek's API already uses - so streamOpenRouter in background.js
// reuses buildMessages() rather than needing its own turn-builder.
export const MODELS = [
  { id: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek", apiModel: "deepseek-v4-flash", thinking: "disabled" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner", provider: "deepseek", apiModel: "deepseek-v4-flash", thinking: "enabled" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", apiModel: "deepseek-v4-pro", thinking: "enabled" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "gemini", apiModel: "gemini-3.7-flash" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "gemini", apiModel: "gemini-3.1-pro-preview" },
  { id: "claude-fable-5", label: "Claude Fable 5", provider: "claude", apiModel: "claude-fable-5" },
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "claude", apiModel: "claude-opus-5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "claude", apiModel: "claude-sonnet-5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude", apiModel: "claude-haiku-4-5-20251001" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai", apiModel: "gpt-5.6-sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", apiModel: "gpt-5.6-terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai", apiModel: "gpt-5.6-luna" },
  { id: "openrouter-ox-alpha", label: "OpenRouter: Ox Alpha", provider: "openrouter", apiModel: "stealth/ox-alpha" },
];

export function findModelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}
