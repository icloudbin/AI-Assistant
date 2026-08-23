// background.js (root directory)
import { findModelById } from "./models.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-chat") return;

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "ASK") return;
    try {
      const { question, pageContext, history, modelId, provider, apiModel, thinking } = msg.payload;
      const storedModel = findModelById(modelId);

      // Resolve the model for THIS request. Never reuse a previous request's
      // provider/model or silently fall back to another provider.
      if (!storedModel || storedModel.id !== modelId) {
        throw new Error(`Unknown model selection: ${modelId || "(none)"}`);
      }

      const model = {
        ...storedModel,
        provider: provider || storedModel.provider,
        apiModel: apiModel || storedModel.apiModel,
        thinking: thinking ?? storedModel.thinking,
      };

      if (model.provider !== "gemini" && model.provider !== "deepseek" && model.provider !== "claude") {
        throw new Error(`Unsupported model provider: ${model.provider}`);
      }

      port.postMessage({ type: "START" });

      if (model.provider === "gemini") {
        await streamGemini(model, question, pageContext, history, port);
      } else if (model.provider === "deepseek") {
        await streamDeepSeek(model, question, pageContext, history, port);
      } else if (model.provider === "claude") {
        await streamClaude(model, question, pageContext, history, port);
      }

      port.postMessage({ type: "DONE" });
    } catch (err) {
      port.postMessage({ type: "ERROR", error: err?.message || String(err) });
    }
  });
});

async function streamDeepSeek(model, question, pageContext, history, port) {
  const { apiKey, customPrompt } = await chrome.storage.local.get(["apiKey", "customPrompt"]);
  if (!apiKey) throw new Error("DeepSeek API Key is not configured: open the Settings page to configure and save it");

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

  await readSse(resp, (json) => json.choices?.[0]?.delta?.content ?? "", port);
}

// Gemini uses a different host, auth header, request shape ({contents/parts}
// instead of {messages/content}, plus a single top-level system_instruction
// rather than a list of system messages), and response shape
// (candidates[0].content.parts instead of choices[0].delta), but the same
// alt=sse Server-Sent-Events streaming mechanics as DeepSeek - see
// https://ai.google.dev/gemini-api/docs/text-generation and
// https://ai.google.dev/gemini-api/docs/streaming (checked 2026-08-22).
async function streamGemini(model, question, pageContext, history, port) {
  const { geminiApiKey, customPrompt } = await chrome.storage.local.get(["geminiApiKey", "customPrompt"]);
  if (!geminiApiKey) throw new Error("Gemini API Key is not configured: open the Settings page to configure and save it");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.apiModel}:streamGenerateContent?alt=sse`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemInstruction(pageContext, customPrompt) }] },
      contents: buildGeminiContents(question, history),
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(resp, (json) => (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""), port);
}

// Claude uses api.anthropic.com, authenticated with x-api-key + an
// anthropic-version header (both required), plus
// anthropic-dangerous-direct-browser-access: true - without that header the
// request is blocked by CORS since this call is made directly from the
// extension's background service worker rather than through a server-side
// proxy or the Anthropic SDK - see
// https://platform.claude.com/docs/en/api/overview (checked 2026-08-23).
// Like Gemini, the system prompt is a single top-level field (`system`, a
// plain string here) rather than a message with role "system", so
// buildSystemInstruction is reused unchanged from the Gemini branch above.
// Unlike DeepSeek/Gemini, `max_tokens` is required by the Messages API.
// The SSE stream itself uses named events (message_start,
// content_block_start, content_block_delta, content_block_stop,
// message_delta, message_stop, plus periodic pings) instead of
// DeepSeek/Gemini's unnamed alt=sse chunks, but readSse only ever looks at
// "data:" lines regardless of the preceding "event:" line, so the same
// reader still applies; only content_block_delta events whose delta.type is
// "text_delta" carry answer text, everything else is ignored - see
// https://platform.claude.com/docs/en/build-with-claude/streaming (checked
// 2026-08-23).
async function streamClaude(model, question, pageContext, history, port) {
  const { claudeApiKey, customPrompt } = await chrome.storage.local.get(["claudeApiKey", "customPrompt"]);
  if (!claudeApiKey) throw new Error("Claude API Key is not configured: open the Settings page to configure and save it");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model.apiModel,
      max_tokens: 4096,
      system: buildSystemInstruction(pageContext, customPrompt),
      messages: buildClaudeMessages(question, history),
      stream: true,
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(
    resp,
    (json) => (json?.type === "content_block_delta" && json.delta?.type === "text_delta" ? json.delta.text || "" : ""),
    port
  );
}

// Shared SSE reader: DeepSeek, Gemini, and Claude all send "data: {...}\n\n"
// lines (Claude's are additionally preceded by a named "event:" line, which
// this reader ignores since it only inspects lines starting with "data:");
// only the JSON shape differs, so `extractDelta` picks the provider-specific
// text out of each parsed chunk.
async function readSse(resp, extractDelta, port) {
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
        const delta = extractDelta(json);
        if (delta) port.postMessage({ type: "CHUNK", delta });
      } catch {}
    }
  }
}

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

// Gemini has one system_instruction field rather than a list of system
// messages, so the base prompt, the user's custom prompt, and the page
// context are combined into a single instruction block instead. Claude's
// streamClaude() above reuses this same function for its own top-level
// `system` string field.
function buildSystemInstruction(pageContext, customPrompt) {
  const basePrompt = "You are an assistant running in the browser side panel. If web page context is provided, use it to answer.";
  let text = customPrompt ? `${basePrompt}\n\nUser-defined instructions:\n${customPrompt}` : basePrompt;
  if (pageContext) {
    text += `\n\nThe web page the user is viewing:\nTitle:${pageContext.title || ""}\nURL：${pageContext.url || ""}\nText excerpt:\n${(pageContext.text || "").slice(0, 6000)}`;
  }
  return text;
}

// Gemini turns use role "model" rather than "assistant", and each turn is
// {role, parts:[{text}]} rather than {role, content}.
function buildGeminiContents(question, history) {
  const contents = (history || []).map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }],
  }));
  contents.push({ role: "user", parts: [{ text: question }] });
  return contents;
}

// Claude's messages array takes {role, content} turns like DeepSeek, but
// only accepts "user"/"assistant" roles - unlike DeepSeek's buildMessages,
// no "system" role entries are mixed in here, since Claude rejects that
// role in the messages array (the system prompt goes through the top-level
// `system` field instead, via buildSystemInstruction above).
function buildClaudeMessages(question, history) {
  const messages = (history || [])
    .filter((h) => h.role === "user" || h.role === "assistant")
    .map((h) => ({ role: h.role, content: h.content }));
  messages.push({ role: "user", content: question });
  return messages;
}
