// content.js
//
// Extract the current page context. Synology MailPlus is handled specially
// because its message body is rendered inside a dynamic ExtJS message panel,
// while the mail list can be much larger than the extension's 20,000-character
// page-context limit.

function extractSynologyMailPlus() {
  // A selected/open MailPlus message is represented by an expanded item.
  const message =
    document.querySelector(
      '.syno-mc-message-list .item-wrap.item-expanded'
    ) ||
    document.querySelector(
      '.syno-mc-thread-message-panel .item-wrap.item-expanded'
    ) ||
    document.querySelector(
      '.syno-mc-message-panel .item-wrap.item-expanded'
    );

  if (!message) return null;

  // The actual rendered message content is in .item-detail .body.reset.
  // Prefer this over document.body.innerText so the large mail list does not
  // consume the context limit before the message body is reached.
  const body =
    message.querySelector('.item-detail .body.reset') ||
    message.querySelector('.body.reset');

  if (!body) return null;

  const bodyText = (body.innerText || body.textContent || '').trim();
  if (!bodyText) return null;

  const subject =
    message.querySelector('.item-title .body-preview')?.innerText?.trim() ||
    message.querySelector('.subject')?.innerText?.trim() ||
    '';

  const sender =
    message.querySelector('.from')?.innerText?.trim() ||
    message.querySelector('[class*="from"]')?.innerText?.trim() ||
    '';

  const recipient =
    message.querySelector('.to')?.innerText?.trim() ||
    message.querySelector('[class*="to"]')?.innerText?.trim() ||
    '';

  // Put the message metadata before the body. This gives the model an
  // unambiguous representation of the email currently being displayed.
  const parts = [];
  if (subject) parts.push(`Subject: ${subject}`);
  if (sender) parts.push(`From: ${sender}`);
  if (recipient) parts.push(`To: ${recipient}`);
  parts.push(`Email body:\n${bodyText}`);

  return {
    source: 'synology-mailplus',
    title: document.title,
    url: location.href,
    text: parts.join('\n\n'),
  };
}

function extractPageContent() {
  const mailPlus = extractSynologyMailPlus();
  if (mailPlus) return mailPlus;

  return {
    source: 'generic-page',
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || document.documentElement?.innerText || '').slice(0, 20000),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "EXTRACT_PAGE_CONTENT") {
    sendResponse({
      ok: true,
      data: extractPageContent(),
    });
    return false;
  }

  return false;
});
