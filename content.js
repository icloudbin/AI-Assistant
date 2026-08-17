// content.js (root directory)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "EXTRACT_PAGE_CONTENT") {
    sendResponse({
      ok: true,
      data: {
        title: document.title,
        url: location.href,
        text: (document.body?.innerText || "").slice(0, 20000),
      },
    });
    return false;
  }

  if (msg?.type === "INSERT_TEXT") {
    const el = document.activeElement;
    const editable =
      el &&
      (el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        (el.tagName === "INPUT" && /text|email|search|url/.test(el.type || "text")));
    if (!editable) {
      sendResponse({ ok: false, error: "Please click an input field on the web page first" });
      return false;
    }
    try {
      if (el.isContentEditable) {
        if (msg.mode === "replace") el.innerText = msg.text;
        else {
          el.focus();
          document.execCommand("insertText", false, msg.text);
        }
      } else {
        const { selectionStart: s, selectionEnd: e, value: v } = el;
        if (msg.mode === "replace") el.value = msg.text;
        else {
          el.value = v.slice(0, s) + msg.text + v.slice(e);
          el.selectionStart = el.selectionEnd = s + msg.text.length;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  }
  return false;
});