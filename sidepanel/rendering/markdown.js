// sidepanel/rendering/markdown.js
//
// The Markdown-to-HTML pipeline for model replies: HTML escaping, inline
// formatting (emphasis, code spans, links and images - including titles in
// both raw and &quot;-escaped form), and the block-level renderer (headings,
// fences, quotes, GFM tables, nested lists with loose-list blank lines).
// Pure string functions - no DOM and no chrome.* - directly unit-testable in
// Node (scripts/test-markdown-render.mjs; a `location` stub is supplied
// there because link/image URLs resolve against the panel's own URL).
//
// SECURITY invariant: EVERYTHING passes through escapeHtml() before the
// link/image rules run, and generated tags are re-checked by
// sanitizeRenderedHtml() in sidepanel.js before insertion.

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// URL part of a Markdown link or image. Matches text that may contain one level
// of balanced parentheses, so Wikipedia-style "Foo_(bar)" survives. If the
// parentheses are unbalanced it falls back to everything up to the first ")".
// The optional CommonMark title (`[t](url "Title")`) is matched in BOTH raw and
// escaped form: these regexes run on text that has already been through
// escapeHtml (see inlineMarkdownToHtml), where every `"` is `&quot;` - a raw
// `"...` title group could never match and titled links/images degraded to
// literal text.
const MD_LINK_URL = String.raw`((?:[^()\s]|\([^()\s]*\))+|[^)\s]+)`;
const MD_IMAGE_RE = new RegExp(String.raw`!\[([^\]]*)\]\(` + MD_LINK_URL + String.raw`(?:\s+(?:"[^"]*"|&quot;[^"]*&quot;))?\)`, "g");
const MD_LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\(` + MD_LINK_URL + String.raw`(?:\s+(?:"[^"]*"|&quot;[^"]*&quot;))?\)`, "g");

function inlineMarkdownToHtml(text) {
  // Code spans and the generated tags below are swapped for placeholders while
  // the rules run and put back at the end. A placeholder is a private-use
  // character, the index and a second private-use character (U+E000..U+E003),
  // not printable text such as "@@HTMLTAG0@@": a model can write any printable
  // string, and a literal "@@INLINECODE0@@" in a reply used to be replaced by
  // the first code span while the real placeholder stayed in the output.
  // Private-use characters are not Markdown syntax, letters or digits, so no
  // rule below treats them specially, and any that are already in the text are
  // removed first, so the text can never contain a placeholder of its own.
  let s = escapeHtml(text).replace(/[\uE000-\uE003]/g, "");
  const codeToken = (i) => `\uE000${i}\uE001`;
  const tagToken = (i) => `\uE002${i}\uE003`;
  const codeSpans = [];
  // Generated <a>/<img> tags are kept out of the string while the emphasis
  // rules below run. Those rules work on the HTML built so far and would
  // otherwise rewrite characters inside href/src/alt (a URL containing
  // "_next_" or "*a*" gained <em> tags and led to the wrong address).
  const htmlTags = [];
  const stashTag = (html) => {
    const token = tagToken(htmlTags.length);
    htmlTags.push(html);
    return token;
  };
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = codeToken(codeSpans.length);
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  // Some models return image Markdown in a nested/escaped form such as:
  // ![image]([https://example.com/image.png](https://example.com/image.png))
  // or ![image]\(https://example.com/image.png\).
  // Normalize these common variants before parsing standard Markdown images.
  s = s.replace(
    /!\[([^\]]*)\]\(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\)/gi,
    (_, alt, _displayUrl, realUrl) => `![${alt}](${realUrl})`
  );
  s = s.replace(
    /!\[([^\]]*)\]\\\((https?:\/\/[^\s)]+)\\\)/gi,
    (_, alt, src) => `![${alt}](${src})`
  );

  // Markdown images. Process images before normal Markdown links so that
  // ![alt](url) is not accidentally consumed as [alt](url). Only allow
  // remote HTTP(S) images and image data URLs.
  s = s.replace(MD_IMAGE_RE, (_, alt, src) => {
    const rawSrc = src.replace(/&amp;/g, "&");
    try {
      const u = new URL(rawSrc, location.href);
      const isHttpImage = ["http:", "https:"].includes(u.protocol);
      const isDataImage = u.protocol === "data:" && /^data:image\/(?:png|jpeg|jpg|gif|webp);/i.test(rawSrc);
      if (!isHttpImage && !isDataImage) return `![${alt}](${src})`;
      const safeSrc = escapeHtml(isDataImage ? rawSrc : u.href);
      const safeAlt = escapeHtml(alt);
      return stashTag(`<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async">`);
    } catch {
      return `![${alt}](${src})`;
    }
  });

  // Markdown links: only permit safe navigable protocols.
  s = s.replace(MD_LINK_RE, (_, label, href) => {
    const rawHref = href.replace(/&amp;/g, "&");
    try {
      const u = new URL(rawHref, location.href);
      if (!["http:", "https:", "mailto:"].includes(u.protocol)) return label;

      // Some models ignore the requested Markdown-image syntax and return
      // [image](https://host/path/file.webp) instead. Treat links whose URL
      // clearly points at an image the worker can actually fetch as images,
      // so the conversation UI still renders the requested image rather than
      // showing a clickable "image" link. SVG is deliberately excluded: the
      // worker refuses SVG by content sniffing (see background.js), so an
      // .svg link converted here could only ever render a permanently
      // failing placeholder - it stays an ordinary link instead.
      const imagePath = u.pathname.toLowerCase();
      const isImageUrl = /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(imagePath);
      if (isImageUrl && (u.protocol === "http:" || u.protocol === "https:")) {
        const safeSrc = escapeHtml(u.href);
        const safeAlt = escapeHtml(label);
        return stashTag(`<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async">`);
      }

      const safeHref = escapeHtml(u.href);
      return `${stashTag(`<a href="${safeHref}" target="_blank" rel="noopener noreferrer">`)}${label}</a>`;
    } catch {
      return label;
    }
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // Underscore emphasis follows CommonMark's flanking rule: an intraword
  // underscore pair is not emphasis, so snake_case identifiers such as
  // foo_bar_baz survive rendering instead of becoming foo<em>bar</em>baz.
  // Both underscores must sit at a word boundary; `*` has no such rule and
  // is deliberately left unchanged below.
  s = s.replace(/(?<![\p{L}\p{N}])__([^_\n]+)__(?![\p{L}\p{N}])/gu, "<strong>$1</strong>");
  s = s.replace(/\*(?!\s)([^*\n]*[^*\s])\*/g, "<em>$1</em>");
  s = s.replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  for (let i = 0; i < codeSpans.length; i++) {
    // A replacer function is required: with a plain replacement string, "$&",
    // "$$", "$`" and "$'" inside the code span would be interpreted as special
    // replacement patterns and corrupt the output (e.g. `$&` in a regex).
    s = s.replace(codeToken(i), () => codeSpans[i]);
  }
  for (let i = 0; i < htmlTags.length; i++) {
    s = s.replace(tagToken(i), () => htmlTags[i]);
  }
  return s;
}

function isTableSeparator(line) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join("\n").trim();
    if (text) out.push(`<p>${inlineMarkdownToHtml(text).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) return;
    // Items carry their indentation and marker type, so nested lists, mixed
    // ordered/unordered nesting and an ordered list's start number survive.
    let html = "";
    const stack = []; // { indent, type }
    const closeTop = () => { html += `</li></${stack.pop().type}>`; };
    for (const item of listItems) {
      while (stack.length && item.indent < stack[stack.length - 1].indent) closeTop();
      const top = stack[stack.length - 1];
      if (!top || item.indent > top.indent) {
        const start = item.type === "ol" && item.num !== 1 ? ` start="${item.num}"` : "";
        html += `<${item.type}${start}><li>`;
        stack.push({ indent: item.indent, type: item.type });
      } else if (top.type !== item.type) {
        closeTop();
        const start = item.type === "ol" && item.num !== 1 ? ` start="${item.num}"` : "";
        html += `<${item.type}${start}><li>`;
        stack.push({ indent: item.indent, type: item.type });
      } else {
        html += "</li><li>";
      }
      html += inlineMarkdownToHtml(item.text).replace(/\n/g, "<br>");
    }
    while (stack.length) closeTop();
    out.push(html);
    listType = null;
    listItems = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      // A blank line ends the list UNLESS the list continues right after it.
      // Markdown (and real LLM output especially) commonly writes "loose"
      // lists with a blank line between items, particularly once an item's
      // text gets long - that's still one list, not a new one for every
      // item. Skip past any run of blank lines to the next real line; only
      // flush if that line isn't another item of the SAME list type
      // (switching from ordered to unordered, or ending the list entirely,
      // still correctly flushes).
      if (listType) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nextTrimmed = j < lines.length ? lines[j].trim() : "";
        const nextIndent = j < lines.length ? (lines[j].match(/^[ \t]*/)[0].replace(/\t/g, "    ").length) : 0;
        const continuesSameList =
          (listType === "ol" && /^\d+[.)]\s+/.test(nextTrimmed)) || (listType === "ul" && /^[-+*]\s+/.test(nextTrimmed)) ||
          (nextIndent > 0 && /^(?:\d+[.)]|[-+*])\s+/.test(nextTrimmed));
        if (!continuesSameList) flushList();
      }
      i++;
      continue;
    }

    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      flushParagraph();
      flushList();
      const fence = trimmed.slice(0, 3);
      const language = trimmed.slice(3).trim().split(/\s+/)[0] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const langClass = language ? ` class="language-${escapeHtml(language.replace(/[^a-zA-Z0-9_-]/g, ""))}"` : "";
      // Wrapped in .code-block (same idea as .table-wrap below, for a table)
      // so a copy button can be anchored to a container that doesn't itself
      // scroll horizontally - <pre> does, via overflow-x, so a button
      // positioned against <pre> directly would scroll out of view with
      // long lines.
      out.push(`<div class="code-block"><pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push("<hr>");
      i++;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inlineMarkdownToHtml(quoteLines.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }

    // GFM-style tables.
    if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const headHtml = headers.map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`).join("");
      const bodyHtml = rows.map((row) => `<tr>${headers.map((_, idx) => `<td>${inlineMarkdownToHtml(row[idx] || "")}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const unordered = trimmed.match(/^[-+*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      // A different marker type only starts a new list at the top level;
      // deeper (indented) items nest instead.
      if (listType && listType !== nextType && !(listItems.length && line.match(/^[ \t]*/)[0].length > 0)) flushList();
      if (!listType) listType = nextType;
      listItems.push({
        indent: line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length,
        type: nextType,
        num: ordered ? Number(trimmed.match(/^\d+/)[0]) : 1,
        text: (ordered || unordered)[1],
      });
      i++;
      continue;
    }

    // A non-blank line directly under a list item (an indented continuation
    // or a "lazy" continuation line) belongs to that item. Previously it was
    // pushed onto `paragraph`, which was flushed into the output BEFORE the
    // still-open list, so the text jumped above the list it belonged to.
    if (listType && listItems.length) {
      listItems[listItems.length - 1].text += `\n${trimmed}`;
      i++;
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }

  flushParagraph();
  flushList();
  return out.join("");
}

export { escapeHtml, inlineMarkdownToHtml, markdownToHtml, isTableSeparator, splitTableRow };
