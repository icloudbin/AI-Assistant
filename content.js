// content.js
//
// Extract the current page context, tried in this order:
//   1. Synology MailPlus - a dynamic ExtJS panel; the message body isn't
//      reachable via plain document.body.innerText, and its mail list can
//      be much larger than the extension's page-context
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
// This file is no longer registered in manifest.json content_scripts; it is
// injected on demand from sidepanel.js via chrome.scripting.executeScript
// when the user asks for page context (and again if an earlier instance is
// unreachable, e.g. the extension was reloaded while this tab stayed open). Everything therefore lives inside
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

  // Fallback lookups match a class *word* ("mail-to", "to-list"), never a mere
  // substring: [class*="to"] also matches "button", "bottom", "toolbar" and
  // returned arbitrary page text (sometimes the whole message) as the recipient.
  const byClassWord = (word) => {
    const re = new RegExp(`(?:^|[\\s_-])${word}(?:$|[\\s_-])`, 'i');
    return Array.from(message.querySelectorAll('[class]')).find((el) => re.test(el.getAttribute('class') || ''));
  };

  const sender =
    message.querySelector('.from')?.innerText?.trim() ||
    byClassWord('from')?.innerText?.trim() ||
    '';

  const recipient =
    message.querySelector('.to')?.innerText?.trim() ||
    byClassWord('to')?.innerText?.trim() ||
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

// Keep enough text to cover a complete ordinary webpage instead of keeping
// only its first screenful. The former 20,000-character limit regularly cut
// off content lower on ecommerce pages (including Amazon product bullets),
// before it could reach the model. 120,000 characters is about 30,000 English
// tokens: large enough for a full product page while still leaving room for
// the user's question, instructions, and conversation history.
const PAGE_CONTEXT_CHAR_LIMIT = 120000;
const PAGE_IMAGE_URL_LIMIT = 8;
const PAGE_IMAGE_MIN_DIMENSION = 120;
const PAGE_IMAGE_MIN_AREA = 12000;
const PAGE_IMAGE_NOISE_RE = /(?:^|[-_./])(?:ad|ads|advert|advertisement|banner|avatar|icon|logo|pixel|tracking|spacer)(?:[-_./]|$)/i;

// Returns a bounded list of meaningful visible <img> sources. The actual
// image bytes are fetched later by the extension service worker, where host
// permissions and strict size/type limits can be applied. CSS backgrounds and
// private/cookie-authenticated resources are deliberately not collected.
function extractPageImageUrls() {
  const urls = [];
  const seen = new Set();
  for (const img of document.images) {
    if (!img || img.getAttribute('aria-hidden') === 'true') continue;
    const style = getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    const rect = img.getBoundingClientRect();
    const width = Math.max(img.naturalWidth || 0, img.width || 0, Math.round(rect.width));
    const height = Math.max(img.naturalHeight || 0, img.height || 0, Math.round(rect.height));
    if (Math.max(width, height) < PAGE_IMAGE_MIN_DIMENSION || width * height < PAGE_IMAGE_MIN_AREA) continue;

    const raw = img.currentSrc || img.dataset.src || img.dataset.original || img.dataset.lazySrc || img.src || '';
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const hint = `${url.pathname} ${img.className || ''} ${img.id || ''}`;
    if (PAGE_IMAGE_NOISE_RE.test(hint) || seen.has(url.href)) continue;
    seen.add(url.href);
    urls.push(url.href);
    if (urls.length >= PAGE_IMAGE_URL_LIMIT) break;
  }
  return urls;
}

function withPageImages(result) {
  return result ? { ...result, imageUrls: extractPageImageUrls() } : null;
}

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

// Page DOMs are never modified or duplicated while extracting. Everything
// below only READS the live tree. The previous implementation cloned
// document.body (or the article container) and attached the clone to the live
// page for a moment to get layout-aware innerText. That fired page
// MutationObservers (breaking some SPAs and tripping anti-tamper/anti-bot
// scripts), briefly duplicated every id on the page, could re-trigger media
// and resource loading, and forced a full-page reflow on large documents.

// Nesting guard for the recursive walks below; real pages are far shallower.
const EXTRACT_MAX_DEPTH = 600;

