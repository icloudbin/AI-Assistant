// pii-filter.js
//
// Local, offline redaction of personal / sensitive data. Applied in
// background.js to everything that is about to leave the browser (question,
// page text, attachments, history, and therefore web-research queries) so the
// AI provider only ever sees placeholders such as [EMAIL] or [CREDIT_CARD].
//
// Pattern based: it reliably catches structured data (keys, tokens, cards,
// emails, phones, IDs). Names are only caught when they follow a clear cue
// (e.g. "Name:", "My name is", "Dear", "姓名", "我叫", email display names).
// It is a safety net, not a guarantee.

import { parseIPv6 } from "../url-safety.js";

import { PII_FILTER_STORAGE_KEY } from "../storage-keys.js";

export { PII_FILTER_STORAGE_KEY };

function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const NAME_WORD = "[A-Z][a-zA-Z'’-]{1,24}";
const NAME_SEQ = `${NAME_WORD}(?:\\s+${NAME_WORD}){0,3}`;
// Greetings ("Hello World", "Hi Everyone", "Dear Customer Support Team") are
// followed by a capitalised word far more often than by a person's name. Only
// one or two capitalised words are taken, and a group word is left alone.
const NAME_SEQ_SHORT = `${NAME_WORD}(?:\\s+${NAME_WORD})?`;
const GENERIC_GREETING_TARGETS = new Set([
  "all", "everyone", "everybody", "there", "world", "team", "folks", "guys", "friends", "sir", "madam",
  "customer", "customers", "support", "user", "users", "admin", "administrator", "developer", "developers",
  "colleagues", "students", "reader", "readers", "hiring", "recruiter", "service", "sales", "help",
]);
const isGenericTarget = (word) => GENERIC_GREETING_TARGETS.has(String(word).toLowerCase());
// Date of birth: only the date right after a birth label is redacted (the label
// stays, so the model still sees "Date of birth: [DATE_OF_BIRTH]"). A bare date
// is never touched - without the label it is usually an ordinary date.
const DOB_MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DOB_DATE = [
  "\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}", // 1985-03-12, 1985/03/12, 1985.03.12
  "\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}", // 03/12/1985, 12-03-1985
  `${DOB_MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`, // March 12, 1985
  `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${DOB_MONTH}\\.?,?\\s+\\d{4}`, // 12 March 1985
  "\\d{4}\\s?年\\s?\\d{1,2}\\s?月(?:\\s?\\d{1,2}\\s?[日号])?", // 1985年3月12日
].join("|");
// \b only guards the English labels: the Chinese ones sit next to other Chinese
// characters, where \b never matches.
const DOB_LABEL = "(?:\\b(?:date[\\s_-]*of[\\s_-]*birth|birth[\\s_-]*date|birthday|d\\.?o\\.?b|born(?:\\s+on)?)\\b\\.?|出生日期|出生年月日|出生年月|出生时间|生日|出生于|出生)";
// Common Chinese surnames: "<surname>先生/女士/老师..." is a name, "产品经理" is not.
const CN_SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤";


// ---------- helpers for the rules below ----------

// Words that make a capitalised sequence a role / mailbox / group rather than a
// person ("Customer Support Team <help@x.com>", "Contact: Support Team").
const GENERIC_NAME_WORDS = new Set([
  "support", "team", "service", "services", "sales", "help", "helpdesk", "desk", "admin", "administrator",
  "info", "billing", "customer", "customers", "noreply", "no-reply", "notifications", "notification",
  "department", "dept", "office", "staff", "hr", "marketing", "accounts", "account", "security", "press",
  "newsletter", "updates", "system", "robot", "bot", "group", "committee", "company", "inc", "ltd", "llc",
]);
// Words that precede a name in running text but are not part of it.
const NAME_LEAD_WORDS = new Set([
  "please", "contact", "email", "e-mail", "mail", "from", "to", "cc", "bcc", "send", "sent", "reply", "ask",
  "write", "attn", "attention", "regards", "thanks", "thank", "forward", "fwd", "re", "by", "via", "the",
]);
// Splits a matched capitalised sequence into [lead words kept as-is, name part]; the
// name part is null when it is generic (a role or group) or empty.
function splitNameSeq(seq) {
  const words = seq.split(/\s+/);
  let i = 0;
  while (i < words.length - 1 && NAME_LEAD_WORDS.has(words[i].toLowerCase())) i++;
  const rest = words.slice(i);
  if (!rest.length || rest.some((w) => GENERIC_NAME_WORDS.has(w.toLowerCase()) || NAME_LEAD_WORDS.has(w.toLowerCase()))) return null;
  return { lead: words.slice(0, i), name: rest.join(" ") };
}

