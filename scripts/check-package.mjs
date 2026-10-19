#!/usr/bin/env node
// Packaging / validation check. Run from anywhere:  node scripts/check-package.mjs
//
// 1. Starts from every entry point the extension loads (manifest background
//    worker, side panel / options / mic-permission pages, content script) and
//    follows every static relative `import ... from "./x.js"`, so a module that
//    exists on disk but is missing from a package is found by name.
// 2. Checks that the files the manifest references (icons, pages) exist.
// 3. If this folder is a git checkout, fails when any required file is
//    untracked or git-ignored - such a file is silently absent from
//    `git archive`, CI builds and clean clones.
// Exit code 0 = OK, 1 = problems found.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const problems = [];
const required = new Set();

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
required.add("manifest.json");

const entries = [];
const addEntry = (f) => { if (f) entries.push(f); };
addEntry(manifest.background?.service_worker);
addEntry(manifest.side_panel?.default_path);
addEntry(manifest.options_ui?.page);
for (const cs of manifest.content_scripts || []) (cs.js || []).forEach(addEntry);
for (const f of Object.values(manifest.action?.default_icon || {})) addEntry(f);
for (const f of Object.values(manifest.icons || {})) addEntry(f);
// Pages/scripts loaded dynamically (executeScript, chrome.tabs.create) rather
// than named in the manifest.
for (const f of ["content.js", "sidepanel/mic-permission.html"]) addEntry(f);

const importRe = /(?:^|[\n;])\s*(?:import|export)\s[^"'`;]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|(?:^|[\n;])\s*import\s*["'](\.{1,2}\/[^"']+)["']/g;
const attrRe = /<(?:script|link|img)\b[^>]*?(?:src|href)=["']([^"':#?]+)["']/gi;

function visit(file) {
  const abs = path.resolve(root, file);
  const name = rel(abs);
  if (required.has(name) && visited.has(name)) return;
  required.add(name);
  if (!fs.existsSync(abs)) { problems.push(`MISSING on disk: ${name}`); return; }
  if (visited.has(name)) return;
  visited.add(name);
  const ext = path.extname(abs);
  if (ext !== ".js" && ext !== ".mjs" && ext !== ".html") return;
  const text = fs.readFileSync(abs, "utf8");
  const dir = path.dirname(abs);
  const re = ext === ".html" ? attrRe : importRe;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const spec = m.slice(1).find(Boolean);
    if (spec) visit(path.join(dir, spec));
  }
}
const visited = new Set();
entries.forEach(visit);

// Is this a git checkout? (A source zip has no .git; then only steps 1-2 apply.)
let inGit = false;
try {
  inGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true";
} catch {}
if (inGit) {
  const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean));
  for (const f of [...required].sort()) {
    if (fs.existsSync(path.join(root, f)) && !tracked.has(f)) {
      problems.push(`NOT TRACKED by git (missing from git archive / CI / clean clone): ${f}`);
    }
  }
} else {
  console.log("(not a git checkout: skipped the tracked-files check)");
}

console.log(`Required files (${required.size}):`);
for (const f of [...required].sort()) console.log("  " + f);
if (problems.length) {
  console.error("\nPROBLEMS:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("\nOK: every required file exists" + (inGit ? " and is tracked by git." : "."));
