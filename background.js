// background.js (root directory)
import { findModelById } from "./models.js";
import { CURRENT_CONVERSATION_KEY, LANGUAGE_STORAGE_KEY, PENDING_CONTEXT_ACTION_KEY } from "./storage-keys.js";
import { getStoredLanguage, t } from "./i18n.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);

// ---------- Webpage selection context menu ----------
// Keep exactly one top-level context-menu item. There is deliberately no
// parent menu and no other AI Assistant context-menu actions.
const CONTEXT_MENU_TRANSLATE_ID = "ai-action-translate";

function removeAllContextMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function createTranslateContextMenu() {
  // The title follows the display language chosen on the Settings page
  // ("AI assistant-" prefix + localized action), resolved at creation time -
  // rebuildContextMenus() is re-run at install/startup AND whenever that
  // stored language changes (storage.onChanged listener below), so the menu
  // re-translates live without a browser restart.
  return getStoredLanguage().then((lang) =>
    new Promise((resolve, reject) => {
      chrome.contextMenus.create(
        { id: CONTEXT_MENU_TRANSLATE_ID, title: `AI assistant-${t(lang, "contextMenu_translateSelected")}`, contexts: ["selection"] },
        () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        }
      );
    })
  );
}

let contextMenuRebuild = Promise.resolve();

function rebuildContextMenus() {
  contextMenuRebuild = contextMenuRebuild
    .catch(() => {})
    .then(async () => {
      // Remove every existing context-menu item first. This also removes
      // legacy nested menus left behind by previous extension versions.
      await removeAllContextMenus();
      await createTranslateContextMenu();
    });
  return contextMenuRebuild;
}

rebuildContextMenus().catch((err) => console.warn("[AI Assistant] context menu rebuild failed", err));
chrome.runtime.onInstalled.addListener(() => rebuildContextMenus().catch((err) => console.warn("[AI Assistant] context menu rebuild failed", err)));
chrome.runtime.onStartup.addListener(() => rebuildContextMenus().catch((err) => console.warn("[AI Assistant] context menu rebuild failed", err)));
// Live re-translate the menu when the display language is changed on the
// Settings page (same chrome.storage.onChanged sync pattern the side panel
// uses for language changes - see the header comment in i18n.js).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[LANGUAGE_STORAGE_KEY]) {
    rebuildContextMenus().catch((err) => console.warn("[AI Assistant] context menu rebuild failed", err));
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_TRANSLATE_ID || !info.selectionText?.trim() || !tab?.id) return;

  const pending = {
    action: "translate",
    text: info.selectionText.trim(),
    tabId: tab.id,
    windowId: tab.windowId,
    url: String(tab.url || ""),
    createdAt: Date.now(),
  };

  // Must be called directly from the context-menu click before any await.
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
    console.warn("[AI Assistant] Unable to open side panel from context menu:", err);
  });

  chrome.storage.local.set({ [PENDING_CONTEXT_ACTION_KEY]: pending }).catch((err) => {
    console.warn("[AI Assistant] Unable to store context action:", err);
  });

  setTimeout(() => {
    chrome.runtime.sendMessage({ type: "CONTEXT_ACTION", pending }).catch(() => {});
  }, 200);
});


