#!/usr/bin/env node
import assert from "node:assert/strict";
import { prepareLineTranslation, LineTranslator } from "../translate-lines.js";
import { chooseTranslationSelection } from "../translation-selection.js";

const source = [
  "First source paragraph.",
  "",
  "Second source paragraph.",
  "",
  "Third source paragraph.",
  "",
  "Fourth source paragraph.",
].join("\n");

const prepared = prepareLineTranslation(source);
assert.ok(prepared, "paragraph source should prepare for translation");
let translated = "";
const translator = new LineTranslator(prepared, (delta) => { translated += delta; });
translator.push("[1] 第一段。\n[3] 第二段。\n[5] 第三段。\n[7] 第四段。");
translator.finish();
assert.equal(
  translated,
  ["第一段。", "", "第二段。", "", "第三段。", "", "第四段。"].join("\n"),
  "line translator must retain all blank-line paragraph separators"
);

// v1.10.163 (round-17 #16): a model that DROPS its batch tag and whose reply
// text itself starts with "[n]" (the source line began with a citation
// marker) must not have that reply silently skipped. The third reply drops
// its "[3]" tag - the text is kept as the held line's continuation.
{
  const numbered = prepareLineTranslation("First line.\nSecond line.\nSee [1] docs again");
  assert.ok(numbered, "numbered source prepares");
  let out = "";
  const t = new LineTranslator(numbered, (d) => { out += d; });
  t.push("[1] 第一行。\n[2] 第二行。\n[1] 参见文档");
  t.finish();
  // The dropped-tag reply is KEPT (appended to the held line) instead of
  // silently skipped; the last line itself falls back to its original.
  assert.ok(out.includes("参见文档"), "a dropped-tag reply is not silently skipped");
  assert.ok(out.includes("第二行。"), "the held line's own translation is kept");
  assert.ok(out.includes("See [1] docs again"), "the line whose tag was dropped falls back to its original");
}

// content.js represents each author-visible <br> in long-form page text as a
// blank-line paragraph separator before it enters the numbered protocol. The
// output must keep those separators so the side-panel Markdown renderer creates
// separate paragraphs instead of folding the whole post into one paragraph.
const sourceWithHtmlBreakParagraphs = [
  "First paragraph from a single HTML p element.",
  "",
  "Second paragraph after an author-visible br element.",
  "",
  "Third paragraph after another br element.",
].join("\n");
const htmlBreakPrepared = prepareLineTranslation(sourceWithHtmlBreakParagraphs);
assert.ok(htmlBreakPrepared, "HTML-break paragraphs should prepare for translation");
let htmlBreakTranslated = "";
const htmlBreakTranslator = new LineTranslator(htmlBreakPrepared, (delta) => { htmlBreakTranslated += delta; });
htmlBreakTranslator.push("[1] 第一段来自单个 HTML p 元素。\n[3] 第二段位于作者可见的 br 元素之后。\n[5] 第三段位于另一个 br 元素之后。");
htmlBreakTranslator.finish();
assert.equal(
  htmlBreakTranslated,
  ["第一段来自单个 HTML p 元素。", "", "第二段位于作者可见的 br 元素之后。", "", "第三段位于另一个 br 元素之后。"].join("\n"),
  "translations must retain paragraph breaks derived from HTML br elements"
);

const sourceWithTrailingWhitespace = [
  "```js",
  "const value = 1;  ",
  "```",
  "",
  "First source line with Markdown hard break  ",
  "Second source line.",
  "",
].join("\n");
const preparedWithTrailingWhitespace = prepareLineTranslation(sourceWithTrailingWhitespace);
assert.ok(preparedWithTrailingWhitespace, "source with trailing whitespace should prepare for translation");
let translatedWithTrailingWhitespace = "";
const trailingWhitespaceTranslator = new LineTranslator(
  preparedWithTrailingWhitespace,
  (delta) => { translatedWithTrailingWhitespace += delta; }
);
trailingWhitespaceTranslator.push("[5] 第一条翻译行\n[6] 第二条翻译行。");
trailingWhitespaceTranslator.finish();
assert.equal(
  translatedWithTrailingWhitespace,
  [
    "```js",
    "const value = 1;  ",
    "```",
    "",
    "第一条翻译行  ",
    "第二条翻译行。",
    "",
  ].join("\n"),
  "line translator must retain trailing spaces, Markdown hard breaks, and a final newline"
);

