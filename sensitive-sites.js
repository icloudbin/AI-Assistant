// sensitive-sites.js
//
// Which pages count as "sensitive" for the "Read current page" feature, and the
// two lists the user can edit.
//
//  * Built in: well-known webmail, banking, brokerage, crypto-exchange,
//    password-manager, sign-in/identity, tax/government and payment-dashboard
//    sites, plus a strict hostname rule for self-hosted ones (mail.example.org,
//    bank.example.de, ...). It is a safety net, not a complete list - which is
//    why the user can add their own sites.
//  * "Never send": sites whose page is never sent, not even by a quick action.
//  * "Always allow": sites that skip the sensitive-site protection and the
//    "ask each time" prompt.
//
// An entry matches the host itself and every subdomain of it ("example.com"
// matches "mail.example.com"). Precedence, strongest first:
//   never > allowed > sensitive > normal      (see sitePolicy)
//
// Everything here is pure (no DOM, no storage) and covered by
// scripts/test-sensitive-sites.mjs.

const WEBMAIL = [
  "gmail.com", "googlemail.com", "mail.google.com",
  "outlook.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft",
  "hotmail.com", "live.com",
  "mail.yahoo.com", "mail.aol.com", "mail.zoho.com", "mail.zoho.eu", "zohomail.com",
  "mail.yandex.com", "mail.yandex.ru", "mail.ru", "gmx.com", "gmx.net", "web.de",
  "icloud.com", "fastmail.com", "hey.com", "mailbox.org", "posteo.de",
  "proton.me", "protonmail.com", "tutanota.com", "tuta.com", "tuta.io",
  // China
  "mail.qq.com", "exmail.qq.com", "mail.163.com", "mail.126.com", "qiye.163.com",
  "mail.aliyun.com", "qiye.aliyun.com", "mail.sina.com.cn", "mail.sohu.com", "mail.139.com", "mail.189.cn",
];

// Sign-in pages and account/identity portals: they show or reset credentials.
const ACCOUNTS = [
  "accounts.google.com", "myaccount.google.com", "passwords.google.com", "pay.google.com", "payments.google.com",
  "login.microsoftonline.com", "login.microsoft.com", "account.microsoft.com",
  "appleid.apple.com", "account.apple.com", "idmsa.apple.com",
  "id.me", "login.gov", "okta.com",
];

const PASSWORD_MANAGERS = [
  "1password.com", "1password.eu", "1password.ca", "bitwarden.com", "bitwarden.eu",
  "lastpass.com", "dashlane.com", "keepersecurity.com", "nordpass.com", "roboform.com",
];

const CRYPTO_EXCHANGES = [
  "binance.com", "binance.us", "coinbase.com", "kraken.com", "gemini.com", "crypto.com",
  "okx.com", "bybit.com", "kucoin.com", "bitfinex.com", "bitstamp.net", "gate.io", "bitget.com",
  "mexc.com", "htx.com", "huobi.com", "upbit.com", "bithumb.com", "bitflyer.com", "blockchain.com",
];

const BROKERAGES = [
  "robinhood.com", "interactivebrokers.com", "ibkr.com", "schwab.com", "fidelity.com", "vanguard.com",
  "etrade.com", "webull.com", "tradestation.com", "tdameritrade.com", "merrilledge.com",
  "moomoo.com", "futunn.com", "tigerbrokers.com", "trading212.com", "etoro.com", "degiro.com",
  "wealthfront.com", "betterment.com", "sofi.com",
];

const TAX_AND_GOVERNMENT = [
  "irs.gov", "ssa.gov", "treasurydirect.gov", "uscis.gov", "healthcare.gov", "studentaid.gov",
  "hmrc.gov.uk", "ato.gov.au", "my.gov.au", "cra-arc.gc.ca", "chinatax.gov.cn", "impots.gouv.fr", "elster.de",
];

const PAYMENTS = [
  "paypal.com", "venmo.com", "wise.com", "alipay.com", "pay.weixin.qq.com", "cash.app", "payoneer.com",
  "dashboard.stripe.com", "squareup.com", "braintreegateway.com",
  "quickbooks.intuit.com", "turbotax.intuit.com", "accounts.intuit.com",
  "creditkarma.com", "experian.com", "equifax.com", "transunion.com", "annualcreditreport.com",
];