// Remote images embedded in model Markdown can be rejected when loaded directly
// from an extension page (for example, because the image host applies hotlink
// or referrer rules). Fetch them from the extension service worker, which has
// <all_urls> host permission, and return a data URL for the side panel.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "FETCH_IMAGE" || typeof msg.url !== "string") return;

  (async () => {
    try {
      const url = new URL(msg.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported image URL');

      const resp = await fetch(url.href, {
        method: 'GET',
        credentials: 'omit',
        cache: 'force-cache',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const contentType = (resp.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
      if (!/^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(contentType)) {
        throw new Error(`Not an image (${contentType || 'unknown content type'})`);
      }

      const buffer = await resp.arrayBuffer();
      // Avoid sending unexpectedly large resources through extension messaging.
      if (buffer.byteLength > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB');

      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      sendResponse({ ok: true, dataUrl: `data:${contentType};base64,${btoa(binary)}` });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-chat") return;

  // Per-connection in-flight-request state (fresh for each side panel
  // session/reconnect, since these are declared inside this listener's
  // closure). At most one request is ever active at a time - the side
  // panel's own UI disables the composer while streaming - but a STOP can
  // legitimately race a fresh ASK sent immediately after (e.g. the user
  // clicks "Clear" to escape a hung request, then immediately asks a new
  // question), so both the abort controller AND the request id it belongs
  // to are tracked together and only ever overwritten as a pair.
  let activeRequestId = null;
  let activeAbortController = null;

  // sidepanel.js opens this port once per document lifetime (connectPort(),
  // called from its init()) and never itself calls port.disconnect(), so on
  // this (background) side, onDisconnect firing means the side panel's page
  // was actually torn down - either the user closed the panel (Chrome does
  // not expose a dedicated close event; a dropped long-lived port is the
  // documented way extensions detect it - see
  // https://developer.chrome.com/docs/extensions/reference/api/sidePanel
  // and the related community pattern at
  // https://github.com/GoogleChrome/chrome-extensions-samples/issues/998),
  // or this service worker itself restarted (normal MV3 behavior after ~30s
  // idle) and dropped every port it held. Either way, clearing the
  // "current conversation" pointer here is safe: if the panel is still
  // genuinely open with an active conversation, sidepanel.js's own
  // saveConversations() rewrites this same key on the very next message
  // send, so a spurious clear from a service-worker restart self-heals
  // without losing anything. This is a second, independent layer behind
  // sidepanel.js's own init() (which already resets to a blank New Topic on
  // every fresh load) - if the panel's document is somehow reused instead
  // of freshly reloaded on close/reopen, this still guarantees the pointer
  // it would restore from is already empty. Also abort whatever request is
  // still in flight, so a closed/reloaded panel doesn't leave a fetch
  // running for no listener.
  port.onDisconnect.addListener(() => {
    chrome.storage.local.set({ [CURRENT_CONVERSATION_KEY]: "" }).catch(() => {});
    activeAbortController?.abort();
  });

  port.onMessage.addListener(async (msg) => {
    // STOP: sent when the user escapes a hung/unwanted request via "Clear"
    // or by picking a conversation (including "New Topic") from the history
    // dropdown while a request is still in flight - see stopActiveRequest()
    // in sidepanel.js. Aborting the controller propagates to whichever
    // fetch()/reader.read() is currently pending in the matching streamXxx
    // call below, which rejects with a DOMException named "AbortError" that
    // the catch block downstream recognizes and does NOT report as an
    // error (the user asked for this, it isn't a failure).
    if (msg?.type === "STOP") {
      if (msg.requestId === activeRequestId) activeAbortController?.abort();
      return;
    }
    if (msg?.type !== "ASK") return;

    const requestId = msg.payload?.requestId ?? null;
    const abortController = new AbortController();
    activeRequestId = requestId;
    activeAbortController = abortController;

    try {
      const { question, pageContext, includePageContext, history, images = [], modelId, provider, apiModel, thinking, factCheck } = msg.payload;
      const lang = await getStoredLanguage();
      // Never trust a stale/accidental pageContext value when the user has
      // disabled "Read current page". This is the final privacy boundary
      // before any provider request is constructed - independent of, and
      // unaffected by, any attached images (see normalizedImages below),
      // which are sent whenever present regardless of this toggle.
      const requestPageContext = includePageContext === true ? pageContext : null;
      const storedModel = findModelById(modelId);

      // Resolve the model for THIS request. Never reuse a previous request's
      // provider/model or silently fall back to another provider.
      if (!storedModel || storedModel.id !== modelId) {
        throw new Error(t(lang, "bg_error_unknownModel_template", { model: modelId || "(none)" }));
      }

      const model = {
        ...storedModel,
        provider: provider || storedModel.provider,
        apiModel: apiModel || storedModel.apiModel,
        thinking: thinking ?? storedModel.thinking,
      };

      if (
        model.provider !== "gemini" &&
        model.provider !== "deepseek" &&
        model.provider !== "claude" &&
        model.provider !== "openai" &&
        model.provider !== "openrouter"
      ) {
        throw new Error(t(lang, "bg_error_unsupportedProvider_template", { provider: model.provider }));
      }

      port.postMessage({ type: "START", requestId });

      const ctx = { port, requestId, signal: abortController.signal, lang };
      const normalizedImages = Array.isArray(images) ? images.filter((img) => img && typeof img.dataUrl === "string" && /^data:image\/(jpeg|png|gif|webp);base64,/i.test(img.dataUrl)) : [];
      if (normalizedImages.length !== (Array.isArray(images) ? images.length : 0)) throw new Error(t(lang, "bg_error_imagesEncoding"));

      let effectiveQuestion = question;
      if (factCheck?.enabled) {
        const research = await runTavilyFactCheckResearch({
          question,
          pageContext: requestPageContext,
          ctx,
          selectedText: factCheck.selectedText || "",
        });
        effectiveQuestion = research.prompt;
      }

      if (model.provider === "gemini") {
        await streamGemini(model, effectiveQuestion, requestPageContext, history, normalizedImages, ctx);
      } else if (model.provider === "deepseek") {
        await streamDeepSeek(model, effectiveQuestion, requestPageContext, history, normalizedImages, ctx);
      } else if (model.provider === "claude") {
        await streamClaude(model, effectiveQuestion, requestPageContext, history, normalizedImages, ctx);
      } else if (model.provider === "openai") {
        await streamOpenAI(model, effectiveQuestion, requestPageContext, history, normalizedImages, ctx);
      } else if (model.provider === "openrouter") {
        await streamOpenRouter(model, effectiveQuestion, requestPageContext, history, normalizedImages, ctx);
      }

      port.postMessage({ type: "DONE", requestId });
    } catch (err) {
      // A deliberate STOP surfaces here as an AbortError (either from the
      // fetch() call itself being aborted, or from the stream reader's
      // pending read() rejecting once the same signal fires) - this is the
      // user cancelling on purpose, not a failure, so nothing is reported
      // back for it. sidepanel.js already reset its own UI state the moment
      // it sent STOP, without waiting for background.js to confirm.
      if (err?.name === "AbortError") return;
      port.postMessage({ type: "ERROR", error: err?.message || String(err), requestId });
    } finally {
      if (activeRequestId === requestId) {
        activeRequestId = null;
        activeAbortController = null;
      }
    }
  });
});


// ---------- Tavily web research for Fact Check ----------
const FACT_CHECK_MAX_CLAIMS = 5;
const FACT_CHECK_RESULTS_PER_CLAIM = 4;
const FACT_CHECK_MAX_EVIDENCE_CHARS = 18000;

// Human-readable names for the display languages offered in Settings
// (i18n.js SUPPORTED_LANGUAGES). Used by outputLanguageInstruction() to tell
// the model which language its answer must be written in, and by the Fact
// Check prompt for the same purpose.
const OUTPUT_LANGUAGE_NAMES = {
  "en": "English",
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  "fr": "French (Français)",
  "ja": "Japanese (日本語)",
  "es": "Spanish (Español)",
};

function outputLanguageName(lang) {
  return OUTPUT_LANGUAGE_NAMES[lang] || OUTPUT_LANGUAGE_NAMES.en;
}

function factCheckOutputLanguage(lang) {
  return outputLanguageName(lang);
}

// Sent with EVERY request (all five providers), not just Fact Check: the
// answer language must follow the display language chosen in Settings.
// Previously only Fact Check carried an explicit output-language
// requirement, so with e.g. a Japanese UI a quick action - whose API prompt
// was hard-coded to the English string, with (usually English) page context
// on top - came back in English or the page's language instead of Japanese.
// Quoting verbatim page content and code stays in its original language;
// only the assistant's own prose is constrained, and an explicit translate
// request always wins for the translated text itself.
function outputLanguageInstruction(lang) {
  return `OUTPUT LANGUAGE REQUIREMENT: Respond entirely in ${outputLanguageName(lang)}, the display language the user selected in this extension's settings. This applies to all of your own prose - explanations, summaries, verdicts, and list or table content. Keep source URLs, code, file paths, identifiers, and verbatim quotes in their original language. Do not switch to the language of the webpage, of earlier conversation turns, or of the question itself. The only exception: when the request explicitly asks for a translation into a specific language, the translated text itself must be in that requested target language.`;
}

function factCheckLanguageInstruction(lang) {
  return `OUTPUT LANGUAGE REQUIREMENT: Respond entirely in ${factCheckOutputLanguage(lang)}. This applies to the claim text, verdict labels, explanations, overall assessment, and source descriptions. Do not switch to the language used by the webpage or sources. Keep source URLs unchanged.`;
}

function cleanResearchText(value, max = 800) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function candidateFactClaims(text, title = "") {
  const sentences = String(text || "")
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => cleanResearchText(s, 700))
    .filter((s) => s.length >= 35);

  const scored = sentences.map((s, index) => {
    let score = 0;
    if (/\b(19|20)\d{2}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(s)) score += 4;
    if (/\d/.test(s)) score += 3;
    if (/%|\bpercent\b|\bmillion\b|\bbillion\b|\bthousand\b/i.test(s)) score += 2;
    if (/\b(according to|reported|announced|said|confirmed|found|study|research|data|official)\b/i.test(s)) score += 2;
    if (/[“”"']/.test(s)) score += 1;
    score += Math.max(0, 1 - index / 80);
    return { text: s, score };
  });

  const claims = [];
  if (title && title.length >= 15) claims.push(cleanResearchText(title, 500));
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    if (claims.some((c) => c.toLowerCase() === item.text.toLowerCase())) continue;
    claims.push(item.text);
    if (claims.length >= FACT_CHECK_MAX_CLAIMS) break;
  }
  return claims;
}

async function tavilySearch(query, apiKey, signal, topic = "news") {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: cleanResearchText(query, 900),
      topic,
      search_depth: "basic",
      max_results: FACT_CHECK_RESULTS_PER_CLAIM,
      include_answer: false,
      include_raw_content: false,
    }),
    signal,
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Tavily HTTP ${resp.status}: ${detail.slice(0, 500)}`);
  }
  return resp.json();
}

async function runTavilyFactCheckResearch({ question, pageContext, ctx, selectedText = "" }) {
  const stored = await chrome.storage.local.get(["tavilyApiKey", "factCheckWebResearch"]);
  if (stored.factCheckWebResearch !== true) {
    return {
      prompt: `${question}\n\n${factCheckLanguageInstruction(ctx.lang)}\nIMPORTANT: Online web research is disabled in Settings. Do not claim that you verified this against current web sources. Clearly distinguish your own knowledge from verification.`,
    };
  }
  const apiKey = String(stored.tavilyApiKey || "").trim();
  if (!apiKey) throw new Error(t(ctx.lang, "bg_error_tavilyKeyMissing"));

  const sourceText = selectedText || pageContext?.text || "";
  const title = selectedText ? "" : (pageContext?.title || "");
  const claims = selectedText && cleanResearchText(selectedText, 900).length >= 15
    ? [cleanResearchText(selectedText, 900)]
    : candidateFactClaims(sourceText, title);
  if (!claims.length) throw new Error(t(ctx.lang, "bg_error_factCheckNoClaims"));

  const topic = selectedText ? "general" : "news";
  const settled = await Promise.allSettled(
    claims.map((claim) => tavilySearch(claim, apiKey, ctx.signal, topic))
  );
  const evidence = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status !== "fulfilled") {
      if (result.reason?.name === "AbortError") throw result.reason;
      continue;
    }
    for (const item of result.value?.results || []) {
      const titleText = cleanResearchText(item.title, 220);
      const content = cleanResearchText(item.content, 1000);
      const url = String(item.url || "").trim();
      if (!url || (!titleText && !content)) continue;
      evidence.push({
        claim: claims[i],
        title: titleText,
        url,
        content,
        published: item.published_date || item.publishedDate || "",
        score: Number(item.score || 0),
      });
    }
  }

  const byUrl = new Map();
  for (const item of evidence) {
    const old = byUrl.get(item.url);
    if (!old || item.score > old.score) byUrl.set(item.url, item);
  }
  const deduped = [...byUrl.values()].sort((a, b) => b.score - a.score);
  if (!deduped.length) throw new Error(t(ctx.lang, "bg_error_factCheckNoResults"));

  let evidenceText = "";
  for (const item of deduped) {
    const block =
      `CLAIM: ${item.claim}\nSOURCE: ${item.title || item.url}\n` +
      `PUBLISHED: ${item.published || "unknown"}\nURL: ${item.url}\n` +
      `EVIDENCE: ${item.content}\n\n`;
    if (evidenceText.length + block.length > FACT_CHECK_MAX_EVIDENCE_CHARS) break;
    evidenceText += block;
  }

  return {
    prompt: `${question}

You are performing a web-grounded fact check. Fresh web evidence is supplied below by Tavily.

${factCheckLanguageInstruction(ctx.lang)}

Rules:
1. Evaluate the claims using the supplied evidence, not pretraining knowledge, for time-sensitive facts.
2. Do not treat a search-result snippet as proof by itself. Compare multiple independent sources when available.
3. Prefer primary/official sources and reputable journalism over low-quality aggregators.
4. Pay attention to publication dates and whether a source supports the exact claim.
5. If evidence conflicts or is insufficient, say "Unverified" or "Conflicting evidence" rather than guessing.
6. Never invent a source, URL, publication date, quote, or fact.
7. For each important claim, give: Claim, Verdict (Confirmed / Partially supported / Misleading / False / Unverified), Explanation, and Sources.
8. End with a short overall assessment of the article/selected text.
9. Keep source URLs as plain URLs.
10. The output language requirement above is mandatory even when the evidence or original claim is written in another language.

TAVILY WEB EVIDENCE:
${evidenceText}`,
  };
}

async function streamDeepSeek(model, question, pageContext, history, images, ctx) {
  const { apiKey, customPrompt } = await chrome.storage.local.get(["apiKey", "customPrompt"]);
  if (!apiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "DeepSeek" }));

  // Image requests swap in the entry's vision-capable model (the regular
  // deepseek-v4-* chat models reject image inputs); the user's chosen
  // apiModel is kept for text-only requests, and the `thinking` flag is
  // only sent alongside apiModel - the vision-exp endpoint does not take
  // it. See the `visionModel` note in models.js.
  const useVision = images.length > 0 && !!model.visionModel;
  const requestModel = useVision ? model.visionModel : model.apiModel;
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: requestModel,
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang),
      stream: true,
      ...(useVision || !model.thinking ? {} : { thinking: { type: model.thinking } }),
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(resp, (json) => json.choices?.[0]?.delta?.content ?? "", ctx);
}

// OpenRouter (https://openrouter.ai) is a third-party router, not a model's
// own native API. The extension uses OpenRouter's Free Models Router via
// `openrouter/free`, which automatically selects an available free model.
// The endpoint is OpenAI-Chat-Completions-compatible, so the request shape
// and SSE response handling below stay unchanged.
async function streamOpenRouter(model, question, pageContext, history, images, ctx) {
  const { openrouterApiKey, customPrompt } = await chrome.storage.local.get(["openrouterApiKey", "customPrompt"]);
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
      messages: buildMessages(question, pageContext, history, customPrompt, images, ctx.lang),
      stream: true,
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(resp, (json) => json.choices?.[0]?.delta?.content ?? "", ctx);
}

// Gemini uses a different host, auth header, request shape ({contents/parts}
// instead of {messages/content}, plus a single top-level system_instruction
// rather than a list of system messages), and response shape
// (candidates[0].content.parts instead of choices[0].delta), but the same
// alt=sse Server-Sent-Events streaming mechanics as DeepSeek - see
// https://ai.google.dev/gemini-api/docs/text-generation and
// https://ai.google.dev/gemini-api/docs/streaming (checked 2026-08-22).
async function streamGemini(model, question, pageContext, history, images, ctx) {
  const { geminiApiKey, customPrompt } = await chrome.storage.local.get(["geminiApiKey", "customPrompt"]);
  if (!geminiApiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "Gemini" }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.apiModel}:streamGenerateContent?alt=sse`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemInstruction(pageContext, customPrompt) }] },
      contents: buildGeminiContents(question, history, images),
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(resp, (json) => (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""), ctx);
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
// 8192 is requested because adaptive-thinking models draw from the same
// output budget and 4096 could be consumed entirely by thinking, leaving no
// visible answer.
// The SSE stream itself uses named events (message_start,
// content_block_start, content_block_delta, content_block_stop,
// message_delta, message_stop, plus periodic pings) instead of
// DeepSeek/Gemini's unnamed alt=sse chunks, but readSse only ever looks at
// "data:" lines regardless of the preceding "event:" line, so the same
// reader still applies; only content_block_delta events whose delta.type is
// "text_delta" carry answer text, everything else is ignored - see
// https://platform.claude.com/docs/en/build-with-claude/streaming (checked
// 2026-08-23).
async function streamClaude(model, question, pageContext, history, images, ctx) {
  const { claudeApiKey, customPrompt } = await chrome.storage.local.get(["claudeApiKey", "customPrompt"]);
  if (!claudeApiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "Claude" }));

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
      max_tokens: 8192,
      system: buildSystemInstruction(pageContext, customPrompt),
      messages: buildClaudeMessages(question, history, images),
      stream: true,
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(
    resp,
    (json) => (json?.type === "content_block_delta" && json.delta?.type === "text_delta" ? json.delta.text || "" : ""),
    ctx
  );
}