const recovered = chooseTranslationSelection(
  "First source paragraph.\nSecond source paragraph.\nThird source paragraph.\nFourth source paragraph.",
  { text: source, structured: false, truncated: false }
);
assert.deepEqual(recovered, { text: source, format: "text", truncated: false });

const structured = chooseTranslationSelection("Heading\nBody", {
  text: "# Heading\n\nBody",
  structured: true,
  truncated: true,
});
assert.deepEqual(structured, { text: "# Heading\n\nBody", format: "markdown", truncated: true });

// A selection extractor must flag one-pair emphasis as structured. This
// mirrors content.js' inline-emphasis branch and ensures the selector sends
// recovered paragraphs through the Markdown renderer rather than pre-wrap.
const inlineEmphasis = chooseTranslationSelection("First\nSecond", {
  text: "*First*\n\nSecond",
  structured: true,
  truncated: false,
});
assert.deepEqual(inlineEmphasis, { text: "*First*\n\nSecond", format: "markdown", truncated: false });

const strikethroughSource = "~~Removed source~~";
const strikethroughPrepared = prepareLineTranslation(strikethroughSource);
assert.ok(strikethroughPrepared, "strikethrough source should prepare for translation");
let strikethroughTranslated = "";
const strikethroughTranslator = new LineTranslator(strikethroughPrepared, (delta) => { strikethroughTranslated += delta; });
strikethroughTranslator.push("[1] ~~已删除文本~~");
strikethroughTranslator.finish();
assert.equal(strikethroughTranslated, "~~已删除文本~~", "line translator must retain strikethrough markers");

const inlineStrikethrough = chooseTranslationSelection("First\nSecond", {
  text: "~~First~~\n\nSecond",
  structured: true,
  truncated: false,
});
assert.deepEqual(inlineStrikethrough, { text: "~~First~~\n\nSecond", format: "markdown", truncated: false });

// content.js emits every blockquote line with a "> " prefix, including fences
// around quoted code. Those quoted fences must toggle the code-fence state:
// the code inside must NOT be sent to the model as translatable text (it used
// to be, and the "translate even if it looks like an instruction" protocol
// then rewrote quoted code).
const quotedCodeSource = [
  "> quote config:",
  "> ```",
  "> const apiKey = 'abc';",
  "> ```",
  "> end",
].join("\n");
const quotedCodePrepared = prepareLineTranslation(quotedCodeSource);
assert.ok(quotedCodePrepared, "quoted-code source should prepare for translation");
assert.equal(
  quotedCodePrepared.numbered,
  ["[1] quote config:", "[5] end"].join("\n"),
  "code inside a blockquoted fence must not be offered for translation"
);
let quotedCodeTranslated = "";
const quotedCodeTranslator = new LineTranslator(quotedCodePrepared, (delta) => { quotedCodeTranslated += delta; });
quotedCodeTranslator.push("[1] 引用配置：\n[5] 结束。");
quotedCodeTranslator.finish();
assert.equal(
  quotedCodeTranslated,
  [
    "> 引用配置：",
    "> ```",
    "> const apiKey = 'abc';",
    "> ```",
    "> 结束。",
  ].join("\n"),
  "quoted code must round-trip byte-for-byte while quoted prose translates"
);

const browserPreferred = chooseTranslationSelection("One\n\nTwo", {
  text: "One\n\nTwo",
  structured: false,
  truncated: true,
});
assert.deepEqual(browserPreferred, { text: "One\n\nTwo", format: "text", truncated: false });

