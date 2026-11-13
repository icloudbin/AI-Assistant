#!/usr/bin/env node
// Run: node scripts/test-storage-access-level.mjs
//
// Storage isolation invariants. Retracts the v1.10.167 SEC-03 claim: there is
// NO API to keep content scripts away from chrome.storage.local -
// StorageArea.setAccessLevel() applies exclusively to storage.session (whose
// default is already trusted-contexts-only), and storage.local stays readable
// by content scripts for as long as the "storage" permission is held. The
// isolation that actually protects these data is STRUCTURAL: the code that
// runs in the page's content-script world (content.js, page-images.js) never
// touches chrome.storage at all, so nothing a page can influence reaches the
// stored history or keys. This file pins that invariant instead of grepping
// for a call whose effect it cannot verify.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(resolve(root, f), "utf8");
const manifest = JSON.parse(read("manifest.json"));

// The permission stays: the panel/worker use storage.local deliberately, and
// removing it would change nothing about content-script access anyway (they
// see storage.local because the extension is installed, not via this key).
assert.ok(manifest.permissions.includes("storage"), "the storage permission is declared");

// The structural invariant: no chrome.storage usage in any content-script-
// world file. These are the only scripts Chrome runs in the page's world.
for (const f of ["content.js", "page-images.js"]) {
  assert.ok(!/chrome\.storage/.test(read(f)), `${f} must not touch chrome.storage (structural isolation)`);
}

// The placebo call must not come back: chrome.storage.local.setAccessLevel()
// is accepted without effect (probe-verified in real Chromium; the docs scope
// setAccessLevel to storage.session), so re-adding it would only re-create a
// false "storage is restricted" impression.
assert.ok(!/setAccessLevel/.test(read("background.js")), "background.js must not call setAccessLevel (no-op for storage.local)");

console.log("OK: storage isolation is structural - content-script files never touch chrome.storage; no placebo setAccessLevel call.");
