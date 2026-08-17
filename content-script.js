/**
 * content-script.js
 * Injected into every page (document_idle stage).
 * Single responsibility: when requested by the side panel, extract and return the current page text.
 * Makes no network requests and stores no data — keep the content script lightweight and side-effect free,
 * which is a Chromium extension best practice (content scripts have broad permissions, so problems can affect all websites).
 */

const MAX_CONTEXT_CHARS = 12000; // Avoid sending the entire page to the model and control token cost

function extractMainText() {
  // Try semantic elements first, then fall back to body
  const candidates = [
    document.querySelector("article"),
    document.querySelector("main"),
    document.body,
  ].filter(Boolean);

  const root = candidates[0];
  if (!root) return "";

  // Clone it to avoid affecting the real DOM
  const clone = root.cloneNode(true);

  // Remove obvious noise elements
  const noisySelectors = [
    "script",
    "style",
    "noscript",
    "svg",
    "nav",
    "footer",
    "header",
    "iframe",
    "form",
    "[aria-hidden='true']",
    ".ad",
    ".ads",
    ".advertisement",
  ];
  clone.querySelectorAll(noisySelectors.join(",")).forEach((el) => el.remove());

  const text = clone.innerText || clone.textContent || "";
  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function getPageSnapshot() {
  const text = extractMainText();
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, MAX_CONTEXT_CHARS),
    truncated: text.length > MAX_CONTEXT_CHARS,
  };
}

// ---------- Write back to the page: track the editable element containing the cursor ----------
// The side panel is independent of the web page. Clicking a panel button causes the previously focused input field on the page to lose focus
// (activeElement becomes body). Therefore, the target element must be recorded before focus is lost,
// then focus and cursor position are restored when an insertion command is received.

let lastActiveEditable = null;
let lastRange = null;

function isEditableEl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "email", "search", "url", "tel", ""].includes(type);
  }
  return el.isContentEditable === true;
}

document.addEventListener("focusin", (e) => {
  if (isEditableEl(e.target)) lastActiveEditable = e.target;
});

// Continuously track the cursor position inside contenteditable areas for "Insert at cursor"
document.addEventListener("selectionchange", () => {
  const el = lastActiveEditable;
  if (!el || !el.isContentEditable) return;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    lastRange = sel.getRangeAt(0).cloneRange();
  }
});

// <input>/<textarea> are usually "controlled components" in frameworks such as React/Vue:
// Directly assigning el.value may not be detected by the framework; the UI changes, but internal state does not, and submission can revert it.
// Using the native setter and manually dispatching input/change events is a general way to avoid this problem.
function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function insertIntoFormField(el, text, mode) {
  el.focus();
  let newValue;
  let caret;
  if (mode === "replace") {
    newValue = text;
    caret = text.length;
  } else {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    newValue = el.value.slice(0, start) + text + el.value.slice(end);
    caret = start + text.length;
  }
  setNativeValue(el, newValue);
  el.setSelectionRange?.(caret, caret);
}

function insertIntoContentEditable(el, text, mode) {
  el.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();

  const range = document.createRange();
  if (mode === "replace") {
    range.selectNodeContents(el);
  } else if (lastRange && el.contains(lastRange.startContainer)) {
    range.setStart(lastRange.startContainer, lastRange.startOffset);
    range.setEnd(lastRange.endContainer, lastRange.endOffset);
  } else {
    range.selectNodeContents(el);
    range.collapse(false); // If no valid cursor position is found, fall back to inserting at the end
  }
  sel.addRange(range);

  // Although execCommand is deprecated, Chromium-based browsers still support it,
  // and it is also the most reliable way to make contenteditable editors such as Gmail/Outlook treat this insertion as "real user input"
  // so that their internal draft state is updated correctly (a common problem with directly changing innerText is
  // "it looks inserted, but the content is empty when sent").
  const ok = document.execCommand && document.execCommand("insertText", false, text);
  if (!ok) {
    el.innerText = mode === "replace" ? text : el.innerText + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
}

function insertTextIntoActiveElement(text, mode) {
  const el = lastActiveEditable;
  if (!el || !document.contains(el)) {
    return { ok: false, error: "No editable area found. Click the email body input field first, then click Insert." };
  }
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    insertIntoFormField(el, text, mode);
  } else if (el.isContentEditable) {
    insertIntoContentEditable(el, text, mode);
  } else {
    return { ok: false, error: "The target element does not support writing" };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXTRACT_PAGE_CONTENT") {
    try {
      sendResponse({ ok: true, data: getPageSnapshot() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  }

  if (message?.type === "INSERT_TEXT") {
    try {
      sendResponse(insertTextIntoActiveElement(message.text, message.mode || "cursor"));
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  }
});
