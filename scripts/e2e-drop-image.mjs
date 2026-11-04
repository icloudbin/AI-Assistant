// scripts/e2e-drop-image.mjs
//
// Real-browser check for R-06: dropping an IMAGE from a web page onto the
// composer must attach it WITHOUT also inserting its URL into the question
// box as text. Chrome puts the image's URL into text/plain (and uri-list) of
// such a drag, and the drop handler used to insert that text unconditionally
// after attaching the image.
//
// Needs Playwright with Chromium (not a dependency of the extension itself):
//   node scripts/e2e-drop-image.mjs
// It loads this extension unpacked, opens the side panel page in a tab and
// fires synthetic `drop` events with a DataTransfer at the real composer. The
// worker's FETCH_IMAGE channel is stubbed in the page (no network); everything
// from the drop handler down to the attachment chip is the real code.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-e2e-"));

// 1x1 transparent PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
const IMG_URL = "https://images.example.test/photos/cat.png";

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium", // new headless mode: supports extensions
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

try {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  // The panel asks once before it reads pages (S-05) and once before the first image
  // is attached (S-08). This test is about neither, so both are already settled -
  // except in the last test, which is about the second.
  await worker.evaluate(() => chrome.storage.local.set({ includeCurrentPageContext: false, imageNoticeAcknowledged: true }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await page.waitForSelector("#chatForm");
  await page.waitForTimeout(500); // let init() finish

  // Stub the worker's image fetch: ok for IMG_URL, failure for anything containing "broken".
  const stubFetch = (target) => target.evaluate(({ png }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg?.type === "FETCH_IMAGE") {
        return Promise.resolve(String(msg.url).includes("broken") ? { ok: false, error: "unavailable" } : { ok: true, dataUrl: png });
      }
      return real(msg, ...rest);
    };
  }, { png: PNG_DATA_URL });
  await stubFetch(page);

  // Fire one drop at the composer; resolve with what the panel ended up with.
  async function drop(payload, target = page) {
    return target.evaluate(async (payload) => {
      // Start clean: remove earlier attachments through the panel's own remove
      // buttons (they update its state, unlike clearing the DOM) and the text.
      for (const b of [...document.querySelectorAll(".remove-attachment")]) b.click();
      document.getElementById("questionInput").value = "";
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(payload)) dt.setData(type, value);
      const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      document.getElementById("chatForm").dispatchEvent(ev);
      // the handler is async (fetch + decode): wait for chips to settle
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const states = [...document.querySelectorAll(".attachment-state")].map((e) => e.textContent);
        const settled = states.length === 0 ? i > 6 : states.every((s) => !/read/i.test(s));
        if (settled && i > 4) break;
      }
      return {
        text: document.getElementById("questionInput").value,
        chips: [...document.querySelectorAll(".attachment")].map((c) => ({
          name: c.querySelector(".attachment-name")?.textContent,
          state: c.querySelector(".attachment-state")?.textContent,
          error: c.querySelector(".attachment-state")?.classList.contains("error"),
        })),
      };
    }, payload);
  }

  await test("dragged <img> (URL): attached, and its URL is NOT inserted as text", async () => {
    const r = await drop({
      "text/html": `<img src="${IMG_URL}">`,
      "text/uri-list": IMG_URL,
      "text/plain": IMG_URL,
    });
    assert.equal(r.chips.length, 1, JSON.stringify(r));
    assert.equal(r.chips[0].error, false, JSON.stringify(r));
    assert.equal(r.text, "", `the question box received text: ${JSON.stringify(r.text)}`);
  });

  await test("dragged <img> (data: URL): attached, and the data URL is NOT inserted as text", async () => {
    const r = await drop({
      "text/html": `<img src="${PNG_DATA_URL}">`,
      "text/plain": PNG_DATA_URL,
    });
    assert.equal(r.chips.length, 1, JSON.stringify(r).slice(0, 300));
    assert.equal(r.chips[0].error, false, JSON.stringify(r).slice(0, 300));
    assert.equal(r.text, "", `the question box received text: ${JSON.stringify(r.text).slice(0, 80)}`);
  });

  await test("copied image address (text/plain only): attached, not inserted", async () => {
    const r = await drop({ "text/uri-list": IMG_URL, "text/html": "", "text/plain": IMG_URL });
    assert.equal(r.chips.length, 1, JSON.stringify(r));
    assert.equal(r.text, "");
  });

  await test("image that cannot be fetched: error chip, and the URL still falls back to text (unchanged)", async () => {
    const url = "https://images.example.test/broken.png";
    const r = await drop({ "text/html": `<img src="${url}">`, "text/plain": url });
    assert.equal(r.chips.length, 1, JSON.stringify(r));
    assert.equal(r.chips[0].error, true, JSON.stringify(r));
    assert.equal(r.text, url);
  });

  await test("page text selection (text/html without an image): inserted as text, no attachment", async () => {
    const r = await drop({ "text/html": "<p>some <b>selected</b> words</p>", "text/plain": "some selected words" });
    assert.equal(r.chips.length, 0, JSON.stringify(r));
    assert.equal(r.text, "some selected words");
  });

  await test("a dropped page link that is not an image: inserted as text, no attachment", async () => {
    const r = await drop({ "text/uri-list": "https://example.test/article", "text/plain": "https://example.test/article" });
    assert.equal(r.chips.length, 0, JSON.stringify(r));
    assert.equal(r.text, "https://example.test/article");
  });

  await test("S-08: the first dropped image asks first; declining attaches nothing and does not paste its address either", async () => {
    await worker.evaluate(() => chrome.storage.local.remove("imageNoticeAcknowledged"));
    const fresh = await context.newPage(); // a new panel: it has not been told about the notice
    fresh.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      await fresh.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
      await fresh.waitForSelector("#chatForm");
      await fresh.waitForFunction(() => !document.getElementById("sendBtn").disabled, null, { timeout: 15000 });
      await stubFetch(fresh);
      const state = () => fresh.evaluate(() => ({
        dialog: Boolean(document.getElementById("imageNoticeDialog")?.open),
        chips: document.querySelectorAll(".attachment").length,
        text: document.getElementById("questionInput").value,
      }));
      const waitState = async (pred, what) => {
        for (let i = 0; i < 100; i++) { if (pred(await state())) return; await sleep(50); }
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await state())}`);
      };
      const payload = { "text/html": `<img src="${IMG_URL}">`, "text/uri-list": IMG_URL, "text/plain": IMG_URL };

      await drop(payload, fresh); // returns while the question is open
      await waitState((st) => st.dialog, "the image notice");
      assert.equal((await state()).chips, 0, "the image was attached before the user answered");
      await fresh.click("#imageNoticeDialogCancel");
      await waitState((st) => !st.dialog, "the notice to close");
      await sleep(400);
      const declined = await state();
      assert.equal(declined.chips, 0, "an image was attached although the user declined");
      assert.equal(declined.text, "", `declining pasted the address as text: ${JSON.stringify(declined.text)}`);

      await drop(payload, fresh);
      await waitState((st) => st.dialog, "the notice again");
      await fresh.click("#imageNoticeDialogConfirm");
      await waitState((st) => !st.dialog && st.chips === 1, "the image to be attached");
      assert.equal((await state()).text, "");
      assert.equal((await worker.evaluate(() => chrome.storage.local.get("imageNoticeAcknowledged"))).imageNoticeAcknowledged, true);
    } finally {
      await fresh.close();
    }
  });

  assert.deepEqual(pageErrors, [], `uncaught errors in the panel: ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
