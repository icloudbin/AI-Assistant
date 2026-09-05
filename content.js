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
//
// This file is also injected on demand from sidepanel.js via
// chrome.scripting.executeScript when the registered content script is
// unreachable (e.g. the extension was reloaded while this tab stayed open,
// or the message raced document_idle). Everything therefore lives inside
// the single aiAssistantPageExtractor() function declaration below:
// re-injecting redeclares that function without error (top-level const/let
// would throw on re-injection), and the extractor closure is pure DOM code
// with no chrome.* calls, so even a closure captured by a stale, orphaned
// script instance still extracts correctly when the live listener below
// invokes it.

function aiAssistantPageExtractor() {

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


// Reddit uses custom <shreddit-post> and <shreddit-comment> elements.
// The main post has its article body inside the post element itself;
// comments are separate custom elements. Handle this before generic
// reader-mode heuristics so a comment is never mistaken for the article.
function extractRedditArticle() {
  const host = String(location.hostname || '').toLowerCase();
  if (!/(^|\.)reddit\.com$/.test(host) && !/(^|\.)old\.reddit\.com$/.test(host)) {
    return null;
  }

  const post = document.querySelector('shreddit-post[id^="t3_"], shreddit-post[post-type], shreddit-post');
  if (!post) return null;

  const title =
    String(post.getAttribute('post-title') || '').trim() ||
    (post.querySelector('h1[slot="title"], h1[id^="post-title-"], h1')?.innerText || '').replace(/\s+/g, ' ').trim() ||
    document.title;

  // IMPORTANT: scope body lookup to the main shreddit-post element.
  // Do not use document.querySelector('.md') because Reddit comments also
  // use .md and would otherwise be selected instead of the main post.
  const bodySelectors = [
    'shreddit-post-text-body .md[property="schema:articleBody"]',
    'shreddit-post-text-body [property="schema:articleBody"]',
    'shreddit-post-text-body .md',
    '[slot="text-body"] .md[property="schema:articleBody"]',
    '[slot="text-body"] [property="schema:articleBody"]',
    'div.md[property="schema:articleBody"]',
  ];

  let bodyEl = null;
  for (const selector of bodySelectors) {
    const el = post.querySelector(selector);
    const text = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) {
      bodyEl = el;
      break;
    }
  }

  // Some Reddit layouts expose the body through a direct text-body slot.
  if (!bodyEl) {
    const slotBody = post.querySelector('[slot="text-body"]');
    const text = (slotBody?.innerText || slotBody?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) bodyEl = slotBody;
  }

  if (!bodyEl) return null;

  const articleText = (bodyEl.innerText || bodyEl.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!articleText) return null;

  const parts = [];
  if (title) parts.push(`MAIN ARTICLE TITLE:\n${title}`);
  parts.push(`MAIN ARTICLE:\n${articleText}`);

  // Add comments only after the main article. Scope the lookup to comments
  // and never let comment content participate in main-post selection.
  const comments = [];
  const seen = new Set();
  for (const comment of Array.from(document.querySelectorAll('shreddit-comment'))) {
    if (seen.has(comment)) continue;
    seen.add(comment);

    // Skip comments that are clearly promoted/advertising containers.
    const wrapper = comment.closest('shreddit-comments-page-ad, [data-testid*="ad"], [id*="ad"]');
    if (wrapper) continue;

    const commentBody = comment.querySelector(
      '.md[property="schema:commentBody"], [property="schema:commentBody"], .md'
    );
    const text = (commentBody?.innerText || commentBody?.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text) comments.push(text);
  }

  if (comments.length) {
    parts.push(`COMMENTS:\n${comments.join('\n\n---\n\n')}`);
  }

  return {
    source: 'reddit',
    title: title || document.title,
    url: location.href,
    text: parts.join('\n\n').slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  };
}

