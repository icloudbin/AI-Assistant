// content.js
//
// Extract the current page context, tried in this order:
//   1. Synology MailPlus - a dynamic ExtJS panel; the message body isn't
//      reachable via plain document.body.innerText, and its mail list can
//      be much larger than the extension's 20,000-character page-context
//      limit (handled below).
//   2. Proton Mail - the message body renders inside a sandboxed <iframe>,
//      isolating any script embedded in the email's own HTML from the mail
//      app's origin. innerText never crosses a document/frame boundary, so
//      a generic extractor sees the inbox list and the message header
//      chrome around the iframe, but never the opened email itself, no
//      matter how much of the character limit is left.
//   3. Reader-mode-style article extraction (extractReaderModeArticle,
//      below) - for ordinary pages (articles, blog posts, docs), scores
//      candidate containers by paragraph text vs. link density and keeps
//      only the best-scoring one, stripping nav/header/footer/sidebar/ads/
//      cookie-banner noise out of it first. This is a small original
//      heuristic, not Mozilla's Readability.js: the extension's CSP is
//      script-src 'self' with no bundled third-party libraries anywhere in
//      the project (matching the hand-rolled ZIP/inflate code already in
//      sidepanel.js), so it deliberately stays simple rather than trying to
//      match any specific library's exact scoring. It only ever replaces
//      step 4 below, never steps 1-2, and falls through to step 4 whenever
//      it isn't confident it actually found an article.
//   4. Plain document.body.innerText, sliced to the character limit - the
//      original fallback, unchanged, used whenever nothing above matches.

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

// Page-context text is capped at this many characters everywhere below -
// factored out since the reader-mode extractor now applies the same cap
// the plain fallback always has.
const PAGE_CONTEXT_CHAR_LIMIT = 20000;

// A result only counts as a usable "article" if it clears this much text -
// otherwise extractReaderModeArticle() returns null and the caller falls
// through to the plain innerText fallback. Also the minimum before a
// candidate element is scored at all (see readerModeScore).
const READER_MODE_MIN_TEXT_LENGTH = 200;

// A candidate whose text is more than half link text is treated as a
// navigation/link-list block (a menu, a "related articles" rail, a tag
// cloud) rather than an article, regardless of its raw length.
const READER_MODE_MAX_LINK_DENSITY = 0.5;

// A single article page rarely has more than a handful of elements matching
// candidateSelector below. Far more than that (a forum thread, a listing
// page with one ".content" div per row) means candidateSelector isn't
// picking out "the article" at all - bail out rather than cloning and
// scoring dozens of subtrees for no benefit.
const READER_MODE_MAX_CANDIDATES = 60;

// Tag names that are never the article itself and are always stripped out
// of a candidate before it's scored or its text is read.
const READER_MODE_NOISE_TAGS = new Set([
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
  'iframe', 'form', 'button', 'svg',
]);

// id/class text matching this marks an element as noise even when its tag
// name alone wouldn't (e.g. a <div class="cookie-banner">). Checked against
// id and className together so it doesn't matter which attribute a given
// site happens to use.
const READER_MODE_NOISE_PATTERN =
  /nav|menu|sidebar|footer|header|comment|cookie|consent|banner|subscribe|newsletter|popup|modal|overlay|social|share|related|widget|breadcrumb|pagination|pager|advert|sponsor|promo|masthead|skip-link/i;

function readerModeIsNoise(el) {
  if (!el.tagName) return false;
  if (READER_MODE_NOISE_TAGS.has(el.tagName.toLowerCase())) return true;
  const signature = `${el.id || ''} ${el.className || ''}`;
  return READER_MODE_NOISE_PATTERN.test(signature);
}

// Removes noise descendants from root in place. root itself is assumed to
// have already passed (or deliberately skipped, like <body>) the same
// check, and is never removed by this step.
function readerModeStripNoise(root) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (readerModeIsNoise(el)) el.remove();
  }
  return root;
}