// Is `value` (right after a key such as "password:" or "SECRET_KEY=") a secret,
// as opposed to ordinary text ("required", "4096", "<your key>")?
const NOT_A_SECRET_RE = /^(?:\[[A-Z_]+(?:#\d+)?\]|<[^>]*>|\$\{?[\w.:-]+\}?|%[\w.]+%|\{\{.*\}\}|x{3,}|\*{3,}|•+|\.{3,}|-{3,}|_{3,})$/i;
// Only a value made of letters / _ / - around such a word is a placeholder
// ("your_api_key_here"); a real-looking value that merely contains "example"
// (AWS's documented sample key) is still treated as a secret.
const PLACEHOLDER_WORD_RE = /^[a-z_-]*(?:your|example|placeholder|changeme|dummy|sample|redacted|masked|replace|insert|enter|todo|tbd)[a-z_-]*$/i;
const NOT_A_SECRET_WORDS = new Set([
  "required", "optional", "none", "null", "nil", "undefined", "true", "false", "yes", "no", "empty", "missing",
  "invalid", "incorrect", "wrong", "hidden", "masked", "unknown", "default", "string", "number", "text",
  "boolean", "object", "env", "enabled", "disabled", "expired", "valid", "set", "unset", "n/a", "na",
  "mandatory", "forgotten", "reset", "change", "changed", "protected", "secure", "strong", "weak", "length",
  "limit", "count", "type", "value", "key", "token", "password", "secret",
]);
const CJK_ONLY_RE = /^[぀-ヿ㐀-鿿가-힯]+$/;
function looksLikeSecret(raw, passwordLike) {
  const v = String(raw).trim();
  if (v.length < 4) return false;
  if (NOT_A_SECRET_RE.test(v) || PLACEHOLDER_WORD_RE.test(v)) return false;
  if (NOT_A_SECRET_WORDS.has(v.toLowerCase().replace(/[.,!]+$/, ""))) return false;
  if (CJK_ONLY_RE.test(v)) return false;
  if (passwordLike) return true; // a password-style label is strong evidence: any non-placeholder value
  const hasLetter = /[A-Za-z]/.test(v);
  const hasDigit = /\d/.test(v);
  if (v.length >= 8 && hasLetter && hasDigit) return true;
  if (v.length >= 20 && !/^[A-Za-z]+$/.test(v)) return true;
  if (v.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(v)) return true;
  return false;
}

// key = value where the key NAME contains secret / token / password / api key ...
// (SECRET_KEY, AWS_SECRET_ACCESS_KEY, db_password, "X-Api-Key", client_secret).
// Whole-identifier match, so "tokenizer" and "max_tokens" are not keys.
const SECRET_KEY_NAME = String.raw`(?<![\w.-])[\w.-]*?(?:secret|token|passw(?:or)?d|pwd|passphrase|api[ _-]?key|private[ _-]?key|access[ _-]?key|credentials?)(?:[_-]?(?:access|key|value|string|id|hash|base)){0,3}(?![\w-])|密码|口令|密钥`;
const PASSWORD_LIKE_KEY_RE = /passw|pwd|passphrase|密码|口令/i;
const SECRET_KV_RE = new RegExp(`(${SECRET_KEY_NAME})(["']?\\s*[:=：]\\s*)(?:"([^"\\r\\n]{1,200})"|'([^'\\r\\n]{1,200})'|([^\\s"',;]+))`, "gi");
function redactSecretKeyValue(m, key, sep, dq, sq, bare) {
  const value = dq ?? sq ?? bare;
  if (value === undefined || !looksLikeSecret(value, PASSWORD_LIKE_KEY_RE.test(key))) return m;
  const q = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
  return `${key}${sep}${q}[SECRET]${q}`;
}

// Session cookies and CSRF values are credentials too.
const COOKIE_NAME = String.raw`(?:PHPSESSID|JSESSIONID|ASP\.NET_SessionId|connect\.sid|session[_-]?id|sess[_-]?id|session[_-]?token|session|sid|csrf[_-]?token|csrftoken|xsrf[_-]?token|remember[_-]?(?:me|token)|__Host-[\w-]+|__Secure-[\w-]+)`;
const COOKIE_KV_RE = new RegExp(`((?<![\\w.-])${COOKIE_NAME}\\s*[=:]\\s*["']?)([A-Za-z0-9%._~+/=-]{8,})`, "gi");

// IPv6 (any text shape: full, ::-compressed, with an IPv4 tail or zone id).
const IPV6_CANDIDATE_RE = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?(?:%[\w.-]+)?(?![\w:]|\.\d)/g;
function redactIPv6(m) {
  if (m.length < 6) return m;
  const groups = parseIPv6(m.replace(/%.*$/, ""));
  if (!groups) return m; // "10:30:45", "std::string" ... are not addresses
  // A real address has a longer group (fe80, 2001, db8 ...) or many groups; this
  // keeps "12:30::" and similar time / scope-like text out.
  const written = m.replace(/%.*$/, "").split(":").filter(Boolean);
  if (!written.some((g) => g.length >= 3) && written.length < 5) return m;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1) return m; // :: and ::1 identify nobody
  return "[IP_ADDRESS]";
}

// Phone numbers written with a cue word, in any digit grouping.
const PHONE_CUE = String.raw`(?:\b(?:phone|tel|telephone|mobile|cell(?:phone)?|fax|whatsapp|call\s+(?:me|us)(?:\s+(?:at|on))?|reach\s+(?:me|us)\s+(?:at|on)|(?:my|our)\s+(?:phone\s+|mobile\s+)?number\s+is)(?:\s*(?:number|no\.?|#))?|电话|手机号?|联系电话|联系方式)`;
const CUED_PHONE_RE = new RegExp(`(${PHONE_CUE}\\s*[:=：]?\\s*)(\\+?\\(?\\d[\\d ()\\-.]{7,18}\\d)(?![\\d])`, "gi");
function redactCuedPhone(m, cue, number) {
  const digits = number.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 15 ? `${cue}[PHONE]` : m;
}
// A bare, strictly valid North American number (area code and exchange start
// with 2-9). Skipped when it sits next to an order / reference style label.
const NANP_CONTEXT_SKIP_RE = /(?:\b(?:order|invoice|ref|reference|tracking|account|acct|serial|sku|isbn|ticket|case|transaction|txn|confirmation|code|id|no)\b[^\n]{0,16}|#\s*)$/i;
function redactBareNanp(m, offset, whole) {
  return NANP_CONTEXT_SKIP_RE.test(whole.slice(Math.max(0, offset - 28), offset)) ? m : "[PHONE]";
}

// Street addresses: "123 Main Street, Springfield, IL 62704", "350 5th Ave Apt 4B".
const STREET_WORD = String.raw`(?:\d{1,3}(?:st|nd|rd|th)|[A-Z][\w'’.-]*)`;
const STREET_SUFFIX = "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Square|Sq|Circle|Cir|Alley|Trail";
const CITY_WORDS = String.raw`[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,2}`;
const US_ADDRESS_RE = new RegExp(
  String.raw`\b\d{1,6}(?:-\d{1,6})?\s+(?:(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\.?\s+)?(?:${STREET_WORD}\s+){1,3}(?:${STREET_SUFFIX})\b\.?` +
  String.raw`(?:,?\s+(?:Apt|Apartment|Suite|Ste|Unit|Floor|Fl)\.?\s*#?[\w-]+)?` +
  String.raw`(?:,\s*${CITY_WORDS},\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)?`,
  "g"
);
const CN_ADDRESS_RE = /(?:[一-龥]{2,9}(?:省|自治区|特别行政区|市|区|县|镇|乡)){1,4}[一-龥\d]{0,12}?(?:路|街|大道|巷|弄|胡同)\d{1,5}(?:号|號)?(?:[一-龥\d-]{0,12}?(?:栋|幢|号楼|单元|室|楼|层|座))*/g;

// Common given names (without cue words such as "Name:"). Names that are also
// ordinary words or places (Mark, Will, Rose, Grace, Jordan, Austin, Paris,
// Victoria ...) are left out on purpose.
const FIRST_NAMES = (
  "James John Robert Michael William David Richard Joseph Thomas Charles Christopher Daniel Matthew Anthony Donald Steven Paul Andrew Joshua Kenneth Kevin Brian George Edward Ronald Timothy Jason Jeffrey Ryan Jacob Gary Nicholas Eric Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel Gregory Alexander Patrick Frank Raymond Dennis Jerry Tyler Aaron Jose Adam Nathan Henry Douglas Zachary Peter Kyle Walter Ethan Jeremy Harold Keith Christian Roger Noah Gerald Carl Terry Sean Arthur Lawrence Jesse Dylan Bryan Joe Billy Bruce Albert Willie Gabriel Logan Alan Juan Wayne Roy Ralph Randy Eugene Vincent Russell Elijah Louis Bobby Philip Johnny Liam Oliver Harry Oscar Theo Callum Connor Owen Luke Mason Lucas " +
  "Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Lisa Nancy Betty Margaret Sandra Ashley Kimberly Emily Donna Michelle Carol Amanda Dorothy Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia Kathleen Amy Angela Shirley Anna Brenda Pamela Emma Nicole Helen Samantha Katherine Christine Debra Rachel Carolyn Janet Catherine Maria Heather Diane Olivia Julie Joyce Kelly Christina Lauren Joan Evelyn Judith Megan Cheryl Andrea Hannah Martha Jacqueline Frances Gloria Teresa Kathryn Sara Janice Alice Doris Abigail Julia Judy Denise Marilyn Beverly Danielle Theresa Sophia Diana Brittany Natalie Isabella Alexis Kayla Chloe Zoe Mia Ella Amelia " +
  "Mohammed Muhammad Ahmed Omar Hassan Raj Amit Rahul Priya Anil Sanjay Vikram Carlos Luis Miguel Pedro Diego Javier Fernando Sofia Isabel Elena Giovanni Marco Luca Pierre Francois Hans Klaus Stefan Anders Lars Ivan Dmitri Sergei Yuki Hiroshi Kenji Takeshi Akira"
).split(/\s+/);
const SURNAME_STOP = new Set(["Is", "Has", "Was", "Said", "And", "The", "Or", "But", "For", "With", "Will", "Can", "Did", "Does", "Are", "Were", "Had", "Not", "Who", "Which", "That", "This", "When", "Where"]);
const BARE_NAME_RE = new RegExp(`\\b(?:${FIRST_NAMES.join("|")})(?:\\s+[A-Z]\\.)?\\s+([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)\\b`, "g");
function redactBareName(m, surname) {
  return SURNAME_STOP.has(surname) ? m : "[NAME]";
}

// Each rule: [regex, replacement | function]. Order matters (specific first).
const RULES = [
  // --- secrets / keys ---
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[PRIVATE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[API_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[API_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[API_KEY]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[API_KEY]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[API_KEY]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[API_KEY]"],
  [/\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{20,}\b/g, "[API_KEY]"],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, "[API_KEY]"],
  [/\btvly-[A-Za-z0-9_-]{16,}\b/g, "[API_KEY]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{16,}/gi, "$1 [TOKEN]"],
  // Cookie headers carry session ids: the whole header value is a credential.
  // Skipped when the value already contains a numbered placeholder from an
  // earlier rule: blanking the whole header with an unnumbered [COOKIE] would
  // sever that placeholder's mapping (its value became unrecoverable) - the
  // earlier rule already redacted exactly the sensitive part.
  [/^([ \t]*(?:Set-)?Cookie2?[ \t]*:[ \t]*)(?!\[COOKIE)(?![^:\n]*\[[A-Z_]+(?:#\d+)?\])(\S.*)$/gim, (m, head, value) => (/^\[[A-Z_]+(?:#\d+)?\]$/.test(value.trim()) ? m : `${head}[COOKIE]`)],
  // Session cookie / CSRF values outside a Cookie header (sessionid=..., csrftoken=...).
  [COOKIE_KV_RE, (m, head, value) => (looksLikeSecret(value, false) ? `${head}[COOKIE]` : m)],
  // key = value where the key NAME contains secret / token / password / api key
  // (SECRET_KEY=..., AWS_SECRET_ACCESS_KEY=..., "password": "...") and the value
  // looks like a secret: "Password: required" and "max token: 4096" stay.
  [SECRET_KV_RE, redactSecretKeyValue],
  // secrets inside URL query strings. The value class also excludes brackets:
  // a value that is/contains an earlier rule's placeholder (e.g. "?token=[JWT#1]",
  // where the "#" would additionally truncate the match) must be left alone -
  // replacing part of it produced corrupted output like "[SECRET]#1]" and
  // broke the placeholder→value mapping.
  [/([?&](?:api[_-]?key|key|token|access_token|auth|sig|signature|secret|password|pwd)=)[^&\s#\[\]]+/gi, "$1[SECRET]"],
  // user:pass@host
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, "$1[CREDENTIALS]@"],

  // --- contact ---
  // The lookbehind makes the scan linear: without it a long run of letters / dots
  // with no "@" (minified code, base64) is re-scanned from every position.
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],

  // --- government / financial ids ---
  [/(?<![\d])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\d])/g, "[ID_NUMBER]"],
  [/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, "[SSN]"],
  [/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g, (m) => (m.replace(/\s/g, "").length >= 15 ? "[IBAN]" : m)],
  // credit / debit cards: 13-19 digits, optional space/dash separators, Luhn-checked
  [/(?<![\w.])\d(?:[ -]?\d){12,18}(?![\w])/g, (m) => {
    const d = m.replace(/[ -]/g, "");
    return d.length >= 13 && d.length <= 19 && luhnValid(d) ? "[CREDIT_CARD]" : m;
  }],
  [/((?:cvv|cvc|cid|security code|安全码)\s*[:=：#]?\s*)\d{3,4}\b/gi, "$1[CVV]"],
  // Canadian Business Number with its GST/HST program account ("123456789 RT0001").
  // Must run before the SIN rule so the 9-digit part is not handled on its own.
  [/(?<![\w.])\d{9}\s?RT\d{4}(?!\w)/gi, "[BUSINESS_NUMBER]"],
  // Canadian SIN: 9 digits, written solid or grouped 3-3-3 with the same space or
  // hyphen between groups, and Luhn-checked so ordinary 9-digit numbers stay.
  // (046 454 286 is a valid SIN, so the first digit is deliberately not limited.)
  [/(?<![\w.])\d{3}([  -]?)\d{3}\1\d{3}(?!\w|\.\d)/g, (m) => (luhnValid(m.replace(/\D/g, "")) ? "[SIN]" : m)],

  // --- phone numbers (specific formats only, to avoid eating dates/ids) ---
  // With a cue word ("Phone:", "mobile", "call me at", "电话") any grouping of 9-15 digits.
  [CUED_PHONE_RE, redactCuedPhone],
  // North American with a country code, solid or grouped: +14155550132, 1-415-555-0132.
  [/(?<![\w.+])\+?1[ .-]?\(?[2-9]\d{2}\)?[ .-]?[2-9]\d{2}[ .-]?\d{4}(?![\d])/g, "[PHONE]"],
  // UK national format: 07911 123456, 07911123456, 020 7946 0958, 0121 496 0123, 01632 960123.
  [/(?<![\w.])0?7\d{3}[ -]?\d{6}(?![\d])/g, (m) => (m.startsWith("0") || /^7\d{3}[ -]/.test(m) ? "[PHONE]" : m)],
  [/(?<![\w.])\(?0[1-3]\d{1,3}\)?[ -]\d{3,4}[ -]\d{3,4}(?![\d])/g, "[PHONE]"],
  [/(?<![\w.])0\d{4}[ -]\d{6}(?![\d])/g, "[PHONE]"],
  [/(?<![\d])(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?![\d])/g, "[PHONE]"],
  [/(?<![\d])0\d{2,3}[ -]\d{7,8}(?![\d])/g, "[PHONE]"],
  [/(?<![\w])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\d])/g, "[PHONE]"],
  [/(?<![\d])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d])/g, "[PHONE]"],
  // A bare 10-digit North American number (4155550132).
  [/(?<![\w.\-/:#$,])[2-9][0-8]\d[2-9]\d{6}(?![\w]|[.,]\d)/g, redactBareNanp],

  // --- network ---
  [IPV6_CANDIDATE_RE, redactIPv6],
  [/(?<![\w:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![\w:-])/g, "[MAC_ADDRESS]"],
  [/(?<![\w.])(?=[0-9a-f.]*[a-f])[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}(?![\w.])/gi, "[MAC_ADDRESS]"],
  // "Version 1.2.3.4" / "v2.0.1.5" look like IPv4 addresses but are not.
  [/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g, (m, offset, whole) => (/(?:\bversion|\bver\.?|\bv|版本|\brelease|\bbuild)\s*:?\s*$/i.test(whole.slice(Math.max(0, offset - 14), offset)) ? m : "[IP_ADDRESS]")],

  // --- personal details ---
  // Runs before the name rules: "Name: John Smith Date of birth: ..." would
  // otherwise have "Date" swallowed as part of the name, hiding the label.
  [new RegExp(`(${DOB_LABEL}\\s*[:=：]?\\s*)(?:${DOB_DATE})(?!\\d)`, "gi"), "$1[DATE_OF_BIRTH]"],
  // Canadian postal code (A1A 1A1). Real codes never start with D F I O Q U W Z
  // and never use D F I O Q U in the other two letter slots.
  [/(?<![A-Za-z0-9])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![A-Za-z0-9])/gi, "[POSTAL_CODE]"],

  // --- street addresses ---
  [US_ADDRESS_RE, "[ADDRESS]"],
  [CN_ADDRESS_RE, "[ADDRESS]"],
  // UK postcodes (SW1A 2AA, M1 1AE, EC1A1BB).
  [/(?<![A-Za-z0-9])[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}(?![A-Za-z0-9])/g, "[POSTAL_CODE]"],

  // --- names (only with a clear cue) ---
  // "John Smith <john@x.com>" - but not "Please Contact Support Team <help@x.com>".
  [new RegExp(`("?)(${NAME_SEQ})("?)(\\s*<\\[EMAIL(?:#\\d+)?\\]>)`, "g"), (m, q1, seq, q2, tail) => {
    const parts = splitNameSeq(seq);
    return parts ? `${q1}${parts.lead.length ? `${parts.lead.join(" ")} ` : ""}[NAME]${q2}${tail}` : m;
  }],
  // Case-sensitive on purpose: with an "i" flag [A-Z] matches any letter, so
  // "this is very important" used to become "this is [NAME] ...". "this is" was
  // dropped altogether (far too common in ordinary prose).
  [new RegExp(`((?:\\b[Mm]y name is|\\bI am called|\\bI'm called|\\bI’m called)\\s+)${NAME_SEQ}`, "g"), "$1[NAME]"],
  [new RegExp(`(\\b(?:[Ff][Uu][Ll][Ll][ _-]?[Nn][Aa][Mm][Ee]|[Ff][Ii][Rr][Ss][Tt][ _-]?[Nn][Aa][Mm][Ee]|[Ll][Aa][Ss][Tt][ _-]?[Nn][Aa][Mm][Ee]|[Ss][Uu][Rr][Nn][Aa][Mm][Ee]|[Nn][Aa][Mm][Ee]|[Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Cc][Uu][Ss][Tt][Oo][Mm][Ee][Rr]|[Cc][Ll][Ii][Ee][Nn][Tt]|[Pp][Aa][Tt][Ii][Ee][Nn][Tt]|[Cc][Aa][Rr][Dd][Hh][Oo][Ll][Dd][Ee][Rr]|[Rr][Ee][Cc][Ii][Pp][Ii][Ee][Nn][Tt]|[Ss][Ee][Nn][Dd][Ee][Rr]|[Aa][Uu][Tt][Hh][Oo][Rr]|[Aa][Pp][Pp][Ll][Ii][Cc][Aa][Nn][Tt]|[Ee][Mm][Pp][Ll][Oo][Yy][Ee][Ee])\\s*[:=]\\s*)(${NAME_SEQ})`, "g"), (m, head, seq) => (splitNameSeq(seq) ? `${head}[NAME]` : m)],
  [new RegExp(`(\\b(?:Dear|Hi|Hello|Hey|Regards,|Sincerely,|Best,|Thanks,|Cheers,)\\s+)(${NAME_SEQ_SHORT})`, "g"), (m, cue, name) => (isGenericTarget(name.split(/\s+/)[0]) ? m : `${cue}[NAME]`)],
  [new RegExp(`(\\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\\.?\\s+)${NAME_SEQ}`, "g"), "$1[NAME]"],
  [/((?:姓名|名字|联系人|收件人|寄件人|持卡人|客户|申请人|患者|用户名)\s*[:：]\s*)[一-龥·]{2,5}/g, "$1[NAME]"],
  [/((?:我叫|我的名字是|本人)\s*)[一-龥·]{2,4}/g, "$1[NAME]"],
  [new RegExp(`[${CN_SURNAMES}][一-龥]?(?=先生|女士|小姐)`, "g"), "[NAME]"],
  [new RegExp(`[${CN_SURNAMES}](?=老师|经理|总监|医生|教授|博士)`, "g"), "[NAME]"],
  // No cue at all: a common given name followed by a capitalised surname.
  [BARE_NAME_RE, redactBareName],
];

// ---------- numbered placeholders + local mapping ----------
//
// Within one request every distinct value gets its own numbered placeholder
// ([EMAIL#1], [EMAIL#2], [PHONE#1] ...), the same value always gets the same one,
// and the mapping lives only in memory in this session object. It is never sent
// anywhere: it is used to put the real values back into the model's reply
// (restorePlaceholders / PlaceholderRestorer), so a translation or summary shows
// the user's own email address, not "[EMAIL]".
export function createRedactionSession() {
  // reserved: numbers already used by literal placeholder-shaped text in the
  // source, so a generated placeholder never reuses one and the restorer can
  // leave the literal token untouched.
  return { byKey: new Map(), byPlaceholder: new Map(), counters: new Map(), reserved: new Map() };
}

function reservePlaceholders(text, session) {
  if (!session || typeof text !== "string" || !text.includes("[")) return;
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const type = match[1];
    const number = Number(match[2]);
    let reserved = session.reserved.get(type);
    if (!reserved) {
      reserved = new Set();
      session.reserved.set(type, reserved);
    }
    reserved.add(number);
  }
}

function placeholderFor(session, type, original) {
  const key = `${type}\u0000${original}`;
  let ph = session.byKey.get(key);
  if (!ph) {
    let n = (session.counters.get(type) || 0) + 1;
    const reserved = session.reserved.get(type);
    while (reserved?.has(n)) n++;
    session.counters.set(type, n);
    ph = `[${type}#${n}]`;
    session.byKey.set(key, ph);
    session.byPlaceholder.set(ph, original);
  }
  return ph;
}

// Expands "$1[NAME]$3" style replacement strings the same way String.replace does.
function expandReplacement(rep, args) {
  return rep.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? "");
}

// `full` was replaced by `replaced`; give the placeholder that appeared in its
// place a number and remember what it stands for.
function numberPlaceholder(full, replaced, session) {
  if (full === replaced) return replaced;
  let p = 0;
  const max = Math.min(full.length, replaced.length);
  while (p < max && full[p] === replaced[p]) p++;
  let s = 0;
  while (s < max - p && full[full.length - 1 - s] === replaced[replaced.length - 1 - s]) s++;
  const originalPart = full.slice(p, full.length - s);
  const replacedPart = replaced.slice(p, replaced.length - s);
  const m = /^\[([A-Z_]+)\]$/.exec(replacedPart);
  if (!m || !originalPart) return replaced; // unusual shape: keep the plain placeholder
  return replaced.slice(0, p) + placeholderFor(session, m[1], originalPart) + replaced.slice(replaced.length - s);
}

// With a session, placeholders are numbered and remembered; without one the
// plain placeholders ([EMAIL]) are produced.
export function redactSensitive(text, session = null) {
  if (typeof text !== "string" || !text) return text;
  // Reserve literal placeholder-shaped tokens BEFORE any rule runs, so a real
  // value never gets the same number as text such as "use [EMAIL#1] literally".
  reservePlaceholders(text, session);
  let out = text;
  for (const [re, rep] of RULES) {
    if (!session) {
      out = out.replace(re, rep);
      continue;
    }
    out = out.replace(re, (...args) => {
      const full = args[0];
      const replaced = typeof rep === "function" ? rep(...args) : expandReplacement(rep, args);
      return typeof replaced === "string" ? numberPlaceholder(full, replaced, session) : replaced;
    });
  }
  return out;
}

const PLACEHOLDER_RE = /\\?\[([A-Z_]+)#(\d+)\\?\]/g;

// Puts the real values back into text that contains this session's placeholders.
// Unknown placeholders are left as they are. Originals can themselves contain
// placeholders (a later rule saw an earlier one), so this repeats a few times.
export function restorePlaceholders(text, session) {
  if (typeof text !== "string" || !text || !session || !session.byPlaceholder.size) return text;
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(PLACEHOLDER_RE, (m, type, n) => session.byPlaceholder.get(`[${type}#${n}]`) ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}

// Streaming version: a placeholder can be split across two chunks
// ("... [EMA" + "IL#1] ..."), so a possible partial placeholder at the end of
// the buffer is held back until it is complete (or clearly is not one).
export class PlaceholderRestorer {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.buf = "";
  }

  push(delta) {
    if (!this.session || !this.session.byPlaceholder.size) {
      if (delta) this.emit(delta);
      return;
    }
    this.buf += delta;
    const open = this.buf.lastIndexOf("[");
    let hold = this.buf.length;
    if (open >= 0 && this.buf.length - open <= 32 && !this.buf.includes("]", open)) {
      hold = open > 0 && this.buf[open - 1] === "\\" ? open - 1 : open;
    }
    const ready = this.buf.slice(0, hold);
    this.buf = this.buf.slice(hold);
    if (ready) this.emit(restorePlaceholders(ready, this.session));
  }

  flush() {
    const rest = this.buf;
    this.buf = "";
    if (rest) this.emit(restorePlaceholders(rest, this.session));
  }
}

// Single choke point for EVERYTHING in an ASK payload that can leave the
// browser (provider requests and Tavily queries are both built from these
// fields). Every string leaf is redacted, so a field added to the payload later
// (e.g. factCheck.selectedText, which previously bypassed the filter) is
// covered by default. Structural keys and binary image fields are left alone.
const STRUCTURAL_KEYS = new Set(["role", "type", "id", "requestId", "modelId", "tabId"]);
const NON_TEXT_KEYS = new Set(["images", "dataUrl", "imageUrls", "pageScreenshot"]);

function walkText(value, key, visit) {
  if (NON_TEXT_KEYS.has(key)) return;
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkText(item, key, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) walkText(childValue, childKey, visit);
  }
}

function deepRedact(value, key, session) {
  if (NON_TEXT_KEYS.has(key)) return value;
  if (typeof value === "string") return STRUCTURAL_KEYS.has(key) ? value : redactSensitive(value, session);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, key, session));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, k, session);
    return out;
  }
  return value;
}

export function redactOutbound(payload, session = null) {
  if (!payload || typeof payload !== "object") return payload;
  // Reserve every literal placeholder-shaped token in the whole payload BEFORE
  // any field is redacted, so a question and a page/history field cannot each
  // start number assignment at #1.
  if (session) walkText(payload, undefined, (text) => reservePlaceholders(text, session));
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = NON_TEXT_KEYS.has(key) || STRUCTURAL_KEYS.has(key)
      ? value
      : deepRedact(value, key, session);
  }
  return out;
}