// textContent of `root` with noise subtrees left out - the same text the old
// "clone, strip noise, read textContent" sequence produced, without the clone.
// Like readerModeStripNoise(), the root itself is never treated as noise.
function textContentWithoutNoise(root) {
  let text = '';
  const walk = (node, depth) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) text += c.nodeValue;
      else if (c.nodeType === 1 && depth < EXTRACT_MAX_DEPTH && !readerModeIsNoise(c)) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return text;
}

// Elements whose contents are never part of the readable page text.
const VISIBLE_TEXT_SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link',
  'canvas', 'object', 'embed', 'video', 'audio', 'iframe', 'svg', 'textarea',
]);

// Read-only stand-in for element.innerText on a noise-stripped copy. Walks the
// live tree and emulates the parts of innerText that matter for reading:
// elements that are display:none (any cause - [hidden], CSS classes) or
// visibility:hidden are left out, block-level elements start and end a line
// (<p> a blank line), <br> is a newline, table cells are tab-separated, and
// whitespace is collapsed unless the element is preformatted. Noise elements
// (see readerModeIsNoise) are skipped exactly as readerModeStripNoise() removed
// them. Nothing is cloned, inserted, or modified.
function readVisibleText(root) {
  const items = []; // text tokens ({ text, pre }) and required-line-break counts (numbers)
  const pushBreak = (n) => {
    const last = items.length - 1;
    if (last >= 0 && typeof items[last] === 'number') {
      if (items[last] < n) items[last] = n;
    } else {
      items.push(n);
    }
  };

  const walk = (el, depth) => {
    const style = getComputedStyle(el);
    const display = style.display;
    if (display === 'none') return;
    const visible = style.visibility === 'visible';
    const ws = style.whiteSpace;
    const preserve = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
    const preLine = ws === 'pre-line';
    const isBlock = display !== 'inline' && display !== 'contents' && display !== 'table-cell' &&
      !display.startsWith('inline') && !display.startsWith('ruby');
    const breakCount = el.localName === 'p' ? 2 : 1;
    const closedDetails = el.localName === 'details' && !el.open;

    if (isBlock && visible) pushBreak(breakCount);
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (!visible || closedDetails) continue;
        let text = c.nodeValue;
        if (!preserve) {
          text = preLine
            ? text.replace(/[ \t\f\r]*\n[ \t\f\r]*/g, '\n').replace(/[ \t\f\r]+/g, ' ')
            : text.replace(/[ \t\n\r\f]+/g, ' ');
        }
        if (text) items.push({ text, pre: preserve });
      } else if (c.nodeType === 1) {
        const tag = c.localName;
        if (VISIBLE_TEXT_SKIP_TAGS.has(tag) || readerModeIsNoise(c)) continue;
        // The body of a collapsed <details> is not rendered; only <summary> is.
        if (closedDetails && tag !== 'summary') continue;
        if (tag === 'br') {
          if (visible) items.push({ text: '\n', pre: true });
        } else if (depth < EXTRACT_MAX_DEPTH) {
          walk(c, depth + 1);
        }
      }
    }
    if (isBlock && visible) pushBreak(breakCount);
    else if (display === 'table-cell' && visible && el.nextElementSibling) items.push({ text: '\t', pre: true });
  };
  walk(root, 0);

  // Assemble: adjacent line-break requirements merge to the largest one,
  // leading/trailing breaks are dropped, and collapsible spaces never start a
  // line, end a line, or double up across element boundaries. Built from an
  // array of parts with the last character tracked separately: re-scanning or
  // re-flattening one ever-growing string for every token is quadratic and took
  // seconds on very large pages.
  const parts = [];
  let last = ''; // last character emitted ('' while nothing has been emitted)
  const trimTrailingSpaces = () => {
    while (parts.length) {
      const part = parts[parts.length - 1];
      let end = part.length;
      while (end > 0 && part.charCodeAt(end - 1) === 32) end--;
      if (end === part.length) break;
      if (end === 0) parts.pop();
      else { parts[parts.length - 1] = part.slice(0, end); break; }
    }
    const tail = parts[parts.length - 1];
    last = tail ? tail[tail.length - 1] : '';
  };
  let pending = 0;
  for (const item of items) {
    if (typeof item === 'number') {
      if (item > pending) pending = item;
      continue;
    }
    let text = item.text;
    if (!item.pre && (!last || pending || last === ' ' || last === '\n' || last === '\t')) text = text.replace(/^ +/, '');
    if (!text) continue;
    if (pending && last) {
      trimTrailingSpaces();
      parts.push('\n'.repeat(pending));
    } else if (item.pre && text.startsWith('\n')) {
      trimTrailingSpaces();
    }
    pending = 0;
    parts.push(text);
    last = text[text.length - 1];
  }
  return parts.join('');
}

