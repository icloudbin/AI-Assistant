#!/usr/bin/env node
/**
 * Chrome Web Store Package Builder
 * Creates a clean, verified .zip archive containing exactly the required
 * runtime extension files (no dev scripts, tests, docs, or git noise).
 * Run: node scripts/build-package.mjs
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");
const STAGING_DIR = path.join(DIST_DIR, "staging");

console.log("=================================================");
console.log("   Chrome Web Store Package Builder              ");
console.log("=================================================");

// 1. Run package pre-flight check
console.log("\n[1/5] Running package pre-flight validation check...");
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "check-package.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (err) {
  console.error("Pre-flight check failed! Fix the reported errors before packaging.");
  process.exit(1);
}

// 2. Read manifest metadata
const manifestPath = path.join(ROOT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = manifest.version;
const extName = manifest.name.replace(/[^a-zA-Z0-9_-]/g, "_");
const zipFileName = `${extName}-v${version}.zip`;
const zipFilePath = path.join(DIST_DIR, zipFileName);

console.log(`\n[2/5] Packaging ${manifest.name} (v${version})...`);

// 3. Define the exact runtime files required for the Chrome Web Store package
const RUNTIME_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "models.js",
  "storage-keys.js",
  "i18n.js",
  "settings-storage.js",
  "settings-crypto.js",
  "translate-lines.js",
  "translation-selection.js",
  "url-safety.js",
  "sensitive-sites.js",
  "conversation-store.js",
  "providers/messages.js",
  "providers/openai-compatible.js",
  "privacy/pii-filter.js",
  "options/options.html",
  "options/options.js",
  "sidepanel/sidepanel.html",
  "sidepanel/sidepanel.css",
  "sidepanel/sidepanel.js",
  "sidepanel/mic-permission.html",
  "sidepanel/mic-permission.css",
  "sidepanel/mic-permission.js",
  "sidepanel/history-manager.js",
  "sidepanel/attachment-budget.js",
  "sidepanel/rendering/markdown.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

// 4. Stage files into dist/staging
console.log(`\n[3/5] Staging ${RUNTIME_FILES.length} extension runtime files...`);
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(STAGING_DIR, { recursive: true });

for (const relFile of RUNTIME_FILES) {
  const src = path.join(ROOT, relFile);
  const dest = path.join(STAGING_DIR, relFile);
  if (!fs.existsSync(src)) {
    console.error(`ERROR: Missing required runtime file: ${relFile}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 5. Compress into ZIP archive
console.log(`\n[4/5] Compressing files into ${zipFileName}...`);
if (process.platform === "win32") {
  const psCmd = `Compress-Archive -Path '${STAGING_DIR}\\*' -DestinationPath '${zipFilePath}' -Force`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-r", "-q", zipFilePath, "."], { cwd: STAGING_DIR, stdio: "inherit" });
}

// 6. Verify the created ZIP archive
console.log(`\n[5/5] Verifying archive integrity...`);
if (!fs.existsSync(zipFilePath)) {
  console.error("ERROR: Failed to create ZIP archive!");
  process.exit(1);
}

const zipStats = fs.statSync(zipFilePath);
const zipBuffer = fs.readFileSync(zipFilePath);
const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");

// Verify unzipping back to test directory
const verifyDir = path.join(DIST_DIR, "verify-unpack");
if (process.platform === "win32") {
  const psUnpack = `Expand-Archive -Path '${zipFilePath}' -DestinationPath '${verifyDir}' -Force`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", psUnpack], { stdio: "ignore" });
} else {
  execFileSync("unzip", ["-q", zipFilePath, "-d", verifyDir], { stdio: "ignore" });
}

for (const relFile of RUNTIME_FILES) {
  const p = path.join(verifyDir, relFile);
  if (!fs.existsSync(p)) {
    console.error(`VERIFICATION ERROR: File missing in zip: ${relFile}`);
    process.exit(1);
  }
}

// Clean up staging & verification directories
fs.rmSync(STAGING_DIR, { recursive: true, force: true });
fs.rmSync(verifyDir, { recursive: true, force: true });

console.log("\n=================================================");
console.log("   Package Successfully Built & Verified!        ");
console.log("=================================================");
console.log(`Package Name:    ${zipFileName}`);
console.log(`Package Path:    ${zipFilePath}`);
console.log(`File Size:       ${(zipStats.size / 1024).toFixed(2)} KB (${zipStats.size} bytes)`);
console.log(`SHA-256 Hash:    ${sha256}`);
console.log(`Manifest Vers:   ${version}`);
console.log(`Files Included:  ${RUNTIME_FILES.length} (exact runtime set, 0 dev noise)`);
console.log("=================================================\n");
console.log("Ready for Chrome Web Store upload:");
console.log("1. Open Chrome Web Store Developer Dashboard: https://chrome.google.com/webstore/devconsole");
console.log(`2. Select your extension and click 'Package' -> 'Upload new package'`);
console.log(`3. Select '${zipFilePath}'`);