// Synology Community forum pages use a dedicated #original-post container for
// the thread's main article, while replies/comments live in separate
// .reply-panel / comment containers. Prefer this structure explicitly so a
// forum thread is never mistaken for a generic article containing replies.
function extractSynologyCommunity() {
  const host = String(location.hostname || '').toLowerCase();
  if (!/(^|\.)community\.synology\.com$/.test(host)) return null;

  // Synology Community has a stable thread structure:
  //   #original-post                  -> the topic / main article
  //   #replies-container .reply-panel -> replies
  // The main post and replies can both contain .editor-tinymce-container,
  // therefore the selector must always start from #original-post.
  const original = document.querySelector('#original-post');
  if (!original) return null;

  const title = (
    original.querySelector('h1.post-title, h2.post-title, .post-title')?.innerText ||
    document.title ||
    ''
  ).replace(/\s+/g, ' ').trim();

  const bodyCandidates = [
    '#original-post .editor-tinymce-container',
    '#original-post [class*="editor-tinymce-container"]',
    '#original-post .post-content',
    '#original-post .article-content',
    '#original-post [class*="post-content"]',
  ];

  let articleBody = null;
  for (const selector of bodyCandidates) {
    const el = original.querySelector(selector);
    const value = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (value) {
      articleBody = el;
      break;
    }
  }
  if (!articleBody) return null;

  const articleText = (articleBody.innerText || articleBody.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!articleText) return null;

  const parts = [];
  if (title) parts.push(`MAIN ARTICLE TITLE:\n${title}`);
  parts.push(`MAIN ARTICLE:\n${articleText}`);

  // Replies/comments are deliberately collected only AFTER the main article.
  // Never search the whole document for .editor-tinymce-container here.
  const repliesRoot = document.querySelector('#replies-container');
  if (repliesRoot) {
    const replies = [];
    const replyPanels = repliesRoot.querySelectorAll(':scope > .reply-panel, .reply-panel');

    for (const panel of replyPanels) {
      const clone = panel.cloneNode(true);
      for (const noise of Array.from(clone.querySelectorAll(
        'header, nav, footer, aside, script, style, noscript, iframe, form, button, svg, ' +
        '.post-action-buttons, .btn-group, .com_btn_like, .reply-bottom-block, ' +
        '.quick-r-btn, .post-avatar, .post-avatar-name, .post-avatar-date'
      ))) {
        noise.remove();
      }

      // Prefer the actual reply post body; then include nested comment bodies.
      const replyBody = clone.querySelector('.replay-main-post .editor-tinymce-container, .replay-main-post [class*="editor-tinymce-container"]');
      const replyText = (replyBody?.innerText || replyBody?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      const commentTexts = Array.from(clone.querySelectorAll('.comment-content'))
        .map((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const combined = [replyText, ...commentTexts].filter(Boolean).join('\n\n');
      if (combined) replies.push(combined);
    }

    if (replies.length) {
      parts.push(`REPLIES AND COMMENTS:\n${replies.join('\n\n---\n\n')}`);
    }
  }

  return {
    source: 'synology-community',
    title: title || document.title,
    url: location.href,
    text: parts.join('\n\n').slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  };
}

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

  const reddit = extractRedditArticle();
  if (reddit) return reddit;

  const synologyCommunity = extractSynologyCommunity();
  if (synologyCommunity) return synologyCommunity;

  const readerMode = extractReaderModeArticle();
  if (readerMode) return readerMode;

  // Last-resort extraction: still exclude common page chrome/noise rather
  // than returning document.body.innerText verbatim. This is important for
  // quick actions such as Translate: when a page has no obvious <article> or
  // <main>, the model should receive the readable page content without
  // navigation, headers, footers, sidebars, cookie banners, and ads.
  if (!document.body) return null;

  const clone = document.body.cloneNode(true);
  readerModeStripNoise(clone);
  const text = (clone.innerText || clone.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;

  return {
    source: 'generic-page-cleaned',
    title: document.title,
    url: location.href,
    text: text.slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  };
}

  return { extractPageContent };
}

if (!globalThis.__aiAssistantPageExtractor) {
  globalThis.__aiAssistantPageExtractor = aiAssistantPageExtractor;
}

// Registered unconditionally (not behind the flag above): on re-injection
// the previously registered listener may be gone or dead, and a duplicate
// live registration - possible only when this injection races the manifest
// content script's document_idle registration - is benign, since both
// listeners extract identical content and the first sendResponse wins.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "EXTRACT_PAGE_CONTENT") return false;
  sendResponse({ ok: true, data: globalThis.__aiAssistantPageExtractor().extractPageContent() });
  return false;
});