// Cheap text/link measurement (no layout/reflow needed), used only to score and
// compare candidates against each other. Reads the live tree directly and skips
// noise subtrees, so nothing is cloned and the live page is never affected.
function readerModeMeasure(root) {
  let linkText = '';
  let longParagraphCount = 0;
  const walk = (node, inLink, depth) => {
    let own = '';
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        own += c.nodeValue;
      } else if (c.nodeType === 1 && depth < EXTRACT_MAX_DEPTH && !readerModeIsNoise(c)) {
        const isLink = c.localName === 'a';
        const sub = walk(c, inLink || isLink, depth + 1);
        own += sub;
        if (isLink && !inLink) linkText += sub;
        if (c.localName === 'p' && sub.trim().length > 40) longParagraphCount++;
      }
    }
    return own;
  };
  const text = walk(root, false, 0).replace(/\s+/g, ' ').trim();
  linkText = linkText.replace(/\s+/g, ' ').trim();
  const linkDensity = text.length ? linkText.length / text.length : 1;
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

    // Skip comments that are clearly promoted/advertising containers. "ad" must
    // be a whole word in the id/test-id: the old [id*="ad"] substring match also
    // hit ids such as "thread", "header" or "loaded" and silently dropped real
    // comments.
    const isAdWord = (value) => /(?:^|[-_:\s])ads?(?:$|[-_:\s])/i.test(String(value || ''));
    let adWrapper = comment.closest('shreddit-comments-page-ad');
    for (let node = comment.parentElement; node && !adWrapper; node = node.parentElement) {
      if (isAdWord(node.id) || isAdWord(node.getAttribute('data-testid'))) adWrapper = node;
    }
    if (adWrapper) continue;

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

function findReaderModeBestEl() {
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
  return bestEl;
}

function extractReaderModeArticle() {
  const bestEl = findReaderModeBestEl();
  if (!bestEl) return null;

  // Re-read the winning candidate's visible, layout-aware text (rather than
  // reusing the cheap textContent-based measurement above) by walking the live
  // tree read-only - see readVisibleText(). The page is never modified.
  const text = readVisibleText(bestEl).replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < READER_MODE_MIN_TEXT_LENGTH) return null;

  return {
    source: 'reader-mode',
    title: document.title,
    url: location.href,
    text: text.slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  };
}

