// content.js
//
// Extract the current page context. Synology MailPlus and Proton Mail are
// each handled specially because their message body isn't reachable by
// simply reading document.body.innerText on the top-level document:
//   - MailPlus renders it inside a dynamic ExtJS panel, and its mail list
//     can be much larger than the extension's 20,000-character page-context
//     limit (handled below).
//   - Proton Mail renders it inside a sandboxed <iframe>, isolating any
//     script embedded in the email's own HTML from the mail app's origin.
//     innerText never crosses a document/frame boundary, so the generic
//     extractor at the bottom of this file sees the inbox list and the
//     message header chrome around the iframe, but never the opened email
//     itself, no matter how much of the character limit is left.

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

// A selected/open Proton Mail message renders its body inside
// iframe[data-testid="content-iframe"] (sandbox="allow-same-origin ..."
// deliberately without allow-scripts, so anything embedded in the email's
// HTML can't execute - but allow-same-origin keeps the iframe's origin
// matching the parent's, so contentDocument is reachable from here; the
// try/catch below is only a safety net in case that ever changes).
// A conversation can have more than one message expanded at once, each
// with its own such iframe; data-subject is set individually per iframe, so
// pairing a subject to the right body doesn't depend on assuming a document
// order.
function extractProtonMail() {
  const iframes = document.querySelectorAll('iframe[data-testid="content-iframe"]');
  if (!iframes.length) return null;

  const bodies = [];
  for (const iframe of iframes) {
    let frameDoc;
    try {
      frameDoc = iframe.contentDocument;
    } catch (err) {
      continue; // cross-origin or otherwise inaccessible - skip, don't throw
    }
    const bodyText = (frameDoc?.body?.innerText || '').trim();
    if (!bodyText) continue;
    const subject = iframe.getAttribute('data-subject');
    bodies.push(subject ? `Subject: ${subject}\n${bodyText}` : bodyText);
  }
  if (!bodies.length) return null;

  // From/To live in the message header, outside the iframe. Best-effort only
  // (for the currently expanded message) - if Proton's markup doesn't match,
  // this returns '' and the caller just omits that line; it never blocks the
  // body extraction above, which is the actual bug being fixed here.
  const headerValue = (containerTestId) => {
    const container = document.querySelector(`[data-testid="${containerTestId}"]`);
    if (!container) return '';
    const names = Array.from(container.querySelectorAll('[data-testid="recipient-label"]')).map((el) => el.textContent.trim());
    const addresses = Array.from(container.querySelectorAll('[data-testid="recipient-address"]')).map((el) => el.textContent.trim());
    if (!names.length && !addresses.length) return '';
    return names.map((name, i) => `${name} ${addresses[i] || ''}`.trim()).join(', ');
  };

  const parts = [];
  const from = headerValue('message-header-expanded:From');
  const to = headerValue('message-header-expanded:To');
  if (from) parts.push(`From: ${from}`);
  if (to) parts.push(`To: ${to}`);
  parts.push(`Email body:\n${bodies.join('\n\n---\n\n')}`);

  return {
    source: 'proton-mail',
    title: document.title,
    url: location.href,
    text: parts.join('\n\n'),
  };
}

function extractPageContent() {
  const mailPlus = extractSynologyMailPlus();
  if (mailPlus) return mailPlus;

  const protonMail = extractProtonMail();
  if (protonMail) return protonMail;

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
