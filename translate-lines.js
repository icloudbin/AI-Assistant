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

// Whether the model's raw reply kept exactly the line's {{Un}} tokens.
// restore() can only replace tokens that are still present: a model that drops
// {{U0}} silently deletes the URL / inline code / link target from the output,
// and a hallucinated {{U5}} would print as literal garbage. The check compares
// the MULTISETOF token VALUES the reply references against the line's own
// token values - exact, and immune to two traps: substring-matching restored
// values (an inline-code token like `a` is a substring of almost any sentence)
// and same-value tokens (a reply that writes {{U0}} twice for {{U0}}+{{U1}}
// restores to the correct text when both tokens hold the same URL, so raw
// index coverage would false-flag it). A violation marks the line
// untranslated: the original line (value intact) is written and the line
// counts toward `missing`, which fires the missing-lines NOTICE and gives the
// single-batch replay its chance.
function tokensKept(heldText, tokens) {
  const actual = [...heldText.matchAll(/\{\{\s*U(\d+)\s*\}\}/g)]
    .map((m) => tokens[Number(m[1])])
    .sort();
  const expected = [...tokens].sort();
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}
const HAS_LETTER_RE = /\p{L}/u;
// Whitespace-insensitive equality: a model that "translates" a line by echoing
// it back (with its own line wrapping re-joined) has not translated it.
const collapseWs = (s) => s.replace(/\s+/g, " ").trim();

// ---- echoes that are not misses ----------------------------------------------
// A model may hand a line back unchanged because it SHOULD stay as it is: a
// brand or product name ("GitHub"), an acronym ("OK"), an identifier, a shell
// command ("npm install"), a number with a unit, or a line holding nothing but
// protected spans (a URL, inline code). Counting those as untranslated fired the
// single-batch replay (a whole second request, whose echo was judged missing
// again) and a "N lines were not translated" notice for a translation that was
// in fact complete; multi-batch translations showed the same false notice.
//
// So a SHORT echo that does not read like a sentence is accepted. A sentence
// echoed back - 4+ words, sentence case ("Hello world"), or a closing full stop /
// question mark - is still a miss: that is how a lazy or confused reply looks,
// and the replay / notice is the right response to it. Only Latin-script text is
// waved through: a line in another script may simply be in a language other than
// the target, so an echo of it keeps counting as untranslated.
const SHORT_ECHO_MAX_WORDS = 3;
const PROTECTED_TOKEN_RE = /\{\{\s*U\d+\s*\}\}/g;
const LATIN_TEXT_RE = /^[\s\p{Script=Latin}\p{M}\p{N}\p{P}\p{S}\p{Z}]+$/u;
const bareWord = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

// `safeText` is the line as the model saw it ({{Un}} in place of every protected
// span, which the model can neither translate nor change).
function mayStayUntranslated(safeText) {
  const rest = safeText.replace(PROTECTED_TOKEN_RE, " ").trim();
  if (!HAS_LETTER_RE.test(rest)) return true; // only protected spans, digits, symbols
  if (!LATIN_TEXT_RE.test(rest)) return false;
  const words = rest.split(/\s+/).filter((w) => HAS_LETTER_RE.test(w));
  if (words.length > SHORT_ECHO_MAX_WORDS) return false;
  if (words.length > 1) {
    const [first, ...others] = words.map(bareWord);
    // "Hello world": a capitalized word followed by ordinary lowercase words is
    // a sentence. "Visual Studio Code", "NEW RELEASE" and "npm install" are not.
    const sentenceCase = /^\p{Lu}\p{Ll}+$/u.test(first) && others.some((w) => /^\p{Ll}[\p{Ll}'’-]*$/u.test(w));
    const sentenceEnd = /[.!?…]["'”’)\]]*$/.test(rest);
    if (sentenceCase || sentenceEnd) return false;
  }
  return true;
}
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
    const restored = restore(this.heldText.trim(), l.tokens);
    const tokensOk = tokensKept(this.heldText, l.tokens);
    const echo = !!restored && tokensOk && collapseWs(restored) === collapseWs(l.body);
    // Two ways a "translation" is not a translation: an echo of the source
    // line, or a reply that dropped (or hallucinated) a {{Un}} token - the
    // visible text would lose the URL / inline code / link target. Both fall
    // back to the original line and leave the line counted as missing - except
    // an echo of a line that plausibly needed no translation (a name, an
    // acronym, a command, a bare URL; see mayStayUntranslated), which is the
    // correct output: it is written as the source had it and counts as done.
    const usable = !!restored && tokensOk && (!echo || mayStayUntranslated(l.safe));
    const translatedText = usable ? (echo ? l.body : restored) : "";
    if (translatedText) this.translated++;
    this.write(`${l.prefix}${translatedText || l.body}${l.trailingWhitespace}`);
    this.next = this.heldId + 1;
    this.heldId = -1;
    this.heldText = "";
  }

  // Append a wrapped-continuation chunk to the held line's translation. CJK
  // scripts write no spaces between words: a model wrapping a long
  // Chinese/Japanese/Korean line must be re-joined WITHOUT the inserted
  // space (你好世 + 界 -> 你好世界); spaced scripts keep it.
  holdContinuation(t) {
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const sep = cjk.test(this.heldText.slice(-1)) && cjk.test(t[0]) ? "" : " ";
    this.heldText += sep + t;
  }

  handleLine(line) {
    const m = line.match(TAG_RE);
    if (m) {
      const id = Number(m[1]) - 1;
      const pendingPreFlush = id >= this.next && id < this.lines.length && this.lines[id].translatable;
      if (!pendingPreFlush && this.heldId >= 0 && !this.skipping && line.trim()) {
        // A tag that does not name a pending line, while a translation is
        // being collected: the model DROPPED its batch tag and the text
        // itself happens to start with "[n]" (e.g. the source line began
        // with a citation marker). Treating it as a tag silently skipped the
        // text; keep the whole line as the held line's continuation - the
        // token and echo checks below still guard what is kept. Residual
        // ambiguity (it could be the NEXT line's full reply) is accepted:
        // the text is preserved either way (round-17 #16).
        this.holdContinuation(line.trim());
        return;
      }
      this.flushHeld();
      const pending = id >= this.next && id < this.lines.length && this.lines[id].translatable;
      if (pending) {
        this.heldId = id;
        this.heldText = m[2];
        this.skipping = false;
      } else {
        this.skipping = true; // duplicate or unknown id
      }
      return;
    }
    // Untagged text: treat as a wrapped continuation of the current line.
    if (this.heldId >= 0 && !this.skipping && line.trim()) {
      this.holdContinuation(line.trim());
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
