<!-- README.md —— For this update, replace the entire package, especially manifest.json -->
# Structure (three sidepanel files in the subdirectory, all other files in the root; matches import "../models.js")
Brave-AI-assistant/
├── manifest.json      ← v1.0.2：options_ui removed; this avoids the "Could not load options page" error
├── models.js
├── background.js
├── content.js
├── options.html       ← kept: even if your old manifest still has options_ui, it can pass validation
├── options.js
└── sidepanel/
    ├── sidepanel.html ← dropdown moved next to the title; API Key configuration bar built in
    ├── sidepanel.css  ← fixed the * selector
    └── sidepanel.js   ← fixed all trailing-space bugs

# Deployment
1. brave://extensions → Developer mode → Load unpacked → select the deepseek-assistant folder
2. If loading failed before: remove the old entry first, then select "Load unpacked" again
3. Click the toolbar icon to open the side panel; click "Settings" to paste and save the API Key
4. After changing code: reload the extension card; reopen the side panel; refresh existing web pages

# Validation checklist (file names must match exactly, UTF-8, no .txt suffix)
manifest.json / models.js / background.js / content.js /
options.html / options.js / sidepanel/sidepanel.html /
sidepanel/sidepanel.css / sidepanel/sidepanel.js

## File Uploads (v1.0.6)

The side panel now has an Upload button below the question box. It accepts images, common text/code files, HTML, and ZIP/WinZip archives. Text and HTML files are read locally and included in the DeepSeek chat request. ZIP files are parsed locally and supported text/HTML entries are extracted and included.

The current DeepSeek API Chat Completions interface is text-only, so image files can be attached and displayed in the extension but their binary image data is not sent to DeepSeek. The extension does not claim image understanding through DeepSeek.


Version 1.0.9 adds a Settings > Backup History button that exports all locally saved conversations as a standard ZIP file. API keys and custom prompts are not included.

## Voice input (v1.5.0)

A microphone button sits between Upload and the history dropdown. Click it to start dictating into the question box; click it again to stop. It listens continuously (through normal pauses) until you click it off. A small language badge on the button (EN / 中) sets which language it expects — English or Mandarin — since the browser's speech engine needs to be told the language rather than detecting it automatically; it remembers your last choice. Recognized text is appended after anything already typed.

This uses the browser's built-in Web Speech API, so it needs an internet connection and, the first time, a microphone permission grant (a small tab opens for that grant — Chromium side panels have a known bug where the in-panel permission prompt can fail to appear, so a normal tab is used instead and closes itself once you allow access).

**Known Brave limitation:** Brave's speech-recognition backend is unreliable — the classic cloud engine returns a "network" error because Brave doesn't have access to Google's private recognition service, and Brave's newer on-device engine has an open bug where the required language model never finishes installing. Voice input reliably works in Chrome; in Brave it depends on your version, and the extension shows an on-screen error rather than failing silently if it's blocked. If Brave fixes this, no code changes should be needed.

## DeepSeek model IDs updated to V4 (v1.6.0)

`deepseek-chat` and `deepseek-reasoner` were DeepSeek's standard API model names for about two years (the model behind each name was upgraded repeatedly, but the names themselves stayed stable) — that's why they were the names used here. DeepSeek introduced explicit `deepseek-v4-flash` / `deepseek-v4-pro` names on 2026-04-24 and announced the legacy names would stop working on 2026-07-24; that date has now passed, so the old IDs can no longer be relied on.

`models.js` now sends `deepseek-v4-flash` / `deepseek-v4-pro` as the actual API model, while keeping the internal `id` values (`deepseek-chat`, `deepseek-reasoner`) unchanged so anyone's already-saved model preference still matches. A new "DeepSeek V4 Pro" option was added. One behavior change worth knowing: thinking mode is enabled by default on the V4 models (it previously only ran under the `deepseek-reasoner` name), so `models.js` now explicitly passes `thinking: {type: "disabled"}` for the Chat option to keep it fast/non-thinking like before - without that, Chat would silently start reasoning on every request. See DeepSeek's [Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode) for the underlying parameters.


## Gemini support alongside DeepSeek (v1.7.0)

