// models.js（root directory）
export const MODELS = [
  { id: "deepseek-chat", label: "DeepSeek Chat" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
];

export function findModelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}