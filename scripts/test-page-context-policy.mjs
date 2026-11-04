// scripts/test-page-context-policy.mjs
//
// Regression test for the decision table behind S-05. Run with:
//   node scripts/test-page-context-policy.mjs
//
// S-05  "Read current page" was ON by default with no first-use choice, and the
//       quick actions (Summarize, Explain, ...) sent the full text of a webmail or
//       banking page without any confirmation. Now: the user chooses (off / ask
//       each time / always), a quick action on a sensitive site asks first, and the
//       user's never-send / always-allow lists decide before the built-in rules.

import assert from "node:assert/strict";

const {
  PAGE_CONTEXT_MODES, pageContextModeOf, storedValueForMode, pageContextProtectionLevel, decidePageSend, contextBarStateFor,
} = await import("../page-context-policy.js");

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log(`PASS  ${name}`); }
  catch (err) { results.push(false); console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`); }
}

test("stored value <-> mode: the classic booleans keep their meaning, \"ask\" is new, anything else is undecided", () => {
  assert.deepEqual([...PAGE_CONTEXT_MODES], ["off", "ask", "on"]);
  assert.equal(pageContextModeOf(true), "on");
  assert.equal(pageContextModeOf(false), "off");
  assert.equal(pageContextModeOf("ask"), "ask");
  for (const v of [undefined, null, "on", "true", "off", "", 0, 1, {}, []]) assert.equal(pageContextModeOf(v), null, `pageContextModeOf(${JSON.stringify(v)})`);
  assert.equal(storedValueForMode("on"), true);
  assert.equal(storedValueForMode("off"), false);
  assert.equal(storedValueForMode("ask"), "ask");
  assert.equal(storedValueForMode(null), undefined);
  assert.equal(storedValueForMode("bogus"), undefined);
  for (const mode of PAGE_CONTEXT_MODES) assert.equal(pageContextModeOf(storedValueForMode(mode)), mode);
});

test("protection levels: off (and undecided) > ask > on", () => {
  assert.ok(pageContextProtectionLevel("off") > pageContextProtectionLevel("ask"));
  assert.ok(pageContextProtectionLevel("ask") > pageContextProtectionLevel("on"));
  assert.equal(pageContextProtectionLevel(null), pageContextProtectionLevel("off"));
  assert.equal(pageContextProtectionLevel(undefined), pageContextProtectionLevel("off"));
});

// ---- the table, written out in full ----------------------------------------
// [mode, kind, policy, sessionAllowed] -> "action/reason"
const D = (args) => { const d = decidePageSend(args); return d.reason ? `${d.action}/${d.reason}` : d.action; };

test("ordinary question, mode ON", () => {
  const a = (policy, sessionAllowed = false) => D({ mode: "on", kind: "ordinary", policy, sessionAllowed });
  assert.equal(a("normal"), "send");
  assert.equal(a("allowed"), "send");
  assert.equal(a("sensitive"), "skip/sensitive", "unchanged protection: a sensitive site is not sent unless allowed");
  assert.equal(a("sensitive", true), "send", "allowed for this session");
  assert.equal(a("never"), "skip/never");
  assert.equal(a("never", true), "skip/never", "never beats a session allowance");
});

test("ordinary question, mode ASK", () => {
  const a = (policy, sessionAllowed = false) => D({ mode: "ask", kind: "ordinary", policy, sessionAllowed });
  assert.equal(a("normal"), "confirm/ask");
  assert.equal(a("normal", true), "send", "\"don't ask again for this site\" this session");
  assert.equal(a("allowed"), "send", "the always-allow list skips the question");
  assert.equal(a("sensitive"), "confirm/sensitive");
  assert.equal(a("sensitive", true), "send");
  assert.equal(a("never"), "skip/never");
});

test("ordinary question, mode OFF or not decided yet: the page is never sent", () => {
  for (const mode of ["off", null, undefined]) {
    for (const policy of ["normal", "allowed", "sensitive", "never"]) {
      for (const sessionAllowed of [false, true]) {
        const d = decidePageSend({ mode, kind: "ordinary", policy, sessionAllowed });
        assert.equal(d.action, "skip", `${mode} ${policy} ${sessionAllowed}`);
        assert.equal(d.reason, policy === "never" ? "never" : "off");
      }
    }
  }
});

test("quick action: works in every mode, but a sensitive site asks first and a never-send site refuses", () => {
  for (const mode of ["on", "ask", "off", null]) {
    const a = (policy, sessionAllowed = false) => D({ mode, kind: "quick", policy, sessionAllowed });
    assert.equal(a("normal"), "send", `mode ${mode}`);
    assert.equal(a("allowed"), "send", `mode ${mode}`);
    assert.equal(a("sensitive"), "confirm/sensitive", `mode ${mode}`);
    assert.equal(a("sensitive", true), "send", `mode ${mode}`);
    assert.equal(a("never"), "refuse/never", `mode ${mode}`);
    assert.equal(a("never", true), "refuse/never", `mode ${mode}`);
  }
});

test("defaults: no arguments means an ordinary question, nothing decided, normal site -> not sent", () => {
  assert.deepEqual(decidePageSend(), { action: "skip", reason: "off" });
  assert.deepEqual(decidePageSend({}), { action: "skip", reason: "off" });
  assert.deepEqual(decidePageSend({ mode: "on" }), { action: "send" });
});

test("invariants over the whole table (4 modes x 2 kinds x 4 policies x 2 session flags)", () => {
  for (const mode of ["on", "ask", "off", null]) {
    for (const kind of ["ordinary", "quick"]) {
      for (const policy of ["normal", "allowed", "sensitive", "never"]) {
        for (const sessionAllowed of [false, true]) {
          const d = decidePageSend({ mode, kind, policy, sessionAllowed });
          const label = JSON.stringify({ mode, kind, policy, sessionAllowed });
          assert.ok(["send", "skip", "confirm", "refuse"].includes(d.action), label);
          // A never-send site is never sent and never even asked about.
          if (policy === "never") assert.ok(d.action === "skip" || d.action === "refuse", label);
          // A sensitive site that is neither on the allow list nor allowed for the session is never sent unasked.
          if (policy === "sensitive" && !sessionAllowed) assert.notEqual(d.action, "send", label);
          // Only quick actions can be refused, and only for a never-send site.
          if (d.action === "refuse") assert.ok(kind === "quick" && policy === "never", label);
          // "skip" (question without the page) only exists for ordinary questions.
          if (d.action === "skip") assert.equal(kind, "ordinary", label);
          // An ordinary question is sent only when the mode is on, or it is ask-mode on a trusted site.
          if (kind === "ordinary" && d.action === "send") {
            assert.ok(mode === "on" || mode === "ask", label);
            if (mode === "ask") assert.ok(policy === "allowed" || sessionAllowed, label);
          }
          // Asking is only ever offered when the answer can change the outcome.
          if (d.action === "confirm") assert.ok(policy === "normal" || policy === "sensitive", label);
        }
      }
    }
  }
});

test("a quick action on a normal site is not slowed down by a question in any mode", () => {
  for (const mode of ["on", "ask", "off", null]) assert.equal(D({ mode, kind: "quick", policy: "normal" }), "send");
});

test("bar state follows the same decision", () => {
  const bar = (args) => contextBarStateFor(decidePageSend({ kind: "ordinary", ...args }));
  assert.equal(bar({ mode: "off", policy: "normal" }), "hidden");
  assert.equal(bar({ mode: null, policy: "sensitive" }), "hidden");
  assert.equal(bar({ mode: "on", policy: "normal" }), "send");
  assert.equal(bar({ mode: "on", policy: "allowed" }), "send");
  assert.equal(bar({ mode: "on", policy: "sensitive" }), "blockedSensitive");
  assert.equal(bar({ mode: "on", policy: "sensitive", sessionAllowed: true }), "send");
  assert.equal(bar({ mode: "ask", policy: "normal" }), "ask");
  assert.equal(bar({ mode: "ask", policy: "normal", sessionAllowed: true }), "send");
  assert.equal(bar({ mode: "ask", policy: "sensitive" }), "askSensitive");
  assert.equal(bar({ mode: "on", policy: "never" }), "never");
  assert.equal(bar({ mode: "ask", policy: "never" }), "never");
  assert.equal(contextBarStateFor(null), "hidden");
  assert.equal(contextBarStateFor({ action: "refuse", reason: "never" }), "hidden");
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
