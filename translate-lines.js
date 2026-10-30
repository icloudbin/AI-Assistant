// translate-lines.js
//
// Deterministic, format-preserving translation. Asking a model to "keep the
// format" is unreliable, so the layout is never delegated to it:
//   1. The source text is split into lines. Blank lines, indentation, trailing
//      horizontal whitespace, list markers / numbering ("1.", "-", "•", "#",
//      ">") and lines with no letters (separators, bare numbers) stay in code.
//   2. Only the translatable text of each remaining line is sent to the model,
//      tagged "[n] text".
//   3. The model's "[n] translation" lines are streamed back through
//      LineTranslator, which re-inserts the original structure around each
//      translation. A missing line falls back to its original text; extra
//      commentary from the model is dropped.
// The result always has exactly the same line layout as the source.

import { cutAtCodePointBoundary } from "./models.js";

// List markers / numbering that stay in code: latin "1."/"1)" (the space
// after is mandatory so "3.14" never loses its "3."), CJK enumerators
// "1、"/"一、" (written tight against the text, so no space required),
// en/em-dash bullets, and markdown "#".
const PREFIX_RE = /^(\s*(?:>\s?)*(?:(?:\d+[.)]\s+|[一二三四五六七八九十]{1,3}[、.]\s*|\d+[、．]\s*|[-*+•·◦▪–—]\s+|#{1,6}\s+))?)/;
// A fence may sit inside a blockquote; content.js emits every quoted line
// with a "> " prefix, so "> ```" must toggle the fence state too - otherwise
// quoted code is sent to the model as translatable text and gets garbled.
const FENCE_RE = /^\s*(?:>\s?)*(```|~~~)/;
// A line that merely CONTAINS ``` (an inline span like "```code``` more")
// is not a fence: the span opens and closes on the same line, so only an
// ODD number of ```/~~~ runs toggles the fence state. Without this check a
// transcript line starting with ``` turned every following line into "code"
// and - via the identity fallback - silently skipped the whole translation.
const FENCE_RUN_RE = /```|~~~/g;
const IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
// Things the model must never touch: inline code, link/image targets, bare
// URLs. Link targets may contain one balanced parenthesis level
// (Wikipedia-style ".../Foo_(bar)") - without it the target was cut at the
// inner ")" and a stray ")" stayed in the translatable text.
// A literal {{U0}}-style token already present in the SOURCE (a page about
// template syntax, or this protocol itself) must also be protected: left
// alone, restore() rewrote it to the line's own protected token at that
// index ("use the token {{U0}}" became "use the token https://..."). Being
// protected, it round-trips to itself whatever index it receives.
const PROTECT_RE = /`[^`\n]+`|\]\((?:[^()\s]|\([^()\s]*\))+\)|https?:\/\/[^\s)\]>]+|\{\{\s*U\d+\s*\}\}/g;

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
// "[3] text" from the model - optionally markdown-escaped as "\[3\] text",
// exactly like PLACEHOLDER_RE tolerates escaped brackets in pii-filter.js.
const TAG_RE = /^\s*\\?\[(\d+)\\?\]\s?(.*)$/;

export function prepareLineTranslation(source, maxChars = 120000) {
  let text = String(source ?? "").replace(/\r\n?/g, "\n");
  let truncated = false;
  if (text.length > maxChars) {
    truncated = true;
    // Cut between code points: a UTF-16 slice can halve an emoji / astral
    // character and send a lone surrogate to the model (every other text cap
    // in the codebase goes through this helper - see models.js).
    text = cutAtCodePointBoundary(text, maxChars);
    const cut = text.lastIndexOf("\n");
    if (cut > 0) text = text.slice(0, cut);
  }
  const rawLines = text.split("\n");
  let inFence = false;
  const lines = rawLines.map((raw) => {
    const isFence = FENCE_RE.test(raw) && (raw.match(FENCE_RUN_RE) || []).length % 2 === 1;
    if (isFence) inFence = !inFence;
    const prefix = raw.match(PREFIX_RE)[1];
    const bodyAndTrailingWhitespace = raw.slice(prefix.length);
    const trailingWhitespace = bodyAndTrailingWhitespace.match(/[ \t]+$/)?.[0] || "";
    const body = trailingWhitespace
      ? bodyAndTrailingWhitespace.slice(0, -trailingWhitespace.length)
      : bodyAndTrailingWhitespace;
    // Code (inside fences), fence lines, image lines and letter-less lines stay as they are.
    const translatable = !isFence && !inFence && !IMAGE_LINE_RE.test(raw) && HAS_LETTER_RE.test(body);
    const p = translatable ? protect(body) : { text: body, tokens: [] };
    return { raw, prefix, body, trailingWhitespace, safe: p.text, tokens: p.tokens, translatable };
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
    this.write(`${l.prefix}${translatedText || l.body}${l.trailingWhitespace}`);
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
    // CJK scripts write no spaces between words: a model wrapping a long
    // Chinese/Japanese/Korean line must be re-joined WITHOUT the inserted
    // space (你好世 + 界 -> 你好世界); spaced scripts keep it.
    if (this.heldId >= 0 && !this.skipping && line.trim()) {
      const t = line.trim();
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
      const sep = cjk.test(this.heldText.slice(-1)) && cjk.test(t[0]) ? "" : " ";
      this.heldText += sep + t;
    }
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
