// scripts/chrome-path.mjs
//
// Shared Chrome/Chromium locator for the browser test suites, so they run on
// any machine (Windows workstation, Linux sandbox, CI) without editing paths.
//
// Resolution order:
//   1. CHROME_PATH env var - an explicit override; if it is set but does not
//      exist, that is a misconfiguration and fails loudly (no silent fallback).
//   2. playwright / playwright-core, when installed: chromium.executablePath().
//   3. Well-known per-OS install locations.
//   4. `which` on the PATH (Linux/macOS only).
//
// Throws with the list of tried candidates when nothing is found - the message
// tells the user exactly how to fix the run.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  joinLocalAppData("Google\\Chrome\\Application\\chrome.exe"),
];

function joinLocalAppData(tail) {
  return process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\${tail}` : "";
}

function darwinCandidates() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
}

function linuxCandidates() {
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
}

async function playwrightChromiumPath() {
  // Optional dependency: neither package is required, so both imports are
  // guarded. When playwright IS installed, its pinned Chromium is a reliable,
  // version-matched browser for these suites.
  for (const name of ["playwright-core", "playwright"]) {
    try {
      const mod = await import(name);
      const p = mod?.chromium?.executablePath?.();
      if (typeof p === "string" && p) return p;
    } catch { /* not installed */ }
  }
  return null;
}

function onPath(bin) {
  try {
    execFileSync("which", [bin], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromePath() {
  // An explicitly configured path that does not exist is a misconfiguration:
  // fail loudly instead of silently running a different browser.
  if (process.env.CHROME_PATH && !existsSync(process.env.CHROME_PATH)) {
    throw new Error(`CHROME_PATH is set to "${process.env.CHROME_PATH}" but the file does not exist. Point it at a Chrome/Chromium binary.`);
  }
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const pwPath = await playwrightChromiumPath();
  if (pwPath) candidates.push(pwPath);
  if (process.platform === "win32") candidates.push(...WINDOWS_CANDIDATES);
  else if (process.platform === "darwin") candidates.push(...darwinCandidates());
  else candidates.push(...linuxCandidates());

  const existing = candidates.filter((c) => c && existsSync(c));
  if (existing.length) return existing[0];

  if (process.env.CHROME_PATH) {
    throw new Error(`CHROME_PATH is set to "${process.env.CHROME_PATH}" but the file does not exist. Point it at a Chrome/Chromium binary.`);
  }
  if (process.platform !== "win32") {
    for (const bin of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
      if (onPath(bin)) return bin;
    }
  }
  throw new Error(
    `No Chrome/Chromium executable found. Tried:\n  ${candidates.filter(Boolean).join("\n  ")}\n`
    + "Install Google Chrome (or Chromium), or set CHROME_PATH to the browser binary and re-run.",
  );
}
