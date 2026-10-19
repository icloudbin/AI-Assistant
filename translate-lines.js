// translate-lines.js
//
// Deterministic, format-preserving translation. Asking a model to "keep the
// format" is unreliable, so the layout is never delegated to it:
//   1. The source text is split into lines. Blank lines, indentation, list
//      markers / numbering ("1.", "-", "•", "#", ">") and lines with no
//      letters (separators, bare numbers) stay in code.
//   2. Only the translatable text of each remaining line is sent to the model,
//      tagged "[n] text".
//   3. The model's "[n] translation" lines are streamed back through
//      LineTranslator, which re-inserts the original structure around each
//      translation. A missing line falls back to its original text; extra
//      commentary from the model is dropped.
// The result always has exactly the same line layout as the source.

const PREFIX_RE = /^(\s*(?:>\s?)*(?:(?:\d+[.)]|[-*+•·◦▪]|#{1,6})\s+)?)/;
const FENCE_RE = /^\s*(```|~~~)/;
const IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
// Things the model must never touch: inline code, link/image targets, bare URLs.
const PROTECT_RE = /`[^`\n]+`|\]\(([^)\s]+)[^)]*\)|https?:\/\/[^\s)\]>]+/g;

function protect(body) {
  const tokens = [];
  const text = body.replace(PROTECT_RE, (m) => {
    const id = tokens.length;
    if (m.startsWith("](")) {
      const url = m.slice(2, m.indexOf(")") >= 0 ? m.lastIndexOf(")") : m.length);
      tokens.push(url);
      return `]({{U${id}}})`;
    }
    tokens.push(m);
    return `{{U${id}}}`;
  });
  return { text, tokens };
}

function restore(text, tokens) {
  return tokens.length ? text.replace(/\{\{\s*U(\d+)\s*\}\}/g, (m, i) => (tokens[Number(i)] ?? m)) : text;
}
const HAS_LETTER_RE = /\p{L}/u;
const TAG_RE = /^\s*\[(\d+)\]\s?(.*)$/;

export function prepareLineTranslation(source, maxChars = 120000) {
  let text = String(source ?? "").replace(/\r\n?/g, "\n");
  let truncated = false;
  if (text.length > maxChars) {
    truncated = true;
    text = text.slice(0, maxChars);
    const cut = text.lastIndexOf("\n");
    if (cut > 0) text = text.slice(0, cut);
  }
  text = text.replace(/\s+$/, "");
  const rawLines = text.split("\n");
  let inFence = false;
  const lines = rawLines.map((raw) => {
    const isFence = FENCE_RE.test(raw);
    if (isFence) inFence = !inFence;
    const prefix = raw.match(PREFIX_RE)[1];
    const body = raw.slice(prefix.length).replace(/\s+$/, "");
    // Code (inside fences), fence lines, image lines and letter-less lines stay as they are.
    const translatable = !isFence && !inFence && !IMAGE_LINE_RE.test(raw) && HAS_LETTER_RE.test(body);
    const p = translatable ? protect(body) : { text: body, tokens: [] };
    return { raw: raw.replace(/\s+$/, ""), prefix, body, safe: p.text, tokens: p.tokens, translatable };
  });
  const numbered = lines
    .map((l, i) => (l.translatable ? `[${i + 1}] ${l.safe}` : null))
    .filter((l) => l !== null)
    .join("\n");
  if (!numbered) return null;
  // truncated: the source was longer than maxChars and was cut here.
  // keptChars: how much of the source is being translated.
  return { lines, numbered, truncated, keptChars: text.length };
}

// Splits the numbered translatable lines into batches of at most `maxChars`
// characters (never splitting a line), so a long page is translated with
// several moderate requests instead of one whose reply can hit the model's
// output limit and be cut off. Line numbers stay global, so LineTranslator
// maps every batch back onto the right source line.
export function numberedBatches(prepared, maxChars = 8000) {
  const batches = [];
  let cur = [];
  let len = 0;
  prepared.lines.forEach((l, i) => {
    if (!l.translatable) return;
    const row = `[${i + 1}] ${l.safe}`;
    if (cur.length && len + row.length + 1 > maxChars) {
      batches.push(cur.join("\n"));
      cur = [];
      len = 0;
    }
    cur.push(row);
    len += row.length + 1;
  });
  if (cur.length) batches.push(cur.join("\n"));
  return batches;
}

export class LineTranslator {
  constructor(prepared, emit) {
    this.lines = prepared.lines;
    this.emit = emit;
    this.buf = "";
    this.next = 0;          // next source line index to output
    this.heldId = -1;       // index of the model line currently being collected
    this.heldText = "";
    this.skipping = false;  // inside a duplicate / out-of-range model line
    this.wrote = false;
    this.expected = prepared.lines.filter((l) => l.translatable).length;
    this.translated = 0;    // lines for which the model actually returned text
  }

  // Source lines that fell back to their original text because the model never
  // returned a translation for them (e.g. its reply was cut off).
  get missing() {
    return Math.max(0, this.expected - this.translated);
  }

  write(line) {
    this.emit((this.wrote ? "\n" : "") + line);
    this.wrote = true;
  }

  // Output untouched lines up to (not including) index `end`.
  fill(end) {
    while (this.next < end && this.next < this.lines.length) {
      const l = this.lines[this.next++];
      this.write(l.raw); // blank/static line, or untranslated fallback
    }
  }

  flushHeld() {
    if (this.heldId < 0) return;
    this.fill(this.heldId);
    const l = this.lines[this.heldId];
    const translatedText = restore(this.heldText.trim(), l.tokens);
    if (translatedText) this.translated++;
    this.write(`${l.prefix}${translatedText || l.body}`);
    this.next = this.heldId + 1;
    this.heldId = -1;
    this.heldText = "";
  }

  handleLine(line) {
    const m = line.match(TAG_RE);
    if (m) {
      const id = Number(m[1]) - 1;
      this.flushHeld();
      if (id >= this.next && id < this.lines.length && this.lines[id].translatable) {
        this.heldId = id;
        this.heldText = m[2];
        this.skipping = false;
      } else {
        this.skipping = true; // duplicate or unknown id
      }
      return;
    }
    // Untagged text: treat as a wrapped continuation of the current line.
    if (this.heldId >= 0 && !this.skipping && line.trim()) this.heldText += ` ${line.trim()}`;
  }

  push(delta) {
    this.buf += delta;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      this.handleLine(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  // End of one batch's reply: process what is buffered, but do not fill the
  // rest of the document yet - the next batch continues from here.
  endBatch() {
    if (this.buf) this.handleLine(this.buf);
    this.buf = "";
    this.flushHeld();
    this.skipping = false;
  }

  finish() {
    if (this.buf) this.handleLine(this.buf);
    this.buf = "";
    this.flushHeld();
    this.fill(this.lines.length);
  }
}
