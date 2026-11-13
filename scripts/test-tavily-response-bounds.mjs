#!/usr/bin/env node
// Run: node scripts/test-tavily-response-bounds.mjs
import assert from "node:assert/strict";
import { MAX_TAVILY_RESPONSE_BYTES, readTavilyJsonCapped, normalizeTavilyPayload } from "../tavily-response.js";

const valid = { results: [{ title: "Title", url: "https://example.com", content: "Evidence", score: 0.8 }] };
assert.deepEqual(await readTavilyJsonCapped(new Response(JSON.stringify(valid))), valid);
assert.throws(() => normalizeTavilyPayload({ results: "not-an-array" }), /invalid response/);
const normalized = normalizeTavilyPayload({ results: Array.from({ length: 9 }, (_, i) => ({
  title: "t".repeat(1500), url: "https://example.com/" + "u".repeat(3000),
  content: "c".repeat(12000), publishedDate: "d".repeat(150), score: i ? 0.5 : "bad",
})) }, 99);
assert.equal(normalized.results.length, 6);
assert.equal(normalized.results[0].title.length, 1000);
assert.equal(normalized.results[0].url.length, 2048);
assert.equal(normalized.results[0].content.length, 10000);
assert.equal(normalized.results[0].published_date.length, 100);
assert.equal(normalized.results[0].score, 0);
const body = new Uint8Array(MAX_TAVILY_RESPONSE_BYTES + 1);
const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }));
await assert.rejects(readTavilyJsonCapped(response), /exceeded the size limit/);
console.log("OK: Tavily JSON byte cap, schema validation, result count and field bounds.");
