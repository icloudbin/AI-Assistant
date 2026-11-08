#!/usr/bin/env node
// Unit tests for page-images.js (page images fetched in the page's own
// context instead of by the privileged service worker).
// Run:  node scripts/test-page-images.mjs
import { fetchImagesInPage, collectPageImageResults, PAGE_IMAGE_MAX_COUNT, PAGE_IMAGE_MAX_BYTES } from "../page-images.js";

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
};

// ---------- fetchImagesInPage (serialization safety) ----------
// The function's source is serialized into the page: it must not reference
// module-scope identifiers (a violated reference only explodes in the page,
// never in this module's own scope).
{
  const src = fetchImagesInPage.toString();
  ok("fetchImagesInPage is self-contained (no module-scope references)",
    !/collectPageImageResults|PAGE_IMAGE_|checkImageUrl|\bimport\b|\brequire\(/.test(src), src.slice(0, 120));
}

// ---------- fetchImagesInPage against a stubbed fetch ----------
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5]);

const realFetch = globalThis.fetch;
const stubFetch = (impl) => {
  globalThis.fetch = impl;
  return () => { globalThis.fetch = realFetch; };
};
// A minimal Response double: a hand-rolled body stream whose read() yields the
// given parts and whose cancel() sets `cancelled` - the production code must
// stop reading on oversize.
const response = ({ ok = true, contentType = "image/png", parts = null, headers = {} } = {}) => ({
  ok,
  headers: {
    get: (name) => {
      const key = String(name).toLowerCase();
      if (key in headers) return headers[key];
      if (key === "content-type") return contentType;
      return "";
    },
  },
  body: {
    cancelled: false,
    getReader() {
      const partsIterator = (parts ?? [PNG])[Symbol.iterator]();
      return {
        read: async () => {
          const { value, done } = await Promise.resolve(partsIterator.next());
          return done ? { done: true, value: undefined } : { done: false, value };
        },
        cancel: async () => { this.cancelled = true; },
      };
    },
  },
});
const decode = (dataUrl) => new Uint8Array(Buffer.from(String(dataUrl).split(",", 2)[1] || "", "base64"));