// Amazon's product facts are distributed across several independent page
// modules rather than one article-shaped container. Put every product module
// before the cleaned full-page text so facts below a long navigation, offer,
// or recommendation section are never lost merely because they appear late in
// document order. textContent is intentional for these known product modules:
// Amazon keeps some details in collapsed panels, which innerText omits until a
// user expands them. Scripts, styles, and common page chrome are removed from
// the clone before it is read.
function extractAmazonProductPage() {
  const host = String(location.hostname || '').toLowerCase();
  if (!/(^|\.)amazon\.[a-z.]+$/.test(host)) return null;

  const sectionSelectors = [
    '#productTitle',
    '#feature-bullets',
    '#productDescription',
    '#productDescription_feature_div',
    '#aplus',
    '#aplus_feature_div',
    '#aplus3p_feature_div',
    '#productOverview_feature_div',
    '#detailBulletsWrapper_feature_div',
    '#detailBullets_feature_div',
    '#prodDetails',
    '#productDetails_feature_div',
    '#productDetails_db_sections',
    '#productFactsDesktopExpander',
    '#productFactsMobileExpander',
  ];
  const seen = new Set();
  const sections = [];

  for (const selector of sectionSelectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const text = textContentWithoutNoise(el).replace(/\s+/g, ' ').trim();
      if (text) sections.push(text);
    }
  }
  if (!sections.length) return null;

  // Preserve a cleaned representation of the rest of the page as well. This
  // lets questions about material outside the standard product modules still
  // use the full page, while product facts remain at the front of the context.
  const fullPageText = document.body
    ? readVisibleText(document.body).replace(/\n{3,}/g, '\n\n').trim()
    : '';

  const text = [
    'AMAZON PRODUCT INFORMATION:',
    sections.join('\n\n'),
    fullPageText ? `FULL READABLE PAGE:\n${fullPageText}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    source: 'amazon-product',
    title: document.title,
    url: location.href,
    text: text.slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Structure-preserving extraction (used by Translate).
//
// readVisibleText() above flattens a page to plain text: heading levels, list
// markers/numbering, table structure, links, bold/italic and code blocks are
// all lost before the text ever reaches the model, so a translation can never
// reproduce them. This converts the DOM to Markdown instead, keeping that
// structure explicit in the text. Only scripts/menus/ads/hidden elements are
// skipped; <header> content (article titles) is kept.
// ---------------------------------------------------------------------------
const MD_SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
  'embed', 'video', 'audio', 'button', 'form', 'select', 'input', 'textarea',
  'nav', 'aside', 'footer', 'head', 'title', 'meta', 'link',
]);
const MD_NOISE_PATTERN = /cookie|consent|banner|newsletter|popup|modal|overlay|advert|sponsor|skip-link/i;
const MD_BLOCK_TAGS = new Set([
  'address', 'article', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'ul', 'caption',
]);
const MD_BLOCK_SELECTOR = 'p,div,ul,ol,li,table,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,figure';
const MD_LIST_MARK = '\u0001';

function mdDisplay(el) {
  try { return getComputedStyle(el).display || ''; } catch (err) { return ''; }
}

function mdSkip(el) {
  if (MD_SKIP_TAGS.has(el.localName)) return true;
  if (el.hasAttribute('hidden')) return true;
  if (mdDisplay(el) === 'none') return true;
  const sig = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
  return MD_NOISE_PATTERN.test(sig);
}

function mdIsBlock(el) {
  if (MD_BLOCK_TAGS.has(el.localName)) return true;
  const d = mdDisplay(el);
  return !!d && d !== 'inline' && d !== 'contents' && d !== 'table-cell' && !d.startsWith('inline') && !d.startsWith('ruby');
}

function mdAbsUrl(u) {
  try {
    const x = new URL(u, location.href);
    return /^(https?:|mailto:)$/.test(x.protocol) ? x.href : '';
  } catch (err) { return ''; }
}

function mdWrap(inner, mark) {
  const core = inner.trim();
  if (!core || core.includes('\n')) return inner;
  return `${inner.match(/^\s*/)[0]}${mark}${core}${mark}${inner.match(/\s*$/)[0]}`;
}

function mdInlineList(nodes, pre) {
  let out = '';
  for (const c of nodes) {
    if (c.nodeType === 3) {
      out += pre ? c.nodeValue : c.nodeValue.replace(/[ \t\r\n\f]+/g, ' ');
      continue;
    }
    if (c.nodeType !== 1 || mdSkip(c)) continue;
    const tag = c.localName;
    if (tag === 'br') { out += '\n'; continue; }
    if (tag === 'img') {
      const src = mdAbsUrl(c.getAttribute('src') || '');
      if (src) out += `![${(c.getAttribute('alt') || '').replace(/[\[\]\n]/g, ' ').trim()}](${src})`;
      continue;
    }
    const inner = mdInlineList(Array.from(c.childNodes), pre);
    if (tag === 'strong' || tag === 'b') out += mdWrap(inner, '**');
    else if (tag === 'em' || tag === 'i') out += mdWrap(inner, '*');
    else if (tag === 'code' || tag === 'kbd' || tag === 'samp') out += inner.trim() ? `\`${inner.trim().replace(/`/g, "'")}\`` : inner;
    else if (tag === 'a') {
      const href = mdAbsUrl(c.getAttribute('href') || '');
      const label = inner.replace(/[\[\]]/g, '').trim();
      out += href && label && !label.includes('\n') ? `${inner.match(/^\s*/)[0]}[${label}](${href})${inner.match(/\s*$/)[0]}` : inner;
    } else if (mdIsBlock(c)) out += ` ${inner} `;
    else out += inner;
  }
  return out;
}

