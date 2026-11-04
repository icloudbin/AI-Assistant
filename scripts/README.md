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
| `node scripts/test-settings-import.mjs` | S-06 / S-05: which differences a settings file makes and which need explicit confirmation (privacy switches, the "Read current page" mode, the never-send / always-allow site lists, custom prompt, API keys); custom-prompt length limit |
| `node scripts/test-sensitive-sites.mjs` | S-05: the built-in sensitive-site rules (the sites the review named - outlook.com, exmail.qq.com, accounts.google.com, exchanges, brokers, password managers, irs.gov, ... - are flagged; `river-bank.com` is not; a tab label counts only when it is the whole label), host-list parsing and normalisation, and the never > allowed > sensitive > normal precedence |
| `node scripts/test-page-context-policy.mjs` | S-05: the whole decision table - mode (off / ask / always / not chosen yet) x request kind (typed question / quick action) x site policy - plus the stored-value mapping and the context-bar state derived from the same decision |
| `node scripts/test-conversation-store.mjs` | B-04: two copies of one conversation merge by message id and are ordered by time in whole turns (no scrambled order, identical messages not folded); old messages get deterministic ids; a quota-shortened attachment preview sticks without a flag |

## Real-browser tests (need `playwright` with Chromium; the chat-flow test also needs `openssl`)

They load this folder as an unpacked extension in headless Chromium.

| Command | Covers |
| --- | --- |
| `node scripts/e2e-chat-flow.mjs` | B-02 against a real HTTPS server (Stop closes the provider connection), a normal send/receive round trip, and the context-menu translate action (E-04) |
| `node scripts/e2e-restore-history.mjs` | B-01: Settings > Restore shows the success message (and the quota notices) instead of "Restore failed"; B-04: a restore keeps message ids and times, and gives old backups deterministic ids |
| `node scripts/e2e-two-windows.mjs [folder]` | B-04: two side panels continue the same conversation at the same time - both turns are saved, each question stays with its answer, identical messages are not folded (fails on the original package) |
| `node scripts/e2e-drop-image.mjs` | R-06: dropping a page image attaches it without also inserting its URL as text; S-08: the first dropped image asks first, and declining attaches nothing and pastes nothing |
| `node scripts/e2e-attachments.mjs` | S-02 through the side panel: a text file and a ZIP (with a newline in an entry name) reach the model only inside random UNTRUSTED blocks; stored messages are structured; an old inline-format conversation is migrated on load |
| `node scripts/e2e-pii-render.mjs [folder]` | S-03: with a prompt-injected reply, no link/image address carries the user's real e-mail, while the text still shows it; the image placeholder names the host and warns about a query string |
| `node scripts/e2e-import-settings.mjs [folder]` | S-06: a hostile settings file shows a review dialog, risky items start unticked, Cancel changes nothing, only ticked items are applied; S-05: a file that weakens page reading or the site lists needs its own ticks, a file that only tightens needs none, a bogus mode or list is ignored |
| `node scripts/e2e-page-privacy.mjs [folder]` | S-05 / S-08: the first-run question (Esc = undecided); ask-each-time (Cancel keeps the draft and saves nothing, send without the page, "don't ask again" per site); sensitive sites (stronger wording, blocked in always-read mode, "Allow" for the session); quick actions on sensitive and never-send sites; the always-allow list; a tab switch while a question is open; a webmail that only the page extractor recognises (second question, and Cancel takes the question back out of the saved history); the Settings site lists; the one-time voice-input and image notices. Every "was the page sent?" check looks for a marker in the request the fake provider actually received. `ONLY=<regex>` runs matching tests only |
| `node scripts/e2e-tabs-permission.mjs` | S-07: loads the extension with and without the `tabs` permission and compares what the panel needs (tab url/title of web pages, scripting, captureVisibleTab, tabs.onUpdated) |

`[folder]` runs the same test against another copy of the extension (for example the original package) as a control.

Each script exits non-zero if an assertion fails.
