#!/usr/bin/env node
// Unit tests for pii-filter.js: what must be redacted, what must be left alone,
// numbered placeholders and restoring the real values in a reply.
// Run:  node scripts/test-pii-filter.mjs
import { redactSensitive as R, createRedactionSession, restorePlaceholders, restoreNamePlaceholders, placeholderMapFromSession, sanitizePiiMap, usedPiiMap, restoreWithMap, restoreInHtmlText, redactOutbound } from "../privacy/pii-filter.js";

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
  // v1.10.147 (review round #10): shapes the 95-sample missed-detection probe caught.
  ["Call 0049 171 1234567 today", "0049 171 1234567", "[PHONE]"],
  ["Ring 03-1234-5678 now", "03-1234-5678", "[PHONE]"],
  ["id 0312345678 here", "0312345678", "[PHONE]"],
  ["Social Security Number: 123456789", "123456789", "[SSN]"],
  ["SSN 123 45 6789", "123 45 6789", "[SSN]"],
  // The webhook URLs are assembled from parts: a contiguous literal would
  // trip GitHub push protection (they are fake, but scanners cannot know).
  ["webhook " + ["https://", "hooks.slack.com", "/services/T00000000/B00000000/", "X".repeat(24)].join("") + " end",
    ["hooks.slack.com", "/services/T00000000/B00000000/", "X".repeat(24)].join(""), "[API_KEY]"],
  ["see " + ["https://", "discord.com", "/api/webhooks/123456789012345678/", "A".repeat(40)].join("") + " end",
    ["discord.com", "/api/webhooks/123456789012345678/", "A".repeat(40)].join(""), "[API_KEY]"],
  [`key SG.${"A".repeat(22)}.${"B".repeat(43)} end`, `SG.${"A".repeat(22)}.${"B".repeat(43)}`, "[API_KEY]"],
  [`bot 1234567890:${"Z".repeat(35)} here`, `1234567890:${"Z".repeat(35)}`, "[API_KEY]"],
  ["KR id 900101-1234567", "900101-1234567", "[ID_NUMBER]"],
  ["Passport No. E12345678", "E12345678", "[ID_NUMBER]"],
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

