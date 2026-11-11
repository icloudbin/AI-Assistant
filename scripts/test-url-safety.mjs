#!/usr/bin/env node
// Unit tests for url-safety.js (SSRF guard for remote image fetching).
// Run:  node scripts/test-url-safety.mjs
import fs from "node:fs";
import { checkImageUrl, checkReplyImageUrl, isNonPublicHost, isTrustedImageHost } from "../url-safety.js";

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

// ---- reply images: the stricter gate for an address a model reply wrote ----
// A reply can be steered by a web page, so the worker fetches such an image from
// the vetted hosts only. A public IP literal passes the general gate (it needs no
// DNS lookup) but is a server the reply's author can run, and the request would
// carry the path and query the injected prompt chose.
const replyAllowed = (img) => checkReplyImageUrl(img) !== null;
eq("reply image: vetted host (https)", replyAllowed("https://upload.wikimedia.org/a.png"), true);
eq("reply image: vetted host (http)", replyAllowed("http://i.imgur.com/a.png"), true);
eq("reply image: vetted host with a trailing dot", replyAllowed("https://upload.wikimedia.org./a.png"), true);
eq("reply image: vetted host with a query string", replyAllowed("https://images.unsplash.com/photo.jpg?w=400"), true);
eq("reply image: returns the parsed URL", checkReplyImageUrl("https://i.imgur.com/a.png")?.href, "https://i.imgur.com/a.png");
eq("reply image: public IPv4 literal refused", replyAllowed("https://93.184.216.34/a.png"), false);
eq("reply image: public IPv6 literal refused", replyAllowed("https://[2001:4860:4860::8888]/a.png"), false);
eq("reply image: data hidden in the PATH of a public literal refused", replyAllowed("http://93.184.216.34/c/dGhlLXNlY3JldA.png"), false);
eq("reply image: the same literal still passes the general gate", allowed("https://93.184.216.34/a.png"), true);
eq("reply image: arbitrary public hostname refused", replyAllowed("https://example.com/a.png"), false);
eq("reply image: non-default port refused even on a vetted host", replyAllowed("https://upload.wikimedia.org:8443/a.png"), false);
eq("reply image: credentials refused", replyAllowed("https://u:p@upload.wikimedia.org/a.png"), false);
eq("reply image: file: refused", replyAllowed("file:///etc/passwd"), false);
eq("reply image: localhost refused", replyAllowed("http://localhost/a.png"), false);
eq("reply image: 127.0.0.1 refused", replyAllowed("http://127.0.0.1/a.png"), false);
eq("reply image: cloud metadata endpoint refused", replyAllowed("http://169.254.169.254/latest/meta-data"), false);
eq("reply image: look-alike subdomain of a vetted host refused", replyAllowed("https://upload.wikimedia.org.evil.example/a.png"), false);
eq("reply image: vetted host inside the path of another host refused", replyAllowed("https://evil.example/https://upload.wikimedia.org/a.png"), false);
eq("reply image: unlisted sibling of a vetted host refused", replyAllowed("https://xupload.wikimedia.org/a.png"), false);
eq("reply image: garbage refused", replyAllowed("not a url"), false);
for (const [host, want] of [
  ["upload.wikimedia.org", true], ["UPLOAD.WIKIMEDIA.ORG", true], ["upload.wikimedia.org.", true],
  ["wikimedia.org", false], ["evil.example", false], ["93.184.216.34", false], ["", false], [undefined, false],
]) {
  eq(`isTrustedImageHost(${JSON.stringify(host)})`, isTrustedImageHost(host), want);
}

// ---- wiring: the worker applies the gate, the panel marks every reply image ----
{
  const worker = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
  eq("worker: source:\"reply\" selects the stricter gate", /msg\.source === "reply" \? checkReplyImageUrl : checkImageUrl/.test(worker), true);
  eq("worker: the gate also judges the final response URL", /!gate\(resp\.url\)/.test(worker), true);
  const from = panel.indexOf("async function loadRemoteImage");
  const loadFn = panel.slice(from, panel.indexOf("chatLog.addEventListener", from));
  const sends = loadFn.match(/type: "FETCH_IMAGE"[^}]*\}/g) || [];
  eq("panel: loadRemoteImage sends the https request and the http->https retry", sends.length, 2);
  eq("panel: every reply-image FETCH_IMAGE is marked source:\"reply\"", sends.length > 0 && sends.every((s) => /source: "reply"/.test(s)), true);
  eq("panel: an untrusted placeholder never reaches the worker", /classList\.contains\("untrusted"\)\) return;/.test(loadFn), true);
}

process.exit(failed ? 1 : 0);
