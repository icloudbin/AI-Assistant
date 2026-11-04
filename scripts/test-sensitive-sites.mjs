// scripts/test-sensitive-sites.mjs
//
// Regression test for the host rules of S-05. Run with:
//   node scripts/test-sensitive-sites.mjs
//
// S-05  The built-in sensitive-site knowledge missed outlook.com, exmail.qq.com,
//       accounts.google.com, binance, coinbase, robinhood, interactivebrokers,
//       1password, bitwarden, irs.gov and the Stripe dashboard, and its label
//       rule flagged river-bank.com. The user also had no way to add a site of
//       their own or to say "never send this site" / "always allow this site".

import assert from "node:assert/strict";

const ss = await import("../sensitive-sites.js");
const {
  BUILTIN_SENSITIVE_HOSTS, sensitiveHostOf, isSensitiveUrl, isBuiltinSensitiveHost, hostOf, webHostOf,
  normalizeHostEntry, parseHostList, parseHostListDetailed, hostMatchesEntry, sitePolicy,
  MAX_HOST_LIST_ENTRIES, SENSITIVE_EXTRACTOR_SOURCES,
} = ss;

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

const https = (host, path = "/") => `https://${host}${path}`;

await test("every site the issue lists as missing is now marked sensitive (with www. and deeper subdomains)", () => {
  const missed = [
    "outlook.com", "exmail.qq.com", "accounts.google.com", "binance.com", "coinbase.com", "robinhood.com",
    "interactivebrokers.com", "1password.com", "bitwarden.com", "irs.gov", "dashboard.stripe.com",
  ];
  for (const host of missed) {
    assert.ok(isSensitiveUrl(https(host)), `${host} must be sensitive`);
    assert.ok(isSensitiveUrl(https(`www.${host}`, "/account")), `www.${host} must be sensitive`);
    assert.ok(isSensitiveUrl(https(`a.b.${host}`)), `a.b.${host} must be sensitive`);
  }
  // Real entry points of those services, not just the bare domain.
  for (const url of [
    "https://outlook.live.com/mail/0/", "https://my.1password.com/vaults", "https://vault.bitwarden.com/#/vault",
    "https://www.irs.gov/payments", "https://sa.www4.irs.gov/", "https://pro.coinbase.com/", "https://www.binance.com/en/my/wallet",
    "https://client.schwab.com/", "https://www.interactivebrokers.com/sso/Login",
  ]) {
    assert.ok(isSensitiveUrl(url), `${url} must be sensitive`);
  }
});

await test("the stripe.com marketing site and docs are NOT marked - only the dashboard", () => {
  assert.equal(isSensitiveUrl("https://stripe.com/"), false);
  assert.equal(isSensitiveUrl("https://docs.stripe.com/api"), false);
  assert.equal(isSensitiveUrl("https://dashboard.stripe.com/payments"), true);
});

await test("the label rule needs a WHOLE label: river-bank.com and mail-archive.com are not marked", () => {
  for (const host of [
    "river-bank.com", "www.river-bank.com", "riverbank.com", "mail-archive.com", "lists.mail-archive.com",
    "my-mail.example.com", "mailer.example.com", "mailchimp.com", "banking-news.example.com", "bank-of-x.example.com",
    "snowbank.example.org", "emailsignature.example.com",
  ]) {
    assert.equal(isSensitiveUrl(https(host)), false, `${host} must not be marked`);
  }
});

await test("self-hosted webmail and banking hosts are still caught by the label rule", () => {
  for (const host of [
    "mail.example.org", "webmail.example.org", "mailplus.example.com", "owa.company.com", "mail2.example.com",
    "webmail01.example.org", "bank.example.de", "banking.example.com", "onlinebanking.example.de",
    "ebank.example.com.cn", "netbank.example.dk", "internetbanking.example.pt", "ebanque.example.fr",
    "online-banking.example.com", "web-mail.example.com", "x.webmail.example.com", "zimbra.example.com",
  ]) {
    assert.ok(isSensitiveUrl(https(host)), `${host} must be marked`);
  }
  // Three trailing digits are not "mail2"-style numbering.
  assert.equal(isSensitiveUrl("https://mail123.example.com/"), false);
});