// OpenAI's current recommended endpoint is the Responses API
// (https://api.openai.com/v1/responses), not the older
// /v1/chat/completions - see
// https://platform.openai.com/docs/guides/migrate-to-responses (checked
// 2026-08-24). Like Claude/Gemini, the system prompt is a single top-level
// field (`instructions`, a plain string) rather than a message with role
// "system" - unlike Claude, OpenAI's `input` array does technically also
// accept a "system"/"developer" role turn, but `instructions` is used here
// to stay consistent with how the other three providers are wired, reusing
// the same buildSystemInstruction helper. `store: false` is set because
// this extension is stateless per request (it always resends the full
// history itself, like the other three providers) and never uses OpenAI's
// previous_response_id continuation feature, so there's no reason for
// OpenAI to retain the response server-side by default.
//
// CORS CAVEAT: multiple OpenAI community threads confirm api.openai.com
// does not return CORS-permissive headers for a plain webpage origin, and
// OpenAI's own guidance is to proxy through a backend rather than call the
// API directly from client-side code. That guidance is written for
// ordinary web pages; a Chrome/Brave extension's background service worker
// with host_permissions (this extension already has "<all_urls>") is a
// different, more privileged fetch() context that is not normally subject
// to the same CORS enforcement - which is exactly what already lets this
// same file call api.deepseek.com, generativelanguage.googleapis.com, and
// api.anthropic.com directly. This could not be verified against a live
// api.openai.com endpoint from the sandbox this was written in (network
// access there is allow-listed to a small set of domains that doesn't
// include it), so it needs a real test with a live key; unlike Claude,
// OpenAI does not document an equivalent explicit opt-in header to add if
// a direct request does turn out to be blocked.
async function streamOpenAI(model, question, pageContext, history, images, ctx) {
  const { openaiApiKey, customPrompt } = await chrome.storage.local.get(["openaiApiKey", "customPrompt"]);
  if (!openaiApiKey) throw new Error(t(ctx.lang, "bg_error_apiKeyMissing_template", { provider: "ChatGPT" }));

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: model.apiModel,
      instructions: buildSystemInstruction(pageContext, customPrompt),
      input: buildOpenAIInput(question, history, images),
      store: false,
      stream: true,
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

  await readSse(resp, (json) => (json?.type === "response.output_text.delta" ? json.delta || "" : ""), ctx);
}

