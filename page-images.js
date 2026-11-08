// page-images.js (root directory)
// Fetching the current page's own images for quick actions ("page images").
//
// These images are fetched IN THE PAGE'S OWN CONTEXT, not by the privileged
// service worker: chrome.scripting.executeScript runs fetchImagesInPage() in
// the tab, where fetch() is subject to the page's own CORS rules, so only
// responses the page itself could read come back. No extension privilege is
// lent out, which is why the worker's SSRF image-host allowlist (url-safety.js)
// does not apply here - it would gate almost every real-world image host and
// the feature would deliver nothing on most pages.
//
// The price of that context switch: sources that refuse cross-origin reads
// (no Access-Control-Allow-Origin, or a page CSP connect-src that blocks the
// request), oversized images and timeouts are skipped. The caller reports the
// number of skipped images to the user instead of dropping them silently.
//
// fetchImagesInPage is injected, collectPageImageResults is pure - both are
// unit-tested in Node (scripts/test-page-images.mjs).

export const PAGE_IMAGE_MAX_COUNT = 4;
export const PAGE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const PAGE_IMAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const PAGE_IMAGE_FETCH_TIMEOUT_MS = 6000;
export const PAGE_IMAGE_TOTAL_BUDGET_MS = 15000;

// Runs INSIDE the target tab (chrome.scripting.executeScript, isolated world).
// Must stay fully self-contained - no references to module scope, because the
// function's source is serialized and evaluated in the page.
export function fetchImagesInPage(urls, perImageTimeoutMs, deadlineMs, maxBytesPerImage) {
  const sniffKind = (b) => {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
    if (
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) return "webp";
    return null;
  };
  const toBase64 = (bytes) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
  };
  const fetchOne = async (rawUrl) => {
    // An https page can never read an http response (mixed content), so the
    // https spelling is tried first when the page offered an http src.
    const attempts = /^http:/i.test(rawUrl) ? [rawUrl.replace(/^http:/i, "https:"), rawUrl] : [rawUrl];
    for (const url of attempts) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(perImageTimeoutMs, remainingMs));
      try {
        // mode "cors" is the fetch default and is what confines the read to
        // the page's own privileges. Credentials are never sent to the image
        // host. Redirects may be followed: the browser re-evaluates CORS on
        // every hop, so no response beyond the page's own reach comes back.
        const resp = await fetch(url, { credentials: "omit", mode: "cors", signal: controller.signal });
        if (!resp.ok) continue;
        const contentType = (resp.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (contentType && !contentType.startsWith("image/")) continue;
        let bytes;
        if (resp.body && typeof resp.body.getReader === "function") {
          // A server can lie about (or omit) Content-Length - cap the stream.
          const reader = resp.body.getReader();
          const chunks = [];
          let total = 0;
          let oversize = false;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytesPerImage) {
              oversize = true;
              reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
          }
          if (oversize) continue;
          bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
        } else {
          const declared = Number(resp.headers.get("content-length") || 0);
          if (declared > maxBytesPerImage) continue;
          bytes = new Uint8Array(await resp.arrayBuffer());
          if (bytes.length > maxBytesPerImage) continue;
        }
        const kind = sniffKind(bytes);
        if (!kind) continue;
        // Report the ORIGINALLY requested URL: the https spelling tried above
        // is an internal detail, and the caller matches results by URL.
        return { url: rawUrl, dataUrl: `data:image/${kind};base64,${toBase64(bytes)}` };
      } catch {
        // Network/CORS/abort failure: fall through to the next spelling.
      } finally {
        clearTimeout(timer);
      }
    }
    return { url: rawUrl };
  };
  return Promise.all((Array.isArray(urls) ? urls : []).filter((url) => typeof url === "string").map(fetchOne));
}

const PAGE_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp);base64,/i;

function dataUrlBytes(dataUrl) {
  const encoded = String(dataUrl).split(",", 2)[1] || "";
  return Math.floor((encoded.length * 3) / 4);
}

// Pure result accounting for the in-page fetch (no chrome.* calls): dedupes
// the requested URLs, keeps their order, enforces the count and total-byte
// caps, and reports how many of the requested images were skipped (CORS-
// refusing sources, oversize, timeouts, failed injections).
export function collectPageImageResults(requestedUrls, results, opts = {}) {
  const maxCount = opts.maxCount ?? PAGE_IMAGE_MAX_COUNT;
  const maxTotalBytes = opts.maxTotalBytes ?? PAGE_IMAGE_MAX_TOTAL_BYTES;
  const requested = [...new Set((Array.isArray(requestedUrls) ? requestedUrls : [])
    .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)))].slice(0, maxCount * 2);
  const byUrl = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (
      result && typeof result.url === "string" &&
      typeof result.dataUrl === "string" && PAGE_IMAGE_DATA_URL_RE.test(result.dataUrl)
    ) {
      // A URL reported twice keeps its first valid result.
      if (!byUrl.has(result.url)) byUrl.set(result.url, result.dataUrl);
    }
  }
  const images = [];
  let totalBytes = 0;
  for (const url of requested) {
    if (images.length >= maxCount) break;
    const dataUrl = byUrl.get(url);
    if (!dataUrl) continue;
    const imageBytes = dataUrlBytes(dataUrl);
    if (totalBytes + imageBytes > maxTotalBytes) continue;
    totalBytes += imageBytes;
    images.push({ name: `Web image ${images.length + 1}`, dataUrl });
  }
  return { images, skipped: requested.length - images.length, requested: requested.length };
}
