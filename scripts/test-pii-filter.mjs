#!/usr/bin/env node
// Unit tests for pii-filter.js: what must be redacted, what must be left alone,
// numbered placeholders and restoring the real values in a reply.
// Run:  node scripts/test-pii-filter.mjs
import { redactSensitive as R, createRedactionSession, restorePlaceholders, restoreNamePlaceholders, PlaceholderRestorer, redactOutbound } from "../privacy/pii-filter.js";

let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${extra}`}`);
};

// ---- must be redacted: [input, secret that must not survive, placeholder expected] ----
const MUST = [
  ["Call 4155550132 tomorrow", "4155550132", "[PHONE]"],
  ["Phone: 4155550132", "4155550132", "[PHONE]"],
  ["+14155550132", "4155550132", "[PHONE]"],
  ["Ring me on 07911 123456", "07911 123456", "[PHONE]"],
  ["Mobile 07911123456", "07911123456", "[PHONE]"],
  ["Office 020 7946 0958", "7946 0958", "[PHONE]"],
  ["call 0121 496 0123", "496 0123", "[PHONE]"],
  ["Tel 01632 960123", "960123", "[PHONE]"],
  ["ip 2001:db8:85a3::8a2e:370:7334 here", "8a2e:370:7334", "[IP_ADDRESS]"],
  ["gateway fe80::1ff:fe23:4567:890a", "fe80::1ff", "[IP_ADDRESS]"],
  ["::ffff:192.168.0.1", "192.168.0.1", "[IP_ADDRESS]"],
  ["mac 00:1A:2B:3C:4D:5E ok", "00:1A:2B:3C:4D:5E", "[MAC_ADDRESS]"],
  ["MAC 00-1A-2B-3C-4D-5E", "00-1A-2B-3C-4D-5E", "[MAC_ADDRESS]"],
  ["SECRET_KEY=abc123def456ghi789", "abc123def456ghi789", "[SECRET]"],
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI", "[SECRET]"],
  ["export DB_PASSWORD='hunter2hunter2'", "hunter2hunter2", "[SECRET]"],
  ['{"client_secret": "a1b2c3d4e5f6g7h8"}', "a1b2c3d4e5f6g7h8", "[SECRET]"],
  ["password = hunter2", "hunter2", "[SECRET]"],
  ["密码：abc12345", "abc12345", "[SECRET]"],
  ["Cookie: sessionid=abcd1234efgh5678; csrftoken=zzzzyyyyxxxx1111", "abcd1234efgh5678", "[COOKIE]"],
  ["Set-Cookie: JSESSIONID=ABCDEF1234567890; Path=/; HttpOnly", "ABCDEF1234567890", "[COOKIE]"],
  ["sessionid=abcd1234efgh5678", "abcd1234efgh5678", "[COOKIE]"],
  ["I live at 123 Main Street, Springfield, IL 62704", "Main Street", "[ADDRESS]"],
  ["Deliver to 350 5th Ave Apt 4B please", "5th Ave", "[ADDRESS]"],
  ["Ship to 10 Downing Street, London SW1A 2AA", "Downing", "[ADDRESS]"],
  ["Ship to 10 Downing Street, London SW1A 2AA", "SW1A 2AA", "[POSTAL_CODE]"],
  ["地址：北京市朝阳区建国路88号3号楼502室", "建国路88号", "[ADDRESS]"],
  ["From: John Smith <john@x.com>", "John Smith", "[NAME]"],
];
for (const [input, secret, ph] of MUST) {
  const out = R(input);
  check(`redacts: ${input.slice(0, 60)}`, !out.includes(secret) && out.includes(ph), `-> ${out}`);
}