// Shared SSE reader: DeepSeek, Gemini, Claude, OpenAI, and OpenRouter all
// send
// "data: {...}\n\n"
// lines (Claude's are additionally preceded by a named "event:" line, which
// this reader ignores since it only inspects lines starting with "data:");
// only the JSON shape differs, so `extractDelta` picks the provider-specific
// text out of each parsed chunk. `ctx` (added alongside the STOP/abort
// mechanism) carries the port to post CHUNKs to and the requestId to tag
// them with, so sidepanel.js can tell a chunk belonging to a since-aborted
// request apart from the current one if any are still in flight when a STOP
// lands (see stopActiveRequest() in sidepanel.js) - reader.read() itself
// also naturally rejects once ctx.signal aborts, ending this loop via the
// same AbortError path the initial fetch() would take.
async function readSse(resp, extractDelta, ctx) {
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
        if (delta) ctx.port.postMessage({ type: "CHUNK", delta, requestId: ctx.requestId });
      } catch {}
    }
  }
}

// Shared base prompt, kept provider-agnostic and toggle-agnostic. Previously
// this string (plus the whole CURRENT PAGE CONTEXT template below) was
// hand-duplicated inside both buildMessages() and buildSystemInstruction(),
// which risked the two drifting apart on a future edit; both now read from
// this single copy via pageContextInstruction().
const BASE_PROMPT = "You are an assistant running in the browser side panel.";