try {
  // Success: png bytes, png content type.
  {
    let seenArgs = null;
    const restore = stubFetch(async (url, init) => { seenArgs = { url, init }; return response({}); });
    const out = await fetchImagesInPage(["https://host.example/a.png"], 1000, Date.now() + 5000, 1 << 20);
    restore();
    eq("success returns one result", out.length, 1);
    ok("success dataUrl kind", String(out[0].dataUrl || "").startsWith("data:image/png;base64,"), String(out[0].dataUrl || "").slice(0, 30));
    ok("success bytes survive the base64 round-trip", decode(out[0].dataUrl).every((b, i) => b === PNG[i]));
    ok("fetch runs with credentials omitted + cors mode", seenArgs?.init?.credentials === "omit" && seenArgs?.init?.mode === "cors", JSON.stringify(seenArgs?.init));
    eq("result reports the requested URL", out[0].url, "https://host.example/a.png");
  }
  // Sniffing wins over a missing content type; a non-image type is skipped.
  {
    const restore = stubFetch(async () => response({ contentType: "", parts: [JPEG] }));
    const out = await fetchImagesInPage(["https://host.example/a.jpg"], 1000, Date.now() + 5000, 1 << 20);
    restore();
    ok("missing content-type: sniffed jpeg", String(out[0].dataUrl || "").startsWith("data:image/jpeg;base64,"), String(out[0].dataUrl || "").slice(0, 30));
  }
  {
    const restore = stubFetch(async () => response({ contentType: "text/html" }));
    const out = await fetchImagesInPage(["https://host.example/a"], 1000, Date.now() + 5000, 1 << 20);
    restore();
    ok("non-image content-type skipped", !out[0].dataUrl, JSON.stringify(out[0]));
  }
  {
    const restore = stubFetch(async () => response({ ok: false }));
    const out = await fetchImagesInPage(["https://host.example/a"], 1000, Date.now() + 5000, 1 << 20);
    restore();
    ok("non-2xx skipped", !out[0].dataUrl, JSON.stringify(out[0]));
  }
  // Oversize: the reader must be cancelled mid-stream.
  {
    const resp = response({ parts: [new Uint8Array(600), new Uint8Array(600)] });
    const restore = stubFetch(async () => resp);
    const out = await fetchImagesInPage(["https://host.example/big"], 1000, Date.now() + 5000, 1024);
    restore();
    ok("oversize stream skipped", !out[0].dataUrl, JSON.stringify(out[0]));
    eq("oversize stream is cancelled", resp.body.cancelled, true);
  }
  // Declared content-length over the cap, no stream: skipped without reading.
  {
    let read = false;
    const restore = stubFetch(async () => ({
      ok: true,
      headers: { get: (n) => (String(n).toLowerCase() === "content-length" ? "99999999" : "") },
      body: null,
      arrayBuffer: async () => { read = true; return new ArrayBuffer(16); },
    }));
    const out = await fetchImagesInPage(["https://host.example/big"], 1000, Date.now() + 5000, PAGE_IMAGE_MAX_BYTES);
    restore();
    ok("declared oversize skipped unread", !out[0].dataUrl && !read, JSON.stringify(out[0]));
  }
  // Non-image bytes (invalid signature): skipped.
  {
    const restore = stubFetch(async () => response({ parts: [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])] }));
    const out = await fetchImagesInPage(["https://host.example/x"], 1000, Date.now() + 5000, 1 << 20);
    restore();
    ok("file-signature mismatch skipped", !out[0].dataUrl, JSON.stringify(out[0]));
  }
  // http src: https spelling first, original http spelling as the fallback;
  // the result reports the ORIGINAL url either way.
  {
    const tried = [];
    const restore = stubFetch(async (url) => {
      tried.push(url);
      if (/^https:/.test(url)) return response({ ok: false });
      return response({});
    });
    const out = await fetchImagesInPage(["http://host.example/a.png"], 1000, Date.now() + 5000, 1 << 20);
    restore();
    eq("http src falls back to the http spelling", tried.join("|"), "https://host.example/a.png|http://host.example/a.png");
    eq("fallback reports the original http URL", out[0].url, "http://host.example/a.png");
    ok("fallback still yields the image", !!out[0].dataUrl, JSON.stringify(out[0]));
  }
  // Per-image timeout: a fetch that hangs until aborted is skipped promptly.
  {
    const restore = stubFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const started = Date.now();
    const out = await fetchImagesInPage(["https://host.example/hang"], 40, Date.now() + 5000, 1 << 20);
    const elapsed = Date.now() - started;
    restore();
    ok("hanging fetch skipped", !out[0].dataUrl, JSON.stringify(out[0]));
    ok("per-image timeout bounded the wait", elapsed < 3000, `elapsed=${elapsed}ms`);
  }
  // Overall budget: a deadline in the past never calls fetch at all.
  {
    let calls = 0;
    const restore = stubFetch(async () => { calls++; return response({}); });
    const out = await fetchImagesInPage(["https://host.example/a", "https://host.example/b"], 1000, Date.now() - 1, 1 << 20);
    restore();
    eq("expired deadline calls fetch zero times", calls, 0);
    ok("expired deadline yields plain misses", out.every((r) => !r.dataUrl), JSON.stringify(out));
  }
  // Input hygiene: order preserved, non-strings dropped, empty input fine.
  {
    const seen = [];
    const restore = stubFetch(async (url) => { seen.push(url); return response({}); });
    const out = await fetchImagesInPage(["https://a/1", 42, null, "https://b/2"], 1000, Date.now() + 5000, 1 << 20);
    const empty = await fetchImagesInPage([], 1000, Date.now() + 5000, 1 << 20);
    restore();
    eq("urls fetched in order", seen.join("|"), "https://a/1|https://b/2");
    eq("non-string urls dropped from results", out.length, 2);
    eq("empty input gives empty results", empty.length, 0);
  }
} finally {
  globalThis.fetch = realFetch;
}

