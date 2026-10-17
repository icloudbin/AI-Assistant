// url-safety.js (root directory)
// Destination checks for requests the background service worker makes on behalf
// of the extension (remote image fetching). The service worker holds the
// extension's <all_urls> host permission, which lets it reach hosts that a web
// page could not, so image URLs - which can be influenced by a web page or by a
// prompt-injected model reply - must never be allowed to point it at the
// user's own machine or network (localhost services, router admin pages, cloud
// metadata endpoints such as http://169.254.169.254/ ...).
//
// Pure functions, no chrome.* calls, so they can be unit-tested in Node.
//
// Known limit: a PUBLIC hostname whose DNS record points at a private address
// (DNS rebinding, or wildcard-DNS services) cannot be detected here - browser
// extensions have no DNS-resolution API. The best-effort suffix list below
// covers the common wildcard-DNS services; everything else relies on the
// redirect/final-URL check and on the response having to be a genuine image.

// ---------- IPv4 ----------
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

// Non-public IPv4 space: "this" network, private (RFC 1918), CGNAT, loopback,
// link-local (includes 169.254.169.254 cloud metadata), IETF/documentation
// ranges, benchmarking, multicast, reserved and broadcast.
function isNonPublicIPv4([a, b, c]) {
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

// ---------- IPv6 ----------
// Returns eight 16-bit groups, or null if `text` is not a valid IPv6 literal.
function parseIPv6(text) {
  let s = text;
  let tail = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const octets = parseIPv4(v4[1]);
    if (!octets) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    s = s.slice(0, -v4[1].length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const groupCount = head.length + rest.length;
  if (halves.length === 1 ? groupCount !== 8 : groupCount > 7) return null;
  const all = halves.length === 2 ? [...head, ...Array(8 - groupCount).fill('0'), ...rest] : head;
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const groups = all.map((g) => parseInt(g, 16));
  if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups;
}

function embeddedIPv4(g6, g7) {
  return [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
}

function isNonPublicIPv6(g) {
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 7) && g[7] <= 1) return true; // :: (unspecified) and ::1 (loopback)
  if (zeros(0, 6)) return isNonPublicIPv4(embeddedIPv4(g[6], g[7])); // IPv4-compatible ::a.b.c.d
  if (zeros(0, 5) && g[5] === 0xffff) return isNonPublicIPv4(embeddedIPv4(g[6], g[7])); // IPv4-mapped ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isNonPublicIPv4(embeddedIPv4(g[6], g[7])); // NAT64 64:ff9b::/96
  }
  if (g[0] === 0x2002) return isNonPublicIPv4(embeddedIPv4(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

// ---------- Hostnames ----------
const LOCAL_NAME_SUFFIXES = [
  '.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa',
  // Wildcard-DNS services that resolve a name embedding any IP (best effort).
  '.nip.io', '.sslip.io', '.xip.io', '.traefik.me', '.localtest.me', '.lvh.me',
];
const LOCAL_NAMES = new Set(['localhost', 'localtest.me', 'lvh.me', 'nip.io', 'sslip.io', 'xip.io']);

// True when `hostname` (as returned by URL.hostname, which already normalises
// decimal/hex/octal IPv4 spellings and IPv6 forms) names this machine, a private
// or reserved network, or an unqualified intranet name - i.e. anything that is
// not an ordinary public internet host.
export function isNonPublicHost(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIPv6(host.slice(1, -1));
    return groups ? isNonPublicIPv6(groups) : true;
  }
  host = host.replace(/\.+$/, '');
  if (!host) return true;
  const v4 = parseIPv4(host);
  if (v4) return isNonPublicIPv4(v4);
  if (/^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true; // odd numeric spelling the URL parser did not normalise
  if (!host.includes('.')) return true; // single-label name: localhost, router, nas, intranet ...
  if (LOCAL_NAMES.has(host)) return true;
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Decides whether the service worker may fetch `rawUrl` as an image.
//  - only http(s), no embedded credentials;
//  - public hosts are allowed;
//  - a non-public host is allowed ONLY when it is the same host as the page the
//    user is currently looking at (`pageUrl`), so images on an intranet or
//    localhost page still work while that page is open, but a public page
//    (or a model reply) can never point the extension at some other internal
//    address.
// Returns the parsed URL when allowed, otherwise null.
export function checkImageUrl(rawUrl, pageUrl = '') {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!isNonPublicHost(url.hostname)) return url;
  try {
    const page = new URL(String(pageUrl));
    if ((page.protocol === 'http:' || page.protocol === 'https:') && page.hostname === url.hostname) return url;
  } catch {
    // no usable page URL: fall through to blocked
  }
  return null;
}
