# Regression tests

None of these are loaded by the extension (they are not referenced from `manifest.json`).

## Unit tests (Node 20+, no dependencies)

| Command | Covers |
| --- | --- |
| `node scripts/test-auto-web-research.mjs` | ARCH-02: missing values default to ON; only an explicit `false` opts out |
| `node scripts/test-request-keep-alive.mjs` | ARCH-01: immediate heartbeat, shared reference holds, serialized calls, retry after failure, and idempotent release |
| `node scripts/test-stop-streaming.mjs` | B-02: STOP aborts an already-started stream (`fetchWithHeadersTimeout` + `readSse`), and timeout paths that must not change |
| `node scripts/test-translate-replay.mjs` | B-03: replayed single-batch translation keeps trailing static lines |
| `node scripts/test-markdown-heading.mjs` | B-05: heading parser matches the old regex over adversarial short strings and passes performance checks |
| `node scripts/test-markdown-render.mjs` | Markdown rendering and sanitization regression cases |
| `node scripts/test-pii-name-perf.mjs` | B-06: PII name rule remains linear and behavior-compatible |
| `node scripts/test-untrusted-boundary.mjs` | S-01 / S-02 / S-04: request boundary ids, structured attachments, and privacy-safe Explain research |
| `node scripts/test-pii-restore.mjs` | S-03: PII placeholders are restored in text only, never in link targets or image URLs |
| `node scripts/test-pii-filter.mjs` | PII redaction rules and edge cases |
| `node scripts/test-outbound-pii.mjs` | Outbound request redaction behavior |
| `node scripts/test-settings-import.mjs` | S-06 / S-05: settings-import review and risk confirmation |
| `node scripts/test-settings-crypto.mjs` | Settings backup secret encryption/decryption |
| `node scripts/test-settings-storage-keys.mjs` | Settings key/default behavior |
| `node scripts/test-options-backup.mjs` | Options page backup/restore behavior |
| `node scripts/test-conversation-store.mjs` | B-04: multi-window merge ordering and stable message ids |
| `node scripts/test-history-manager.mjs` | History serialization, migration and quota handling |
| `node scripts/test-attachment-budget.mjs` | Attachment size and count budgets |
| `node scripts/test-content-visibility.mjs` | Page content extraction visibility rules |
| `node scripts/test-translation-paragraphs.mjs` | Translation paragraph and formatting preservation |
| `node scripts/test-providers-messages.mjs` | Provider message construction and untrusted boundaries |
| `node scripts/test-models.mjs` | Model catalog and model selection behavior |
| `node scripts/test-openai-compatible.mjs` | OpenAI-compatible SSE parsing, timeouts, cancellation and response limits |
| `node scripts/test-url-safety.mjs` | Remote image URL and SSRF destination policy |
| `python scripts/test-sidepanel-context.py` | Side-panel "Read current page" checkbox against stubbed `chrome.*` APIs: checked by default, unchecking is remembered, quick actions still send the page, and a failure while preparing a request does not lock the composer |

## Playwright browser tests (need `playwright` with Chromium; the chat-flow test also needs `openssl`)

They load this folder as an unpacked extension in headless Chromium.

| Command | Covers |
| --- | --- |
| `node scripts/e2e-chat-flow.mjs` | B-02 against a real HTTPS server (Stop closes the provider connection), a normal send/receive round trip, and the context-menu translate action (E-04) |
| `node scripts/e2e-restore-history.mjs` | B-01: Settings > Restore shows the success message (and the quota notices) instead of "Restore failed"; B-04: a restore keeps message ids and times, and gives old backups deterministic ids |
| `node scripts/e2e-two-windows.mjs [folder]` | B-04: two side panels continue the same conversation at the same time - both turns are saved, each question stays with its answer, identical messages are not folded (fails on the original package) |
| `node scripts/e2e-drop-image.mjs` | R-06: dropping a page image attaches it without also inserting its URL as text; S-08: the first dropped image asks first, and declining attaches nothing and pastes nothing |
| `node scripts/e2e-attachments.mjs` | S-02 through the side panel: a text file and a ZIP (with a newline in an entry name) reach the model only inside random UNTRUSTED blocks; stored messages are structured; an old inline-format conversation is migrated on load; a stored ZIP entry whose header understates its size (header says 12 bytes, data is ~1 MB) is left out as too large instead of being read in full and using up the character budget |
| `node scripts/e2e-pii-render.mjs [folder]` | S-03: with a prompt-injected reply, no link/image address carries the user's real e-mail, while the text still shows it; the image placeholder names the host and warns about a query string |
| `node scripts/e2e-import-settings.mjs [folder]` | S-06: a hostile settings file shows a review dialog, risky items start unticked, Cancel changes nothing, only ticked items are applied; S-05: a file that re-checks "Read current page" (which the user had unchecked) needs its own tick, a file that only unchecks it needs none |
| `node scripts/e2e-page-privacy.mjs [folder]` | S-05 / S-08: the "Read current page" checkbox is checked by default (a fresh install sends the page with an ordinary question and asks nothing first); unchecking it sends the question without the page, the choice is stored, survives a re-opened panel and reaches an open one; quick actions (Summarize, Translate, Key Points) send the page whatever the box says and leave it alone; the one-time voice-input and image notices. Every "was the page sent?" check looks for a marker in the request the fake provider actually received. `ONLY=<regex>` runs matching tests only |
| `node scripts/e2e-tabs-permission.mjs` | S-07: loads the extension with and without the `tabs` permission and compares what the panel needs (tab url/title of web pages, scripting, captureVisibleTab, tabs.onUpdated) |

`[folder]` runs the same test against another copy of the extension (for example the original package) as a control.

## Standalone Chrome/CDP tests

These tests use Chrome's DevTools Protocol directly; they do not require Playwright.

- `node scripts/test-extension-e2e.mjs` loads the unpacked extension and exercises the real service worker, options page, side panel, storage and image-fetch handler. Requires Chrome 125+ with the `Extensions` CDP domain and `--enable-unsafe-extension-debugging`. Optional environment variables: `CHROME_PATH`, `EXT_TEST_PORT`, and `EXT_ROOT`.
- `node scripts/test-chrome-browser.mjs` runs the separate CDP browser suite. It uses the `CHROME_PATH` constant near the top of the script; edit that value when Chrome is installed elsewhere.

Each script exits non-zero if an assertion fails.