function mdCleanInline(text) {
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function mdTable(el) {
  const rows = [];
  for (const tr of el.querySelectorAll('tr')) {
    const cells = Array.from(tr.children)
      .filter((cell) => cell.localName === 'td' || cell.localName === 'th')
      .map((cell) => mdInlineList(Array.from(cell.childNodes), false).replace(/\s+/g, ' ').replace(/\|/g, '/').trim());
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const lines = rows.map((r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

function mdList(el, depth) {
  const ordered = el.localName === 'ol';
  let n = parseInt(el.getAttribute('start') || '1', 10) || 1;
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const li of el.children) {
    if (li.localName !== 'li' || mdSkip(li)) continue;
    const blocks = mdBlocksOf(li, depth + 1);
    const marker = ordered ? `${n++}. ` : '- ';
    let first = true;
    for (const block of blocks) {
      if (block.startsWith(MD_LIST_MARK)) {
        lines.push(block.slice(1));
      } else {
        const text = block.split('\n').map((l, i) => (first && i === 0 ? `${pad}${marker}${l}` : `${pad}   ${l}`)).join('\n');
        lines.push(text);
        first = false;
      }
    }
  }
  return lines.join('\n');
}

function mdBlocksOf(root, depth = 0) {
  const blocks = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const text = mdCleanInline(mdInlineList(run, false));
    run = [];
    if (text) blocks.push(text);
  };
  const visit = (parent) => {
    for (const c of Array.from(parent.childNodes)) {
      if (c.nodeType === 3) { run.push(c); continue; }
      if (c.nodeType !== 1 || mdSkip(c)) continue;
      const tag = c.localName;
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const text = mdInlineList(Array.from(c.childNodes), false).replace(/\s+/g, ' ').trim();
        if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      } else if (tag === 'ul' || tag === 'ol') {
        flush();
        const list = mdList(c, depth);
        if (list) blocks.push(depth > 0 ? MD_LIST_MARK + list : list);
      } else if (tag === 'blockquote') {
        flush();
        const inner = mdBlocksOf(c, 0).map((b) => b.replace(new RegExp(MD_LIST_MARK, 'g'), '')).join('\n\n');
        if (inner) blocks.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      } else if (tag === 'pre') {
        flush();
        const code = (c.textContent || '').replace(/\n+$/, '');
        if (code.trim()) blocks.push('```\n' + code + '\n```');
      } else if (tag === 'table') {
        flush();
        const table = mdTable(c);
        if (table) blocks.push(table);
      } else if (tag === 'hr') {
        flush();
        blocks.push('---');
      } else if (mdIsBlock(c) || c.querySelector(MD_BLOCK_SELECTOR)) {
        flush();
        visit(c);
        flush();
      } else {
        run.push(c);
      }
    }
  };
  visit(root);
  flush();
  return blocks;
}

function mdCut(text) {
  let out = text.replace(new RegExp(MD_LIST_MARK, 'g'), '').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > PAGE_CONTEXT_CHAR_LIMIT) {
    out = out.slice(0, PAGE_CONTEXT_CHAR_LIMIT);
    const cut = out.lastIndexOf('\n');
    if (cut > 0) out = out.slice(0, cut);
  }
  return out;
}

function extractPageMarkdownContent() {
  const roots = [findReaderModeBestEl(), document.body].filter(Boolean);
  for (let i = 0; i < roots.length; i++) {
    const text = mdCut(mdBlocksOf(roots[i]).join('\n\n'));
    if (text && (text.length >= READER_MODE_MIN_TEXT_LENGTH || i === roots.length - 1)) {
      return { source: 'markdown-page', format: 'markdown', title: document.title, url: location.href, text };
    }
  }
  return null;
}

// The current selection as Markdown (null when nothing is selected).
function extractSelectionMarkdown() {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const holder = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) holder.appendChild(sel.getRangeAt(i).cloneContents());
  const text = mdCut(mdBlocksOf(holder).join('\n\n'));
  if (!text) return null;
  const structured = /^(#{1,6} |[-*] |\d+\. |> |\||```)/m.test(text) || /\*\*|\]\(|`/.test(text);
  return { text, structured };
}

function extractPageContent(opts) {
  const mailPlus = extractSynologyMailPlus();
  if (mailPlus) return withPageImages(mailPlus);

  const protonMail = extractProtonMail();
  if (protonMail) return withPageImages(protonMail);

  const reddit = extractRedditArticle();
  if (reddit) return withPageImages(reddit);

  const synologyCommunity = extractSynologyCommunity();
  if (synologyCommunity) return withPageImages(synologyCommunity);

  const amazonProduct = extractAmazonProductPage();
  if (amazonProduct) return withPageImages(amazonProduct);

  if (opts && opts.markdown) {
    const markdownPage = extractPageMarkdownContent();
    if (markdownPage) return withPageImages(markdownPage);
  }

  const readerMode = extractReaderModeArticle();
  if (readerMode) return withPageImages(readerMode);

  // Last-resort extraction: still exclude common page chrome/noise rather
  // than returning document.body.innerText verbatim. This is important for
  // quick actions such as Translate: when a page has no obvious <article> or
  // <main>, the model should receive the readable page content without
  // navigation, headers, footers, sidebars, cookie banners, and ads.
  if (!document.body) return null;

  // Walk the live tree read-only (see readVisibleText): the page is never
  // cloned, modified, or re-laid-out.
  const text = readVisibleText(document.body).replace(/\n{3,}/g, '\n\n').trim();
  // A page can be meaningful even when it has no extractable text, such as
  // an image gallery or a scanned document. Keep that page available to the
  // quick actions when it contains eligible images, so they can still be
  // fetched and included in the model request.
  if (!text) {
    const imageUrls = extractPageImageUrls();
    if (!imageUrls.length) return null;
    return {
      source: 'generic-page-images',
      title: document.title,
      url: location.href,
      text: '',
      imageUrls,
    };
  }

  return withPageImages({
    source: 'generic-page-cleaned',
    title: document.title,
    url: location.href,
    text: text.slice(0, PAGE_CONTEXT_CHAR_LIMIT),
  });
}

  return { extractPageContent, extractSelectionMarkdown };
}

