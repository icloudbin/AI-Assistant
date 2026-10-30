// background.js (root directory)
import { findKnownModel, DEFAULT_MAX_PAGE_CHARS, MAX_PAGE_CONTEXT_CHARS, cutAtCodePointBoundary } from "./models.js";
import { AUTO_WEB_RESEARCH_KEY, CURRENT_CONVERSATION_KEY, LANGUAGE_STORAGE_KEY, PENDING_CONTEXT_ACTION_KEY } from "./storage-keys.js";
import { getStoredLanguage, t } from "./i18n.js";
import { restoreSettingsFromBackupOnce } from "./settings-storage.js";
import { withNamedLock, CONTEXT_ACTION_LOCK } from "./conversation-store.js";
import { checkImageUrl } from "./url-safety.js";
import { redactOutbound, createRedactionSession, PlaceholderRestorer, PII_FILTER_STORAGE_KEY } from "./privacy/pii-filter.js";
import { prepareLineTranslation, numberedBatches, LineTranslator } from "./translate-lines.js";
import { chooseTranslationSelection } from "./translation-selection.js";
import { streamDeepSeek, streamGroq, streamOpenRouter } from "./providers/openai-compatible.js";
import { factCheckLanguageInstruction } from "./providers/messages.js";

// Restore settings as soon as the service worker starts, before any request
// arrives. restoreSettingsFromBackupOnce() memoizes the run for this service
// worker instance, so the per-request safety-net call below is free after
// the first (each fresh worker instance checks recovery exactly once).
void restoreSettingsFromBackupOnce();

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
  // The title follows the display language chosen on the Settings page -
  // including the "AI assistant" prefix itself, which used to be a
  // hard-coded English string in front of an otherwise localized action.
  // Resolved at creation time - rebuildContextMenus() is re-run at
  // install/startup AND whenever that stored language changes
  // (storage.onChanged listener below), so the menu re-translates live
  // without a browser restart.
  return getStoredLanguage().then((lang) =>
    new Promise((resolve, reject) => {
      chrome.contextMenus.create(
        { id: CONTEXT_MENU_TRANSLATE_ID, title: t(lang, "contextMenu_title_template", { action: t(lang, "contextMenu_translateSelected") }), contexts: ["selection"] },
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

// Reads the selection as Markdown (headings, lists, tables, links, bold) from
// the frame the user right-clicked in. Resolves to null when unavailable.
async function readSelectionMarkdown(tabId, frameId) {
  try {
    const target = { tabId, frameIds: [typeof frameId === "number" ? frameId : 0] };
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    const res = await chrome.scripting.executeScript({
      target,
      func: () => globalThis.__aiAssistantPageExtractor?.().extractSelectionMarkdown?.() || null,
    });
    return res?.[0]?.result || null;
  } catch (err) {
    console.debug("[AI Assistant] Selection markdown unavailable:", err);
    return null;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_TRANSLATE_ID || !info.selectionText?.trim() || !tab?.id) return;

  // Must be called directly from the context-menu click before any await.
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
    console.warn("[AI Assistant] Unable to open side panel from context menu:", err);
  });

  (async () => {
    // Keep Markdown only for selections that actually contain Markdown
    // structure. For plain text, also prefer the extractor when it recovered
    // paragraph separators that Chrome's selection serialization dropped.
    const md = await readSelectionMarkdown(tab.id, info.frameId);
    const selection = chooseTranslationSelection(info.selectionText, md);
    const pending = {
      action: "translate",
      text: selection.text,
      format: selection.format,
      truncated: selection.truncated,
      tabId: tab.id,
      windowId: tab.windowId,
      url: String(tab.url || ""),
      createdAt: Date.now(),
    };
    // Context actions are a small queue, not one global slot: a second rapid
    // selection in another window must not overwrite the first. The lock keeps
    // the read-append-write atomic across service-worker instances.
    await withNamedLock(CONTEXT_ACTION_LOCK, async () => {
      const stored = await chrome.storage.local.get(PENDING_CONTEXT_ACTION_KEY);
      const raw = stored[PENDING_CONTEXT_ACTION_KEY];
      const existing = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const fresh = existing.filter((item) => item && Date.now() - item.createdAt <= 120000);
      fresh.push(pending);
      await chrome.storage.local.set({ [PENDING_CONTEXT_ACTION_KEY]: fresh.slice(-20) });
    }).catch((err) => {
      console.warn("[AI Assistant] Unable to store context action:", err);
    });
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "CONTEXT_ACTION", pending }).catch(() => {});
    }, 200);
  })();
});


