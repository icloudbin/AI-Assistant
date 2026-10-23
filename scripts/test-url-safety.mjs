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
const allowed = (img, page) => checkImageUrl(img, page) !== null;

// Same host AND port as the page: allowed (images on a local dev page keep working).
eq("localhost:3000 page, image on localhost:3000", allowed("http://localhost:3000/a.png", "http://localhost:3000/"), true);
eq("intranet page, image on same host", allowed("http://nas.corp:5000/a.png", "http://nas.corp:5000/x"), true);
eq("default port is the same as an explicit one", allowed("http://localhost/a.png", "http://localhost:80/"), true);
// Other ports on the same machine: blocked (the reported bug).
for (const port of [6379, 22, 5432, 8080, 80]) {
  eq(`localhost:3000 page -> localhost:${port}`, allowed(`http://localhost:${port}/x`, "http://localhost:3000/"), false);
}
eq("127.0.0.1:3000 page -> 127.0.0.1:6379", allowed("http://127.0.0.1:6379/x", "http://127.0.0.1:3000/"), false);
eq("[::1]:3000 page -> [::1]:6379", allowed("http://[::1]:6379/x", "http://[::1]:3000/"), false);
eq("localhost page (no port) -> localhost:6379", allowed("http://localhost:6379/x", "http://localhost/"), false);
// Other hosts, from a public page, and metadata endpoints.
eq("public page -> localhost", allowed("http://localhost:3000/x", "https://example.com/"), false);
eq("public page -> 169.254.169.254", allowed("http://169.254.169.254/latest/meta-data", "https://example.com/"), false);
eq("local page -> different local host", allowed("http://192.168.1.1/a.png", "http://localhost:3000/"), false);
eq("no page url -> local host blocked", allowed("http://localhost:3000/a.png", ""), false);
// Public hosts still fine; non-http and credentials still rejected.
eq("public image allowed", allowed("https://upload.wikimedia.org/a.png", "https://example.com/"), true);
eq("file: rejected", allowed("file:///etc/passwd", "http://localhost:3000/"), false);
eq("credentials rejected", allowed("http://u:p@localhost:3000/a.png", "http://localhost:3000/"), false);
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
// Internal-suffix host is only reachable from a page on the same host:port.
eq("public page -> printer.corp", allowed("http://printer.corp/a.png", "https://example.com/"), false);

process.exit(failed ? 1 : 0);
