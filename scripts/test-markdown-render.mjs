#!/usr/bin/env node
// Unit tests for sidepanel/rendering/markdown.js (the reply-rendering
// pipeline moved verbatim from sidepanel.js). A `location` stub is supplied
// because link/image URLs resolve against the panel page's own URL.
// Run:  node scripts/test-markdown-render.mjs
import assert from "node:assert/strict";
globalThis.location = { href: "https://panel.example/" };
const { escapeHtml, inlineMarkdownToHtml, markdownToHtml } = await import("../sidepanel/rendering/markdown.js");

// ---------- escapeHtml ----------
assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");

// ---------- inline: escaping happens BEFORE the link/image rules ----------
const titled = inlineMarkdownToHtml('[t](https://example.com/x "Title")');
assert.ok(titled.includes('<a href="https://example.com/x"'), "titled link renders as an anchor");
assert.ok(!titled.includes("&quot;Title&quot;"), "the raw title does not leak into the output");
const titledImg = inlineMarkdownToHtml('![alt](https://example.com/i.png "Pic")');
assert.ok(titledImg.includes('<img src="https://example.com/i.png"'), "titled image renders as an image tag");
assert.ok(!titledImg.includes("&quot;Pic&quot;"), "no literal &quot; in the image output");

// ---------- inline: dangerous URLs degrade to plain text ----------
assert.equal(inlineMarkdownToHtml("[x](javascript:alert(1))"), "x", "javascript: link reduced to its label");
assert.ok(!inlineMarkdownToHtml("![i](data:image/svg+xml;base64,AAAA)").includes("<img"), "svg data URL not rendered");
assert.ok(inlineMarkdownToHtml("![i](data:image/png;base64,AAAA)").includes("<img"), "png data URL rendered");

// ---------- inline: emphasis, code spans, strikethrough ----------
assert.equal(inlineMarkdownToHtml("**b**"), "<strong>b</strong>");
assert.equal(inlineMarkdownToHtml("*i*"), "<em>i</em>");
assert.equal(inlineMarkdownToHtml("~~gone~~"), "<del>gone</del>");
assert.equal(inlineMarkdownToHtml("`<b>`"), "<code>&lt;b&gt;</code>", "code span content stays escaped");
assert.equal(inlineMarkdownToHtml("snake_case_name"), "snake_case_name", "intraword underscores are not emphasis");

// ---------- block: fences escape their content and keep the language class ----------
const fenced = markdownToHtml("```js\nconst a = \"<b>\";\n```");
assert.ok(fenced.includes('<code class="language-js">'), "language class preserved");
assert.ok(fenced.includes("const a = &quot;&lt;b&gt;&quot;;"), "fence content fully escaped");

// ---------- block: nested lists keep structure; loose lists stay one list ----------
const nested = markdownToHtml("- a\n  - b\n    - c\n- d");
const ulCount = (nested.match(/<ul>/g) || []).length;
assert.equal(ulCount, 3, "three nesting levels -> three <ul>");
assert.ok(nested.indexOf("- a") === -1 && nested.includes("d"), "markers consumed");
const loose = markdownToHtml("- first item\n\n- second item");
assert.equal((loose.match(/<ul>/g) || []).length, 1, "blank line between same-type items does not split the list");
assert.ok(loose.includes("first item") && loose.includes("second item"));

// ---------- block: ordered start numbers survive ----------
assert.ok(markdownToHtml("3. three\n4. four").includes('<ol start="3">'), "start attribute for non-1 numbering");

// ---------- block: headings, quotes, hr, tables ----------
assert.ok(markdownToHtml("## Head").includes("<h2>Head</h2>"));
assert.ok(markdownToHtml("> quoted").includes("<blockquote>quoted</blockquote>"));
assert.ok(markdownToHtml("a\n\n---\n\nb").includes("<hr>"));
const table = markdownToHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");
assert.ok(table.includes("<table>") && table.includes("<th>A</th>") && table.includes("<td>2</td>"), "GFM table");

// ---------- block: a paragraph's inline content is still escaped ----------
assert.ok(markdownToHtml("hello <script>alert(1)</script>").includes("&lt;script&gt;"), "raw HTML in prose is escaped");

// ---------- regression guards from the browser fixes (v1.10.108) ----------
// Titled links used to degrade to literal text because escapeHtml ran first.
assert.ok(markdownToHtml("See [doc](https://example.com/d \"Docs\").").includes('<a href="https://example.com/d"'), "titled link inside a paragraph");
// The nested-list anchor shape produced by content.js (empty parent item) renders nested.
const anchored = markdownToHtml("-\n  - alpha nested entry\n- plain sibling item");
assert.ok(anchored.includes("alpha nested entry") && anchored.includes("plain sibling item"), "empty-parent anchor markup renders both levels");

console.log("OK: rendering/markdown.js — escaping order, titled links/images, URL policy, fences, nested/loose lists, tables.");
process.exit(0);
