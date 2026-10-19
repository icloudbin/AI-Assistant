// sensitive-sites.js
//
// Heuristic list of webmail and online-banking/payment sites. On these pages
// the "Read current page" option does NOT send the page to the AI provider
// for ordinary questions unless the user explicitly allows that site for the
// current panel session (the quick actions are explicit actions on the page
// and are not affected). It is a safety net, not a complete list.

const SENSITIVE_HOSTS = [
  // webmail
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
  "mail.yahoo.com", "mail.proton.me", "proton.me", "protonmail.com", "mail.protonmail.com",
  "icloud.com", "mail.aol.com", "mail.zoho.com", "fastmail.com", "mail.qq.com", "mail.163.com",
  "mail.126.com", "mail.sina.com.cn", "tutanota.com", "app.tuta.com", "mail.tuta.com",
  // payments / banks (well-known)
  "paypal.com", "venmo.com", "wise.com", "alipay.com", "pay.weixin.qq.com",
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "capitalone.com",
  "usbank.com", "schwab.com", "fidelity.com", "americanexpress.com", "hsbc.com", "barclays.co.uk",
  "icbc.com.cn", "ccb.com", "boc.cn", "abchina.com", "cmbchina.com", "bankcomm.com",
];

const SENSITIVE_HOST_SET = new Set(SENSITIVE_HOSTS);
// Host labels that very likely mean mail or banking (webmail.example.org,
// onlinebanking.example.de, ebank.example.com.cn, ...).
const SENSITIVE_LABEL_RE = /(^|[.-])(mail|webmail|mailplus|owa|bank|banking|onlinebanking|ebank|netbank|ibank|ibanking|ebanking|internetbanking|ebanque)([.-]|\d|$)/i;

export function sensitiveHostOf(url) {
  let host = "";
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/.test(u.protocol)) return "";
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
  if (!host) return "";
  // Registered/listed host or any subdomain of one.
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (SENSITIVE_HOST_SET.has(parts.slice(i).join("."))) return host;
  }
  if (SENSITIVE_LABEL_RE.test(host)) return host;
  return "";
}

export function isSensitiveUrl(url) {
  return sensitiveHostOf(url) !== "";
}

export function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return "";
  }
}