// ---- fixed-prefix developer-platform tokens + vendor-prefixed URL parameters ----
// Every value is synthetic and assembled from parts: a contiguous "glpat-..." /
// "hf_..." literal can trip GitHub push protection even when it is fake.
{
  const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const alnum = (n) => rep("Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xR", n);
  const urlsafe = (n) => rep("Ab3-E6_H9jK2mN5pQ8sT1vW4yZ7cF0xR", n);
  const hex = (n) => rep("a1b2c3d4e5f60718", n);

  const TOKENS = [
    ["HuggingFace hf_", "hf_", alnum(34)],
    ["npm npm_", "npm_", alnum(36)],
    ["Replicate r8_", "r8_", alnum(37)],
    ["GitLab glpat-", "glpat-", urlsafe(20)],
    ["Google OAuth ya29.", "ya29.", urlsafe(60)],
    ["Google service-account ya29.c.", "ya29.c.", urlsafe(60)],
    ["PyPI pypi-", "pypi-", urlsafe(70)],
    ["xAI xai-", "xai-", alnum(80)],
    ["Perplexity pplx-", "pplx-", alnum(48)],
    ["DigitalOcean dop_v1_", "dop_v1_", hex(64)],
    ["Mailgun key-", "key-", hex(32)],
    // Round-17 review: bare pastes of these leaked (SECRET_KV needs a "key:" /
    // "key=" context, the URL rule needs "?name=", Bearer needs its prefix).
    ["Shopify shpat_", "shpat_", hex(32)],
    ["Shopify shpss_", "shpss_", hex(32)],
    ["Shopify shpvt_", "shpvt_", hex(32)],
    ["Supabase sb_secret_", "sb_secret_", urlsafe(40)],
    ["Notion legacy secret_", "secret_", alnum(32)],
    ["Notion current ntn_", "ntn_", alnum(34)],
    ["Linear lin_api_", "lin_api_", alnum(32)],
    ["Square EAAA", "EAAA", alnum(40)],
  ];
  for (const [name, prefix, body] of TOKENS) {
    const out = R(`the value is ${prefix}${body} here`);
    check(`redacts ${name} token`, out === "the value is [API_KEY] here", `-> ${out}`);
  }
  const jsonOut = R(`{"hf":"hf_${alnum(34)}"}`);
  check("token inside a JSON string is redacted, quotes kept", jsonOut === '{"hf":"[API_KEY]"}', `-> ${jsonOut}`);

  // Short or differently-shaped look-alikes are ordinary text.
  for (const keep of [
    `hf_${alnum(12)}`, "hf_hub_download(repo_id)", "npm_config_cache=/tmp/npm", `r8_${alnum(12)}`,
    "xai-core and pplx-api are product names", "pypi-mirror", "a key-value store", `dop_v1_${hex(10)}`,
    `monkey-${hex(32)}`, // no word boundary before "key-"
    `shpat_${hex(10)}`, // too short for the Shopify shape
    `sb_secret_${urlsafe(10)}`, // too short for the Supabase shape
    `secret_${alnum(29)}`, // one char below the Notion gate
    "secret_recipe_of_the_house", // underscores break the alnum run
    "the EAAAs are awarded yearly", // no long alnum run after the prefix
    `EAAA${alnum(10)}`, // too short for the Square shape
  ]) check(`unchanged: ${keep.slice(0, 50)}`, R(keep) === keep, `-> ${R(keep)}`);

  // Numbered placeholders round-trip for the new rules too.
  {
    const s = createRedactionSession();
    const text = `token hf_${alnum(34)} then ya29.c.${urlsafe(60)}`;
    const red = R(text, s);
    check("new token rules get numbered placeholders", red === "token [API_KEY#1] then [API_KEY#2]", red);
    check("... and the originals are restored", restorePlaceholders(red, s) === text, restorePlaceholders(red, s));
  }

  // Presigned URLs: the signature is a bearer credential for the object.
  const sig = hex(64);
  const amz = `https://bucket.s3.amazonaws.com/f.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=${sig}`;
  const amzOut = R(amz);
  check("presigned URL: X-Amz-Signature redacted", !amzOut.includes(sig) && amzOut.endsWith("&X-Amz-Signature=[SECRET]"), amzOut);
  check("presigned URL: the other parameters survive", amzOut.includes("?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-SignedHeaders=host&"), amzOut);
  const goog = R(`https://storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${sig}&X-Goog-Expires=60`);
  check("presigned URL: X-Goog-Signature redacted mid-URL", goog.endsWith("X-Goog-Signature=[SECRET]&X-Goog-Expires=60") && !goog.includes(sig), goog);
  const session = urlsafe(80);
  check("presigned URL: X-Amz-Security-Token redacted", R(`https://b.s3.amazonaws.com/f?X-Amz-Security-Token=${session}&X-Amz-Expires=300`) === "https://b.s3.amazonaws.com/f?X-Amz-Security-Token=[SECRET]&X-Amz-Expires=300");
  check("presigned URL: X-Amz-Credential redacted", R("https://b.s3.amazonaws.com/f?X-Amz-Credential=AKIDEXAMPLE%2F20240101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240101T000000Z") === "https://b.s3.amazonaws.com/f?X-Amz-Credential=[SECRET]&X-Amz-Date=20240101T000000Z");
  check("vendor-prefixed x-api-key parameter redacted", R("https://a.example/v1?x-api-key=abc123XYZ789") === "https://a.example/v1?x-api-key=[SECRET]");

  // The bare names the old rule covered must keep working (key, auth, sig, access_token).
  for (const [u, want] of [
    ["https://a.example/x?key=abc123XYZ789", "https://a.example/x?key=[SECRET]"],
    ["https://a.example/x?id=1&auth=abc123XYZ789", "https://a.example/x?id=1&auth=[SECRET]"],
    ["https://a.example/x?sv=2022&sig=abc123XYZ789", "https://a.example/x?sv=2022&sig=[SECRET]"],
    ["https://a.example/x?access_token=abc123XYZ789", "https://a.example/x?access_token=[SECRET]"],
  ]) check(`bare URL parameter still redacted: ${u.split("?")[1]}`, R(u) === want, `-> ${R(u)}`);

  // A value that is already a placeholder is left alone (no "[SECRET]]" residue).
  const jwt = ["eyJ", "hbGciOiJI", ".", "eyJzdWIiOiIx", ".", "c2lnbmF0dXJl"].join("");
  check("placeholder value under a prefixed parameter is not corrupted", R(`https://a.example/?X-Amz-Signature=${jwt}`) === "https://a.example/?X-Amz-Signature=[JWT]");

  // The prefix is not a licence to eat ordinary parameters.
  for (const keep of [
    "https://a.example/?turkey=abc123&author=jane&page=2&sort=asc",
    "https://b.s3.amazonaws.com/f?X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Algorithm=AWS4-HMAC-SHA256",
    "https://a.example/?tokenizer=bert&design=dark",
  ]) check(`unchanged: ${keep.slice(8, 70)}`, R(keep) === keep, `-> ${R(keep)}`);

  // The lazy prefix must stay linear on a long run of name characters.
  const t0 = performance.now();
  R("&" + "a".repeat(200000));
  R("&a".repeat(100000));
  check("URL-parameter rule stays fast on pathological input", performance.now() - t0 < 1500, `${(performance.now() - t0).toFixed(0)} ms`);
}

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
  // v1.10.140: the worker streams the placeholders as they are; the panel
  // accumulates the raw chunks and restores values from the PII map when it
  // renders. A placeholder split across chunks restores once the pieces join.
  const map = placeholderMapFromSession(s);
  acc = restoreWithMap("Here: [EMA" + "IL#1] and [EMAIL" + "#2].", map);
  check("literal token survives map-based restore (split across chunks)", acc === "Here: [EMAIL#1] and jane@example.com.", JSON.stringify(acc));
}
{
  // v1.10.140: restored values can never become markup. restoreInHtmlText
  // HTML-escapes every value it inserts into text nodes, and never touches
  // an address (href / src keep their placeholders).
  const s = createRedactionSession();
  const red = R("call 415-555-0132 now", s); // [PHONE#1]
  const map = placeholderMapFromSession(s);
  check("setup: phone redacted to a numbered placeholder", red.includes("[PHONE#1]"), red);
  const html = `<p>call [PHONE#1] &lt;tag&gt; and <a href="x?q=[PHONE#1]">link</a></p>`;
  const restored = restoreInHtmlText(html, map);
  check("restored value appears in the text node", restored.includes("call 415-555-0132 &lt;tag&gt;"), restored);
  check("a link target keeps its placeholder", /href="x\?q=\[PHONE#1\]"/.test(restored), restored);
}
{
  // numberPlaceholder: a rule whose matched value ends with "]" (or starts at
  // a literal "[") used to degrade to an UNNUMBERED [COOKIE] - unrestorable.
  const s = createRedactionSession();
  const red = R("Set-Cookie: sid=abc123456]", s);
  check("cookie value ending in ] is numbered", red === "Set-Cookie: [COOKIE#1]", red);
  check("... and restores the original value", restorePlaceholders(red, s) === "Set-Cookie: sid=abc123456]");
  const red2 = R("Cookie: sid=[9", s);
  check("value starting at a literal [ is numbered", red2 === "Cookie: [COOKIE#2]", red2);
  check("... and restores", restorePlaceholders(red2, s) === "Cookie: sid=[9");
}

