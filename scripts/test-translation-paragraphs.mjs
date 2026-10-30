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
