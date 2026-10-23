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

// 4. i18n consistency. English is the reference: every other language must
// have exactly the same keys (a missing key silently falls back to English,
// which is how the privacy-filter switch ended up untranslated) and the same
// {placeholders} in each message. Every key the code or HTML asks for must
// exist in English.
{
  const src = fs.readFileSync(path.join(root, "i18n.js"), "utf8");
  const langs = {};
  let cur = null;
  for (const line of src.split("\n")) {
    const lm = line.match(/^  (?:"([\w-]+)"|(\w+)): \{$/);
    if (lm) { cur = lm[1] || lm[2]; langs[cur] = {}; continue; }
    const km = line.match(/^    ([A-Za-z0-9_]+):\s*(.*)$/);
    if (km && cur) {
      if (km[1] in langs[cur]) problems.push(`i18n: duplicate key "${km[1]}" in ${cur}`);
      langs[cur][km[1]] = km[2];
    }
  }
  const en = langs.en;
  if (!en) {
    problems.push("i18n: could not find the English table in i18n.js");
  } else {
    // {count} is ignored on "_one" keys: English writes "1 conversation" while
    // languages without a singular form (zh, ja) reuse the {count} wording.
    const ph = (v, key) => [...new Set([...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((p) => !(p === "count" && key.endsWith("_one"))).sort().join(",");
    for (const [lang, table] of Object.entries(langs)) {
      if (lang === "en") continue;
      const missing = Object.keys(en).filter((k) => !(k in table));
      const extra = Object.keys(table).filter((k) => !(k in en));
      if (missing.length) problems.push(`i18n: ${lang} is missing ${missing.length} key(s): ${missing.join(", ")}`);
      if (extra.length) problems.push(`i18n: ${lang} has key(s) not in English: ${extra.join(", ")}`);
      for (const k of Object.keys(en)) {
        if (k in table && ph(en[k], k) !== ph(table[k], k)) problems.push(`i18n: ${lang}.${k} placeholders {${ph(table[k], k)}} differ from English {${ph(en[k], k)}}`);
      }
    }
    const used = new Map();
    const note = (k, f) => { if (!used.has(k)) used.set(k, f); };
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (![".js", ".mjs", ".html"].includes(path.extname(e.name)) || e.name === "i18n.js") continue;
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/\bt\(\s*[\w.?]+\s*,\s*["']([A-Za-z0-9_]+)["']/g)) note(m[1], rel(p));
        // tPlural(lang, count, oneKey, otherKey, vars) passes its two message
        // keys as the 3rd/4th args; validate both (the plain t() regex above
        // cannot match the call because `t` is followed by "Plural", not "(").
        for (const m of text.matchAll(/\btPlural\(\s*[\w.?]+\s*,\s*[^,]+,\s*["']([A-Za-z0-9_]+)["']\s*,\s*["']([A-Za-z0-9_]+)["']/g)) {
          note(m[1], rel(p));
          note(m[2], rel(p));
        }
        for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?=["']([A-Za-z0-9_]+)["']/g)) note(m[1], rel(p));
      }
    };
    walk(root);
    for (const [k, f] of used) if (!(k in en)) problems.push(`i18n: key "${k}" used in ${f} does not exist in English`);
    console.log(`i18n: ${Object.keys(langs).length} languages x ${Object.keys(en).length} keys checked.`);
  }
}

// 5. The page-text limit has ONE definition: MAX_PAGE_CONTEXT_CHARS in
// models.js. background.js and sidepanel.js must import it rather than declare
// their own copy. content.js is injected as a classic script and cannot import
// a module, so it keeps PAGE_CONTEXT_CHAR_LIMIT; its value must match.
{
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const shared = read("models.js").match(/export const MAX_PAGE_CONTEXT_CHARS = (\d+);/);
  const content = read("content.js").match(/const PAGE_CONTEXT_CHAR_LIMIT = (\d+);/);
  if (!shared) problems.push("page limit: models.js does not export MAX_PAGE_CONTEXT_CHARS");
  else if (!content) problems.push("page limit: PAGE_CONTEXT_CHAR_LIMIT not found in content.js");
  else if (shared[1] !== content[1]) problems.push(`page limit: content.js PAGE_CONTEXT_CHAR_LIMIT (${content[1]}) differs from models.js MAX_PAGE_CONTEXT_CHARS (${shared[1]})`);
  for (const f of ["background.js", "sidepanel/sidepanel.js"]) {
    if (/^\s*(?:export\s+)?(?:const|let|var)\s+MAX_PAGE_CONTEXT_CHARS\b/m.test(read(f))) problems.push(`page limit: ${f} declares its own MAX_PAGE_CONTEXT_CHARS; import it from models.js instead`);
  }
}

console.log(`Required files (${required.size}):`);
for (const f of [...required].sort()) console.log("  " + f);
if (problems.length) {
  console.error("\nPROBLEMS:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("\nOK: every required file exists" + (inGit ? " and is tracked by git." : "."));