// ---- round-17 #11/#12/#13: cookie-value shape gate, numeric session ids, 15-digit IDs ----
{
  // A Cookie: header is blanked only when the value is actually cookie-shaped
  // (name=value pairs); prose stays ordinary text.
  check("prose after Cookie: is kept", R("Cookie: This dough needs chilling") === "Cookie: This dough needs chilling", R("Cookie: This dough needs chilling"));
  check("Set-Cookie attribute tail still blanks", R("Set-Cookie: JSESSIONID=ABCDEF1234567890; Path=/; HttpOnly") === "Set-Cookie: [COOKIE]", R("Set-Cookie: JSESSIONID=ABCDEF1234567890; Path=/; HttpOnly"));
  // A pure-digit session id is a credential (it has no letter, so the
  // looksLikeSecret gate alone let it through).
  check("numeric sessionid is redacted", R("sessionid=123456789012") === "sessionid=[COOKIE]", R("sessionid=123456789012"));
  check("numeric csrf token is redacted", R("csrftoken: 987654321098") === "csrftoken: [COOKIE]", R("csrftoken: 987654321098"));
  check("short numeric value stays text", R("sid=1234567") === "sid=1234567", R("sid=1234567"));

  // Legacy (pre-2000) 15-digit resident IDs: month/day shape only (no
  // checksum exists in the old format).
  check("15-digit legacy CN ID is redacted", R("old id 110105491231002 here") === "old id [ID_NUMBER] here", R("old id 110105491231002 here"));
  // A 15-digit credit card (AmEx shape) must NOT be mislabeled as an ID.
  check("15-digit AmEx stays a card", R("card 378282246310005 charge") === "card [CREDIT_CARD] charge", R("card 378282246310005 charge"));
  check("invalid month 15-digit run stays text", R("ref 990123456789012") === "ref 990123456789012", R("ref 990123456789012"));
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

// ---- credit cards: every common length, solid and grouped ----
// Regression for two review findings (2026-11-07):
//  1. luhnValid() iterated left-to-right with the first digit undoubled -
//     equivalent to the standard direction only for ODD lengths, so 14/16/
//     18-digit cards (16 is the mainstream Visa/Mastercard/Discover/JCB/
//     UnionPay length) failed the check ~90% of the time and leaked in
//     plaintext (measured: 9-10% detection for even lengths).
//  2. The 12-digit Aadhaar / My Number rules ran BEFORE the card rule and
//     swallowed a grouped card's first 12 digits - the 4111... sample below
//     surfaced as "[ID_NUMBER] 1111", which is why the outbound-PII suite
//     never noticed bug 1 (its assertion only requires the full number to be
//     gone, and it was).
// The card rule now runs before the 12-digit rules, so a valid 13-19-digit
// card is always ONE [CREDIT_CARD] - and never "[ID_NUMBER] + last 4".
const luhnCheckDigit = (base) => {
  let sum = 0;
  let dbl = true; // from the right: skip the (future) check digit, double the rest alternately
  for (let i = base.length - 1; i >= 0; i--) {
    let d = base.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
};
for (const L of [13, 14, 15, 16, 17, 18, 19]) {
  const base = "45391876425309714539187642530971".slice(0, L - 1);
  const card = base + luhnCheckDigit(base);
  const grouped = card.replace(/(\d{4})(?=\d)/g, "$1 ");
  check(`card ${L} digits (solid) redacted whole`, R(`pay ${card} now`) === "pay [CREDIT_CARD] now", JSON.stringify(R(`pay ${card} now`)));
  check(`card ${L} digits (grouped) redacted whole`, R(`pay ${grouped} now`) === "pay [CREDIT_CARD] now", JSON.stringify(R(`pay ${grouped} now`)));
}
// The concrete report cases. "4111 1111 1111 1111" is the outbound-PII suite's
// own sample: its first 12 digits pass the My Number check, so before the rule
// reorder it came back as "[ID_NUMBER] 1111" even after the Luhn fix.
check("Visa 16 solid (4539 1488 0343 6467) redacted", R("Pay 4539148803436467 now") === "Pay [CREDIT_CARD] now", JSON.stringify(R("Pay 4539148803436467 now")));
check("Visa 16 grouped with cue redacted", R("Card number: 4539 1488 0343 6467") === "Card number: [CREDIT_CARD]", JSON.stringify(R("Card number: 4539 1488 0343 6467")));
check("Amex 15 grouped redacted", R("Pay 3714 496353 98431 now") === "Pay [CREDIT_CARD] now", JSON.stringify(R("Pay 3714 496353 98431 now")));
check("4111 sample is one [CREDIT_CARD], not [ID_NUMBER] + 1111", R("card 4111 1111 1111 1111") === "card [CREDIT_CARD]", JSON.stringify(R("card 4111 1111 1111 1111")));
// The SIN rule shares the Luhn helper (9 digits): the direction fix must not
// change it, and a Spanish mobile must stay a [PHONE] (rule order untouched).
check("valid SIN still redacted as [SIN]", R("my sin 046 454 286") === "my sin [SIN]", JSON.stringify(R("my sin 046 454 286")));
check("Spanish mobile is still [PHONE], not [SIN]", R("612 345 678") === "[PHONE]", R("612 345 678"));

// ---- v1.10.147 (review round #10): false positives must stay ----
check('"Name: Python" stays (technology word)', R("Name: Python") === "Name: Python", JSON.stringify(R("Name: Python")));
check('"Client: Acme Corp" stays (organization suffix)', R("Client: Acme Corp") === "Client: Acme Corp", JSON.stringify(R("Client: Acme Corp")));
check('"Dr. Pepper" stays (brand)', R("Dr. Pepper") === "Dr. Pepper", JSON.stringify(R("Dr. Pepper")));
check("solid uncued Luhn-valid 9-digit stays (not a SIN)", R("ref 046454286 here") === "ref 046454286 here", JSON.stringify(R("ref 046454286 here")));
check("solid cued 9-digit redacts as [SIN]", R("SIN: 046454286") === "SIN: [SIN]", JSON.stringify(R("SIN: 046454286")));
check("grouped SIN still redacts without a cue", R("call 046 454 286") === "call [SIN]", JSON.stringify(R("call 046 454 286")));

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
  // v1.10.140: the map is what the panel uses. Full-text restore round-trips;
  // the map is sanitized (bad keys / oversized values dropped); usedPiiMap
  // keeps only the placeholders a stored reply actually uses - and restoring
  // with THAT subset still round-trips (the storage projection property).
  const map = placeholderMapFromSession(s);
  check("map: restore round trip", restoreWithMap(red, map) === text, restoreWithMap(red, map));
  check("map: escaped-bracket form restores", restoreWithMap("Write to \\[EMAIL#1\\] now", map) === "Write to jane@x.com now");
  check("map: unknown placeholder untouched", restoreWithMap("[EMAIL#9] [FOO#1]", map) === "[EMAIL#9] [FOO#1]");
  check("map: no map is a no-op", restoreWithMap(red, null) === red);
  const bad = sanitizePiiMap({ ...map, "not a placeholder": "x", "[BAD]": "y", "[EMAIL#3]": "z".repeat(3000) });
  check("map: sanitizePiiMap drops malformed keys and oversized values", Object.keys(bad).every((k) => /^\[[A-Z_]+#\d+\]$/.test(k)) && !("[EMAIL#3]" in bad), JSON.stringify(Object.keys(bad)));
  const used = usedPiiMap("mail [EMAIL#1] only", map);
  check("map: usedPiiMap keeps only what the text uses", used && "[EMAIL#1]" in used && !("[PHONE#1]" in used) && !("[EMAIL#2]" in used), JSON.stringify(used || {}));
  check("map: the used subset restores that text", restoreWithMap("mail [EMAIL#1] only", used) === "mail jane@x.com only", restoreWithMap("mail [EMAIL#1] only", used));
  // restoreInHtmlText: text nodes restore, addresses never do.
  const html = `<p>mail [EMAIL#1] and <a href="https://x/?a=[EMAIL#1]">write</a> <img src="https://x/?b=[EMAIL#2]" alt="to [EMAIL#1]"></p>`;
  const inHtml = restoreInHtmlText(html, map);
  check("html: text node restored", inHtml.includes("<p>mail jane@x.com and"), inHtml);
  check("html: href keeps the placeholder", inHtml.includes('href="https://x/?a=[EMAIL#1]"'), inHtml);
  check("html: src keeps the placeholder", inHtml.includes('src="https://x/?b=[EMAIL#2]"'), inHtml);
  check("html: alt text restored (display text, not an address)", inHtml.includes('alt="to jane@x.com"'), inHtml);
  check("html: no real value inside any address", !/https:\/\/x\/\?[ab]=jane@/.test(inHtml), inHtml);
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

// ---- full-width CJK punctuation ends a bare secret value (round-12 finding) ----
{
  const text = "密码：abc12345，Y仍然可见。token：xyz78912。";
  const out = R(text);
  check("CJK bare value stops at ，", !out.includes("abc12345") && out.includes("Y仍然可见"), out);
  check("CJK bare value stops at 。", !out.includes("xyz78912"), out);
  check("only the two secrets are placeholders", (out.match(/\[[A-Z_]+(?:#\d+)?\]/g) || []).length === 2, out);
  const s = createRedactionSession();
  const redacted = R(text, s);
  check("CJK bare value round-trips", restorePlaceholders(redacted, s) === text, restorePlaceholders(redacted, s));
  // A value consumed up to ASCII punctuation still works as before.
  const ascii = R("password = hunter2, next");
  check("ASCII bare value unchanged", !ascii.includes("hunter2") && ascii.includes(", next"), ascii);
}

// ---- full-width digits and separators (Japanese / Chinese input methods) ----
// Every rule is written for ASCII, so "０９０－１２３４－５６７８", a card number grouped
// with ideographic spaces or a resident ID ending in "Ｘ" used to match nothing and
// went out in plain text. Matching now runs on an ASCII-folded shadow copy and the
// placeholder is spliced into the REAL text: whatever the rule kept around the value
// (a cue word, the punctuation next to it) stays as the user typed it, and the value
// that is remembered - and shown back in the reply - is the typed one.
{
  // ASCII -> full-width: "!".."~" shift by 0xFEE0 and a space becomes U+3000. Done
  // with arithmetic so that this file contains no invisible character.
  const fw = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/ /g, String.fromCharCode(0x3000));

  // What an input method really produces, typed literally rather than through fw().
  check("full-width mobile number (literal)", R("Ring ０９０－１２３４－５６７８ now") === "Ring [PHONE] now", R("Ring ０９０－１２３４－５６７８ now"));
  check("full-width email (literal)", R("ｊａｎｅ．ｄｏｅ＠ｅｘａｍｐｌｅ．ｃｏｍ") === "[EMAIL]", R("ｊａｎｅ．ｄｏｅ＠ｅｘａｍｐｌｅ．ｃｏｍ"));
  check("full-width resident ID ending in Ｘ (literal)", R("id １１０１０５１９４９１２３１００２Ｘ here") === "id [ID_NUMBER] here", R("id １１０１０５１９４９１２３１００２Ｘ here"));

  // A value typed in full-width form is treated exactly like its ASCII spelling.
  // [label, text before, ASCII value, text after, placeholder both must produce]
  const SAME_AS_ASCII = [
    ["JP mobile, hyphens", "Ring ", "090-1234-5678", " now", "[PHONE]"],
    ["JP mobile, solid", "Ring ", "09012345678", " now", "[PHONE]"],
    ["JP landline", "Ring ", "03-1234-5678", " now", "[PHONE]"],
    ["CN mobile", "Ring ", "13812345678", " now", "[PHONE]"],
    ["US number with + and spaces", "Call ", "+1 415 555 0132", " now", "[PHONE]"],
    ["card, ideographic-space groups", "card ", "4111 1111 1111 1111", "", "[CREDIT_CARD]"],
    ["card, hyphen groups", "card ", "4111-1111-1111-1111", "", "[CREDIT_CARD]"],
    ["card, solid", "Pay ", "4539148803436467", " now", "[CREDIT_CARD]"],
    ["CN resident ID, X", "id ", "11010519491231002X", " here", "[ID_NUMBER]"],
    ["CN resident ID, x", "id ", "11010519491231002x", " here", "[ID_NUMBER]"],
    ["CN resident ID, legacy 15 digits", "old id ", "110105491231002", " here", "[ID_NUMBER]"],
    ["Taiwan ID (letter + digits)", "id ", "A123456789", " here", "[ID_NUMBER]"],
    ["SSN, dashes", "id ", "123-45-6789", " here", "[SSN]"],
    ["SSN behind its cue", "", "SSN: 123456789", "", "[SSN]"],
    ["email", "write ", "jane.doe@example.com", " now", "[EMAIL]"],
  ];
  for (const [label, before, value, after, ph] of SAME_AS_ASCII) {
    const ascii = R(`${before}${value}${after}`);
    const wide = R(`${before}${fw(value)}${after}`);
    check(`full-width ${label} is redacted like its ASCII spelling`, ascii === `${before}${ph}${after}` && wide === ascii, `ascii -> ${ascii} | full-width -> ${wide}`);
  }

  // A birth date behind its label; the label (with its full-width colon) stays.
  const dob = R(`生日：${fw("1990年1月2日")}`);
  check("full-width birth date behind its label", dob === "生日：[DATE_OF_BIRTH]", dob);

  // Whatever the rule kept around the value comes back from the REAL text: the
  // cue word of a passport number stays full-width, only the value is replaced.
  {
    const cue = fw("Passport No. ");
    const value = fw("E12345678");
    const plain = R(`${cue}${value}`);
    check("a full-width cue word is kept as typed", plain === `${cue}[ID_NUMBER]`, plain);
    const s = createRedactionSession();
    const numbered = R(`${cue}${value}`, s);
    check("... and with numbering", numbered === `${cue}[ID_NUMBER#1]`, numbered);
    check("... the remembered value is the typed one", placeholderMapFromSession(s)["[ID_NUMBER#1]"] === value, JSON.stringify(placeholderMapFromSession(s)));
    check("... and it restores to the original text", restorePlaceholders(numbered, s) === `${cue}${value}`, restorePlaceholders(numbered, s));
  }

  // CJK punctuation and labels around a value are left exactly as typed.
  {
    const input = `連絡先：${fw("090-1234-5678")}（携帯）。メール：${fw("jane.doe@example.com")}。`;
    const out = R(input);
    check("punctuation around full-width values is untouched", out === "連絡先：[PHONE]（携帯）。メール：[EMAIL]。", out);
    const two = R(`${fw("090-1234-5678")}，${fw("080-1111-2222")}`);
    check("a full-width comma separates two full-width numbers", two === "[PHONE]，[PHONE]", two);
  }

  // Numbered placeholders: one per distinct typed value, restored as typed.
  {
    const s = createRedactionSession();
    const phone = fw("090-1234-5678");
    const card = fw("4111 1111 1111 1111");
    const input = `Ring ${phone} now, again ${phone}, and ${card}.`;
    const out = R(input, s);
    check("one numbered placeholder per distinct full-width value", out === "Ring [PHONE#1] now, again [PHONE#1], and [CREDIT_CARD#1].", out);
    check("the remembered value is the one the user typed", placeholderMapFromSession(s)["[PHONE#1]"] === phone && placeholderMapFromSession(s)["[CREDIT_CARD#1]"] === card, JSON.stringify(placeholderMapFromSession(s)));
    check("full-width values round-trip exactly as typed", restorePlaceholders(out, s) === input, restorePlaceholders(out, s));
  }

  // Text that merely contains full-width characters is not changed.
  {
    const date = "２０２６年１１月１０日の会議は１２時からです。";
    check("full-width dates and times stay text", R(date) === date, R(date));
    const version = fw("v2.0.1.5");
    check("a full-width version string is not an IP address", R(version) === version, R(version));
    const s = createRedactionSession();
    check("... also with a session", R(version, s) === version && !s.byPlaceholder.size, R(version, s));
  }

  // The fold set deliberately leaves the full-width colon alone: a Chinese or
  // Japanese label is usually followed by exactly that colon, and the lookbehinds
  // of the MAC / IPv6 / bare-phone rules refuse a match right after an ASCII ":".
  // Folding it would stop redacting values that are redacted today.
  check("MAC address after a full-width colon is still redacted", R("MAC地址：00:1A:2B:3C:4D:5E") === "MAC地址：[MAC_ADDRESS]", R("MAC地址：00:1A:2B:3C:4D:5E"));
  check("IPv6 address after a full-width colon is still redacted", R("IP：2001:db8:85a3::8a2e:370:7334") === "IP：[IP_ADDRESS]", R("IP：2001:db8:85a3::8a2e:370:7334"));
  check("bare phone number after a full-width colon is still redacted", R("号码：4155550132") === "号码：[PHONE]", R("号码：4155550132"));

  // The single choke point covers every text field.
  {
    const s = createRedactionSession();
    const out = redactOutbound({
      question: `Ring ${fw("090-1234-5678")} now`,
      history: [{ role: "user", content: `write ${fw("jane.doe@example.com")}` }],
      pageContext: { text: `card ${fw("4111 1111 1111 1111")}` },
    }, s);
    check(
      "redactOutbound redacts full-width values in every text field",
      out.question === "Ring [PHONE#1] now" && out.history[0].content === "write [EMAIL#1]" && out.pageContext.text === "card [CREDIT_CARD#1]" && out.history[0].role === "user",
      JSON.stringify(out)
    );
    check("... and the question restores to what was typed", restorePlaceholders(out.question, s) === `Ring ${fw("090-1234-5678")} now`, restorePlaceholders(out.question, s));
  }
}

process.exit(failed ? 1 : 0);
