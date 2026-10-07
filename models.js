// AI model catalog for AI Assistant.
export const MODELS = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", provider: "deepseek", apiModel: "deepseek-flash", thinking: "enabled" },
  { id: "openrouter-free-auto", label: "OpenRouter: Free Model (Auto)", provider: "openrouter", apiModel: "openrouter/free" },
  { id: "groq-gpt-oss-120b", label: "Groq: GPT-OSS 120B", provider: "groq", apiModel: "openai/gpt-oss-120b" },
  { id: "groq-qwen3.8-27b", label: "Groq: Qwen 3.8 27B", provider: "groq", apiModel: "qwen/qwen3.8-27b" },
  { id: "groq-gpt-oss-20b", label: "Groq: GPT-OSS 20B", provider: "groq", apiModel: "openai/gpt-oss-20b" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini", apiModel: "gemini-3.8-flash" },
];

export function findModelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}
