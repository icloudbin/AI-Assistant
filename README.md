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


## Rich conversation rendering

Assistant responses are stored as their original Markdown/plain text, but rendered in the side panel as sanitized HTML. Supported formatting includes headings, paragraphs, bold/italic text, links, lists, blockquotes, tables, horizontal rules, inline code, and fenced code blocks. Raw HTML from the model is escaped rather than executed. Normal browser selection/copy operates on the rendered DOM, so copying selected content copies readable text/rich text rather than HTML tags.
