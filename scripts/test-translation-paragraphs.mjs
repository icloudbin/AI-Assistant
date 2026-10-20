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

const browserPreferred = chooseTranslationSelection("One\n\nTwo", {
  text: "One\n\nTwo",
  structured: false,
  truncated: true,
});
assert.deepEqual(browserPreferred, { text: "One\n\nTwo", format: "text", truncated: false });

console.log("OK: translated paragraphs and selection-source precedence are preserved.");