// ---------- Trust boundary: who may talk to this service worker ----------
// This worker holds the extension's <all_urls> host permission and every API
// key, so its message and port handlers only serve the extension's OWN pages
// (side panel, settings, mic-permission tab). Content scripts - which run
// inside arbitrary web pages and share this extension's id - are rejected: the
// sender's URL for a content script is the web page's URL, not a
// chrome-extension:// URL. (The manifest also declares no
// externally_connectable, so web pages themselves cannot reach this worker.)
function isOwnExtensionPage(sender) {
  return (
    Boolean(sender) &&
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

// ---------- Remote image fetching ----------
// Remote images embedded in model Markdown can be rejected when loaded directly
// from an extension page (for example, because the image host applies hotlink
// or referrer rules). Fetch them from the extension service worker, which has
// <all_urls> host permission, and return a data URL for the side panel.
//
// Because this worker can reach hosts a web page cannot, and the URLs come from
// web pages or from model replies (which a page can steer by prompt injection),
// every fetch is restricted - see url-safety.js:
//  * only public internet hosts, never localhost / private / link-local /
//    cloud-metadata addresses, unless the host is the one the user is currently
//    viewing (so images on an intranet or localhost page still work there);
//  * redirects are refused (redirect: "error") because a redirect target can
//    only be checked after the request has been sent; the final URL is still
//    re-checked as defense in depth;
//  * a timeout and a hard byte cap, enforced while streaming;
//  * the body must really be an image (file signature), not merely labelled one;
//  * SVG is not accepted (the side panel's sanitizer already refuses SVG data
//    images, and the provider-bound page-image path never allowed it);
//  * failures are reported as a coarse "unavailable", with no network detail.
const PAGE_IMAGE_MAX_COUNT = 4;
const PAGE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const PAGE_IMAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10000;
// Page images are optional quick-action context: they are fetched in
// parallel with a short per-image timeout and one overall budget, so a
// handful of slow or hanging image hosts can never lock the composer for
// the old serial worst case (8 URLs x 10 s = 80 s). A user-clicked
// FETCH_IMAGE keeps the full IMAGE_FETCH_TIMEOUT_MS.
const PAGE_IMAGE_FETCH_TIMEOUT_MS = 6000;
const PAGE_IMAGE_TOTAL_BUDGET_MS = 15000;

function sniffImageType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return null;
}

// Reads at most maxBytes from the response body, cancelling the stream as soon
// as the cap is exceeded (a server can lie about, or omit, Content-Length).
async function readBodyCapped(resp, maxBytes) {
  if (!resp.body) {
    // Fetch responses normally expose a stream; this fallback is rare. Reject a
    // declared oversized body before materializing it, and cap after (the
    // browser gives no streaming handle here).
    const declared = Number(resp.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("too large");
    const whole = new Uint8Array(await resp.arrayBuffer());
    if (whole.length > maxBytes) throw new Error("too large");
    return whole;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function fetchImageDataUrl(rawUrl, maxBytes, allowedTypes, pageUrl = "", { timeoutMs = IMAGE_FETCH_TIMEOUT_MS, signal } = {}) {
  const url = checkImageUrl(rawUrl, pageUrl);
  if (!url) throw new Error("blocked");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // An external signal (the page-image total budget) aborts this fetch the
  // same way the per-image timeout does.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const resp = await fetch(url.href, {
      method: "GET",
      credentials: "omit",
      cache: "force-cache",
      // Never follow redirects. The destination of a redirect cannot be checked
      // BEFORE the request is sent (extension fetch() cannot read Location with
      // redirect:"manual"), so a public URL could 302 the worker to localhost,
      // a router or a cloud-metadata endpoint and the request would already
      // have reached it. A redirecting image URL simply fails as "unavailable".
      redirect: "error",
      signal: controller.signal,
    });
    // Defense in depth: with redirects refused this should always equal the
    // requested URL, but keep verifying the final destination.
    if (resp.url && !checkImageUrl(resp.url, pageUrl)) {
      resp.body?.cancel().catch(() => {});
      throw new Error("blocked");
    }
    if (!resp.ok) throw new Error("unavailable");

    const contentType = (resp.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!allowedTypes.test(contentType)) throw new Error("unsupported");
    const contentLength = Number(resp.headers.get("content-length") || 0);
    if (contentLength > maxBytes) throw new Error("too large");

    const bytes = await readBodyCapped(resp, maxBytes);
    const kind = sniffImageType(bytes);
    if (!kind || !allowedTypes.test(`image/${kind}`)) throw new Error("unsupported");

    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return `data:image/${kind};base64,${btoa(binary)}`;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FETCH_IMAGE" && typeof msg.url === "string") {
    if (!isOwnExtensionPage(sender)) return false;
    const pageUrl = typeof msg.pageUrl === "string" ? msg.pageUrl : "";
    (async () => {
      try {
        const dataUrl = await fetchImageDataUrl(msg.url, 10 * 1024 * 1024, /^image\/(png|jpeg|gif|webp|bmp)$/, pageUrl);
        sendResponse({ ok: true, dataUrl });
      } catch {
        // Deliberately no detail: timing/error text must not become a probe
        // for what is (or is not) listening on the user's network.
        sendResponse({ ok: false, error: "unavailable" });
      }
    })();
    return true;
  }

  if (msg?.type === "FETCH_PAGE_IMAGES" && Array.isArray(msg.urls)) {
    if (!isOwnExtensionPage(sender)) return false;
    const pageUrl = typeof msg.pageUrl === "string" ? msg.pageUrl : "";
    (async () => {
      const urls = [...new Set(msg.urls.filter((url) => typeof url === "string"))].slice(0, PAGE_IMAGE_MAX_COUNT * 2);
      // All at once, under one overall budget (see the PAGE_IMAGE_* constants
      // above): a slow host can no longer serialize its timeout behind the
      // previous one. Promise.allSettled resolves in input order, so the
      // byte accounting below still sees the page's document order; a
      // rejected fetch (blocked, unsupported, too large, budget hit) is
      // simply skipped - page images are optional context and must not
      // prevent the requested text operation.
      const budget = new AbortController();
      const budgetTimer = setTimeout(() => budget.abort(), PAGE_IMAGE_TOTAL_BUDGET_MS);
      const settled = await Promise.allSettled(
        urls.map((url) =>
          fetchImageDataUrl(url, PAGE_IMAGE_MAX_BYTES, /^image\/(png|jpeg|gif|webp)$/, pageUrl, {
            timeoutMs: PAGE_IMAGE_FETCH_TIMEOUT_MS,
            signal: budget.signal,
          })
        )
      );
      clearTimeout(budgetTimer);
      const images = [];
      let totalBytes = 0;
      for (const result of settled) {
        if (images.length >= PAGE_IMAGE_MAX_COUNT) break;
        if (result.status !== "fulfilled") continue;
        const dataUrl = result.value;
        const encoded = dataUrl.split(",", 2)[1] || "";
        const imageBytes = Math.floor((encoded.length * 3) / 4);
        if (totalBytes + imageBytes > PAGE_IMAGE_MAX_TOTAL_BYTES) continue;
        totalBytes += imageBytes;
        images.push({ name: `Web image ${images.length + 1}`, dataUrl });
      }
      sendResponse({ ok: true, images });
    })();
    return true;
  }
  return false;
});