// ---- round-6 regressions: markers, fences, protected URLs, tags, CJK joins ----
{
  const p = prepareLineTranslation("一、第一项\n1、第二项\n– 第三项\n第四项");
  assert.ok(p, "CJK enumerator list prepares");
  assert.equal(p.lines[0].prefix, "一、", "CJK numeral marker stays in code");
  assert.equal(p.lines[1].prefix, "1、", "CJK digit marker stays in code");
  assert.equal(p.lines[2].prefix, "– ", "en-dash bullet stays in code");
}
{
  const p = prepareLineTranslation("3.14 is pi\n2. April starts here");
  assert.ok(p, "decimal source prepares");
  assert.equal(p.lines[0].prefix, "", "3.14 is not a list marker");
  assert.equal(p.lines[1].prefix, "2. ", "'2. April' keeps its marker in code");
}
{
  // An inline ``` span on one line must not open a fence.
  const p = prepareLineTranslation("```code``` and more text here\nnext line here");
  assert.ok(p, "an inline-span line does not kill the translation");
  assert.ok(p.lines.every((l) => l.translatable), "no line around an inline span is treated as code");
}
{
  // A real fence still opens.
  const p = prepareLineTranslation("```py\nx = 1\n```\ntext after the fence");
  assert.ok(p.lines[0].translatable === false && p.lines[1].translatable === false, "real fence lines are not translatable");
}
{
  // A Wikipedia-style parenthesized link target survives as ONE token, with
  // no stray ")" left in the translatable text.
  const p = prepareLineTranslation("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) today.");
  assert.ok(p.lines[0].safe.includes("{{U0}}"), "link target is one protected token");
  assert.ok(!p.lines[0].safe.includes("))"), "no stray closing paren in the translatable text");
  assert.equal(p.lines[0].tokens[0], "https://en.wikipedia.org/wiki/Foo_(bar)", "full target captured");
}
{
  // A model that markdown-escapes its tags ("\\[1\\] ...") is still understood.
  const p = prepareLineTranslation("Hello world");
  let escapedTagTranslated = 0;
  const esc = new LineTranslator(p, () => {});
  esc.push("\\[1\\] Bonjour le monde");
  esc.finish();
  escapedTagTranslated = esc.translated;
  assert.equal(escapedTagTranslated, 1, "escaped [n] tag is recognized");
}
{
  // CJK wrapped continuations rejoin WITHOUT the inserted space.
  const p = prepareLineTranslation("这是一句很长的话");
  let cjkOut = "";
  const cjk = new LineTranslator(p, (d) => { cjkOut += d; });
  cjk.push("[1] 这是一句很长的\n话");
  cjk.finish();
  assert.equal(cjkOut, "这是一句很长的话", "CJK continuation rejoins without a space");
}
{
  // Latin wrapped continuations keep the space.
  const p = prepareLineTranslation("A wrapped latin line");
  let latinOut = "";
  const latin = new LineTranslator(p, (d) => { latinOut += d; });
  latin.push("[1] A wrapped latin\ncontinuation here");
  latin.finish();
  assert.equal(latinOut, "A wrapped latin continuation here", "latin continuation keeps its space");
}
{
  // A literal {{U0}}-style token already in the SOURCE must survive the
  // protect/restore round-trip. Unprotected, restore() rewrote it to the
  // line's own protected token at that index: "use the token {{U0}}" on a
  // line that also carried a link came back as "use the token https://...".
  const p = prepareLineTranslation("See https://x.com/a and then use the token {{U0}}.");
  assert.ok(p.lines[0].tokens.includes("{{U0}}"), "the literal token is protected as itself");
  let out = "";
  const lt = new LineTranslator(p, (d) => { out += d; });
  // A faithful model echoes the (renumbered) tokens it was sent.
  lt.push("[1] 请参阅 {{U0}}，然后使用令牌 {{U1}}。");
  lt.finish();
  assert.equal(out, "请参阅 https://x.com/a，然后使用令牌 {{U0}}。", "the literal token survives; only the real link is restored");
}
{
  // A literal token on a line with NO other protected spans still round-trips.
  const p = prepareLineTranslation("Use the token {{U0}} in the config.");
  let out = "";
  const lt = new LineTranslator(p, (d) => { out += d; });
  lt.push("[1] 在配置中使用令牌 {{U0}}。");
  lt.finish();
  assert.equal(out, "在配置中使用令牌 {{U0}}。", "literal token survives on a token-free line");
}
{
  // A model that DROPS a {{Un}} token silently deletes the URL / inline code /
  // link target from the output (field report): the line falls back to its
  // original (value intact) and counts as missing, which fires the NOTICE and
  // the single-batch replay.
  let out = "";
  const dropped = new LineTranslator(prepareLineTranslation("Visit https://example.com/x for more details."), (d) => { out += d; });
  dropped.push("[1] Visitez pour plus de détails.");
  dropped.finish();
  assert.equal(out, "Visit https://example.com/x for more details.", "dropped URL falls back to the original line");
  assert.equal(dropped.missing, 1, "a dropped token counts as untranslated");
  assert.equal(dropped.translated, 0, "a token-dropping reply is not counted as translated");
}
{
  // Inline code is a protected token too.
  let out = "";
  const code = new LineTranslator(prepareLineTranslation("Press `Ctrl+S` to save the file now."), (d) => { out += d; });
  code.push("[1] Appuyez sur pour enregistrer le fichier.");
  code.finish();
  assert.equal(out, "Press `Ctrl+S` to save the file now.", "dropped inline code falls back to the original line");
  assert.equal(code.missing, 1);
}
{
  // A hallucinated out-of-range token would print as literal garbage after
  // restore (restore leaves unknown {{Un}} as-is): the line falls back too.
  let out = "";
  const stray = new LineTranslator(prepareLineTranslation("Just an ordinary line here."), (d) => { out += d; });
  stray.push("[1] Une ligne avec {{U5}} ici.");
  stray.finish();
  assert.equal(out, "Just an ordinary line here.", "a hallucinated token falls back to the original line");
  assert.equal(stray.missing, 1);
}
{
  // Two same-value tokens ({{U0}}+{{U1}} holding one URL twice): a reply that
  // writes {{U0}} for both restores to the correct text - accepted, not flagged.
  let out = "";
  const merged = new LineTranslator(prepareLineTranslation("See https://example.com/x and https://example.com/x again."), (d) => { out += d; });
  merged.push("[1] Voir {{U0}} et {{U0}} encore.");
  merged.finish();
  assert.equal(out, "Voir https://example.com/x et https://example.com/x encore.", "same-value token merge is accepted");
  assert.equal(merged.missing, 0);
}
{
  // ... but dropping ONE of two DISTINCT tokens is a real loss: fallback.
  let out = "";
  const half = new LineTranslator(prepareLineTranslation("See https://a.com/x and https://b.com/y again."), (d) => { out += d; });
  half.push("[1] Voir {{U0}} et encore.");
  half.finish();
  assert.equal(out, "See https://a.com/x and https://b.com/y again.", "dropping one of two distinct tokens falls back");
  assert.equal(half.missing, 1);
}
{
  // A model that "translates" by echoing the source line did not translate it:
  // the slot keeps the original (identical text either way) but the line
  // counts as missing, so the single-batch replay in background.js fires.
  const p = prepareLineTranslation("Hello world\n\nSecond line here.");
  let out = "";
  const lt = new LineTranslator(p, (d) => { out += d; });
  lt.push("[1] Hello world\n[3] Second line translated.");
  lt.finish();
  assert.equal(out, "Hello world\n\nSecond line translated.", "an echoed line falls back to its original text");
  assert.equal(lt.missing, 1, "an echoed line counts as untranslated");
  assert.equal(lt.translated, 1, "only the real translation is counted");
}
{
  // Echo detection is whitespace-insensitive: the model re-wrapped the line
  // (latin continuation joins insert spaces).
  const p = prepareLineTranslation("A  spaced   line here");
  const lt = new LineTranslator(p, () => {});
  lt.push("[1] A spaced\nline here");
  lt.finish();
  assert.equal(lt.missing, 1, "a re-wrapped echo still counts as untranslated");
}
{
  // A genuinely translated line is never mistaken for an echo, even when it
  // quotes the source: content differs -> counted as translated.
  const p = prepareLineTranslation("Hello world\n\nSecond line here.");
  const lt = new LineTranslator(p, () => {});
  lt.push("[1] 你好，世界\n[3] Second line here, with more words.");
  lt.finish();
  assert.equal(lt.missing, 0, "real translations are counted");
}