// ---------- collectPageImageResults (pure accounting) ----------
{
  const dataUrl = (bytesLen, kind = "png") =>
    `data:image/${kind};base64,${"A".repeat(Math.ceil((bytesLen * 4) / 3))}`;
  const img1 = { url: "https://a/1", dataUrl: dataUrl(100) };
  const img2 = { url: "https://a/2", dataUrl: dataUrl(100) };
  const img3 = { url: "https://a/3", dataUrl: dataUrl(100) };
  const img4 = { url: "https://a/4", dataUrl: dataUrl(100) };
  const img5 = { url: "https://a/5", dataUrl: dataUrl(100) };

  // Basic: order follows the requested list, counts line up.
  {
    const r = collectPageImageResults(["https://a/2", "https://a/1"], [img1, img2]);
    eq("results follow requested order", r.images.map((i) => i.name).join(","), "Web image 1,Web image 2");
    ok("order uses the requested list, not the result order", r.images[0].dataUrl === img2.dataUrl && r.images[1].dataUrl === img1.dataUrl);
    eq("nothing skipped", r.skipped, 0);
    eq("requested counted after dedupe", r.requested, 2);
  }
  // Invalid shapes are skipped, valid ones kept.
  {
    const r = collectPageImageResults(
      ["https://a/1", "https://a/2", "https://a/3"],
      [img1, { url: "https://a/2", dataUrl: "data:image/svg+xml;base64,AAAA" }, { url: "https://a/3" }, null]
    );
    eq("invalid dataUrls skipped", r.images.length, 1);
    eq("skip count includes invalid results", r.skipped, 2);
  }
  // Count cap: earlier (document-order) images win.
  {
    const r = collectPageImageResults(
      ["https://a/1", "https://a/2", "https://a/3", "https://a/4", "https://a/5"],
      [img1, img2, img3, img4, img5],
      { maxCount: 4 }
    );
    eq("count cap keeps four", r.images.length, 4);
    eq("count cap skips the rest", r.skipped, 1);
    ok("cap keeps document order", r.images.every((i) => i.name !== "Web image 5"));
  }
  // Total-byte cap: an image that would overflow is skipped, later smaller ones fit.
  {
    const r = collectPageImageResults(
      ["https://a/1", "https://a/2", "https://a/3"],
      [img1, { url: "https://a/2", dataUrl: dataUrl(1000) }, img3],
      { maxTotalBytes: 500 }
    );
    eq("overflow image skipped", r.images.length, 2);
    ok("overflow does not shadow the smaller follower", r.images[1].dataUrl === img3.dataUrl);
    eq("overflow counted as skipped", r.skipped, 1);
  }
  // Requested list is capped at maxCount * 2 like the old worker path.
  {
    const many = Array.from({ length: 12 }, (_, i) => `https://a/${i}`);
    const r = collectPageImageResults(many, [], { maxCount: 4 });
    eq("requested capped at maxCount*2", r.requested, 8);
    eq("capped-away urls excluded from skip count (8, not 12)", r.skipped, 8);
  }
  // Degenerate inputs never throw.
  {
    eq("null requested", collectPageImageResults(null, null).requested, 0);
    eq("non-array results", collectPageImageResults(["https://a/1"], "nope").skipped, 1);
    const r = collectPageImageResults(["https://a/1", "https://a/1"], [img1]);
    eq("duplicate requested urls dedupe", r.requested, 1);
    eq("duplicate still yields one image", r.images.length, 1);
  }
  // The default caps match the module constants: 10 requested -> 8 requested
  // after the cap, 4 accepted, 4 skipped.
  {
    const r = collectPageImageResults(
      Array.from({ length: 10 }, (_, i) => `https://a/${i}`),
      Array.from({ length: 10 }, (_, i) => ({ url: `https://a/${i}`, dataUrl: dataUrl(100) }))
    );
    eq("default count cap is PAGE_IMAGE_MAX_COUNT", r.images.length, PAGE_IMAGE_MAX_COUNT);
    eq("default requested cap", r.requested, 8);
    eq("default skipped accounting", r.skipped, 4);
  }
  // A single image over the whole total budget: skipped, not truncated
  // silently. (The per-image cap lives in the in-page fetch, not here.)
  {
    const r = collectPageImageResults(["https://a/1"], [{ url: "https://a/1", dataUrl: dataUrl(8 * 1024 * 1024 + 1) }]);
    eq("over-budget image skipped", r.images.length, 0);
    eq("over-budget counted", r.skipped, 1);
  }
}

console.log(failed ? `\n${failed} FAILURES` : "\nAll page-images tests passed.");
process.exitCode = failed ? 1 : 0;