// ---------- MV3 keep-alive for in-flight provider requests ----------
// An MV3 service worker is terminated after ~30 seconds of inactivity, and
// only dispatched events and extension API calls reset that idle timer -
// an open fetch() or a silent stream does NOT. A provider request whose
// stream produces no visible text for ~30s therefore gets its worker killed
// mid-request: the port to the side panel drops with it, and the panel shows
// "The connection to the AI service was interrupted" even though nothing
// failed on the wire (any real HTTP error would have surfaced through the
// ERROR path instead). Some providers can spend more than 30 seconds before producing visible output, so the service worker needs a keep-alive during long-running requests. A side-effect-free
// extension API call every 20s (under the 30s idle threshold) keeps the
// worker alive until DONE/ERROR/STOP.
//
// The service worker is a single process shared by every browser window, and
// each open side panel has its own port and its own in-flight request. The
// timer is therefore shared and reference-held: every in-flight ASK takes one
// hold, the timer runs while at least one hold exists, and it is cleared only
// when the last hold is released. (A single timer that any request could stop
// let one window finishing - or its panel closing - silently remove the
// keep-alive of a request still streaming in another window.)
const KEEP_ALIVE_INTERVAL_MS = 20000;
let keepAliveTimer = null;
const keepAliveHolds = new Set();

