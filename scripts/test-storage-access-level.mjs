#!/usr/bin/env node
// Run: node scripts/test-storage-access-level.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const background = readFileSync(resolve(root, "background.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

assert.ok(manifest.permissions.includes("storage"));
assert.ok(Number.parseInt(manifest.minimum_chrome_version, 10) >= 102, "minimum Chrome supports setAccessLevel");
assert.match(background, /chrome\.storage\.local\.setAccessLevel\(\s*\{\s*accessLevel:\s*["']TRUSTED_CONTEXTS["']/);
console.log("OK: storage.local is restricted to trusted extension contexts.");
