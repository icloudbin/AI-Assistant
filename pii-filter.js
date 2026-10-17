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

export const PII_FILTER_STORAGE_KEY = "piiFilterEnabled";

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
  // key=value / "key": "value" style secrets
  [/((?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|passwd|password|pwd|passphrase|private[_-]?key|密码|口令|密钥)["']?\s*[:=：]\s*["']?)([^\s"',;]{4,})/gi, "$1[SECRET]"],
  // secrets inside URL query strings
  [/([?&](?:api[_-]?key|key|token|access_token|auth|sig|signature|secret|password|pwd)=)[^&\s#]+/gi, "$1[SECRET]"],
  // user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, "$1[CREDENTIALS]@"],

  // --- contact ---
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],

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

  // --- phone numbers (specific formats only, to avoid eating dates/ids) ---
  [/(?<![\d])(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?![\d])/g, "[PHONE]"],
  [/(?<![\d])0\d{2,3}[ -]\d{7,8}(?![\d])/g, "[PHONE]"],
  [/(?<![\w])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\d])/g, "[PHONE]"],
  [/(?<![\d])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d])/g, "[PHONE]"],

  // --- network ---
  [/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g, "[IP_ADDRESS]"],

  // --- names (only with a clear cue) ---
  [new RegExp(`("?)(${NAME_SEQ})("?)(\\s*<\\[EMAIL\\]>)`, "g"), "$1[NAME]$3$4"],
  [new RegExp(`((?:\\bmy name is|\\bI am called|\\bI'm called|\\bthis is)\\s+)${NAME_SEQ}`, "gi"), "$1[NAME]"],
  [new RegExp(`(\\b(?:[Ff][Uu][Ll][Ll][ _-]?[Nn][Aa][Mm][Ee]|[Ff][Ii][Rr][Ss][Tt][ _-]?[Nn][Aa][Mm][Ee]|[Ll][Aa][Ss][Tt][ _-]?[Nn][Aa][Mm][Ee]|[Ss][Uu][Rr][Nn][Aa][Mm][Ee]|[Nn][Aa][Mm][Ee]|[Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Cc][Uu][Ss][Tt][Oo][Mm][Ee][Rr]|[Cc][Ll][Ii][Ee][Nn][Tt]|[Pp][Aa][Tt][Ii][Ee][Nn][Tt]|[Cc][Aa][Rr][Dd][Hh][Oo][Ll][Dd][Ee][Rr]|[Rr][Ee][Cc][Ii][Pp][Ii][Ee][Nn][Tt]|[Ss][Ee][Nn][Dd][Ee][Rr]|[Aa][Uu][Tt][Hh][Oo][Rr]|[Aa][Pp][Pp][Ll][Ii][Cc][Aa][Nn][Tt]|[Ee][Mm][Pp][Ll][Oo][Yy][Ee][Ee])\\s*[:=]\\s*)${NAME_SEQ}`, "g"), "$1[NAME]"],
  [new RegExp(`(\\b(?:Dear|Hi|Hello|Hey|Regards,|Sincerely,|Best,|Thanks,|Cheers,)\\s+)${NAME_SEQ}`, "g"), "$1[NAME]"],
  [new RegExp(`(\\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\\.?\\s+)${NAME_SEQ}`, "g"), "$1[NAME]"],
  [/((?:姓名|名字|联系人|收件人|寄件人|持卡人|客户|申请人|患者|用户名)\s*[:：]\s*)[一-龥·]{2,5}/g, "$1[NAME]"],
  [/((?:我叫|我的名字是|本人)\s*)[一-龥·]{2,4}/g, "$1[NAME]"],
  [/[一-龥]{1,2}(?=(?:先生|女士|小姐|老师|经理|总监|医生)(?![一-龥]{2}))/g, "[NAME]"],
];

export function redactSensitive(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

// Redacts a whole ASK payload (question, page context, history).
export function redactPayload({ question, pageContext, history }) {
  const pc = pageContext && typeof pageContext === "object"
    ? {
        ...pageContext,
        title: redactSensitive(pageContext.title),
        url: redactSensitive(pageContext.url),
        text: redactSensitive(pageContext.text),
        previousPage: pageContext.previousPage
          ? { ...pageContext.previousPage, title: redactSensitive(pageContext.previousPage.title), url: redactSensitive(pageContext.previousPage.url) }
          : pageContext.previousPage,
      }
    : pageContext;
  return {
    question: redactSensitive(question),
    pageContext: pc,
    history: Array.isArray(history)
      ? history.map((h) => (h && typeof h.content === "string" ? { ...h, content: redactSensitive(h.content) } : h))
      : history,
  };
}
