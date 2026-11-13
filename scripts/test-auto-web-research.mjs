#!/usr/bin/env node
// Unit tests for the Automatic Web Research opt-out setting.
// Run: node scripts/test-auto-web-research.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAutoWebResearchEnabled } from "../auto-web-research.js";

assert.equal(isAutoWebResearchEnabled(undefined), true, "new installs default to ON");
assert.equal(isAutoWebResearchEnabled(null), true, "legacy/null values keep the documented default");
assert.equal(isAutoWebResearchEnabled(true), true, "explicit true enables automatic research");
assert.equal(isAutoWebResearchEnabled(false), false, "only explicit false opts out");

const backgroundSource = readFileSync(new URL("../background.js", import.meta.url), "utf8");
assert.match(backgroundSource, /Settings \(ON by default; only an explicit opt-out disables it\)/, "background documentation matches the default-on behavior");
assert.doesNotMatch(backgroundSource, /Settings \(off by default\)/i, "stale default-off wording must not return");

console.log("PASS  automatic web research default and opt-out tests");
