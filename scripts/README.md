# Regression tests

None of these are loaded by the extension (they are not referenced from `manifest.json`).

## Unit tests (Node 20+, no dependencies)

| Command | Covers |
| --- | --- |
| `node scripts/test-stop-streaming.mjs` | B-02: STOP aborts an already-started stream (`fetchWithHeadersTimeout` + `readSse`), and the timeout paths that must not change |
| `node scripts/test-translate-replay.mjs` | B-03: a replayed single-batch translation keeps the document's trailing static lines (drives the real `background.js` ASK handler with a mocked `chrome`) |
| `node scripts/test-markdown-heading.mjs` | B-05: `parseAtxHeading` equals the old heading regex on every short string of an adversarial alphabet, plus performance regression checks |
| `node scripts/test-pii-name-perf.mjs` | B-06: the PII "Name:" rule stays linear, and its behaviour is unchanged |

## Real-browser tests (need `playwright` with Chromium; the chat-flow test also needs `openssl`)

They load this folder as an unpacked extension in headless Chromium.

| Command | Covers |
| --- | --- |
| `node scripts/e2e-chat-flow.mjs` | B-02 against a real HTTPS server (Stop closes the provider connection), a normal send/receive round trip, and the context-menu translate action (E-04) |
| `node scripts/e2e-restore-history.mjs` | B-01: Settings > Restore shows the success message (and the quota notices) instead of "Restore failed" |
| `node scripts/e2e-drop-image.mjs` | R-06: dropping a page image attaches it without also inserting its URL as text |

Each script exits non-zero if an assertion fails.
