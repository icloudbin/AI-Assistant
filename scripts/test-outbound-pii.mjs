#!/usr/bin/env node
// Outbound regression test (privacy + message-role alternation): loads the real background.js with a stubbed
// `chrome`/`fetch`, sends ASK requests over the chat port, and asserts that NO
// outbound fetch body (AI provider or Tavily) contains known PII - for every
// text field the payload carries, including factCheck.selectedText.
// Run:  node scripts/test-outbound-pii.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PII = ["jane.doe@example.com", "+1 415 555 0132", "4111 1111 1111 1111", "sk-abcdefghijklmnopqrstuvwx1234567890"];
const piiText = `Contact jane.doe@example.com or +1 415 555 0132, card 4111 1111 1111 1111, key sk-abcdefghijklmnopqrstuvwx1234567890.`;

const store = { apiKey: "k", tavilyApiKey: "tvly-test", groqApiKey: "k", openrouterApiKey: "k", language: "en" };
const bodies = [];
const listeners = {};
const ev = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
globalThis.chrome = {
  runtime: { id: "x", getURL: () => "chrome-extension://x/", getPlatformInfo: async () => ({}), lastError: undefined,
    onInstalled: ev("i"), onStartup: ev("s"), onMessage: ev("m"), onConnect: ev("c"), sendMessage: async () => {} },
  storage: { local: {
    get: async (k) => { const keys = Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k || store);
      return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]])); },
    set: async (o) => Object.assign(store, o), remove: async () => {} },
    onChanged: ev("sc"), session: { get: async () => ({}), set: async () => {} }, sync: { get: async () => ({}), set: async () => {} } },
  contextMenus: { create: (_, cb) => cb?.(), removeAll: (cb) => cb?.(), onClicked: ev("cm") },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  scripting: { executeScript: async () => [] },
  tabs: {}, windows: {},
};
const sse = (s) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
globalThis.fetch = async (url, opts = {}) => {
  bodies.push({ url: String(url), body: String(opts.body ?? "") });
  if (String(url).includes("tavily")) return new Response(JSON.stringify({ results: [{ url: "https://e.com/a", title: "T", content: "evidence", score: 1 }] }), { status: 200 });
  return sse(providerReply(String(opts.body ?? "")));
};
// Overridable provider behaviour (default: a short, complete answer).
let providerReply = () => 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
const chunk = (content, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;

await import(pathToFileURL(path.join(root, "background.js")).href);
const onConnect = listeners.c[0];

let lastOut = "";
async function ask(payload) {
  bodies.length = 0;
  lastOut = "";
  let port;
  const handlers = [];
  const notices = [];
  const done = new Promise((resolve) => {
    port = { name: "ai-chat", sender: { id: "x", url: "chrome-extension://x/sidepanel.html" },
      onMessage: { addListener: (f) => handlers.push(f) }, onDisconnect: { addListener() {} },
      postMessage: (m) => { if (m.type === "CHUNK") lastOut += m.delta; if (m.type === "NOTICE") notices.push(m.text); if (m.type === "DONE" || m.type === "ERROR") resolve(m); }, disconnect() {} };
  });
  onConnect(port);
  await handlers[0]({ type: "ASK", payload: { requestId: 1, modelId: "deepseek-flash", includePageContext: true, history: [], images: [], ...payload } });
  const final = await done;
  const chunks = []; // not tracked; the translation tests read output via `out`
  return { final, sent: [...bodies], notices, out: lastOut };
}

const pageContext = { tabId: 1, title: "Page", url: "https://example.com/p", text: `Page says: ${piiText}` };
const cases = {
  "plain question": { question: `Hi ${piiText}`, pageContext, noWebResearch: true },
  "history": { question: "ok", pageContext, noWebResearch: true, history: [{ role: "user", content: piiText }] },
  "fact-check selected text": { question: "Check this", pageContext, factCheck: { enabled: true, selectedText: `${piiText} The company was founded in 1998 in Berlin.` } },
  "fact-check whole page": { question: "Check this", pageContext: { ...pageContext, text: `${piiText} The company was founded in 1998 in Berlin and employs 500 people.` }, factCheck: { enabled: true, selectedText: "" } },
};

// Chat templates need strict alternation: one system, then user/assistant/user...
function rolesOk(body) {
  try {
    const roles = (JSON.parse(body).messages || []).map((m) => m.role);
    if (!roles.length) return true; // not a chat request (e.g. Tavily)
    return roles[0] === "system" && roles.slice(1).every((r, i) => r === (i % 2 === 0 ? "user" : "assistant")) && roles[roles.length - 1] === "user";
  } catch { return true; }
}
cases["history ending in an unanswered user turn (after a failed request)"] = {
  question: "second try", pageContext, noWebResearch: true,
  history: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "failed question" }],
};
cases["verbatim retry of a failed question"] = {
  question: "failed question", pageContext, noWebResearch: true,
  history: [{ role: "user", content: "failed question" }],
};

