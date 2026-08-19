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

  return false;
});
