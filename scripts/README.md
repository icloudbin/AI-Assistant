# Regression tests

None of these are loaded by the extension (they are not referenced from `manifest.json`).

## Unit tests (Node 20+, no dependencies)

| Command | Covers |
| --- | --- |
| `node scripts/test-stop-streaming.mjs` | B-02: STOP aborts an already-started stream (`fetchWithHeadersTimeout` + `readSse`), and the timeout paths that must not change |
| `node scripts/test-translate-replay.mjs` | B-03: a replayed single-batch translation keeps the document's trailing static lines (drives the real `background.js` ASK handler with a mocked `chrome`) |
| `node scripts/test-markdown-heading.mjs` | B-05: `parseAtxHeading` equals the old heading regex on every short string of an adversarial alphabet, plus performance regression checks |
| `node scripts/test-pii-name-perf.mjs` | B-06: the PII "Name:" rule stays linear, and its behaviour is unchanged |
| `node scripts/test-untrusted-boundary.mjs` | S-01 / S-02 / S-04: one random id per request, shared by page data, attached files and search evidence and named in the trusted instruction; attachments are structured, quarantined and condensed on the structure; Explain's Tavily query keeps names hidden (drives the real `background.js` ASK handler with a mocked `chrome` and provider) |
| `node scripts/test-pii-restore.mjs` | S-03: placeholders are restored in the text of a rendered reply only, never in a link target or image URL |
| `node scripts/test-settings-import.mjs` | S-06: which differences a settings file makes and which need explicit confirmation; custom-prompt length limit |

## Real-browser tests (need `playwright` with Chromium; the chat-flow test also needs `openssl`)

They load this folder as an unpacked extension in headless Chromium.

| Command | Covers |
| --- | --- |
| `node scripts/e2e-chat-flow.mjs` | B-02 against a real HTTPS server (Stop closes the provider connection), a normal send/receive round trip, and the context-menu translate action (E-04) |
| `node scripts/e2e-restore-history.mjs` | B-01: Settings > Restore shows the success message (and the quota notices) instead of "Restore failed" |
| `node scripts/e2e-drop-image.mjs` | R-06: dropping a page image attaches it without also inserting its URL as text |
| `node scripts/e2e-attachments.mjs` | S-02 through the side panel: a text file and a ZIP (with a newline in an entry name) reach the model only inside random UNTRUSTED blocks; stored messages are structured; an old inline-format conversation is migrated on load |
| `node scripts/e2e-pii-render.mjs [folder]` | S-03: with a prompt-injected reply, no link/image address carries the user's real e-mail, while the text still shows it; the image placeholder names the host and warns about a query string |
| `node scripts/e2e-import-settings.mjs [folder]` | S-06: a hostile settings file shows a review dialog, risky items start unticked, Cancel changes nothing, only ticked items are applied |
| `node scripts/e2e-tabs-permission.mjs` | S-07: loads the extension with and without the `tabs` permission and compares what the panel needs (tab url/title of web pages, scripting, captureVisibleTab, tabs.onUpdated) |

`[folder]` runs the same test against another copy of the extension (for example the original package) as a control.

Each script exits non-zero if an assertion fails.