if (!globalThis.__aiAssistantPageExtractor) {
  globalThis.__aiAssistantPageExtractor = aiAssistantPageExtractor;
}

// content.js is injected on demand (chrome.scripting.executeScript), and every
// injection into the same tab runs again in the SAME isolated world, so each
// run would otherwise add one more message listener - N injections meant the
// extractor ran N times per request. The listener is therefore registered
// unconditionally (a re-injection after an extension reload needs a live one),
// but the previously registered one is removed first, so exactly one is ever
// active per page.
if (globalThis.__aiAssistantMessageListener) {
  try { chrome.runtime.onMessage.removeListener(globalThis.__aiAssistantMessageListener); } catch (err) { /* orphaned context: nothing to remove */ }
}
globalThis.__aiAssistantMessageListener = (msg, sender, sendResponse) => {
  if (msg?.type !== "EXTRACT_PAGE_CONTENT") return false;
  // Only the extension's own pages (side panel) may request page text. Reject
  // other extensions, and anything carrying a tab (another content script)
  // or a non-extension URL. Web pages cannot reach this listener at all.
  if (
    !sender ||
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    typeof sender.url !== "string" ||
    !sender.url.startsWith(chrome.runtime.getURL(""))
  ) {
    return false;
  }
  // Always answer: an exception inside the extractor used to leave the sender
  // with "message port closed before a response was received" and no data.
  try {
    sendResponse({ ok: true, data: globalThis.__aiAssistantPageExtractor().extractPageContent({ markdown: msg.format === 'markdown' }) });
  } catch (err) {
    sendResponse({ ok: false, error: String(err?.message || err) });
  }
  return false;
};
chrome.runtime.onMessage.addListener(globalThis.__aiAssistantMessageListener);
