// scripts/test-pii-name-perf.mjs
//
// Regression test for B-06: the PII "Name:" rule tested NON_PERSON_LABEL_RE
// against whole.slice(0, offset) - the ENTIRE prefix of the document - for
// every match, so the cost grew with (document size x number of matches):
// 120k characters of "Name:" lines took 0.45 s, 240k 1.6 s, 480k 6.2 s, all of
// it synchronous in the service worker. The check now looks at a short window
// right before the cue.
//
// Run with:  node scripts/test-pii-name-perf.mjs

import assert from "node:assert/strict";
import { redactSensitive } from "../privacy/pii-filter.js";

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
const repeatTo = (unit, chars) => unit.repeat(Math.ceil(chars / unit.length));

// ---- behaviour (must not change) -------------------------------------------

await test("a person-plausible 'Name:' value is redacted", () => {
  assert.equal(redactSensitive("Name: John Smith"), "Name: [NAME]");
  assert.equal(redactSensitive("Customer Name: John Smith"), "Customer Name: [NAME]");
  assert.equal(redactSensitive("User Name: Jane Doe"), "User Name: [NAME]");
});

await test("a non-person qualifier directly before the cue keeps the value", () => {
  assert.equal(redactSensitive("Product Name: Widget Pro"), "Product Name: Widget Pro");
  assert.equal(redactSensitive("File Name: Annual Report"), "File Name: Annual Report");
  assert.equal(redactSensitive("Product     Name: Widget Pro"), "Product     Name: Widget Pro"); // several spaces
  assert.equal(redactSensitive("Product\tName: Widget Pro"), "Product\tName: Widget Pro");
});

await test("the qualifier is still honoured after a very long prefix", () => {
  const prefix = "lorem ipsum ".repeat(20000);
  assert.ok(redactSensitive(`${prefix}Product Name: Widget Pro`).endsWith("Product Name: Widget Pro"));
  assert.ok(redactSensitive(`${prefix}Customer Name: John Smith`).endsWith("Customer Name: [NAME]"));
});

await test("every match in a long document is still redacted", () => {
  // The trailing "." ends each name sequence. (Without it a name followed by a
  // newline and another "Name:" label is read as one longer sequence - a
  // separate, pre-existing matching quirk this performance fix does not touch.)
  const text = "Name: John Smith.\n".repeat(2000);
  const out = redactSensitive(text);
  assert.ok(!out.includes("John"), "a name survived");
  assert.equal((out.match(/\[NAME\]/g) || []).length, 2000);
});

// ---- performance -------------------------------------------------------------
// Thresholds leave >10x headroom over the fixed code (~0.1 s at 480k) and sit
// far below the old behaviour (8-19 s at 480k), so they are not timing-flaky.

for (const unit of ["Name: John Smith\n", "Name: Bob ", "Name: "]) {
  await test(`480k characters of ${JSON.stringify(unit)} redact in under 1.5 s (was 8-19 s)`, () => {
    const text = repeatTo(unit, 480000);
    const t = ms(() => redactSensitive(text));
    assert.ok(t < 1500, `took ${t.toFixed(0)} ms for ${text.length} characters`);
  });
}

await test("cost grows roughly linearly with the document (4x text is not ~16x time)", () => {
  const unit = "Name: Bob ";
  const small = repeatTo(unit, 120000);
  const big = repeatTo(unit, 480000);
  redactSensitive(small); // warm up
  const tSmall = Math.max(ms(() => redactSensitive(small)), 20); // floor: avoid dividing by timer noise
  const tBig = ms(() => redactSensitive(big));
  assert.ok(tBig < tSmall * 10, `120k: ${tSmall.toFixed(0)} ms, 480k: ${tBig.toFixed(0)} ms`);
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