// Takes a hold for one request and returns the function that releases it.
// Releasing is idempotent, so a request can never release twice and drop a
// hold that belongs to a different request.
function startRequestKeepAlive() {
  const hold = Symbol("request-keep-alive");
  keepAliveHolds.add(hold);
  if (keepAliveTimer === null) {
    keepAliveTimer = setInterval(() => {
      void chrome.runtime.getPlatformInfo();
    }, KEEP_ALIVE_INTERVAL_MS);
  }
  return function stopRequestKeepAlive() {
    if (!keepAliveHolds.delete(hold)) return;
    if (keepAliveHolds.size === 0 && keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };
}

// Side-panel ports currently connected to this worker: one per open panel,
// i.e. one per browser window that has the panel open. Ports and this set both
// live and die with the service worker instance, so it always matches reality.
const connectedPanelPorts = new Set();

// Long translations are sent as several requests in a row. Free tiers (Groq
// especially) answer a later batch with HTTP 429 or a transient 5xx, which used
// to end the whole translation at that batch. Such a batch is retried up to
// BATCH_MAX_RETRIES times with exponential backoff (3 s, then 6 s) before the
// translation is stopped there.
//
// Only a refusal that arrives before the reply starts is retried: providerHttpError()
// is thrown on a non-2xx response, before readSse() has pushed a single line to the
// LineTranslator, so a retry cannot duplicate or reorder already-translated lines.
// A failure in the middle of a stream has a different message and is not retried.
const BATCH_MAX_RETRIES = 2;
const BATCH_RETRY_BASE_MS = 3000;
const RETRYABLE_HTTP_ERROR_RE = /^HTTP (429|5\d\d)\b/;

function retryableHttpStatus(err) {
  return String(err?.message || "").match(RETRYABLE_HTTP_ERROR_RE)?.[1] || null;
}

// setTimeout that ends with an AbortError as soon as the request is aborted
// (STOP, a newer ASK, panel closed), so a stopped request never sits out the
// remaining backoff and then sends another request.
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runBatchWithRetry(run, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!retryableHttpStatus(err) || attempt >= BATCH_MAX_RETRIES) throw err;
      await abortableDelay(BATCH_RETRY_BASE_MS * 2 ** attempt, signal);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-chat") return;
  // The chat port carries API-key-backed requests; serve only our own pages.
  if (!isOwnExtensionPage(port.sender)) {
    port.disconnect();
    return;
  }
  connectedPanelPorts.add(port);

  // Posts to this port, ignoring the throw of a port that is already
  // disconnected. The panel can close (or its document can be torn down)
  // while the ASK handler below sits in one of its early, non-abortable
  // awaits (settings restore, language read, storage read); resuming after
  // the onDisconnect abort, the next port.postMessage would throw - and the
  // catch's own ERROR postMessage would throw a second time, escaping the
  // async listener as an unhandled promise rejection. There is nobody left
  // to receive anything, so every write just becomes a no-op.
  const safePost = (message) => {
    try {
      port.postMessage(message);
    } catch {
      // Panel gone; nothing to report to.
    }
  };

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
  //
  // The pointer is one global storage key shared by every window, so it is
  // cleared only when the LAST panel disconnects. With two windows open,
  // closing window A's panel must not reset the pointer for window B, which
  // is still showing its conversation. (Aborting this port's own in-flight
  // request is always right, so that part is unconditional.)
  port.onDisconnect.addListener(() => {
    connectedPanelPorts.delete(port);
    if (connectedPanelPorts.size === 0) {
      chrome.storage.local.set({ [CURRENT_CONVERSATION_KEY]: "" }).catch(() => {});
    }
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
    // A second ASK on this port while a request is still running must not leave
    // that request running: its controller is about to be overwritten below,
    // after which nothing could abort it any more (STOP, panel closed) and it
    // would keep spending quota and pushing to this port. Abort it first. It
    // ends through the AbortError path (silent), and its finally block leaves
    // the new request's state alone because the request ids differ.
    activeAbortController?.abort();
    const abortController = new AbortController();
    activeRequestId = requestId;
    activeAbortController = abortController;
    // Keep the worker alive for the whole request (Tavily preflight included)
    // - without this, any provider whose first visible chunk takes >30s
    // (providers with long-running requests) loses the worker mid-request.
    // Released in the finally block below, exactly once per request.
    const releaseKeepAlive = startRequestKeepAlive();

    let pageSentChars = 0;
    let requestWasTranslation = false;
    // Hoisted so the catch below can flush text the PII placeholder restorer
    // was still holding back when the request failed mid-stream (ctx is
    // declared inside the try block and is invisible to the catch).
    let chunkRestorer = null;
    let thinkingRestorer = null;
    try {
      // Recover user settings before reading provider keys or language. This
      // makes the background service worker resilient if extension local
      // storage was unexpectedly reset between browser sessions. Memoized:
      // the first request in this worker instance does the work (usually the
      // startup call above already has), later requests await the same
      // settled promise.
      await restoreSettingsFromBackupOnce();
      if (abortController.signal.aborted) return;
      let { question, pageContext, includePageContext, history, images = [], modelId, factCheck, noWebResearch = false, forceWebResearch = false, translateMode = false, translateSource = null, translateSourceTruncated = false } = msg.payload;
      requestWasTranslation = translateMode === true;
      const lang = await getStoredLanguage();
      if (abortController.signal.aborted) return;
      // Privacy filter (on by default): strip names, phones, emails, cards,
      // keys, tokens, etc. from EVERYTHING that leaves the browser - question,
      // attachments, page text and history - before any provider or web
      // research request is built. Only the local copy keeps the originals.
      // Placeholders are numbered ([EMAIL#1]) and the mapping stays in this
      // request's memory only; it is used to restore the real values in the reply.
      let piiSession = null;
      try {
        const piiSetting = await chrome.storage.local.get(PII_FILTER_STORAGE_KEY);
        if (piiSetting[PII_FILTER_STORAGE_KEY] !== false) {
          piiSession = createRedactionSession();
          // One choke point for every outbound text field, including
          // factCheck.selectedText (sent to Tavily and the model). The generic
          // redaction covers fields added to the payload later as well; image
          // data is left untouched (see NON_TEXT_KEYS in pii-filter.js).
          const redactedPayload = redactOutbound(msg.payload, piiSession);
          ({ question, pageContext, history, translateSource, factCheck } = redactedPayload);
        }
      } catch (err) {
        console.warn("[AI Assistant] privacy filter failed", err);
        throw new Error(t(lang, "bg_error_piiFilter"));
      }
      if (abortController.signal.aborted) return;
      // Never trust a stale/accidental pageContext value when the user has
      // disabled "Read current page". This is the final privacy boundary
      // before any provider request is constructed - independent of, and
      // unaffected by, any attached images (see normalizedImages below),
      // which are sent whenever present regardless of this toggle.
      let requestPageContext = includePageContext === true ? pageContext : null;
      // Resolve the model from the canonical catalog for THIS request.
      // Never trust provider/apiModel/thinking values supplied by the UI and
      // never silently fall back to another provider. Legacy IDs are resolved
      // by findKnownModel(), which (unlike the UI's tolerant findModelById)
      // returns undefined for an unknown ID instead of defaulting to the first
      // model - previously this check could never fire.
      const model = findKnownModel(modelId);
      if (!model) {
        throw new Error(t(lang, "bg_error_unknownModel_template", { model: modelId || "(none)" }));
      }

      if (
        model.provider !== "deepseek" &&
        model.provider !== "openrouter" &&
        model.provider !== "groq"
      ) {
        throw new Error(t(lang, "bg_error_unsupportedProvider_template", { provider: model.provider }));
      }

      safePost({ type: "START", requestId });

      const ctx = { port, requestId, signal: abortController.signal, abort: () => abortController.abort(), lang, translateMode: translateMode === true ? "free" : false, lineTranslator: null, safePost };
      // Everything shown to the user goes through here so the real values replace
      // the placeholders (also when one is split across two streamed chunks).
      chunkRestorer = new PlaceholderRestorer(piiSession, (delta) => safePost({ type: "CHUNK", delta, requestId }));
      ctx.sendChunk = (delta) => chunkRestorer.push(delta);
      ctx.flushChunks = () => chunkRestorer.flush();
      thinkingRestorer = new PlaceholderRestorer(piiSession, (delta) => safePost({ type: "THINKING", delta, requestId }));
      ctx.sendThinking = (delta) => thinkingRestorer.push(delta);
      ctx.flushThinking = () => thinkingRestorer.flush();
      const normalizedImages = Array.isArray(images) ? images.filter((img) => img && typeof img.dataUrl === "string" && /^data:image\/(jpeg|png|gif|webp);base64,/i.test(img.dataUrl)) : [];
      if (normalizedImages.length !== (Array.isArray(images) ? images.length : 0)) throw new Error(t(lang, "bg_error_imagesEncoding"));

      // Per-model page budget (free tiers reject/rate-limit big requests).
      // Translation is not cut to this per-model budget (it relies on the clear
      // error hint below). It does have a hard size limit, though; when the
      // source is cut by it - here or earlier in the content script - the user
      // is told with a NOTICE (see the translation branch below), because a
      // cut translation silently misses the rest of the text.
      const pageCap = model.maxPageChars || DEFAULT_MAX_PAGE_CHARS;
      // `truncated` covers the cut content.js already made at its own 120k
      // limit: without it the length check below never fires for models whose
      // pageCap equals that limit (the extracted text is always <= 120k), and
      // the user was never told the page was shortened.
      if (translateMode !== true && requestPageContext && !requestPageContext.captureFailed && ((requestPageContext.text || "").length > pageCap || requestPageContext.truncated === true)) {
        let cut = cutAtCodePointBoundary(requestPageContext.text, pageCap);
        const nl = cut.lastIndexOf("\n");
        if (nl > pageCap * 0.8) cut = cut.slice(0, nl);
        requestPageContext = { ...requestPageContext, text: cut };
        safePost({ type: "NOTICE", text: t(lang, "bg_notice_pageTruncated_template", { model: model.label, chars: String(cut.length) }), requestId });
      }
      pageSentChars = requestPageContext && !requestPageContext.captureFailed ? (requestPageContext.text || "").length : 0;
      let effectiveQuestion = question;
      let requestPageContextFinal = requestPageContext;
      let translationBatches = [];
      let translateUsingSelection = false;
      // Set when the source contains nothing translatable (see below): the
      // original text is echoed back and no provider request is made at all.
      let translationIdentity = false;
      let identityText = "";
      // Format-preserving translation: the layout (lines, blank lines,
      // indentation, list markers) is kept in code; the model only translates
      // numbered lines. See translate-lines.js.
      if (translateMode === true) {
        const usingSelection = typeof translateSource === "string" && !!translateSource.trim();
        const source = usingSelection
          ? translateSource
          : (requestPageContext && !requestPageContext.captureFailed ? requestPageContext.text : "");
        const prepared = source ? prepareLineTranslation(source, MAX_PAGE_CONTEXT_CHARS) : null;
        if (prepared) {
          ctx.translateMode = "lines";
          const cutUpstream = usingSelection ? translateSourceTruncated === true : requestPageContext?.truncated === true;
          if (prepared.truncated || cutUpstream) {
            safePost({ type: "NOTICE", text: t(lang, "bg_notice_translateTruncated", { chars: String(prepared.keptChars) }), requestId });
          }
          translateUsingSelection = usingSelection;
          translationBatches = numberedBatches(prepared);
          ctx.lineTranslator = new LineTranslator(prepared, (delta) => ctx.sendChunk(delta));
          if (typeof translateSource === "string" && translateSource.trim()) {
            effectiveQuestion = `${question}\n\n${prepared.numbered}`;
          } else {
            requestPageContextFinal = { ...requestPageContext, text: prepared.numbered };
          }
        } else if (source) {
          // Every line of the source is code (inside a fence), an image line
          // or otherwise letter-less, so the model has NOTHING to translate -
          // prepareLineTranslation() returned null. For a selection (page
          // context is deliberately off there) the request previously went
          // out as the bare instruction with no text anywhere, and the model
          // answered "please provide the text". Echo the original back
          // instead - exactly the reply LineTranslator's fallback produces
          // for lines it could not translate - and skip the provider call.
          // A selection that is one big code block is the real-world case.
          translationIdentity = true;
          identityText = source;
          const cutUpstream = usingSelection ? translateSourceTruncated === true : requestPageContext?.truncated === true;
          if (cutUpstream) {
            safePost({ type: "NOTICE", text: t(lang, "bg_notice_translateTruncated", { chars: String(source.length) }), requestId });
          }
          safePost({ type: "NOTICE", text: t(lang, "bg_notice_translateNothingToTranslate"), requestId });
        }
      }
      if (factCheck?.enabled) {
        const research = await runTavilyFactCheckResearch({
          question,
          pageContext: requestPageContext,
          ctx,
          selectedText: factCheck.selectedText || "",
        });
        effectiveQuestion = research.prompt;
      } else if (!noWebResearch && translateMode !== true) {
        // Normal questions use web research when the user asks for it
        // explicitly, or - only if "Automatically search the web" is on in
        // Settings (off by default) - when the current page cannot cover their
        // key conditions. Questions the page already covers stay local.
        //
        // noWebResearch is sent by the predefined page/selection transforms
        // (quick actions Summarize/Translate/Explain/Key Points and their
        // context-menu equivalents): those operate purely on the supplied
        // page or selection text and never need web evidence, so Tavily is
        // skipped entirely. Without this flag their fixed instruction prompts
        // ("Summarize the CURRENT webpage...") match the "current" keyword in
        // ONLINE_RESEARCH_REQUEST_PATTERN (context-menu text actions have no
        // page context either, so the research preflight returned true
        // unconditionally) and fired a Tavily search on every click - and
        // failed outright for users without a Tavily API key.
        const research = await runTavilyQuestionResearch({
          question,
          pageContext: requestPageContext,
          ctx,
          force: forceWebResearch,
        });
        if (research) effectiveQuestion = research.prompt;
      }
      const runProvider = async (q, pc) => {
        if (model.provider === "deepseek") {
          await streamDeepSeek(model, q, pc, history, normalizedImages, ctx);
        } else if (model.provider === "openrouter") {
          await streamOpenRouter(model, q, pc, history, normalizedImages, ctx);
        } else if (model.provider === "groq") {
          await streamGroq(model, q, pc, history, normalizedImages, ctx);
        }
      };
      let translationStoppedAt = null;
      if (translationIdentity) {
        // Nothing translatable: the echoed original (already sent as one
        // CHUNK through the placeholder restorer) is the whole reply.
        ctx.sendChunk(identityText);
      } else if (ctx.lineTranslator && translationBatches.length > 1) {
        // Long text: several moderate requests, so no single reply can run into
        // the model's output limit. Each batch carries its global line numbers.
        for (const batch of translationBatches) {
          try {
            await runBatchWithRetry(
              () => (translateUsingSelection
                ? runProvider(`${question}\n\n${batch}`, requestPageContextFinal)
                : runProvider(effectiveQuestion, { ...requestPageContext, text: batch })),
              abortController.signal,
            );
          } catch (err) {
            // Still refused after the retries (rate limit / server error). If
            // earlier batches were translated, keep them: stop here, let
            // finish() fill the rest with the original text (same layout as
            // for any untranslated line) and say below where it broke off.
            // With nothing translated yet there is nothing to keep, so the
            // error is reported as before.
            const status = retryableHttpStatus(err);
            if (!status || ctx.lineTranslator.translated === 0) throw err;
            translationStoppedAt = { status, line: Number(batch.match(/^\[(\d+)\]/)?.[1]) || 0 };
            break;
          }
          ctx.lineTranslator.endBatch();
        }
      } else {
        await runProvider(effectiveQuestion, requestPageContextFinal);
      }

      ctx.lineTranslator?.finish();
      ctx.flushThinking?.();
      ctx.flushChunks?.();
      // Never let a cut-off reply pass silently.
      if (ctx.lineTranslator) {
        if (translationStoppedAt) {
          // Replaces the generic "lines not translated" notice: it names the
          // line where the translation broke off and why.
          safePost({ type: "NOTICE", text: t(lang, "bg_notice_translateStoppedAtLine_template", { line: String(translationStoppedAt.line), status: translationStoppedAt.status, translated: String(ctx.lineTranslator.translated), total: String(ctx.lineTranslator.expected) }), requestId });
        } else if (ctx.lineTranslator.missing > 0) {
          safePost({ type: "NOTICE", text: t(lang, "bg_notice_translateMissingLines_template", { missing: String(ctx.lineTranslator.missing), total: String(ctx.lineTranslator.expected) }), requestId });
        }
      } else if (ctx.truncatedByLength) {
        safePost({ type: "NOTICE", text: t(lang, "bg_notice_replyTruncatedLength"), requestId });
      }
      safePost({ type: "DONE", requestId });
    } catch (err) {
      // A deliberate STOP surfaces here as an AbortError (either from the
      // fetch() call itself being aborted, or from the stream reader's
      // pending read() rejecting once the same signal fires) - this is the
      // user cancelling on purpose, not a failure, so nothing is reported
      // back for it. sidepanel.js already reset its own UI state the moment
      // it sent STOP, without waiting for background.js to confirm.
      if (err?.name === "AbortError") return;
      let errorText = err?.message || String(err);
      // Clear hint when a page-sized request is refused or rate limited.
      // Tavily errors are excluded: a Tavily 429/5xx ("rate limit exceeded" in
      // its body) has nothing to do with the page size, and the hint would be
      // misleading. Translations are excluded too: they send a bounded batch,
      // so a 429 on one batch does not mean the page is too large.
      if (!requestWasTranslation && pageSentChars > 0 && !/^Tavily\b/i.test(errorText) && /^HTTP (413|429)\b|too large|rate.?limit|context.?length|maximum context|tokens? per (minute|day)|\bTPM\b|reduce the length/i.test(errorText)) {
        errorText += `\n\n${t(await getStoredLanguage().catch(() => "en"), "bg_hint_pageTooLarge")}`;
      }
      // Release whatever the PII placeholder restorer was still holding back
      // (a possible placeholder split across two chunks, held until its "]"
      // arrives): the ERROR path keeps the partial reply as a finished
      // assistant turn, and without this flush its last characters were
      // permanently lost.
      try { thinkingRestorer?.flush(); } catch {}
      try { chunkRestorer?.flush(); } catch {}
      safePost({ type: "ERROR", error: errorText, requestId });
    } finally {
      if (activeRequestId === requestId) {
        activeRequestId = null;
        activeAbortController = null;
      }
      // Always release THIS request's hold - even if a newer ASK on the same
      // port has already replaced activeRequestId (STOP followed immediately
      // by a new question), which skips the reset above. Each request owns
      // exactly one hold, so this neither leaks nor drops anyone else's.
      releaseKeepAlive();
    }
  });
});


