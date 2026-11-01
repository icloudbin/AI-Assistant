// scripts/test-markdown-heading.mjs
//
// Regression test for B-05: the Markdown heading pattern
//   /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/
// was O(n²) on a heading line containing a long run of whitespace (20k spaces
// 1.5 s, 40k 6.2 s; the same-length paragraph took 0 ms), and the panel
// re-renders the whole reply every ~100 ms while streaming. The heading is now
// parsed by parseAtxHeading(), a single linear pass, and a heading line is
// capped at MAX_HEADING_LINE_CHARS.
//
// Run with:  node scripts/test-markdown-heading.mjs
//
// Part 1 pins the behaviour: curated cases plus an exhaustive comparison with
// the old pattern over every short string of an adversarial alphabet.
// Part 2 is the performance regression test.

import assert from "node:assert/strict";

// markdown.js resolves link URLs against the panel's own URL.
globalThis.location = { href: "chrome-extension://test/sidepanel/sidepanel.html" };
const { markdownToHtml, parseAtxHeading, MAX_HEADING_LINE_CHARS } = await import("../sidepanel/rendering/markdown.js");

// The pattern parseAtxHeading() replaced: the behavioural reference.
const LEGACY_HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const legacy = (s) => {
  const m = s.match(LEGACY_HEADING_RE);
  return m ? { level: m[1].length, text: m[2] } : null;
};

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}
const ms = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

// ---- Part 1: behaviour -----------------------------------------------------

await test("renders levels 1-6 and the closing-hash form", () => {
  assert.equal(markdownToHtml("# One"), "<h1>One</h1>");
  assert.equal(markdownToHtml("###### Six"), "<h6>Six</h6>");
  assert.equal(markdownToHtml("## Title ##"), "<h2>Title</h2>");
  assert.equal(markdownToHtml("## Title   ##   "), "<h2>Title</h2>");
  assert.equal(markdownToHtml("### Tabbed\t###"), "<h3>Tabbed</h3>");
  assert.equal(markdownToHtml("#\tTab after marker"), "<h1>Tab after marker</h1>");
  assert.equal(markdownToHtml("# 中文标题 #"), "<h1>中文标题</h1>");
});

await test("things that are NOT headings stay as they were", () => {
  for (const s of ["####### seven", "#nospace", "#", "# ", "##", "#hashtag text"]) {
    assert.equal(parseAtxHeading(s.trim()), null, JSON.stringify(s));
  }
  // closing "#" glued to the text, or a heading that is only hashes, are text
  assert.deepEqual(parseAtxHeading("# C#"), { level: 1, text: "C#" });
  assert.deepEqual(parseAtxHeading("# ###"), { level: 1, text: "###" });
  assert.deepEqual(parseAtxHeading("## a #b"), { level: 2, text: "a #b" });
  assert.deepEqual(parseAtxHeading("# a # b #"), { level: 1, text: "a # b" });
});

await test("agrees with the old pattern on every short string of an adversarial alphabet", () => {
  const alphabet = ["#", " ", "a", "\t", " ", " ", "C"];
  let checked = 0;
  const walk = (prefix, depth) => {
    if (prefix.trim() === prefix) {
      // the caller always passes `line.trim()`
      checked++;
      assert.deepEqual(parseAtxHeading(prefix), legacy(prefix), `input ${JSON.stringify(prefix)}`);
    }
    if (depth === 0) return;
    for (const ch of alphabet) walk(prefix + ch, depth - 1);
  };
  walk("", 7); // 7^7 strings: ~165k trimmed ones
  assert.ok(checked > 100000, `only ${checked} strings were compared`);
});

await test("agrees with the old pattern on random longer lines", () => {
  const pieces = ["#", "#", " ", " ", "\t", "a", "b", "C", " ", "1", ".", "##"];
  let seed = 12345; // deterministic
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 100000; i++) {
    let s = "";
    const len = 1 + Math.floor(rand() * 40);
    for (let j = 0; j < len; j++) s += pieces[Math.floor(rand() * pieces.length)];
    s = s.trim();
    assert.deepEqual(parseAtxHeading(s), legacy(s), `input ${JSON.stringify(s)}`);
  }
});

await test("a heading line over the length cap renders as a paragraph", () => {
  const title = "x".repeat(MAX_HEADING_LINE_CHARS - 2);
  assert.equal(markdownToHtml(`# ${title}`), `<h1>${title}</h1>`); // exactly at the cap: still a heading
  const html = markdownToHtml(`# ${title}y`);
  assert.ok(html.startsWith("<p>"), html.slice(0, 40));
  assert.ok(!html.includes("<h1>"));
});

// ---- Part 2: performance ---------------------------------------------------

await test("heading with a 40k-space run renders in well under a second (was ~6 s)", () => {
  const line = `# a${" ".repeat(40000)}b`;
  const t = ms(() => markdownToHtml(line));
  assert.ok(t < 300, `took ${t.toFixed(0)} ms`);
});

await test("many near-cap headings full of whitespace stay fast (linear scan, not just the cap)", () => {
  // Each line is a heading UNDER the cap whose body is almost all spaces - the
  // old pattern spent ~15 ms per line here (quadratic in the run length).
  const run = " ".repeat(MAX_HEADING_LINE_CHARS - 10);
  const doc = Array.from({ length: 600 }, () => `# a${run}b`).join("\n");
  const t = ms(() => markdownToHtml(doc));
  assert.ok(t < 500, `took ${t.toFixed(0)} ms for 600 lines`);
});

await test("whitespace-heavy variants of every heading shape stay fast", () => {
  const run = " ".repeat(MAX_HEADING_LINE_CHARS - 20);
  const shapes = [`# a${run}b`, `# a${run}#`, `#${run}a`, `# a #${run}#`, `## ${run}x ##`, `# ${"# ".repeat(900)}`];
  for (const shape of shapes) {
    const doc = Array.from({ length: 200 }, () => shape).join("\n");
    const t = ms(() => markdownToHtml(doc));
    assert.ok(t < 500, `${JSON.stringify(shape.slice(0, 16))}...: ${t.toFixed(0)} ms for 200 lines`);
  }
});

await test("streaming re-render of a growing whitespace heading stays cheap", () => {
  // The panel re-renders the accumulated reply on every update.
  let total = 0;
  for (let n = 500; n <= 20000; n += 500) total += ms(() => markdownToHtml(`# a${" ".repeat(n)}b`));
  assert.ok(total < 500, `40 re-renders took ${total.toFixed(0)} ms`);
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
