// auto-web-research.js
// The persisted setting is opt-out: a missing/legacy value means enabled.
// Only an explicit boolean false disables implicit (automatic) web research.
export function isAutoWebResearchEnabled(storedValue) {
  return storedValue !== false;
}