// Cheap text/link measurement via textContent (no layout/reflow needed),
// used only to score and compare candidates against each other. Runs on a
// stripped clone so scoring and the live page can never affect each other.
function readerModeMeasure(root) {
  const clone = root.cloneNode(true);
  readerModeStripNoise(clone);
  const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
  let linkText = '';
  for (const a of clone.querySelectorAll('a')) linkText += a.textContent || '';
  linkText = linkText.replace(/\s+/g, ' ').trim();
  const linkDensity = text.length ? linkText.length / text.length : 1;
  const paragraphs = Array.from(clone.querySelectorAll('p'));
  const longParagraphCount = paragraphs.filter(
    (p) => (p.textContent || '').trim().length > 40
  ).length;
  return { textLength: text.length, linkDensity, longParagraphCount };
}

// Returns a numeric score, or null if root fails the minimum bar outright
// (too short, or too link-dense to plausibly be an article).
function readerModeScore(root) {
  const m = readerModeMeasure(root);
  if (m.textLength < READER_MODE_MIN_TEXT_LENGTH) return null;
  if (m.linkDensity > READER_MODE_MAX_LINK_DENSITY) return null;

  let score = m.textLength * (1 - m.linkDensity) + m.longParagraphCount * 50;
  const tag = root.tagName.toLowerCase();
  if (tag === 'article') score += 500;
  if (tag === 'main' || root.getAttribute('role') === 'main') score += 300;
  if (/\b(article|post|entry|story|content|main)\b/i.test(`${root.id || ''} ${root.className || ''}`)) {
    score += 200;
  }
  return score;
}

// Finds the best-scoring "article-shaped" container on the page and returns
// its cleaned text, or null if nothing scores well enough to be confident -
// the caller then falls through to the plain innerText fallback exactly as
// it did before this function existed.
function extractReaderModeArticle() {
  const candidateSelector =
    'article, main, [role="main"], [class*="article"], [class*="post"], ' +
    '[class*="content"], [id*="article"], [id*="content"], [id*="main"]';
  const seen = new Set();
  const candidates = [];
  for (const el of document.querySelectorAll(candidateSelector)) {
    if (seen.has(el) || readerModeIsNoise(el)) continue;
    seen.add(el);
    candidates.push(el);
  }
  if (candidates.length > READER_MODE_MAX_CANDIDATES) return null;
  // No semantic/heuristic container matched at all (rare, but possible on a
  // very plain or heavily-scripted page) - give <body> itself one chance
  // rather than giving up immediately.
  if (!candidates.length && document.body) candidates.push(document.body);

  let bestEl = null;
  let bestScore = -Infinity;
  for (const el of candidates) {
    const score = readerModeScore(el);
    if (score !== null && score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }
  if (!bestEl) return null;

  // Re-read the winning candidate's text with innerText, matching how every
  // other extractor in this file reads visible text, rather than reusing
  // the cheap textContent-based measurement above. innerText needs real
  // layout, so the stripped clone is attached to the live document in an
  // off-screen (not display:none - that would report empty) holder just
  // long enough to read it, then removed again; the live page itself is
  // never modified.
  const clone = bestEl.cloneNode(true);
  readerModeStripNoise(clone);
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute; left:-99999px; top:0;';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  let text = '';
  try {
    text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    holder.remove();
  }
  if (text.length < READER_MODE_MIN_TEXT_LENGTH) return null;

  return {
    source: 'reader-mode',
    title: document.title,
    url: location.href,
    text: text.slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  };
}

function extractPageContent() {
  const mailPlus = extractSynologyMailPlus();
  if (mailPlus) return mailPlus;

  const protonMail = extractProtonMail();
  if (protonMail) return protonMail;

  const readerMode = extractReaderModeArticle();
  if (readerMode) return readerMode;

  return {
    source: 'generic-page',
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || document.documentElement?.innerText || '').slice(0, PAGE_CONTEXT_CHAR_LIMIT),
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
