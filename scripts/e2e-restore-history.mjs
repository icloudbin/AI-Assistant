// scripts/e2e-restore-history.mjs
//
// Real-browser check for B-01: restoring a history backup in Settings used to
// report "Restore failed: condensed is not defined" AFTER the data had already
// been written, because `condensed` / `dropped` were declared inside the
// withHistoryLock() callback and read outside it. The "condensed" / "dropped"
// notices could therefore never be shown either.
//
// Needs Playwright with Chromium (not a dependency of the extension itself):
//   node scripts/e2e-restore-history.mjs
// It loads this extension unpacked, creates a real backup ZIP with the page's
// own "Back up" button, wipes the history, then restores it through the real
// file input. The quota cases make chrome.storage.local.set() throw the quota
// error a few times, which is the only way the two notices can appear.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  channel: "chromium",
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}

const COUNT = 8;
const now = Date.now();
const seeded = Array.from({ length: COUNT }, (_, i) => ({
  id: `convo-${i}`,
  title: `Conversation ${i}`,
  updatedAt: now - i * 1000,
  messages: [
    { role: "user", content: `question ${i}`, modelLabel: "", modelId: "" },
    { role: "assistant", content: `answer ${i}`, modelLabel: "DeepSeek V4.1 Flash", modelId: "deepseek-flash" },
  ],
}));

try {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  await worker.evaluate((history) => chrome.storage.local.set({ conversationHistory: history }), seeded);

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/options/options.html`);
  await page.waitForSelector("#backupHistory");

  // A real backup, made by the page's own code.
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#backupHistory")]);
  const zipPath = path.join(tmp, "backup.zip");
  await download.saveAs(zipPath);
  assert.ok(fs.statSync(zipPath).size > 100, "the backup ZIP is empty");

  const storedCount = () => worker.evaluate(async () => ((await chrome.storage.local.get("conversationHistory")).conversationHistory || []).length);
  const message = () => page.evaluate(() => document.getElementById("msg").textContent);

  // Wipe the history, optionally make the first `quotaFailures` writes of it
  // fail with the quota error, restore through the real file input, and return
  // the message the user ends up with.
  async function restore(quotaFailures) {
    await worker.evaluate(() => chrome.storage.local.remove("conversationHistory"));
    await page.evaluate((n) => {
      globalThis.__realSet ??= chrome.storage.local.set.bind(chrome.storage.local);
      let failures = n;
      chrome.storage.local.set = (items, ...rest) => {
        if (failures > 0 && items && "conversationHistory" in items) {
          failures--;
          return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
        }
        return globalThis.__realSet(items, ...rest);
      };
      document.getElementById("msg").textContent = "";
    }, quotaFailures);
    await page.setInputFiles("#restoreHistoryFile", zipPath);
    // wait for the page to finish: the in-progress text is exactly "Restoring
    // history..." (note the quota notice itself also contains "restoring")
    for (let i = 0; i < 100; i++) {
      await sleep(50);
      const m = await message();
      if (m && !/^Restoring history/i.test(m)) return m;
    }
    throw new Error(`restore never finished; message: ${JSON.stringify(await message())}`);
  }

  await test("restore succeeds: success message, not 'Restore failed'; data is in storage", async () => {
    const m = await restore(0);
    assert.ok(!/fail|not defined/i.test(m), `the user was told: ${JSON.stringify(m)}`);
    assert.match(m, new RegExp(`History restored \\(${COUNT} conversations\\)`));
    assert.equal(await storedCount(), COUNT);
  });

  await test("quota hit once: restored, and the 'attachment previews were condensed' notice is shown", async () => {
    const m = await restore(1);
    assert.ok(!/fail|not defined/i.test(m), `the user was told: ${JSON.stringify(m)}`);
    assert.match(m, /History restored/);
    assert.match(m, /attachment previews were condensed/);
    assert.ok(!/dropped/.test(m));
    assert.equal(await storedCount(), COUNT);
  });

  await test("quota hit repeatedly: oldest conversations dropped, and the 'dropped' notice names the count", async () => {
    const m = await restore(3); // condense, then halve twice: 8 -> 4 -> 2
    assert.ok(!/fail|not defined/i.test(m), `the user was told: ${JSON.stringify(m)}`);
    assert.match(m, /attachment previews were condensed/);
    assert.match(m, /the 6 oldest conversation\(s\) could not be saved and were dropped/);
    assert.equal(await storedCount(), 2);
  });

  assert.deepEqual(pageErrors, [], `uncaught errors in the page: ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
