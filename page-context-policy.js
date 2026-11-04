// page-context-policy.js
//
// S-05: the rules for "does this request send the page the user is looking at?".
// Pure (no DOM, no storage), so the whole decision table is unit-tested in
// scripts/test-page-context-policy.mjs; sidepanel.js only asks the user when the
// answer is "confirm" and does what the answer says.
//
// The "Read current page" choice has three modes:
//   "on"   always read: the page goes with every ordinary question;
//   "ask"  ask each time before the page is sent;
//   "off"  never read for ordinary questions.
// Until the user has chosen (first run) the mode is `null`, which behaves like "off".
//
// Two kinds of request:
//   "ordinary"  a question typed into the box: the page is sent only as the mode allows;
//   "quick"     Summarize / Translate / Explain / Key Points / Fact Check: explicit
//               actions on the page, which work whatever the mode is.
//
// `policy` is the site's classification (sensitive-sites.js sitePolicy):
//   "never" | "allowed" | "sensitive" | "normal".
// `sessionAllowed` is true when the user already approved this site for the life
// of the panel ("don't ask again" / "Allow on this site").

export const PAGE_CONTEXT_MODES = Object.freeze(["off", "ask", "on"]);

// Stored value -> mode. The storage key still holds a boolean for the two classic
// states (true = always, false = off), so older builds read it exactly as before;
// "ask" is the third value. Anything else - absent, null, a hand-edited string -
// means "not decided yet" and returns null.
export function pageContextModeOf(stored) {
  if (stored === true) return "on";
  if (stored === false) return "off";
  if (stored === "ask") return "ask";
  return null;
}

// The inverse of pageContextModeOf. Returns undefined for anything that is not a mode.
export function storedValueForMode(mode) {
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (mode === "ask") return "ask";
  return undefined;
}

// How protective a mode is: the less the page can leave the machine, the higher.
// "Not decided" is as protective as "off" (nothing is read for ordinary questions).
export function pageContextProtectionLevel(mode) {
  if (mode === "on") return 0;
  if (mode === "ask") return 1;
  return 2;
}

// -> { action, reason }
//   action "send"     send the page
//          "skip"     send the question WITHOUT the page (ordinary requests)
//          "confirm"  ask the user first (reason says which wording)
//          "refuse"   do not run the request at all (a quick action on a never-send site)
//   reason "never" | "off" | "sensitive" | "ask" | undefined
export function decidePageSend({ mode = null, kind = "ordinary", policy = "normal", sessionAllowed = false } = {}) {
  if (policy === "never") {
    return kind === "quick" ? { action: "refuse", reason: "never" } : { action: "skip", reason: "never" };
  }
  const sensitive = policy === "sensitive";
  const trusted = policy === "allowed" || sessionAllowed === true;
  if (kind === "quick") {
    return sensitive && !trusted ? { action: "confirm", reason: "sensitive" } : { action: "send" };
  }
  const effective = mode ?? "off";
  if (effective === "off") return { action: "skip", reason: "off" };
  if (sensitive && !trusted) {
    return effective === "ask" ? { action: "confirm", reason: "sensitive" } : { action: "skip", reason: "sensitive" };
  }
  if (effective === "ask" && !trusted) return { action: "confirm", reason: "ask" };
  return { action: "send" };
}

// What the bar above the composer says about the page the NEXT ordinary question
// would use. Derived from the same decision, so it cannot disagree with it.
//   "hidden" | "send" | "ask" | "askSensitive" | "blockedSensitive" | "never"
export function contextBarStateFor(decision) {
  switch (decision?.action) {
    case "send": return "send";
    case "confirm": return decision.reason === "sensitive" ? "askSensitive" : "ask";
    case "skip":
      if (decision.reason === "never") return "never";
      if (decision.reason === "sensitive") return "blockedSensitive";
      return "hidden";
    default: return "hidden";
  }
}