// Returns this request's page-context instruction, for either providers with
// a message-list system role (buildMessages) or a single system string
// (buildSystemInstruction). Unconditional - always returns something, rather
// than only when pageContext is present - because the OFF case needs its own
// explicit, per-request instruction just as much as the ON case does: with no
// pageContext this call, the model otherwise gets no explicit signal that
// "Read current page" was off *this time*, and could fall back to an earlier
// turn's page context still visible in `history`, or ask the user which page
// they mean. Both branches are placed immediately before the user's question
// (see call sites below) so this is the freshest, most explicit thing the
// model reads before answering - never something for it to infer from mere
// absence. This instruction is only about webpage content: it deliberately
// says nothing about attached images/files, which are a separate mechanism
// (see the `images` parameter in buildMessages() and streamXxx() in this
// file) and should be used normally regardless of this toggle's state.
// A third state exists when the side panel requested the page but capture
// FAILED: pageContext then arrives as a {captureFailed:true} sentinel with
// no text, and the first branch below instructs the model to say so instead
// of falling back to the previous article still visible in the history.
function pageContextInstruction(pageContext) {
  if (pageContext?.captureFailed) {
    return `CURRENT PAGE CONTEXT: REQUESTED BUT UNAVAILABLE. The user asked for this request to use the current webpage, but its content could not be captured (the page may still be loading, or it may not be a regular readable web page). Do NOT translate, summarize, explain, or otherwise reuse any article, webpage, or page content that appeared earlier in this conversation - it is not the current page, and using it would give the user output about the wrong page. Briefly tell the user that the current page could not be read yet, and ask them to wait for the page to finish loading and try again.`;
  }
  if (pageContext) {
    let text = `CURRENT PAGE CONTEXT (authoritative; captured at request time):\nTab ID:${pageContext.tabId ?? ""}\nTitle:${pageContext.title || ""}\nURL:${pageContext.url || ""}\nPage text:\n${(pageContext.text || "").slice(0, 20000)}\n\nFor this request, "Read current page" is ON: use this context for any request about the current page, and ignore page content from a previous tab, a previous page, or an earlier turn in this conversation.`;
    // sidepanel.js only sets this when it has detected an actual change (the
    // URL differs from the page used for the last message in this
    // conversation) - so this note is never added for a same-page follow-up.
    if (pageContext.previousPage) {
      text += ` Note: earlier in this conversation you were shown a different page ("${pageContext.previousPage.title || pageContext.previousPage.url}"). The page above is not that page - the user has switched tabs or navigated. Do not reuse, repeat, or extend your earlier answer; answer this request fresh, based only on the current page content above.`;
    }
    return text;
  }
  return `For this request, "Read current page" is OFF: treat this question as fully independent of any webpage and answer using your own general knowledge only. Do not use, reference, or assume any page content - including anything about a page discussed earlier in this conversation - and do not ask the user which page they mean. This has nothing to do with any attached image or file, which you should still use normally if one is present with this request.`;
}

