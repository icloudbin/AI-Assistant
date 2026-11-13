// tavily-response.js
// Bounded JSON reader and schema normalizer for untrusted Tavily responses.
export const MAX_TAVILY_RESPONSE_BYTES = 1_500_000;
export const MAX_TAVILY_RESULTS = 6;

export async function readTavilyJsonCapped(response, maxBytes = MAX_TAVILY_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("Tavily response exceeded the size limit");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Tavily response exceeded the size limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Tavily response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function normalizeTavilyPayload(payload, maxResults = MAX_TAVILY_RESULTS) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
    throw new Error("Tavily returned an invalid response");
  }
  const limit = Number.isSafeInteger(maxResults) ? Math.max(1, Math.min(MAX_TAVILY_RESULTS, maxResults)) : MAX_TAVILY_RESULTS;
  const results = payload.results.slice(0, limit).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const title = typeof item.title === "string" ? item.title.slice(0, 1000) : "";
    const url = typeof item.url === "string" ? item.url.slice(0, 2048) : "";
    const content = typeof item.content === "string" ? item.content.slice(0, 10000) : "";
    const published_date = typeof item.published_date === "string" ? item.published_date.slice(0, 100)
      : typeof item.publishedDate === "string" ? item.publishedDate.slice(0, 100) : "";
    const score = Number(item.score);
    return [{ title, url, content, published_date, score: Number.isFinite(score) ? score : 0 }];
  });
  return { results };
}
