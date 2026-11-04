// options/settings-import.js
//
// S-06: what importing a settings file would change, and which of those changes
// need the user's explicit say-so. DOM-free, so it can be unit-tested in Node
// (scripts/test-settings-import.mjs); options.js shows the confirmation dialog.
//
// A settings file can come from anywhere. Imported blindly it can switch the
// privacy filter off, turn on page reading / screenshots / automatic web
// research, replace an API key, or write a custom prompt - which is sent to the
// model as a SYSTEM instruction. So every difference is listed, and the ones
// that weaken protection or change what the model is told are applied only when
// the user ticks them.

import {
  AUTO_WEB_RESEARCH_KEY,
  INCLUDE_CONTEXT_STORAGE_KEY,
  PAGE_ALLOW_HOSTS_STORAGE_KEY,
  PAGE_NEVER_HOSTS_STORAGE_KEY,
  PAGE_VISUALS_STORAGE_KEY,
  PII_FILTER_STORAGE_KEY,
} from "../storage-keys.js";
import { MAX_CUSTOM_PROMPT_CHARS } from "../models.js";
import { pageContextModeOf, pageContextProtectionLevel } from "../page-context-policy.js";
import { parseHostList } from "../sensitive-sites.js";

export const SECRET_KEYS = ["apiKey", "openrouterApiKey", "groqApiKey", "tavilyApiKey"];
export const PROVIDER_NAMES = { apiKey: "DeepSeek", openrouterApiKey: "OpenRouter", groqApiKey: "Groq", tavilyApiKey: "Tavily" };

// key -> how the CURRENT stored value reads when it is absent, and whether
// "on" is the safe direction. A stored `false` / `true` is explicit; the
// defaults are the ones the rest of the extension uses (the privacy filter
// defaults to ON, screenshots and automatic web research to OFF).
const PROTECTION_SWITCHES = {
  [PII_FILTER_STORAGE_KEY]: { isOn: (v) => v !== false, onIsProtective: true },
  [PAGE_VISUALS_STORAGE_KEY]: { isOn: (v) => v === true, onIsProtective: false },
  [AUTO_WEB_RESEARCH_KEY]: { isOn: (v) => v === true, onIsProtective: false },
};

// The user's site lists. An import REPLACES a list, so what weakens protection
// differs: a "never send" list weakens when sites are dropped from it, an
// "always allow" list when sites are added to it.
const HOST_LISTS = {
  [PAGE_NEVER_HOSTS_STORAGE_KEY]: { weakensWhen: "removed" },
  [PAGE_ALLOW_HOSTS_STORAGE_KEY]: { weakensWhen: "added" },
};

// Over-long custom prompts are not imported (cutting a system prompt in the
// middle would silently change its meaning). Returns the keys that were dropped.
export function dropOverlongPrompt(restored) {
  if (typeof restored.customPrompt === "string" && restored.customPrompt.length > MAX_CUSTOM_PROMPT_CHARS) {
    delete restored.customPrompt;
    return ["customPrompt"];
  }
  return [];
}

// restored: the validated values from the file. current: chrome.storage.local
// values for the same keys. Returns the list of differences, in a stable order.
//   kind "protection": one of the on/off switches (`weakens` = it moves toward less protection)
//   kind "mode":       "Read current page" (off / ask / on; `from` is "unset" when the user never chose)
//   kind "hostList":   a never-send / always-allow list (`added`, `removed`)
//   kind "prompt":     the custom prompt
//   kind "secret":     an API key (never shown); needsConfirm only when it REPLACES a different stored key
//   kind "plain":      language, theme, model, ... (applied without asking)
export function planSettingsImport(restored, current) {
  const items = [];
  for (const [key, value] of Object.entries(restored)) {
    const now = current[key];
    const sw = PROTECTION_SWITCHES[key];
    if (key === INCLUDE_CONTEXT_STORAGE_KEY) {
      const to = pageContextModeOf(value);
      if (to === null) continue; // not a usable value: nothing to apply
      const fromMode = pageContextModeOf(now);
      if (fromMode === to) continue;
      // "Not chosen yet" reads as off, so any step to ask / on weakens it.
      const weakens = pageContextProtectionLevel(to) < pageContextProtectionLevel(fromMode);
      items.push({ key, kind: "mode", from: fromMode ?? "unset", to, weakens, needsConfirm: weakens });
    } else if (HOST_LISTS[key]) {
      const before = parseHostList(now);
      const after = parseHostList(value);
      const added = after.filter((host) => !before.includes(host));
      const removed = before.filter((host) => !after.includes(host));
      if (!added.length && !removed.length) continue;
      const weakens = HOST_LISTS[key].weakensWhen === "added" ? added.length > 0 : removed.length > 0;
      items.push({ key, kind: "hostList", added, removed, weakens, needsConfirm: weakens });
    } else if (sw) {
      const from = sw.isOn(now);
      const to = value === true;
      if (from === to) continue;
      const weakens = to !== sw.onIsProtective;
      items.push({ key, kind: "protection", from, to, weakens, needsConfirm: weakens });
    } else if (key === "customPrompt") {
      const from = typeof now === "string" ? now : "";
      if (from === value) continue;
      items.push({ key, kind: "prompt", from, to: String(value), needsConfirm: true });
    } else if (SECRET_KEYS.includes(key)) {
      const had = typeof now === "string" && now !== "";
      if (had && now === value) continue;
      items.push({ key, kind: "secret", replaces: had, needsConfirm: had });
    } else {
      if (now === value) continue;
      items.push({ key, kind: "plain", needsConfirm: false });
    }
  }
  return items;
}

// A value of `restored` that planSettingsImport accepts for a site list: an array
// of strings, normalized and capped. Anything else is not a list and is dropped.
export function normalizeImportedHostList(value) {
  return Array.isArray(value) ? parseHostList(value.filter((entry) => typeof entry === "string")) : null;
}

export const HOST_LIST_KEYS = Object.freeze(Object.keys(HOST_LISTS));

// The part of `restored` to write: every change that needs no confirmation,
// plus the confirmed ones. Keys that equal the stored value are left out.
export function approvedSettings(restored, items, approvedKeys) {
  const out = {};
  for (const item of items) {
    if (!item.needsConfirm || approvedKeys.has(item.key)) out[item.key] = restored[item.key];
  }
  return out;
}
