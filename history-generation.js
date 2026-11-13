// history-generation.js
// Pure helpers for the cross-context Delete All History tombstone.
// Missing/invalid values are treated as generation zero for older installs.

export function normalizeHistoryGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function nextHistoryGeneration(value) {
  const current = normalizeHistoryGeneration(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error("History generation exhausted");
  return current + 1;
}

export function isHistoryGenerationCurrent(stored, loaded) {
  return normalizeHistoryGeneration(stored) === normalizeHistoryGeneration(loaded);
}