await test("the .bank top-level domain and a one-label intranet host (http://mail/) are marked", () => {
  assert.ok(isSensitiveUrl("https://example.bank/"));
  assert.ok(isSensitiveUrl("https://login.example.bank/"));
  assert.ok(isSensitiveUrl("http://mail/"));
  assert.ok(isSensitiveUrl("http://webmail/inbox"));
  assert.equal(isSensitiveUrl("http://intranet/"), false);
});

await test("the previous built-in list is still covered", () => {
  for (const host of [
    "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "mail.proton.me",
    "proton.me", "protonmail.com", "icloud.com", "mail.aol.com", "mail.zoho.com", "fastmail.com", "mail.qq.com", "mail.163.com",
    "mail.126.com", "mail.sina.com.cn", "tutanota.com", "app.tuta.com", "mail.tuta.com", "paypal.com", "venmo.com", "wise.com",
    "alipay.com", "pay.weixin.qq.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com",
    "capitalone.com", "usbank.com", "schwab.com", "fidelity.com", "americanexpress.com", "hsbc.com", "barclays.co.uk",
    "icbc.com.cn", "ccb.com", "boc.cn", "abchina.com", "cmbchina.com", "bankcomm.com",
  ]) {
    assert.ok(isSensitiveUrl(https(host)), `${host} must stay marked`);
  }
});

await test("ordinary sites are not marked", () => {
  for (const host of [
    "example.com", "www.google.com", "maps.google.com", "docs.google.com", "github.com", "en.wikipedia.org", "news.ycombinator.com",
    "www.nytimes.com", "stackoverflow.com", "developer.mozilla.org", "notgmail.com", "evil-gmail.com.example.org", "outlook.com.example.org",
    "xoutlook.com", "irs.gov.example.com", "myirs.gov.example.com",
  ]) {
    assert.equal(isSensitiveUrl(https(host)), false, `${host} must not be marked`);
  }
});

await test("a listed name only counts at a dot boundary (notgmail.com is not gmail.com)", () => {
  assert.equal(isBuiltinSensitiveHost("notgmail.com"), false);
  assert.equal(isBuiltinSensitiveHost("gmail.com"), true);
  assert.equal(isBuiltinSensitiveHost("x.gmail.com"), true);
  assert.equal(isBuiltinSensitiveHost("gmail.com.evil.test"), false);
});

await test("URL handling: case, trailing dot, other schemes, garbage", () => {
  assert.equal(sensitiveHostOf("https://MAIL.Google.COM/mail"), "mail.google.com");
  assert.equal(sensitiveHostOf("https://mail.google.com./mail"), "mail.google.com");
  assert.equal(webHostOf("https://Example.COM./x"), "example.com");
  assert.equal(hostOf("https://Example.COM./x"), "example.com");
  assert.equal(sensitiveHostOf("chrome://settings"), "");
  assert.equal(sensitiveHostOf("file:///mail/inbox.html"), "");
  assert.equal(sensitiveHostOf("chrome-extension://abc/mail.html"), "");
  assert.equal(sensitiveHostOf("not a url"), "");
  assert.equal(sensitiveHostOf(undefined), "");
  assert.equal(sensitiveHostOf(""), "");
});

await test("the built-in list is clean: lower case, valid hosts of two or more labels, no duplicates", () => {
  const seen = new Set();
  for (const host of BUILTIN_SENSITIVE_HOSTS) {
    assert.equal(host, host.toLowerCase(), `${host} is not lower case`);
    assert.ok(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host), `${host} is not a valid multi-label host`);
    assert.equal(normalizeHostEntry(host), host, `${host} does not survive normalization`);
    assert.ok(!seen.has(host), `${host} is listed twice`);
    seen.add(host);
  }
  assert.ok(BUILTIN_SENSITIVE_HOSTS.length > 200, "the built-in list should be broad");
  assert.ok(Object.isFrozen(BUILTIN_SENSITIVE_HOSTS));
});

