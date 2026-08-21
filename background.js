// background.js (root directory)
import { findModelById } from "./models.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "deepseek-chat") return;

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "ASK") return;
    try {
      const { question, pageContext, history, modelId } = msg.payload;
      const { apiKey, customPrompt } = await chrome.storage.local.get(["apiKey", "customPrompt"]);
      if (!apiKey) throw new Error("API Key is not configured: open the Settings page to configure and save it");

      const model = findModelById(modelId);
      port.postMessage({ type: "START" });

      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.apiModel,
          messages: buildMessages(question, pageContext, history, customPrompt),
          stream: true,
          thinking: { type: model.thinking },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content ?? "";
            if (delta) port.postMessage({ type: "CHUNK", delta });
          } catch {}
        }
      }
      port.postMessage({ type: "DONE" });
    } catch (err) {
      port.postMessage({ type: "ERROR", error: err?.message || String(err) });
    }
  });
});

function buildMessages(question, pageContext, history, customPrompt) {
  const basePrompt = "You are an assistant running in the browser side panel. If web page context is provided, use it to answer.";
  const messages = [
    { role: "system", content: customPrompt ? `${basePrompt}\n\nUser-defined instructions:\n${customPrompt}` : basePrompt },
  ];
  if (pageContext) {
    messages.push({
      role: "system",
      content: `The web page the user is viewing:\nTitle:${pageContext.title || ""}\nURL：${pageContext.url || ""}\nText excerpt:\n${(pageContext.text || "").slice(0, 6000)}`,
    });
  }
  for (const h of history || []) messages.push({ role: h.role, content: h.content });
  messages.push({ role: "user", content: question });
  return messages;
}