// ---- must NOT change ----
const KEEP = [
  "Password: required", "password: Required", "Password: ********", "secret: required", "token: <your token>",
  "max token: 4096", "max_tokens=4096", "tokenizer: bert-base-uncased", "api_key=your_api_key_here",
  "token limit: 4096", "Where is the search box on this page?",
  "Please Contact Support Team <help@example.com>".replace("help@example.com", "[EMAIL]"),
  "Contact: Support Team", "Customer Service Team",
  "Version 1.2.3.4", "time 10:30:45 and 12:30::", "std::string foo", "a::b",
  "Order 2025551234 shipped", "Invoice #2025551234", "tracking 4155550132x",
  "Meeting at 10:30, price $1,234.56 on 2024/01/02, id 99887766",
  "The quick brown fox jumps over the lazy dog 12345.",
  "Hello World, hi everyone, Dear Customer Support Team",
  "In 2024 Will Smith visited the Main Street Bank.",
  "Paris Hilton Street food in Austin Texas", "Mark the date: 5 Easy Steps",
  // Names WITHOUT a cue are never redacted (the documented contract): a
  // bare-name rule used to blind every Q&A about a public figure and made
  // fact-check claims unsearchable.
  "John Smith approved the request",
  "Meeting with Mary Johnson and Robert Brown",
  "Who was Charles Darwin?",
  "Fact check: Michael Jordan won 6 championships",
  "The theory was developed by Alfred Wallace in 1858.",
  // "Name:" after a non-person qualifier is a label, not a person cue.
  "Product Name: Widget Pro Max",
  "Brand Name: Acme Corp",
  "File Name: Report-2026.PDF",
  "Hi Google, please help me.",
];
for (const input of KEEP) check(`unchanged: ${input.slice(0, 60)}`, R(input) === input, `-> ${R(input)}`);

// ---- display-name rule still redacts a real name, keeps role words ----
check('"Please Contact Support Team <a@b.com>" is not a name', !R("Please Contact Support Team <a@b.com>").includes("[NAME"), R("Please Contact Support Team <a@b.com>"));
check('"Please contact John Smith <a@b.com>" keeps the lead words', /^Please contact \[NAME\] <\[EMAIL\]>$/.test(R("Please contact John Smith <a@b.com>")), R("Please contact John Smith <a@b.com>"));

// ---- cued names still redacted after the bare-name rule removal ----
check('"Name: John Smith" still redacts', R("Name: John Smith").includes("[NAME"), R("Name: John Smith"));
check('"My name is Jane Doe" still redacts', R("My name is Jane Doe").includes("[NAME"), R("My name is Jane Doe"));
check('"Dear John" still redacts', R("Dear John").includes("[NAME"), R("Dear John"));
check('"Hi John," still redacts', R("Hi John, hello").includes("[NAME"), R("Hi John, hello"));
check('"Dr. Smith examined" still redacts', R("Dr. Smith examined the results").includes("[NAME"), R("Dr. Smith examined the results"));
check('"姓名：张三" still redacts', R("姓名：张三").includes("[NAME"), R("姓名：张三"));
check('"Customer Name: John Smith" still redacts (person-plausible qualifier)', R("Customer Name: John Smith").includes("[NAME"), R("Customer Name: John Smith"));

// ---- v1.10.132: placeholder pipeline edges (field report round 8) ----
{
  // A literal [EMAIL#1] in the source is RESERVED: the real email gets #2 and
  // the literal token is never restored to a real value (streaming included).
  const s = createRedactionSession();
  const red = R("Quote [EMAIL#1] literally. Mail jane@example.com.", s);
  check("literal token reserves its number", red.includes("[EMAIL#1]") && red.includes("[EMAIL#2]"), red);
  check("literal token survives restore", restorePlaceholders("Here: [EMAIL#1] and [EMAIL#2].", s) === "Here: [EMAIL#1] and jane@example.com.");
  let acc = "";
  const stream = new PlaceholderRestorer(s, (d) => { acc += d; });
  for (const piece of ["Here: [EMA", "IL#1] and [EMAIL", "#2]."]) stream.push(piece);
  stream.flush();
  check("literal token survives the streaming restorer", acc === "Here: [EMAIL#1] and jane@example.com.", JSON.stringify(acc));
}
{
  // A backslash at a CHUNK boundary escaping the next chunk's placeholder:
  // emitting it immediately left a stray "\" before the restored value.
  const s = createRedactionSession();
  R("call 415-555-0132 or 650-555-0134 now", s); // [PHONE#1], [PHONE#2]
  let out = "";
  const r = new PlaceholderRestorer(s, (d) => { out += d; });
  r.push("see \\");
  r.push("[PHONE#2\] ok");
  r.flush();
  check("cross-chunk escaped placeholder has no stray backslash", out === "see 650-555-0134 ok", JSON.stringify(out));
}
{
  // numberPlaceholder: a rule whose matched value ends with "]" (or starts at
  // a literal "[") used to degrade to an UNNUMBERED [COOKIE] - unrestorable.
  const s = createRedactionSession();
  const red = R("Set-Cookie: sid=abc123456]", s);
  check("cookie value ending in ] is numbered", red === "Set-Cookie: [COOKIE#1]", red);
  check("... and restores the original value", restorePlaceholders(red, s) === "Set-Cookie: sid=abc123456]");
  const red2 = R("Cookie:[9", s);
  check("value starting at a literal [ is numbered", red2 === "Cookie:[COOKIE#2]", red2);
  check("... and restores", restorePlaceholders(red2, s) === "Cookie:[9");
}

