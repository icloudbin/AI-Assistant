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
export const MODELS = [
  { id: "deepseek-chat", label: "DeepSeek Chat", apiModel: "deepseek-v4-flash", thinking: "disabled" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner", apiModel: "deepseek-v4-flash", thinking: "enabled" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", apiModel: "deepseek-v4-pro", thinking: "enabled" },
];

export function findModelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}