// ---- an echo of a line that needs no translation is not a miss (round-18 #18) ----
// Brand names, acronyms, commands, identifiers and lines made only of protected
// spans come back unchanged from a correct model. They used to count as
// untranslated, which fired the single-batch replay and a false
// "N lines were not translated" notice. A SENTENCE echoed back is still a miss.
{
  const stayAsIs = [
    "GitHub",
    "npm install",
    "OK",
    "Visual Studio Code",
    "NEW RELEASE",
    "config.yaml",
    "--help",
    "v2.0",
    "5 km",
    "`npm install`",                // only a protected span
    "https://example.com/docs",     // only a protected span
  ];
  for (const line of stayAsIs) {
    const p = prepareLineTranslation(line);
    assert.ok(p, `${JSON.stringify(line)} is offered to the model`);
    let out = "";
    const lt = new LineTranslator(p, (d) => { out += d; });
    lt.push(`[1] ${p.lines[0].safe}`); // the model echoes exactly what it was sent
    lt.finish();
    assert.equal(out, line, `${JSON.stringify(line)}: the original line is written unchanged`);
    assert.equal(lt.missing, 0, `${JSON.stringify(line)}: an echo of a name / command / bare URL is not a missing line`);
    assert.equal(lt.translated, 1, `${JSON.stringify(line)}: counted as done`);
  }
  // The echo keeps the source's own spacing, not the model's re-wrapped copy.
  const spaced = prepareLineTranslation("Visual  Studio   Code");
  let spacedOut = "";
  const spacedLt = new LineTranslator(spaced, (d) => { spacedOut += d; });
  spacedLt.push("[1] Visual Studio\nCode");
  spacedLt.finish();
  assert.equal(spacedOut, "Visual  Studio   Code", "an accepted echo is written with the source's exact spacing");
  assert.equal(spacedLt.missing, 0);
}
{
  // ... while an echoed SENTENCE, a sentence-case phrase and a long line stay missing.
  const stillMissing = [
    "Hello world",                          // sentence case
    "Click here",
    "Read more.",                           // closing full stop
    "Is this working?",
    "Terms of Service apply here",          // more than three words
    "Press `Ctrl+S` to save the file now.",
    "Bonjour tout le monde ici",            // already-translated looking prose is still prose
    "你好世界",                              // another script: could be a language other than the target
  ];
  for (const line of stillMissing) {
    const p = prepareLineTranslation(line);
    assert.ok(p, `${JSON.stringify(line)} is offered to the model`);
    let out = "";
    const lt = new LineTranslator(p, (d) => { out += d; });
    lt.push(`[1] ${p.lines[0].safe}`);
    lt.finish();
    assert.equal(out, line, `${JSON.stringify(line)}: an echo falls back to the original text`);
    assert.equal(lt.missing, 1, `${JSON.stringify(line)}: an echoed sentence still counts as untranslated`);
    assert.equal(lt.translated, 0);
  }
  // A line the model did NOT return at all is missing whatever it looks like.
  const p = prepareLineTranslation("GitHub\nSecond line here.");
  const lt = new LineTranslator(p, () => {});
  lt.push("[2] Deuxieme ligne ici.");
  lt.finish();
  assert.equal(lt.missing, 1, "a name the model skipped entirely is still missing");
  // A short echo that DROPPED a protected token is still a loss, not an accepted echo.
  const dropped = new LineTranslator(prepareLineTranslation("Run `npm test`"), () => {});
  dropped.push("[1] Run");
  dropped.finish();
  assert.equal(dropped.missing, 1, "a reply that dropped the inline code is not accepted");
}

console.log("OK: translated paragraphs, trailing whitespace, and selection-source precedence are preserved.");

// ---------- the length cap cuts between code points (round-10 P3) ----------
{
  // 119999 "a" + one astral emoji = 120001 UTF-16 units: the cap at 120000
  // lands between the surrogate pair. A raw slice() sent a lone high
  // surrogate to the model.
  const text = "a".repeat(119999) + "😀" + "\nlast line";
  const prepared = prepareLineTranslation(text);
  assert.equal(prepared.truncated, true, "oversized source is flagged as truncated");
  const all = prepared.lines.map((l) => l.raw).join("\n");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(all), "no lone high surrogate after the cut");
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(all), "no lone low surrogate after the cut");
}