// ---------- Tavily web research for Fact Check ----------
const FACT_CHECK_MAX_CLAIMS = 5;
const FACT_CHECK_RESULTS_PER_CLAIM = 4;
const FACT_CHECK_MAX_EVIDENCE_CHARS = 18000;

// Collapse whitespace and bound the length of a piece of research text.
function cleanResearchText(value, max = 800) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function candidateFactClaims(text, title = "") {
  const sentences = String(text || "")
    .replace(/\r/g, "\n")
    // Chinese/Japanese sentences end in 。！？ with no following space, so the
    // split must not require whitespace after those marks.
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .map((s) => cleanResearchText(s, 700))
    // 35 characters is a normal English sentence, but a long CJK one - use a
    // lower floor there or nearly every CJK claim would be discarded.
    .filter((s) => s.length >= (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s) ? 12 : 35));

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

const TAVILY_TIMEOUT_MS = 15000;

async function tavilySearch(query, apiKey, signal, topic = "news", maxResults = FACT_CHECK_RESULTS_PER_CLAIM) {
  // Bound the request so a hung Tavily call cannot stall the whole question.
  // A user STOP (the caller's signal) still surfaces as an AbortError; a
  // timeout is reported as an ordinary error instead, so it is not mistaken
  // for a deliberate cancel.
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; timeoutController.abort(); }, TAVILY_TIMEOUT_MS);
  const onCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  try {
    return await tavilySearchRequest(query, apiKey, timeoutController.signal, topic, maxResults);
  } catch (err) {
    if (timedOut && !signal?.aborted) {
      throw new Error(`Tavily request timed out after ${TAVILY_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

// Tavily rejects queries over 400 characters ("Query is too long"). Every
// caller (question, Explain page excerpt, fact-check claims) goes through
// tavilySearchRequest, so the limit is enforced once here: cut to a safe
// margin below the cap, preferring a word boundary (CJK text has no spaces,
// so it is cut at the limit). Counts code points, not UTF-16 units.
const TAVILY_MAX_QUERY_CHARS = 380;
function fitTavilyQuery(query, max = TAVILY_MAX_QUERY_CHARS) {
  const chars = Array.from(String(query || "").replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max);
  // Only back up to a space if the cut landed mid-word and that keeps most of the query.
  if (chars[max] !== " ") {
    const sp = cut.lastIndexOf(" ");
    if (sp >= max * 0.6) return cut.slice(0, sp).join("").trim();
  }
  return cut.join("").trim();
}

async function tavilySearchRequest(query, apiKey, signal, topic, maxResults) {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: fitTavilyQuery(query),
      topic,
      search_depth: "basic",
      max_results: maxResults,
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

const ONLINE_RESEARCH_MAX_RESULTS = 6;
const ONLINE_RESEARCH_MAX_EVIDENCE_CHARS = 18000;
// Explicit requests to go online. Only a clear instruction to search the web
// counts ("search the web", "look it up online", "联网搜索", "上网查"). Words
// such as latest / current / official / search / research are ordinary page
// vocabulary ("Where is the search box?", "What does the latest changelog
// entry say?") and are NOT explicit; the content-based check in
// onlineResearchTrigger handles them as an implicit (optional) lookup.
const ONLINE_RESEARCH_REQUEST_PATTERN =
  /\b(?:search|google|browse|look\s*(?:it|this|that|them)?\s*up|find|check)\b[^.?!\n]{0,24}\b(?:the\s+)?(?:web|internet|online)\b|\b(?:search|look\s*up|find|check)\s+online\b|\bonline\s+(?:search|research|lookup)\b|\bweb\s+(?:search|research)\b|联网|上网(?:查|搜|找|检索)|网上(?:查|搜|找|搜索|检索)|在线(?:搜索|查询|检索)/i;

// Words that carry no topic information. Ordinary question phrasing ("what does
// it say about ...") must not be counted as "not covered by the page", which
// the previous 25-word list did constantly.
const ONLINE_RESEARCH_STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'analyse', 'analyze', 'and', 'any',
  'are', 'article', 'as', 'at', 'attached', 'attachment', 'attachments', 'be',
  'been', 'but', 'by', 'can', 'could', 'describe', 'did', 'do', 'does', 'document',
  'explain', 'file', 'files', 'for', 'from', 'get', 'give', 'has', 'have', 'he',
  'her', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'key', 'main', 'me',
  'more', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'page', 'please', 'point',
  'points', 'say', 'says', 'she', 'should', 'show', 'so', 'some', 'summarise',
  'summarize', 'tell', 'text', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  // Generic request filler that says nothing about the topic.
  'brief', 'briefly', 'concise', 'content', 'current', 'detail', 'detailed', 'details',
  'help', 'info', 'information', 'like', 'make', 'need', 'sense', 'short', 'simple',
  'simply', 'site', 'terms', 'thing', 'things', 'use', 'using', 'want', 'webpage', 'website',
]);

// CJK text has no spaces between words, so a whole sentence used to be a single
// "term" that never appeared verbatim on a page - every Chinese/Japanese
// question therefore triggered web research. These filler strings are removed
// and what remains is compared as overlapping two-character grams instead.
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_FILLER_RE = new RegExp(
  [
    '请问', '什么', '如何', '是否', '怎么', '怎样', '为什么', '可以', '能否', '这个', '那个',
    '文章', '页面', '网页', '内容', '主要', '观点', '总结', '解释', '介绍', '说明', '告诉', '哪些',
    'について', 'ください', '教えて', 'ですか', 'です', 'ます', 'とは', 'これ', 'それ',
    'ページ', '記事', '内容', '要約', '説明',
    '有', '和', '的', '了', '吗', '呢', '吧', '啊', '请', '这', '那', '是', '在', '我', '你', '他', '她', '它',
    'は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'か',
  ]
    .sort((a, b) => b.length - a.length)
    .join('|'),
  'gu'
);

// Splits a normalized question into comparable terms: whole words for
// space-delimited scripts, two-character grams for CJK runs.
function researchTerms(query) {
  const terms = new Set();
  const nonCjk = query.replace(CJK_RUN_RE, ' ');
  for (const word of nonCjk.match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) || []) {
    if (!ONLINE_RESEARCH_STOP_WORDS.has(word)) terms.add(word);
  }
  for (const run of query.match(CJK_RUN_RE) || []) {
    for (const piece of run.replace(CJK_FILLER_RE, ' ').split(/\s+/)) {
      for (let i = 0; i + 2 <= piece.length; i++) terms.add(piece.slice(i, i + 2));
    }
  }
  return [...terms];
}

// The side panel appends attachment contents and a page-visuals note to the
// question text. They are context, not part of what the user asked: left in,
// they made any file containing a word like "current" or "latest" trigger a web
// search, and the file's text became the search query.
const RESEARCH_EXTRA_BLOCK_RE = /\[(ATTACHMENTS|CURRENT PAGE VISUALS)\][\s\S]*?\[\/\1\]/gi;

function splitResearchQuestion(question) {
  let attachmentText = '';
  const text = String(question || '')
    .replace(RESEARCH_EXTRA_BLOCK_RE, (block) => {
      if (/^\[ATTACHMENTS\]/i.test(block)) attachmentText += `\n${block}`;
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, attachmentText };
}

// Decide before the model request whether the page can answer the question.
// This is deliberately content-based, not topic-based: any missing year,
// product name, version, or other key term can cause research, while a page
// that already covers the question remains local. A streamed model reply
// cannot be safely inspected and retried after it has already been shown, so
// this preflight is the reliable point to make the automatic decision.
//
// Returns "explicit" when the user asked for fresh/online information,
// "implicit" when the page (plus any attachment) simply does not cover the
// question, or null when no research is needed. The distinction matters when
// no Tavily key is configured: an explicit request shows a NOTICE that research
// was skipped, while an implicit (automatic) lookup is skipped silently. Either
// way the model is still called.
function onlineResearchTrigger(question, pageContext, attachmentText = '') {
  const query = String(question || '').normalize('NFKC').toLowerCase();
  if (query.length < 3) return null;
  if (ONLINE_RESEARCH_REQUEST_PATTERN.test(query)) return 'explicit';

  const pageText = `${pageContext?.text || ''}\n${attachmentText}`.normalize('NFKC').toLowerCase().trim();

  const years = [...new Set(query.match(/\b20\d{2}\b/g) || [])];
  if (years.some((year) => !pageText.includes(year))) return 'implicit';

  const terms = researchTerms(query);
  if (!terms.length) return null;
  if (!pageText) return 'implicit';

  const covered = terms.filter((term) => pageText.includes(term)).length;
  return covered / terms.length < 0.6 ? 'implicit' : null;
}

function pageResearchQuery(question, pageContext) {
  const title = cleanResearchText(pageContext?.title, 280);
  const excerpt = cleanResearchText(pageContext?.text, 620);
  // A fixed quick-action instruction such as "Explain the current page" is
  // not useful as a search query. Use the current page's own identifying
  // information, while the original instruction remains the model prompt.
  return cleanResearchText([title, excerpt].filter(Boolean).join("\n"), 900) || question;
}

// "Automatically search the web" in Settings. OFF unless the user turned it on
// (anything but a stored `true`, including a failed read, counts as off).
async function autoWebResearchEnabled() {
  try {
    return (await chrome.storage.local.get(AUTO_WEB_RESEARCH_KEY))[AUTO_WEB_RESEARCH_KEY] === true;
  } catch {
    return false;
  }
}

async function runTavilyQuestionResearch({ question, pageContext, ctx, force = false }) {
  const { text: questionText, attachmentText } = splitResearchQuestion(question);
  const trigger = force ? 'explicit' : onlineResearchTrigger(questionText, pageContext, attachmentText);
  if (!trigger) return null;
  // An implicit trigger is only the extension's guess that the page cannot
  // answer the question (a year the page does not contain, low keyword overlap,
  // or no page text at all). Acting on it sends the user's question to Tavily
  // although the user never asked for a web search, so it needs the user's
  // opt-in. An explicit request ("search the web"), the Explain action and
  // Fact Check are the user's own request and are not affected by the switch.
  if (trigger === 'implicit' && !(await autoWebResearchEnabled())) return null;

  const stored = await chrome.storage.local.get(['tavilyApiKey']);
  const apiKey = String(stored.tavilyApiKey || '').trim();
  if (!apiKey) {
    // Research is always an optional enhancement: without a Tavily key the
    // question is still answered by the model from the page. An explicit
    // request (or the Explain action) tells the user research was skipped via a
    // NOTICE; an implicit lookup is skipped silently. Never throw here - that
    // used to stop the model from being called at all.
    if (trigger !== 'implicit') {
      // safePost, like every other port write: the panel can close during the
      // storage read above, and a raw postMessage would then throw out of the
      // research path and kill the model call with a TypeError.
      ctx.safePost?.({ type: 'NOTICE', text: t(ctx.lang, 'bg_notice_tavilyKeyMissingSkipped'), requestId: ctx.requestId });
    }
    return null;
  }

  // Automatic (implicit) research is an optional enhancement: if Tavily times
  // out, returns HTTP 429/5xx or yields no results, log it and let the model
  // answer from the page / its own knowledge. Explicit or forced research
  // still reports the error. A deliberate STOP is always re-thrown.
  if (trigger !== 'implicit') return await fetchTavilyEvidence();
  try {
    return await fetchTavilyEvidence();
  } catch (err) {
    if (err?.name === 'AbortError' || ctx.signal?.aborted) throw err;
    console.warn('Automatic Tavily research failed; answering without it:', err);
    return null;
  }

  async function fetchTavilyEvidence() {
    // Ordinary questions use the user's wording (without attachment text). A
    // forced Explain action has a fixed instruction, so it instead searches the
    // current page's title and excerpt for relevant supporting sources.
    const searchQuery = force ? pageResearchQuery(questionText, pageContext) : questionText;
    const result = await tavilySearch(searchQuery, apiKey, ctx.signal, 'general', ONLINE_RESEARCH_MAX_RESULTS);
    const byUrl = new Map();
    for (const item of result?.results || []) {
      const url = String(item.url || '').trim();
      const title = cleanResearchText(item.title, 220);
      const content = cleanResearchText(item.content, 1400);
      if (!url || (!title && !content)) continue;
      const prior = byUrl.get(url);
      if (!prior || Number(item.score || 0) > prior.score) {
        byUrl.set(url, {
          title,
          url,
          content,
          published: item.published_date || item.publishedDate || '',
          score: Number(item.score || 0),
        });
      }
    }

    const sources = [...byUrl.values()].sort((a, b) => b.score - a.score);
    // Not the Fact-Check-specific key: this path also serves explicit
    // "search the web" questions and the Explain action, where a message
    // about a fact check would be wrong.
    if (!sources.length) throw new Error(t(ctx.lang, 'bg_error_researchNoResults'));

    let evidenceText = '';
    for (const source of sources) {
      const block =
        `SOURCE: ${source.title || source.url}\n` +
        `PUBLISHED: ${source.published || 'unknown'}\n` +
        `URL: ${source.url}\n` +
        `EVIDENCE: ${source.content}\n\n`;
      if (evidenceText.length + block.length > ONLINE_RESEARCH_MAX_EVIDENCE_CHARS) break;
      evidenceText += block;
    }
    if (!evidenceText) throw new Error(t(ctx.lang, 'bg_error_researchNoResults'));

    return {
      prompt: `${question}\n\nONLINE RESEARCH EVIDENCE:\n${evidenceText}\nAnswer the user's question using the supplied evidence for time-sensitive or missing-page facts. Do not infer a newer version from an older page. Prefer official sources when the evidence identifies them. If the sources do not establish the answer, say that it is unverified. Cite the supplied source URLs and do not invent sources, dates, specifications, or quotes.`,
    };
  }
}