The model dropdown now lists Google Gemini models next to the DeepSeek ones, and Settings has a second, independent "Gemini API Key" field below the DeepSeek one. Either key can be left blank, but Save now requires at least one of the two to be filled in (previously the DeepSeek key alone was required). Picking a Gemini entry from the dropdown and asking a question sends the request to Gemini using the Gemini key; picking a DeepSeek entry still uses the DeepSeek key exactly as before.

Model list as of this version (`models.js`):
- DeepSeek Chat, DeepSeek Reasoner, DeepSeek V4 Pro — unchanged.
- Gemini 3.7 Flash — latest stable Flash model, general-purpose default.
- Gemini 3.1 Pro — Google's flagship Gemini 3 reasoning model, for harder reasoning/agentic tasks.
- Gemini 2.5 Pro — Google's most capable stable (non-preview) model, for harder reasoning tasks.

**v1.7.1:** Gemini 3.5 Flash-Lite was dropped (redundant with Gemini 3.7 Flash) and Gemini 3.1 Pro was added in its place, at explicit user request. Gemini 3.1 Pro's apiModel is `gemini-3.1-pro-preview` and it is currently Preview-tier per https://ai.google.dev/gemini-api/docs/models, not Stable like the other two Gemini entries — Google can change preview model IDs on two weeks' notice, so this ID is more likely to need updating later than the Stable ones.

Implementation notes:
- `background.js` now branches on a `provider` field in each `models.js` entry ("deepseek" or "gemini") and calls one of two request functions, `streamDeepSeek` or `streamGemini`, both of which feed the same SSE-line reader. DeepSeek's request/response shape (OpenAI-style `messages`/`choices[0].delta`) is unchanged; Gemini uses its native `streamGenerateContent?alt=sse` endpoint with `contents`/`candidates[0].content.parts`, authenticated via an `x-goog-api-key` header rather than a bearer token.
- The internal message-passing port between the side panel and the background script was renamed from `"deepseek-chat"` to `"ai-chat"`, since it now carries requests for either provider. This is an internal channel name only and has no effect on stored data or on either provider's API.
- The Gemini API key field's placeholder intentionally does not show a fixed prefix like "AIza...": Google has been transitioning newly issued Google AI Studio keys to a different "AQ." prefix since mid-2026 alongside the older "AIza" format, and both are accepted as-is by the raw `generativelanguage.googleapis.com` endpoint used here.
- Gemini's "thinking" (extended reasoning before answering) is left at each model's own default, and thought summaries are not requested, so only the final answer streams into the chat — no chain-of-thought text should appear.
- Image attachments are still not sent as image data to either provider (only a filename placeholder is included in the prompt text); this was previously described in one spot as a DeepSeek-specific limitation, which was inaccurate now that Gemini is an option, and has been reworded.

## Claude support alongside DeepSeek and Gemini (v1.8.0)

The model dropdown now also lists Anthropic Claude models, and Settings has a third, independent "Claude API Key" field below the Gemini one. Any of the three keys can be left blank, but Save now requires at least one of the three to be filled in. Picking a Claude entry from the dropdown and asking a question sends the request to Anthropic's Messages API using the Claude key; picking a DeepSeek or Gemini entry still behaves exactly as before.

Model list as of this version (`models.js`):
- DeepSeek Chat, DeepSeek Reasoner, DeepSeek V4 Pro — unchanged.
- Gemini 3.7 Flash, Gemini 3.1 Pro — unchanged.
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
- Image attachments are still not sent as image data to any of the three providers (only a filename placeholder is included in the prompt text).

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

## ChatGPT support alongside DeepSeek, Gemini, and Claude (v1.9.0)

The model dropdown now also lists OpenAI models, and Settings has a fourth, independent "ChatGPT API Key" field. Save still only requires at least one of the four keys to be filled in.

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

## Rich conversation rendering

Assistant responses are stored as their original Markdown/plain text, but rendered in the side panel as sanitized HTML. Supported formatting includes headings, paragraphs, bold/italic text, links, lists, blockquotes, tables, horizontal rules, inline code, and fenced code blocks. Raw HTML from the model is escaped rather than executed. Normal browser selection/copy operates on the rendered DOM, so copying selected content copies readable text/rich text rather than HTML tags.