let failed = 0;
for (const [name, payload] of Object.entries(cases)) {
  const { final, sent } = await ask(payload);
  const leaks = PII.filter((p) => sent.some((s) => s.body.includes(p)));
  const reachedProvider = sent.some((s) => !s.url.includes("tavily"));
  const badRoles = sent.filter((s) => !rolesOk(s.body));
  const ok = final.type === "DONE" && leaks.length === 0 && reachedProvider && sent.length > 0 && badRoles.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${sent.length} outbound request(s)${leaks.length ? `, LEAKED: ${leaks.join(" | ")}` : ""}${badRoles.length ? ", BAD ROLE ORDER" : ""}${final.type === "ERROR" ? `, error: ${final.error}` : ""})`);
}

// --- Truncation handling ---------------------------------------------------
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };

// finish_reason "length" on a normal answer -> NOTICE (not a silent cut).
providerReply = () => chunk("A long answer that was cut", "length") + "data: [DONE]\n\n";
let r = await ask({ question: "Tell me everything", pageContext, noWebResearch: true });
check("finish_reason=length produces a NOTICE", r.final.type === "DONE" && r.notices.some((n) => /length limit|cut off/i.test(n)), r.notices.join(" | "));
providerReply = () => chunk("Complete answer", "stop") + "data: [DONE]\n\n";
r = await ask({ question: "Short one", pageContext, noWebResearch: true });
check("finish_reason=stop produces no NOTICE", r.notices.length === 0);

// Translation: a fake "translator" that upper-cases each tagged line.
const tag = (body) => JSON.parse(body).messages.at(-1).content;
const echoTranslate = (limit) => (body) => {
  const rows = [...tag(body).matchAll(/^\[(\d+)\] (.*)$/gm)].slice(0, limit);
  return chunk(rows.map((m) => `[${m[1]}] T:${m[2]}`).join("\n"), "stop") + "data: [DONE]\n\n";
};
const srcLines = Array.from({ length: 6 }, (_, i) => `Sentence number ${i + 1} of the document.`);
// Model returns only the first 2 lines of 6.
providerReply = echoTranslate(2);
r = await ask({ question: "Translate", pageContext: null, includePageContext: false, translateMode: true, translateSource: srcLines.join("\n"), noWebResearch: true });
check("translation with an incomplete reply warns about untranslated lines", r.notices.some((n) => /4/.test(n) && /6/.test(n)), r.notices.join(" | "));
check("untranslated lines keep original text", srcLines.slice(2).every((l) => r.out.includes(l)));

// Long source: must be split into several requests, and every line translated.
const longLines = Array.from({ length: 400 }, (_, i) => `Line ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(4)}`);
providerReply = echoTranslate(Infinity);
r = await ask({ question: "Translate", pageContext: null, includePageContext: false, translateMode: true, translateSource: longLines.join("\n"), noWebResearch: true });
const outLines = r.out.split("\n");
check("long translation is batched into several requests", r.sent.length > 1, `${r.sent.length} requests`);
check("batched translation covers every line, in order, no NOTICE", outLines.length === 400 && outLines.every((l, i) => l.startsWith(`T:Line ${i + 1}:`)) && r.notices.length === 0, `${outLines.length} lines, notices: ${r.notices.join(" | ")}`);
const reqBatch = r.sent.map((s) => tag(s.body));
check("each batch is bounded in size", reqBatch.every((c) => c.length < 12000), `max ${Math.max(...reqBatch.map((c) => c.length))} chars`);
// Same, but translating the whole page (no selection).
r = await ask({ question: "Translate", pageContext: { tabId: 1, title: "P", url: "https://e.com", text: longLines.join("\n") }, translateMode: true, noWebResearch: true });
const pageOut = r.out.split("\n");
check("page translation is batched and complete", r.sent.length > 1 && pageOut.length === 400 && pageOut.every((l, i) => l.startsWith(`T:Line ${i + 1}:`)) && r.notices.length === 0, `${r.sent.length} requests, ${pageOut.length} lines`);
providerReply = () => 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

// --- Placeholders are numbered and the real values come back in the reply ----
const lastUser = (body) => { const c = JSON.parse(body).messages.at(-1).content; return typeof c === "string" ? c : c.map((p) => p.text || "").join(""); };
// A model that mentions the email placeholder, split across two streamed chunks.
providerReply = (body) => {
  const ph = lastUser(body).match(/\[EMAIL#\d+\]/)?.[0] || "[none]";
  const half = Math.ceil(ph.length / 2);
  return chunk(`Sure, I will write to ${ph.slice(0, half)}`) + chunk(`${ph.slice(half)} right away.`, "stop") + "data: [DONE]\n\n";
};
r = await ask({ question: "Write a note to jane.doe@example.com", pageContext: null, includePageContext: false, noWebResearch: true });
check("provider only saw a numbered placeholder", r.sent.every((s) => !s.body.includes("jane.doe@example.com")) && /\[EMAIL#1\]/.test(lastUser(r.sent[0].body)));
check("reply shows the real address (placeholder split across chunks)", r.out === "Sure, I will write to jane.doe@example.com right away.", JSON.stringify(r.out));
check("no placeholder text reaches the user", !/\[[A-Z_]+#\d+\]/.test(r.out));
// Translation: placeholders in the source must not appear in the translated text.
const trSrc = ["Contact jane.doe@example.com or call +1 415 555 0132 today.", "", "Second line mentions bob@example.org only."];
providerReply = echoTranslate(Infinity);
r = await ask({ question: "Translate", pageContext: null, includePageContext: false, translateMode: true, translateSource: trSrc.join("\n"), noWebResearch: true });
check("translation output has real email/phone, not placeholders", r.out.includes("jane.doe@example.com") && r.out.includes("+1 415 555 0132") && r.out.includes("bob@example.org") && !/\[[A-Z_]+(#\d+)?\]/.test(r.out), JSON.stringify(r.out));
check("translation request never contained the real values", r.sent.every((s) => !/jane\.doe@|bob@example|415 555 0132/.test(s.body)));
providerReply = () => 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

// Filter off: the same data must pass through unchanged (proves the test can detect leaks).
store.piiFilterEnabled = false;
const off = await ask({ question: "x", pageContext, noWebResearch: true });
const leaksOff = PII.some((p) => off.sent.some((s) => s.body.includes(p)));
console.log(`${leaksOff ? "PASS" : "FAIL"}  sanity: filter disabled -> PII present (test can detect leaks)`);
if (!leaksOff) failed++;

process.exit(failed ? 1 : 0);
