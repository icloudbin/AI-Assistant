// history-generation.js
// Pure helpers for the cross-context Delete All History tombstone.
// Missing/invalid values are treated as generation zero for older installs.

export function normalizeHistoryGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function nextHistoryGeneration(value) {
  const current = normalizeHistoryGeneration(value);
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

export function isHistoryGenerationCurrent(stored, loaded) {
  return normalizeHistoryGeneration(stored) === normalizeHistoryGeneration(loaded);
}
