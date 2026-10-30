#!/usr/bin/env node
/**
 * Chrome Web Store Package Builder
 * Creates a clean, verified .zip archive containing exactly the required
 * runtime extension files (no dev scripts, tests, docs, or git noise).
 * Run: node scripts/build-package.mjs
 *
 * The archive is written by a pure-Node zip writer (zlib deflate + CRC-32,
 * forward-slash entry names, no directory entries). External zip tools are NOT
 * used: Windows PowerShell 5.1's Compress-Archive stores nested entry names
 * with BACKSLASH separators ("sidepanel\sidepanel.js"), which the Chrome Web
 * Store rejects, and its own Expand-Archive tolerates them, so the mistake
 * passed every check unnoticed (caught by reading the archive's central
 * directory directly).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");

console.log("=================================================");
console.log("   Chrome Web Store Package Builder              ");
console.log("=================================================");

// 1. Run package pre-flight check
console.log("\n[1/4] Running package pre-flight validation check...");
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

console.log(`\n[2/4] Packaging ${manifest.name} (v${version})...`);

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

// ---------- CRC-32 (IEEE, reflected, poly 0xEDB88320) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- MS-DOS timestamp (local time; zip files have no time zone) ----------
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

// ---------- zip writer ----------
// entries: [{ name (forward slashes, no trailing "/"), data: Buffer, mtime: Date }]
// Layout: local file headers + payload, central directory, EOCD. All integers
// little-endian; offsets per the PKWARE APPNOTE.
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const { dosTime, dosDate } = dosDateTime(entry.mtime);
    const crc = crc32(entry.data);
    let method = 8; // deflate
    let payload = zlib.deflateRawSync(entry.data, { level: 9 });
    if (payload.length >= entry.data.length) {
      // Already-compressed bytes (PNG icons) would only grow: store instead.
      method = 0;
      payload = entry.data;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 entry names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8 entry names
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra(30) / comment(32) / disk start(34) / internal attrs(36) stay 0
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }
  const centralStart = offset;
  const centralSize = centralParts.reduce((n, buf) => n + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central directory start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ---------- zip verification (byte-level, on the file that was written) ----------
// Re-parses the central directory and every local header, inflates every entry
// and compares it byte-for-byte with the source file. This is what the old
// Expand-Archive round-trip could not catch: it accepted backslash entry names.
function verifyZip(zipBuffer, entries) {
  const fail = (message) => {
    console.error(`VERIFICATION ERROR: ${message}`);
    process.exit(1);
  };
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 22 - 65536); i--) {
    if (zipBuffer.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) fail("end-of-central-directory record not found");
  const entryCount = zipBuffer.readUInt16LE(eocd + 10);
  const cdSize = zipBuffer.readUInt32LE(eocd + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocd + 16);
  if (entryCount !== entries.length) fail(`entry count ${entryCount} != expected ${entries.length}`);
  if (cdOffset + cdSize > eocd) fail("central directory overruns the EOCD record");

  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zipBuffer.readUInt32LE(pos) !== 0x02014b50) fail(`central directory entry ${i} has a bad signature`);
    const method = zipBuffer.readUInt16LE(pos + 10);
    const crc = zipBuffer.readUInt32LE(pos + 16);
    const compressedSize = zipBuffer.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(pos + 24);
    const nameLen = zipBuffer.readUInt16LE(pos + 28);
    const extraLen = zipBuffer.readUInt16LE(pos + 30);
    const commentLen = zipBuffer.readUInt16LE(pos + 32);
    const localOffset = zipBuffer.readUInt32LE(pos + 42);
    const name = zipBuffer.toString("utf8", pos + 46, pos + 46 + nameLen);

    if (name.includes("\\")) fail(`entry name contains a backslash: ${JSON.stringify(name)}`);
    if (name.endsWith("/")) fail(`entry name is a directory entry: ${JSON.stringify(name)}`);
    const expected = entries[i];
    if (name !== expected.name) fail(`entry ${i} is ${JSON.stringify(name)}, expected ${JSON.stringify(expected.name)}`);

    if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) fail(`entry ${name}: local header has a bad signature`);
    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    if (zipBuffer.toString("utf8", localOffset + 30, localOffset + 30 + localNameLen) !== name) {
      fail(`entry ${name}: local header name does not match the central directory`);
    }
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = zipBuffer.subarray(dataStart, dataStart + compressedSize);
    if (stored.length !== compressedSize) fail(`entry ${name}: data truncated`);
    let content;
    try {
      content = method === 0 ? Buffer.from(stored) : zlib.inflateRawSync(stored);
    } catch (err) {
      fail(`entry ${name}: decompression failed (${err.message})`);
    }
    if (content.length !== uncompressedSize) fail(`entry ${name}: size ${content.length} != header ${uncompressedSize}`);
    if (crc32(content) !== crc) fail(`entry ${name}: CRC-32 mismatch`);
    if (!content.equals(expected.data)) fail(`entry ${name}: decompressed bytes differ from the source file`);

    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== cdOffset + cdSize) fail("central directory size does not match the EOCD record");
}

// 4. Read the runtime files and build the archive
console.log(`\n[3/4] Compressing ${RUNTIME_FILES.length} extension runtime files into ${zipFileName}...`);
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

const entries = [];
for (const relFile of RUNTIME_FILES) {
  const src = path.join(ROOT, relFile);
  if (!fs.existsSync(src)) {
    console.error(`ERROR: Missing required runtime file: ${relFile}`);
    process.exit(1);
  }
  entries.push({
    // Zip entry names ALWAYS use forward slashes, regardless of platform.
    name: relFile.split(path.sep).join("/"),
    data: fs.readFileSync(src),
    mtime: fs.statSync(src).mtime,
  });
}
fs.writeFileSync(zipFilePath, buildZip(entries));

// 5. Verify the archive byte-by-byte
console.log(`\n[4/4] Verifying archive integrity (entry names, CRC-32, source bytes)...`);
const zipBuffer = fs.readFileSync(zipFilePath);
verifyZip(zipBuffer, entries);

const zipStats = fs.statSync(zipFilePath);
const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");

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