const BANKS = [
  // United States
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "capitalone.com",
  "usbank.com", "americanexpress.com", "discover.com", "pnc.com", "truist.com", "tdbank.com",
  "citizensbank.com", "regions.com", "fifththird.com", "53.com", "key.com", "keybank.com", "huntington.com",
  "navyfederal.org", "usaa.com", "ally.com", "chime.com", "marcus.com", "synchrony.com",
  // Canada
  "td.com", "rbcroyalbank.com", "scotiabank.com", "bmo.com", "cibc.com", "tangerine.ca",
  // United Kingdom and Europe
  "barclays.co.uk", "hsbc.co.uk", "hsbc.com", "lloydsbank.com", "natwest.com", "santander.co.uk",
  "nationwide.co.uk", "halifax.co.uk", "monzo.com", "starlingbank.com", "revolut.com", "n26.com",
  "ing.com", "ing.nl", "ing.de", "commerzbank.de", "sparkasse.de", "bnpparibas.com",
  "societegenerale.fr", "credit-agricole.fr", "bbva.com", "bbva.es", "santander.com", "caixabank.es",
  // Australia
  "commbank.com.au", "westpac.com.au", "anz.com.au", "nab.com.au",
  // Asia
  "icbc.com.cn", "ccb.com", "boc.cn", "abchina.com", "cmbchina.com", "bankcomm.com", "psbc.com",
  "spdb.com.cn", "cebbank.com", "cib.com.cn", "citicbank.com", "pingan.com",
  "hsbc.com.hk", "hangseng.com", "dbs.com", "ocbc.com", "uob.com.sg",
  "smbc.co.jp", "mizuhobank.co.jp", "rakuten-bank.co.jp", "kbstar.com", "shinhan.com",
];

export const BUILTIN_SENSITIVE_HOSTS = Object.freeze([
  ...WEBMAIL, ...ACCOUNTS, ...PASSWORD_MANAGERS, ...CRYPTO_EXCHANGES,
  ...BROKERAGES, ...TAX_AND_GOVERNMENT, ...PAYMENTS, ...BANKS,
]);

const BUILTIN_HOST_SET = new Set(BUILTIN_SENSITIVE_HOSTS);

// Self-hosted and unlisted sites: a DNS label that IS one of these words (with
// at most two trailing digits: mail2, webmail01) marks the host. Whole labels
// only - a substring match flagged river-bank.com and mail-archive.com.
const SENSITIVE_LABELS = new Set([
  "mail", "webmail", "mailplus", "owa", "zimbra", "roundcube", "rainloop", "sogo", "squirrelmail",
  "bank", "banking", "onlinebanking", "ebank", "ebanking", "netbank", "ibank", "ibanking",
  "internetbanking", "ebanque",
  "web-mail", "online-banking", "internet-banking", "e-banking", "e-bank", "net-banking", "net-bank",
]);
const TRAILING_DIGITS_RE = /\d{1,2}$/;

function isSensitiveLabel(label) {
  if (SENSITIVE_LABELS.has(label)) return true;
  const stripped = label.replace(TRAILING_DIGITS_RE, "");
  return stripped !== label && SENSITIVE_LABELS.has(stripped);
}

// Extractor sources (content.js) that identify webmail no hostname list can
// know about, such as a self-hosted Synology MailPlus or Proton Mail on a custom
// domain. Only known after the page has been read.
export const SENSITIVE_EXTRACTOR_SOURCES = new Set(["synology-mailplus", "proton-mail"]);

// Lower-case hostname of an http(s) URL without a trailing dot; "" for anything
// else (chrome://, file:, garbage).
export function webHostOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/.test(u.protocol)) return "";
    return u.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

// Hostname of any URL, for display and as a key.
export function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

// True when the built-in knowledge (list, TLD or label rule) marks this host.
export function isBuiltinSensitiveHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.+$/, "");
  if (!h) return false;
  const labels = h.split(".");
  // The ICANN ".bank" TLD is reserved for verified banks.
  if (labels.length > 1 && labels[labels.length - 1] === "bank") return true;
  // Listed host or any subdomain of one (the TLD alone is never an entry).
  for (let i = 0; i < labels.length - 1; i++) {
    if (BUILTIN_HOST_SET.has(labels.slice(i).join("."))) return true;
  }
  return labels.some(isSensitiveLabel);
}

// The host when the built-in knowledge marks this URL sensitive, otherwise "".
export function sensitiveHostOf(url) {
  const host = webHostOf(url);
  return host && isBuiltinSensitiveHost(host) ? host : "";
}

export function isSensitiveUrl(url) {
  return sensitiveHostOf(url) !== "";
}

