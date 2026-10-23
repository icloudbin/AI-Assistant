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

console.log("OK: translated paragraphs, trailing whitespace, and selection-source precedence are preserved.");