// Follow-up requests re-send this extension's stored conversation history
// verbatim, and text/ZIP attachments ride inside their user message as an
// [ATTACHMENTS]...[/ATTACHMENTS] block of up to 180,000 characters
// (MAX_TOTAL_EXTRACTED_CHARS in sidepanel.js). Left untouched, one large
// upload would be re-sent with every later turn of the same conversation -
// up to ~16 times. Attachments in the CURRENT request stay untouched (they
// are passed as `question`); only HISTORY turns get each such block
// condensed to a bounded preview plus an explicit note: enough for most
// follow-up questions about an earlier file, while saying clearly that the
// full text was only provided when the message was first sent. Blocks are
// re-condensed from the stored original on every request, so the cut never
// compounds.
const ATTACHMENTS_BLOCK_RE = /\[ATTACHMENTS\][\s\S]*?\[\/ATTACHMENTS\]/gi;
const HISTORY_ATTACHMENT_PREVIEW_CHARS = 4000;

function condenseHistoryAttachments(text) {
  return String(text || "").replace(ATTACHMENTS_BLOCK_RE, (block) => {
    if (block.length <= HISTORY_ATTACHMENT_PREVIEW_CHARS) return block;
    const head = block.slice(0, HISTORY_ATTACHMENT_PREVIEW_CHARS).trimEnd();
    return `${head}\n...[attachment contents truncated to stay within the context budget - the full text was provided when this message was first sent; ask the user to re-attach the file if this excerpt is not enough]\n[/ATTACHMENTS]`;
  });
}