await test("normalizeHostEntry: URLs, wildcards, ports, case, trailing dots, userinfo", () => {
  const cases = [
    ["example.com", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["https://Mail.Example.com:8443/inbox?x=1#top", "mail.example.com"],
    ["http://user:pass@example.com/", "example.com"],
    ["*.example.com", "example.com"],
    [".example.com", "example.com"],
    ["example.com.", "example.com"],
    ["example.com:8080", "example.com"],
    ["www.example.com/some/path", "www.example.com"],
    ["a.b-c.example.co.uk", "a.b-c.example.co.uk"],
    ["mail", "mail"],
    ["192.168.1.5", "192.168.1.5"],
    ["localhost", "localhost"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeHostEntry(input), expected, `normalizeHostEntry(${JSON.stringify(input)})`);
  const idn = normalizeHostEntry("银行.cn");
  assert.ok(/^xn--[a-z0-9-]+\.cn$/.test(idn), `IDN becomes punycode, got ${idn}`);
});

await test("normalizeHostEntry rejects what is not a host, and public suffixes that would cover a whole country", () => {
  for (const bad of [
    "", "   ", "#comment", "exa mple", "ex@mple@@", "https://", "http://:80", "[::1]", "-bad-.com", "a..b.com", "exa_mple$.com",
    "a".repeat(64) + ".com", `${"a.".repeat(130)}com`, "co.uk", "com.cn", "gov.au", "org.uk", "ac.jp", "javascript:alert(1)",
  ]) {
    assert.equal(normalizeHostEntry(bad), "", `normalizeHostEntry(${JSON.stringify(bad).slice(0, 40)}) must be rejected`);
  }
  assert.equal(normalizeHostEntry(null), "");
  assert.equal(normalizeHostEntry(undefined), "");
  // The URL parser would silently turn these into other IPv4 addresses.
  for (const odd of [42, "42", "127.1", "0x7f.1", "2130706433", "1.2.3", "1.2.3.4.5"]) {
    assert.equal(normalizeHostEntry(odd), "", `normalizeHostEntry(${JSON.stringify(odd)}) must be rejected`);
  }
  // A real site that merely has a suffix-looking first label is fine.
  assert.equal(normalizeHostEntry("com.example.org"), "com.example.org");
  assert.equal(normalizeHostEntry("example.co.uk"), "example.co.uk");
});

await test("parseHostList: lines, separators, comments, duplicates; rejected lines are reported", () => {
  const text = [
    "# my sites", "Mail.Example.com", "https://bank.example.org/login", "example.com, example.net; example.com",
    "*.EXAMPLE.com", "not a host!", "co.uk   # too broad", "", "  intranet  ",
  ].join("\n");
  const { hosts, rejected, truncated } = parseHostListDetailed(text);
  assert.deepEqual(hosts, ["mail.example.com", "bank.example.org", "example.com", "example.net", "intranet"]);
  assert.deepEqual(rejected, ["not a host!", "co.uk"]);
  assert.equal(truncated, false);
  assert.deepEqual(parseHostList(text), hosts);
  assert.deepEqual(parseHostList(["A.com", "a.com", "b.com", 7, null, ""]), ["a.com", "b.com"]);
  assert.deepEqual(parseHostList(undefined), []);
  assert.deepEqual(parseHostList(null), []);
  assert.deepEqual(parseHostList(""), []);
});

await test("parseHostList caps the list and says so", () => {
  const many = Array.from({ length: MAX_HOST_LIST_ENTRIES + 25 }, (_, i) => `site${i}.example.com`).join("\n");
  const out = parseHostListDetailed(many);
  assert.equal(out.hosts.length, MAX_HOST_LIST_ENTRIES);
  assert.equal(out.truncated, true);
  assert.equal(out.hosts[0], "site0.example.com");
  // Duplicates of what is already kept do not count as "cut off".
  const dup = parseHostListDetailed(Array(MAX_HOST_LIST_ENTRIES + 5).fill("same.example.com").join("\n"));
  assert.deepEqual(dup.hosts, ["same.example.com"]);
  assert.equal(dup.truncated, false);
});

await test("hostMatchesEntry: the host and its subdomains only, on a dot boundary; one-label entries match exactly", () => {
  assert.ok(hostMatchesEntry("example.com", "example.com"));
  assert.ok(hostMatchesEntry("www.example.com", "example.com"));
  assert.ok(hostMatchesEntry("a.b.example.com", "example.com"));
  assert.ok(hostMatchesEntry("a.b.example.com", "b.example.com"));
  assert.equal(hostMatchesEntry("notexample.com", "example.com"), false);
  assert.equal(hostMatchesEntry("example.com.evil.test", "example.com"), false);
  assert.equal(hostMatchesEntry("example.com", "www.example.com"), false);
  assert.ok(hostMatchesEntry("mail", "mail"));
  assert.equal(hostMatchesEntry("mail.example.com", "mail"), false);
  assert.equal(hostMatchesEntry("example.com", "com"), false, "a one-label entry never covers a whole TLD");
  assert.equal(hostMatchesEntry("", "example.com"), false);
  assert.equal(hostMatchesEntry("example.com", ""), false);
});

await test("sitePolicy: never > allowed > sensitive > normal", () => {
  const lists = { neverHosts: ["secret.example.com", "both.example.org", "mail.google.com"], allowHosts: ["intranet.example.com", "both.example.org", "outlook.com"] };
  assert.equal(sitePolicy("https://news.example.net/", lists), "normal");
  assert.equal(sitePolicy("https://www.chase.com/", lists), "sensitive");
  assert.equal(sitePolicy("https://x.secret.example.com/a", lists), "never");
  assert.equal(sitePolicy("https://intranet.example.com/wiki", lists), "allowed");
  assert.equal(sitePolicy("https://both.example.org/", lists), "never", "a site on both lists is never sent");
  assert.equal(sitePolicy("https://outlook.com/mail", lists), "allowed", "the user's allow list lifts the built-in protection");
  assert.equal(sitePolicy("https://mail.google.com/", lists), "never", "never beats the built-in list too");
  assert.equal(sitePolicy("https://news.example.net/", {}), "normal");
  assert.equal(sitePolicy("https://news.example.net/"), "normal");
  assert.equal(sitePolicy("https://news.example.net/", { neverHosts: "nope", allowHosts: null }), "normal");
});

await test("sitePolicy: an extractor source marks a site no list knows, unless the user allowed or blocked it", () => {
  assert.deepEqual([...SENSITIVE_EXTRACTOR_SOURCES].sort(), ["proton-mail", "synology-mailplus"]);
  assert.equal(sitePolicy("https://nas.home.example/", {}, { source: "synology-mailplus" }), "sensitive");
  assert.equal(sitePolicy("https://nas.home.example/", {}, { source: "proton-mail" }), "sensitive");
  assert.equal(sitePolicy("https://nas.home.example/", {}, { source: "reddit" }), "normal");
  assert.equal(sitePolicy("https://nas.home.example/", {}, { source: "" }), "normal");
  assert.equal(sitePolicy("https://nas.home.example/", { allowHosts: ["nas.home.example"] }, { source: "synology-mailplus" }), "allowed");
  assert.equal(sitePolicy("https://nas.home.example/", { neverHosts: ["home.example"] }, { source: "synology-mailplus" }), "never");
});

await test("sitePolicy: non-web URLs have no host, so only the extractor source can mark them", () => {
  const lists = { neverHosts: ["example.com"], allowHosts: ["example.com"] };
  assert.equal(sitePolicy("chrome://settings", lists), "normal");
  assert.equal(sitePolicy("", lists), "normal");
  assert.equal(sitePolicy(undefined, lists), "normal");
  assert.equal(sitePolicy("file:///x", lists, { source: "proton-mail" }), "sensitive");
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
