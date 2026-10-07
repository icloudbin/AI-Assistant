// Current production model catalog for the extension.
// Model IDs were checked against the providers' current public API docs.
// Legacy IDs are resolved by resolveModelId() so saved settings/conversations
// continue to work after provider model renames.
export const MODELS = [
  {
    id: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    apiModel: "deepseek-flash",
    thinking: "enabled",
    reasoningEffort: "high",
  },
  {
    id: "openrouter-free-auto",
    label: "OpenRouter: Free Model (Auto)",
    provider: "openrouter",
    apiModel: "openrouter/free",
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "gemini",
    apiModel: "gemini-3.8-flash",
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    provider: "claude",
    apiModel: "claude-fable-5-1",
    maxTokens: 32768,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    provider: "claude",
    apiModel: "claude-opus-5-5",
    maxTokens: 32768,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "claude",
    apiModel: "claude-sonnet-5-5",
    maxTokens: 32768,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "claude",
    apiModel: "claude-haiku-4-5-20251001",
    maxTokens: 16384,
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    apiModel: "gpt-6-astra",
    reasoningEffort: "medium",
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    provider: "openai",
    apiModel: "gpt-6.1-sol",
    reasoningEffort: "medium",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    apiModel: "gpt-6-luna",
    reasoningEffort: "medium",
  },
  {
    id: "glm-5.3-flash",
    label: "GLM-5.3 Flash (Z.AI)",
    provider: "zai",
    apiModel: "glm-5.3-flash",
    thinking: "enabled",
    reasoningEffort: "max",
  },
];

// IDs used by older builds. These aliases are intentionally explicit rather
// than silently falling back to MODELS[0], which could change providers.
export const MODEL_ID_ALIASES = {
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
  "deepseek-v4-pro": "deepseek-flash",
  "gemini-3.7-flash": "gemini-3.8-flash",
  "claude-fable-5": "claude-fable-5-1",
  "claude-opus-5": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "gpt-5.6-sol": "gpt-6-astra",
  "gpt-5.6-terra": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
};

export const MODEL_LABEL_ALIASES = {
  "DeepSeek Chat": "DeepSeek V4.1 Flash",
  "DeepSeek Reasoner": "DeepSeek V4.1 Flash",
  "DeepSeek V4 Pro": "DeepSeek V4.1 Flash",
  "Claude Fable 5": "Claude Fable 5.1",
  "Claude Opus 5": "Claude Opus 5.5",
  "Claude Sonnet 5": "Claude Sonnet 5.5",
  "GPT-5.6 Sol": "GPT-6 Astra",
  "GPT-5.6 Terra": "GPT-6.1 Sol",
  "GPT-5.6 Luna": "GPT-6 Luna",
};

export function resolveModelId(id) {
  if (typeof id !== "string" || !id) return null;
  if (MODELS.some((m) => m.id === id)) return id;
  return MODEL_ID_ALIASES[id] || null;
}

export function findModelById(id) {
  const resolvedId = resolveModelId(id);
  return MODELS.find((m) => m.id === resolvedId) || null;
}

export function findModelIdByLabel(label) {
  if (typeof label !== "string" || !label) return null;
  const direct = MODELS.find((m) => m.label === label);
  if (direct) return direct.id;
  const canonicalLabel = MODEL_LABEL_ALIASES[label];
  return MODELS.find((m) => m.label === canonicalLabel)?.id || null;
}