// Normalizes conversation history for providers that require strict
// user/assistant alternation. Claude's Messages API rejects adjacent
// same-role turns outright, and Gemini's contents have the same expectation.
// Adjacent same-role messages can genuinely occur in this extension: when a
// request fails or is stopped, the user's question stays in history with no
// assistant reply after it, so the next submission would send [..., user,
// user]. Such runs are merged into a single turn, and a leading assistant
// turn (which Claude also rejects, and which the MAX_HISTORY_TURNS window
// slice in sidepanel.js can leave behind when it cuts into a conversation
// mid-exchange) is dropped. Providers that don't require alternation
// (OpenAI-style message lists) receive the same normalized history for
// consistency.
function normalizeHistoryTurns(history) {
  const out = [];
  for (const h of history || []) {
    if (!h || (h.role !== "user" && h.role !== "assistant") || typeof h.content !== "string") continue;
    const content = h.role === "user" ? condenseHistoryAttachments(h.content) : h.content;
    const prev = out[out.length - 1];
    if (prev && prev.role === h.role) {
      prev.content = `${prev.content}\n\n${content}`;
    } else {
      out.push({ role: h.role, content });
    }
  }
  while (out.length && out[0].role === "assistant") out.shift();
  return out;
}

function buildMessages(question, pageContext, history, customPrompt, images = [], lang) {
  const messages = [
    {
      role: "system",
      content: `${customPrompt ? `${BASE_PROMPT}\n\nUser-defined instructions:\n${customPrompt}` : BASE_PROMPT}\n\n${outputLanguageInstruction(lang)}`,
    },
  ];
  for (const h of normalizeHistoryTurns(history)) messages.push({ role: h.role, content: h.content });
  // Put this request's page-context instruction (ON or OFF) immediately
  // before the current user request, while history remains available for
  // conversational continuity. Older page information must never be treated
  // as current - see pageContextInstruction() above.
  messages.push({ role: "system", content: pageContextInstruction(pageContext) });
  const content = [{ type: "text", text: question }];
  for (const img of images) content.push({ type: "image_url", image_url: { url: img.dataUrl, detail: "auto" } });
  messages.push({ role: "user", content: images.length ? content : question });
  return messages;
}

