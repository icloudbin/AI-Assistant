#!/usr/bin/env node
// Unit tests for sensitive-sites.js: webmail and online-banking heuristic guards.
// Run:  node scripts/test-sensitive-sites.mjs
import assert from "node:assert/strict";
import { sensitiveHostOf, isSensitiveUrl, hostOf } from "../sensitive-sites.js";

// ---------- hostOf ----------
assert.equal(hostOf("https://example.com/path"), "example.com");
assert.equal(hostOf("http://sub.domain.org:8080/"), "sub.domain.org");
assert.equal(hostOf("not-a-url"), "");

// ---------- Known sensitive hosts ----------
const knownSensitiveUrls = [
  "https://mail.google.com/mail/u/0/",
  "https://outlook.live.com/mail/",
  "https://outlook.office.com/mail/",
  "https://mail.yahoo.com/",
  "https://mail.proton.me/",
  "https://chase.com/personal",
  "https://paypal.com/signin",
  "https://wise.com/account",
  "https://alipay.com/",
  "https://pay.weixin.qq.com/",
  "https://wellsfargo.com/",
  "https://citi.com/",
  "https://fidelity.com/",
];

for (const url of knownSensitiveUrls) {
  assert.ok(isSensitiveUrl(url), `expected sensitive: ${url}`);
  assert.ok(sensitiveHostOf(url).length > 0, `expected sensitive host: ${url}`);
}

// ---------- Subdomains of known sensitive hosts ----------
assert.ok(isSensitiveUrl("https://subdomain.chase.com/login"));
assert.ok(isSensitiveUrl("https://secure.paypal.com/pay"));
assert.ok(isSensitiveUrl("https://my.mail.yahoo.com/"));

// ---------- Pattern-matched sensitive hosts (SENSITIVE_LABEL_RE) ----------
assert.ok(isSensitiveUrl("https://webmail.company.org/"));
assert.ok(isSensitiveUrl("https://onlinebanking.localbank.com/"));
assert.ok(isSensitiveUrl("https://ebank.regional-bank.cn/"));
assert.ok(isSensitiveUrl("https://netbank.example.co.uk/"));
assert.ok(isSensitiveUrl("https://mailplus.enterprise.io/"));

// ---------- Non-sensitive URLs (must NOT be blocked) ----------
const nonSensitiveUrls = [
  "https://example.com/",
  "https://en.wikipedia.org/wiki/JavaScript",
  "https://github.com/microsoft/playwright",
  "https://developer.mozilla.org/en-US/",
  "https://news.ycombinator.com/",
  "https://stackoverflow.com/questions",
  "https://docs.python.org/3/",
];

for (const url of nonSensitiveUrls) {
  assert.equal(isSensitiveUrl(url), false, `expected NOT sensitive: ${url}`);
  assert.equal(sensitiveHostOf(url), "", `expected empty sensitive host: ${url}`);
}

// ---------- Invalid / non-HTTP URLs ----------
assert.equal(isSensitiveUrl("ftp://mail.google.com/"), false, "non-HTTP protocol not sensitive");
assert.equal(isSensitiveUrl("file:///home/user/doc.html"), false, "file: protocol not sensitive");
assert.equal(isSensitiveUrl(""), false, "empty string not sensitive");

console.log("OK: sensitive-sites.js — known banking/mail hosts, subdomains, keyword heuristics, public-site exclusions.");
process.exit(0);
