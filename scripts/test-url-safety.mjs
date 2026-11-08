#!/usr/bin/env node
// Unit tests for url-safety.js (SSRF guard for remote image fetching).
// Run:  node scripts/test-url-safety.mjs
import { checkImageUrl, isNonPublicHost } from "../url-safety.js";

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
};
// The page argument is gone from checkImageUrl: destinations are judged on
// their own host only (no same-page exception), so the `page` values in the
// tables below document that they are irrelevant.
const allowed = (img) => checkImageUrl(img) !== null;

// Private and intranet destinations are blocked even when they match pageUrl.
for (const [url, page] of [
  ["http://localhost:3000/a.png", "http://localhost:3000/"],
  ["http://nas.corp:5000/a.png", "http://nas.corp:5000/x"],
  ["http://localhost/a.png", "http://localhost:80/"],
  ["https://localhost:8443/a.png", "https://localhost:8443/x"],
  ["http://127.0.0.1:3000/a.png", "http://127.0.0.1:3000/"],
  ["http://[::1]:3000/a.png", "http://[::1]:3000/"],
]) {
  eq(`private destination blocked: ${url}`, allowed(url, page), false);
}
for (const port of [6379, 22, 5432, 8080, 80]) {
  eq(`localhost:3000 page -> localhost:${port}`, allowed(`http://localhost:${port}/x`, "http://localhost:3000/"), false);
}
// Other hosts, from a public page, and metadata endpoints.
eq("public page -> localhost", allowed("http://localhost:3000/x", "https://example.com/"), false);
eq("public page -> 169.254.169.254", allowed("http://169.254.169.254/latest/meta-data", "https://example.com/"), false);
eq("local page -> different local host", allowed("http://192.168.1.1/a.png", "http://localhost:3000/"), false);
eq("no page url -> local host blocked", allowed("http://localhost:3000/a.png", ""), false);
// Exact trusted image hosts and DNS-free public IP literals are allowed.
eq("allowlisted Wikimedia host", allowed("https://upload.wikimedia.org/a.png", "https://example.com/"), true);
eq("allowlisted Unsplash host", allowed("https://images.unsplash.com/photo.jpg", "https://example.com/"), true);
eq("allowlisted host with trailing dot", allowed("https://upload.wikimedia.org./a.png", "https://example.com/"), true);
eq("public IPv4 literal", allowed("https://93.184.216.34/a.png", "https://example.com/"), true);
eq("public IPv6 literal", allowed("https://[2001:4860:4860::8888]/a.png", "https://example.com/"), true);
eq("arbitrary public hostname blocked", allowed("https://example.com/a.png", "https://example.com/"), false);
eq("unapproved CDN hostname blocked", allowed("https://cdn.corporate.com/a.png", "https://example.com/"), false);
eq("non-default port blocked", allowed("https://upload.wikimedia.org:8443/a.png", "https://example.com/"), false);
eq("file: rejected", allowed("file:///etc/passwd", "http://localhost:3000/"), false);
eq("credentials rejected", allowed("https://u:p@upload.wikimedia.org/a.png", "https://example.com/"), false);
// Internal-network suffixes are non-public.
for (const h of ["printer.corp", "nas.home", "svc.test", "a.example", "x.invalid", "db.private", "pc.domain", "box.workgroup", "laptop.tail1234.ts.net", "router.lan", "a.internal", "b.local"]) {
  eq(`${h} is non-public`, isNonPublicHost(h), true);
}
for (const h of ["example.com", "upload.wikimedia.org", "cdn.corporate.com", "homeland.org", "contest.net", "testing.io"]) {
  eq(`${h} is public`, isNonPublicHost(h), false);
}
// The wildcard-DNS services' BARE domains resolve to 127.0.0.1 themselves.
for (const h of ["nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me"]) {
  eq(`${h} (bare) is non-public`, isNonPublicHost(h), true);
}
// Wildcard-DNS hostnames remain blocked regardless of the embedded address.
eq("public page -> printer.corp", allowed("http://printer.corp/a.png", "https://example.com/"), false);
eq("nip.io rebinding hostname blocked", allowed("http://127.0.0.1.nip.io/a.png", "https://example.com/"), false);

process.exit(failed ? 1 : 0);