// Gemini has one system_instruction field rather than a list of system
// messages, so the base prompt, the user's custom prompt, the output-language
// requirement, and the page-context instruction are combined into a single
// instruction block instead. Claude's streamClaude() and OpenAI's
// streamOpenAI() above reuse this same function for their own top-level
// `system`/`instructions` string fields.
function buildSystemInstruction(pageContext, customPrompt, lang) {
  const text = customPrompt ? `${BASE_PROMPT}\n\nUser-defined instructions:\n${customPrompt}` : BASE_PROMPT;
  return `${text}\n\n${outputLanguageInstruction(lang)}\n\n${pageContextInstruction(pageContext)}`;
}

function buildGeminiContents(question, history, images = []) {
  const contents = normalizeHistoryTurns(history).map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] }));
  const parts = [{ text: question }];
  for (const img of images) {
    const match = img.dataUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/i);
    if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
  }
  contents.push({ role: "user", parts });
  return contents;
}

function buildClaudeMessages(question, history, images = []) {
  const messages = normalizeHistoryTurns(history).map((h) => ({ role: h.role, content: h.content }));
  const content = [{ type: "text", text: question }];
  for (const img of images) {
    const match = img.dataUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/i);
    if (match) content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
  }
  messages.push({ role: "user", content });
  return messages;
}

function buildOpenAIInput(question, history, images = []) {
  const input = normalizeHistoryTurns(history).map((h) => ({ role: h.role, content: h.content }));
  const content = [{ type: "input_text", text: question }];
  for (const img of images) content.push({ type: "input_image", image_url: img.dataUrl, detail: "auto" });
  input.push({ role: "user", content });
  return input;
}