// ---------- User-editable lists ----------

export const MAX_HOST_LIST_ENTRIES = 200;
export const MAX_HOST_ENTRY_LENGTH = 253;

const DNS_LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const HOST_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);
// "co.uk", "com.cn", "gov.au": public suffixes. One of these in an "always allow"
// list would allow every site of a whole country, one in "never send" would block
// them all - almost certainly a mistake, so they are not accepted as entries.
const SUFFIX_FIRST_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "ltd", "plc", "sch"]);

function isBroadPublicSuffix(host) {
  const labels = host.split(".");
  return labels.length === 2 && SUFFIX_FIRST_LABELS.has(labels[0]) && /^[a-z]{2}$/.test(labels[1]);
}

// "https://Mail.Example.com:8443/inbox?x=1", "*.example.com", ".example.com." ->
// "mail.example.com" / "example.com". Internationalised names become punycode,
// the form a browser reports. Returns "" when the text is not a usable host.
export function normalizeHostEntry(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s || s.length > 2048) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  // Whitespace inside the host part is a sentence or two entries glued together,
  // not a host: reject it instead of quietly keeping its first word.
  if (/\s/.test(s)) return "";
  s = s.replace(/^[^@]*@/, "");
  s = s.replace(/:\d*$/, "");
  s = s.replace(/^(?:\*\.)+/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!s) return "";
  let host = "";
  try {
    host = new URL(`http://${s}`).hostname.replace(/\.+$/, "");
  } catch {
    return "";
  }
  if (!host || host.length > MAX_HOST_ENTRY_LENGTH || !HOST_RE.test(host)) return "";
  // The URL parser reads "42", "127.1" and "0x7f.1" as IPv4 addresses and rewrites
  // them. An address must be typed in full dotted form, or it is not accepted.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host !== s : /^[\d.]+$/.test(s)) return "";
  if (isBroadPublicSuffix(host)) return "";
  return host;
}

// Accepts the textarea text (one site per line; commas and semicolons also
// separate; "#" starts a comment) or an array of entries. Returns the
// normalized, de-duplicated entries (at most MAX_HOST_LIST_ENTRIES), the entries
// that could not be read, and whether the cap cut something off.
export function parseHostListDetailed(input) {
  let tokens;
  if (Array.isArray(input)) {
    tokens = input.map((item) => String(item ?? ""));
  } else {
    tokens = [];
    for (const line of String(input ?? "").split(/\r?\n/)) {
      const body = line.replace(/#.*$/, "");
      tokens.push(...body.split(/[,;]+/));
    }
  }
  const hosts = [];
  const seen = new Set();
  const rejected = [];
  let truncated = false;
  for (const token of tokens) {
    const text = token.trim();
    if (!text) continue;
    const host = normalizeHostEntry(text);
    if (!host) {
      rejected.push(text.slice(0, 80));
      continue;
    }
    if (seen.has(host)) continue;
    if (hosts.length >= MAX_HOST_LIST_ENTRIES) {
      truncated = true;
      continue;
    }
    seen.add(host);
    hosts.push(host);
  }
  return { hosts, rejected, truncated };
}

export function parseHostList(input) {
  return parseHostListDetailed(input).hosts;
}

// An entry matches the host itself and its subdomains. A one-label entry (an
// intranet name such as "mail") matches only that exact host, so a stray "com"
// can never cover a whole top-level domain.
export function hostMatchesEntry(host, entry) {
  if (!host || !entry) return false;
  if (host === entry) return true;
  return entry.includes(".") && host.endsWith(`.${entry}`);
}

// "never" | "allowed" | "sensitive" | "normal"
//   never      the user's never-send list
//   allowed    the user's always-allow list
//   sensitive  built-in knowledge (list, TLD, label rule) or an extractor `source`
//   normal     everything else
export function sitePolicy(url, lists = {}, { source = "" } = {}) {
  const host = webHostOf(url);
  if (host) {
    const never = Array.isArray(lists?.neverHosts) ? lists.neverHosts : [];
    const allow = Array.isArray(lists?.allowHosts) ? lists.allowHosts : [];
    if (never.some((entry) => hostMatchesEntry(host, entry))) return "never";
    if (allow.some((entry) => hostMatchesEntry(host, entry))) return "allowed";
    if (isBuiltinSensitiveHost(host)) return "sensitive";
  }
  return SENSITIVE_EXTRACTOR_SOURCES.has(source) ? "sensitive" : "normal";
}
