#!/usr/bin/env node
// Unit tests for the Automatic Web Research opt-out setting.
// Run: node scripts/test-auto-web-research.mjs
import assert from "node:assert/strict";
import { isAutoWebResearchEnabled } from "../auto-web-research.js";

assert.equal(isAutoWebResearchEnabled(undefined), true, "new installs default to ON");
assert.equal(isAutoWebResearchEnabled(null), true, "legacy/null values keep the documented default");
assert.equal(isAutoWebResearchEnabled(true), true, "explicit true enables automatic research");
assert.equal(isAutoWebResearchEnabled(false), false, "only explicit false opts out");

console.log("PASS  automatic web research default and opt-out tests");