async function runTavilyFactCheckResearch({ question, pageContext, ctx, selectedText = "" }) {
  const stored = await chrome.storage.local.get(["tavilyApiKey"]);
  const apiKey = String(stored.tavilyApiKey || "").trim();
  if (!apiKey) throw new Error(t(ctx.lang, "bg_error_tavilyKeyMissing"));

  const sourceText = selectedText || pageContext?.text || "";
  const title = selectedText ? "" : (pageContext?.title || "");
  const claims = selectedText && cleanResearchText(selectedText, 900).length >= 15
    ? [cleanResearchText(selectedText, 900)]
    : candidateFactClaims(sourceText, title);
  if (!claims.length) throw new Error(t(ctx.lang, "bg_error_factCheckNoClaims"));

  // "news" without a time window only covers the last few days (Tavily
  // default), so older articles were effectively unsearchable. Fact checks
  // need the best matching sources regardless of age: use "general".
  const topic = "general";
  const settled = await Promise.allSettled(
    claims.map((claim) => tavilySearch(claim, apiKey, ctx.signal, topic))
  );
  const evidence = [];
  let firstSearchError = null;
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status !== "fulfilled") {
      if (result.reason?.name === "AbortError" || ctx.signal?.aborted) throw result.reason;
      // Remember the real failure (e.g. "Tavily HTTP 401: ...") so it can be
      // reported if nothing at all was found, instead of a misleading
      // "no usable sources".
      firstSearchError ??= result.reason;
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
  if (!deduped.length) {
    if (firstSearchError) {
      console.warn("Fact-check search failed:", firstSearchError);
      throw firstSearchError instanceof Error ? firstSearchError : new Error(String(firstSearchError));
    }
    throw new Error(t(ctx.lang, "bg_error_factCheckNoResults"));
  }

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