// ---- v1.10.131: worst-case timing + coverage (field report round 8) ----
{
  const s = "区".repeat(16000);
  const t0 = Date.now();
  R(s);
  check(`16k 区 in ${Date.now() - t0}ms (was 4.3s)`, Date.now() - t0 < 500, `${Date.now() - t0}ms`);
  check("16k 区 untouched", R(s) === s);
  const sp = "phone " + " ".repeat(50000);
  const t1 = Date.now();
  R(sp);
  check(`phone + 50k spaces in ${Date.now() - t1}ms (was 3.8s)`, Date.now() - t1 < 500, `${Date.now() - t1}ms`);
  check("DOB rule stays linear too", R("生日 " + " ".repeat(50000)) === "生日 " + " ".repeat(50000));
}
{
  check("French mobile redacted", R("06 12 34 56 78") === "[PHONE]", R("06 12 34 56 78"));
  check("Japanese mobile redacted", R("090-1234-5678") === "[PHONE]", R("090-1234-5678"));
  check("Taiwanese mobile redacted", R("0912-345-678") === "[PHONE]", R("0912-345-678"));
  check("Spanish mobile is [PHONE], not [SIN]", R("612 345 678") === "[PHONE]", R("612 345 678"));
  check("accented/IDN email redacted", R("josé@exämple.com") === "[EMAIL]", R("josé@exämple.com"));
  check("ETH address redacted", R("0x71C7656EC7ab88b098defB751B7401B5f6d8976F") === "[CRYPTO_ADDRESS]", R("0x71C7656EC7ab88b098defB751B7401B5f6d8976F"));
  check("BTC base58 redacted", R("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa") === "[CRYPTO_ADDRESS]", R("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
  check("BTC bech32 redacted", R("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh") === "[CRYPTO_ADDRESS]", R("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"));
}
{
  check("Taiwan ID redacted", R("A123456789") === "[ID_NUMBER]", R("A123456789"));
  check("Spanish DNI redacted", R("12345678Z") === "[ID_NUMBER]", R("12345678Z"));
  check("UK NI (spaced) redacted", R("AB 12 34 56 C") === "[ID_NUMBER]", R("AB 12 34 56 C"));
  check("Aadhaar (Verhoeff-valid) redacted", R("2345 6789 0121") === "[ID_NUMBER]", R("2345 6789 0121"));
  check("French NIR redacted", R("184127645108451") === "[ID_NUMBER]", R("184127645108451"));
  check("Luhn-true URL path digits are not a card", R("https://x.com/status/1580000000000000000") === "https://x.com/status/1580000000000000000");
  check("Aadhaar with a wrong check digit stays", R("2345 6789 0123") === "2345 6789 0123");
}

// ---- restoreNamePlaceholders: names only, other placeholders untouched ----// ---- restoreNamePlaceholders: names only, other placeholders untouched ----
{
  const s = createRedactionSession();
  const red = R("Name: John Smith, mail jane@x.com", s);
  check("setup: name and email redacted", red.includes("[NAME#1]") && red.includes("[EMAIL#1]"), red);
  const namesBack = restoreNamePlaceholders(red, s);
  check("restoreNamePlaceholders: name restored", namesBack === "Name: John Smith, mail [EMAIL#1]", namesBack);
  check("restoreNamePlaceholders: full restore still works", restorePlaceholders(red, s) === "Name: John Smith, mail jane@x.com");
  check("restoreNamePlaceholders: unknown token untouched", restoreNamePlaceholders("[NAME#9]", s) === "[NAME#9]");
  check("restoreNamePlaceholders: no session is a no-op", restoreNamePlaceholders(red, null) === red);
}

// ---- numbered placeholders and restore ----
{
  const s = createRedactionSession();
  const text = "Mail jane@x.com and bob@y.org, again jane@x.com; call (415) 555-0132 or 4155550132. IP 10.1.2.3 password: hunter2";
  const red = R(text, s);
  check("numbered: distinct values get distinct numbers", red.includes("[EMAIL#1]") && red.includes("[EMAIL#2]"), red);
  check("numbered: same value gets the same number", (red.match(/\[EMAIL#1\]/g) || []).length === 2, red);
  check("numbered: no real value left", !/jane@x|bob@y|555-0132|4155550132|10\.1\.2\.3|hunter2/.test(red), red);
  check("restore: exact round trip", restorePlaceholders(red, s) === text, restorePlaceholders(red, s));
  check("restore: escaped brackets from markdown", restorePlaceholders("Write to \\[EMAIL#1\\] now", s) === "Write to jane@x.com now");
  check("restore: unknown placeholder untouched", restorePlaceholders("[EMAIL#9] [FOO#1]", s) === "[EMAIL#9] [FOO#1]");
  // streamed in tiny pieces, including splits inside a placeholder
  for (const size of [1, 2, 3, 5, 7]) {
    const out = [];
    const pr = new PlaceholderRestorer(s, (x) => out.push(x));
    for (let i = 0; i < red.length; i += size) pr.push(red.slice(i, i + size));
    pr.flush();
    check(`restore: streamed in ${size}-char pieces`, out.join("") === text, out.join(""));
  }
  const out = [];
  const pr = new PlaceholderRestorer(s, (x) => out.push(x));
  pr.push("Brackets [like this and more text that is long enough to be released");
  pr.push(" and [EMAIL#2]");
  pr.flush();
  check("restore: a stray '[' does not stall the stream", out.join("") === "Brackets [like this and more text that is long enough to be released and bob@y.org", out.join(""));
}
{
  // The same session covers several fields (question + page + history).
  const s = createRedactionSession();
  const a = R("write to jane@x.com", s);
  const b = R("page says jane@x.com", s);
  check("session shared across fields: same value, same placeholder", a.endsWith("[EMAIL#1]") && b.endsWith("[EMAIL#1]"));
}
check("without a session plain placeholders are used", R("jane@x.com") === "[EMAIL]");

// ---- round-6 regressions: later rules must not swallow earlier placeholders ----
// A URL query whose value was already redacted by an earlier rule: the
// URL-query rule used to match "?token=[JWT" (stopping at the "#"), which
// produced corrupted output like "[SECRET]#1]" and severed the mapping.
{
  const s = createRedactionSession();
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.c2lnbmF0dXJlMTIzNDU2Nzg";
  const out = R(`https://api.example.com/data?token=${jwt}`, s);
  check("JWT inside a URL stays one intact placeholder", new RegExp(`\\?token=\\[JWT#\\d+\\]$`).test(out), out);
  check("URL-embedded JWT restores to the original value", restorePlaceholders(out, s) === `https://api.example.com/data?token=${jwt}`, restorePlaceholders(out, s));
}
{
  // A raw (not-yet-redacted) query secret is still caught and restored.
  const s = createRedactionSession();
  const out = R("https://e.com/a?api_key=abcdef1234567890abcdef&x=1", s);
  check("raw URL query secret is still redacted", /\?api_key=\[SECRET#\d+\]/.test(out), out);
  check("raw URL query secret restores", restorePlaceholders(out, s) === "https://e.com/a?api_key=abcdef1234567890abcdef&x=1", restorePlaceholders(out, s));
}
{
  // The SECRET_KV bare-value class must stop at "&": "?token=...&page=2"
  // used to swallow the rest of the query string as one secret, hiding the
  // harmless parameters from the model (the restore round-trip masked it).
  const s = createRedactionSession();
  const out = R("https://e.com/a?token=abcdef1234567890abcdef&page=2&id=7", s);
  check("KV secret in a URL keeps the following params visible", /\?token=\[SECRET#\d+\]&page=2&id=7$/.test(out), out);
  check("KV secret in a URL restores fully", restorePlaceholders(out, s) === "https://e.com/a?token=abcdef1234567890abcdef&page=2&id=7", restorePlaceholders(out, s));
}
{
  // A URL query whose value an earlier rule already turned into a placeholder
  // AND that has parameters after it: the bare-value class used to swallow
  // "[JWT#1]&prompt=none" into an unnumbered [SECRET], destroying the
  // placeholder and permanently severing its mapping.
  const s = createRedactionSession();
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.c2lnbmF0dXJlMTIzNDU2Nzg";
  const input = `Open https://id.example.com/authorize?state=xyz&token=${jwt}&prompt=none to continue.`;
  const out = R(input, s);
  check("placeholder-valued query param with a tail keeps the placeholder", /[?&]token=\[JWT#\d+\]&prompt=none to continue\.$/.test(out), out);
  check("placeholder-valued query param with a tail restores", restorePlaceholders(out, s) === input, restorePlaceholders(out, s));
}
{
  // A quoted KV value that contains an earlier placeholder is left alone too
  // (the placeholder guard covers the quoted alternatives as well).
  const s = createRedactionSession();
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.c2lnbmF0dXJlMTIzNDU2Nzg5";
  const input = `api_key: "${jwt} and more"`;
  const out = R(input, s);
  check("quoted KV value holding a placeholder is not re-redacted", /api_key: "\[JWT#\d+\] and more"/.test(out), out);
  check("quoted KV value holding a placeholder restores", restorePlaceholders(out, s) === input, restorePlaceholders(out, s));
}
{
  // "=" stays inside the bare-value class, so a base64-padded secret in KV
  // form is redacted including its padding (no "[SECRET]==" residue).
  const s = createRedactionSession();
  const out = R("SECRET_KEY=abc123def456==", s);
  check("base64-padded bare value fully redacted", /SECRET_KEY=\[SECRET#\d+\]$/.test(out) && !out.includes("abc123def456"), out);
}
{
  // A Cookie header whose value already carries a placeholder (from the JWT
  // rule, which runs earlier): the whole-header [COOKIE] rule used to blank
  // it, orphaning the placeholder's mapping.
  const s = createRedactionSession();
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.c2lnbmF0dXJlMTIzNDU2Nzg";
  const input = `Cookie: auth=${jwt}; session=abcdefghij`;
  const out = R(input, s);
  check("cookie header keeps an earlier placeholder", /\[JWT#\d+\]/.test(out) && !out.startsWith("Cookie: [COOKIE]"), out);
  check("cookie header value restores completely", restorePlaceholders(out, s) === input, restorePlaceholders(out, s));
}

// ---- literal placeholder-shaped text must not collide with generated ones ----
{
  const s = createRedactionSession();
  const input = "Use [EMAIL#1] literally; the real mail is a@b.com";
  const out = R(input, s);
  check("literal [EMAIL#1] is reserved", out.includes("[EMAIL#1]") && out.includes("[EMAIL#2]"), out);
  check("literal placeholder round-trips untouched", restorePlaceholders(out, s) === input, restorePlaceholders(out, s));
}
{
  // Reservation spans the whole payload: a page containing [EMAIL#1] cannot
  // steal the number a real email in the question would use.
  const s = createRedactionSession();
  const out = redactOutbound({
    question: "mail a@b.com",
    pageContext: { text: "page literally says [EMAIL#1]" },
  }, s);
  check("payload-wide reservation skips the literal number", out.question.includes("a@b.com") === false && out.question.includes("[EMAIL#2]"), out.question);
  check("payload-wide reservation leaves page literal", out.pageContext.text.includes("[EMAIL#1]"), out.pageContext.text);
  check("payload-wide restore is clean", restorePlaceholders(out.question, s) === "mail a@b.com", restorePlaceholders(out.question, s));
}
// ---- generic payload redaction covers fields added later ----
{
  const s = createRedactionSession();
  const out = redactOutbound({
    question: "mail a@b.com",
    extraFutureField: { note: "call 4155550132" },
    images: [{ name: "x.png", dataUrl: "data:image/png;base64,AAAA" }],
  }, s);
  check("unknown text field is redacted", !out.extraFutureField.note.includes("4155550132"), out.extraFutureField.note);
  check("image data is left untouched", out.images[0].dataUrl === "data:image/png;base64,AAAA");
}

process.exit(failed ? 1 : 0);
