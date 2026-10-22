# Features

How some of the extension's features work. These notes describe standing behaviour, not individual releases; for what changed in each version see [CHANGELOG.md](../CHANGELOG.md).

## File Uploads (v1.0.6)

The side panel now has an Upload button below the question box. It accepts images, common text/code files, HTML, and ZIP/WinZip archives. Text and HTML files are read locally and included in the DeepSeek chat request. ZIP files are parsed locally and supported text/HTML entries are extracted and included.

Image attachments are encoded locally as data URLs and sent with the current request. DeepSeek image requests are handled natively by `deepseek-flash`; Groq and OpenRouter receive multimodal image content when the selected model supports vision. The two GPT-OSS models on Groq are text-only, so automatic page screenshots/images are not attached for them.


Version 1.0.9 adds a Settings > Backup History button that exports all locally saved conversations as a standard ZIP file. API keys and custom prompts are not included.

## Voice input (v1.5.0)

A microphone button sits between Upload and the history dropdown. Click it to start dictating into the question box; click it again to stop. It listens continuously (through normal pauses) until you click it off. A small language badge on the button (EN / 中) sets which language it expects — English or Mandarin — since the browser's speech engine needs to be told the language rather than detecting it automatically; it remembers your last choice. Recognized text is appended after anything already typed.

This uses the browser's built-in Web Speech API, so it needs an internet connection and, the first time, a microphone permission grant (a small tab opens for that grant — Chromium side panels have a known bug where the in-panel permission prompt can fail to appear, so a normal tab is used instead and closes itself once you allow access).

**Known Brave limitation:** Brave's speech-recognition backend is unreliable — the classic cloud engine returns a "network" error because Brave doesn't have access to Google's private recognition service, and Brave's newer on-device engine has an open bug where the required language model never finishes installing. Voice input reliably works in Chrome; in Brave it depends on your version, and the extension shows an on-screen error rather than failing silently if it's blocked. If Brave fixes this, no code changes should be needed.

## Rich conversation rendering

Assistant responses are stored as their original Markdown/plain text, but rendered in the side panel as sanitized HTML. Supported formatting includes headings, paragraphs, bold/italic text, links, lists, blockquotes, tables, horizontal rules, inline code, and fenced code blocks. Raw HTML from the model is escaped rather than executed. Normal browser selection/copy operates on the rendered DOM, so copying selected content copies readable text/rich text rather than HTML tags.

## Web-grounded Fact Check (v1.10.33)

Fact Check can optionally use Tavily Search to retrieve current web evidence before the selected AI model evaluates the claims. The workflow is intentionally bounded to reduce search cost: up to five candidate factual claims are selected from the current page or highlighted text, each claim gets a basic Tavily news search with up to four results, duplicate URLs are removed, and the resulting evidence is supplied to the AI model with strict instructions not to invent sources.

Configure the Tavily Search API key and enable **Use online research for Fact Check** in Settings. Tavily currently provides a free monthly API-credit allowance; advanced search consumes more credits than basic search, so this implementation uses basic search for the bounded Fact Check workflow.
