# Features

How some of the extension's features work. These notes describe standing behaviour, not individual releases; for what changed in each version see [CHANGELOG.md](../CHANGELOG.md).

## File Uploads (v1.0.6)

The side panel now has an Upload button below the question box. It accepts images, common text/code files, HTML, and ZIP/WinZip archives. Text and HTML files are read locally and included in the selected provider's chat request. ZIP files are parsed locally and supported text/HTML entries are extracted and included.

Image attachments are encoded locally as data URLs and sent with the current request. DeepSeek image requests are handled natively by `deepseek-flash`; Groq and OpenRouter receive multimodal image content when the selected model supports vision. The catalog marks three models `vision: false` — both GPT-OSS models and the OpenRouter free model — so automatic page screenshots/images are not attached for them and image attachments are rejected with the explanatory error. Qwen 3.8 27B on Groq is natively multimodal (verified against the live API) and accepts image attachments.

Groq's Qwen 3.8 27B is a preview model (evaluation only, can be retired at short notice): the model dropdown labels it, and if a provider retires a model or the free route has no active providers, requests fail with an actionable "model unavailable" error instead of the raw HTTP status.


Version 1.0.9 adds a Settings > Backup History button that exports all locally saved conversations as a standard ZIP file. API keys and custom prompts are not included.

## Voice input (v1.5.0)

A microphone button sits between Upload and the history dropdown. Click it to start dictating into the question box; click it again to stop. It listens continuously (through normal pauses) until you click it off. A small language badge on the button (EN / 中) sets which language it expects — English or Mandarin — since the browser's speech engine needs to be told the language rather than detecting it automatically; it remembers your last choice. Recognized text is appended after anything already typed.

This uses the browser's built-in Web Speech API, so it needs an internet connection and, the first time, a microphone permission grant (a small tab opens for that grant — Chromium side panels have a known bug where the in-panel permission prompt can fail to appear, so a normal tab is used instead and closes itself once you allow access).

**Known Brave limitation:** Brave's speech-recognition backend is unreliable — the classic cloud engine returns a "network" error because Brave doesn't have access to Google's private recognition service, and Brave's newer on-device engine has an open bug where the required language model never finishes installing. Voice input reliably works in Chrome; in Brave it depends on your version, and the extension shows an on-screen error rather than failing silently if it's blocked. If Brave fixes this, no code changes should be needed.

## Rich conversation rendering

Assistant responses are stored as their original Markdown/plain text, but rendered in the side panel as sanitized HTML. Supported formatting includes headings, paragraphs, bold/italic text, links, lists, blockquotes, tables, horizontal rules, inline code, and fenced code blocks. Raw HTML from the model is escaped rather than executed. Normal browser selection/copy operates on the rendered DOM, so copying selected content copies readable text/rich text rather than HTML tags.

## Web-grounded Fact Check (v1.10.33)

Fact Check can optionally use Tavily Search to retrieve current web evidence before the selected AI model evaluates the claims. The workflow is intentionally bounded to reduce search cost: up to five candidate factual claims are selected from the current page or highlighted text, each claim gets a basic Tavily general-web search with up to four results, duplicate URLs are removed, and the resulting evidence is supplied to the AI model with strict instructions not to invent sources. A highlighted claim goes to Tavily verbatim - the privacy filter's documented exception, because a redacted claim ("[NAME#1] won 6 championships") is unsearchable; when Fact Check is run without a highlight, the candidate claims are mined from the page text with the privacy filter applied.

Configure the Tavily Search API key in Settings; Fact Check then uses it automatically (there is no separate Fact Check toggle). Tavily currently provides a free monthly API-credit allowance; advanced search consumes more credits than basic search, so this implementation uses basic search for the bounded Fact Check workflow.

## Privacy filter: credential coverage and known gaps

The privacy filter (`privacy/pii-filter.js`) is pattern based: it is a safety net, not a guarantee. For credentials it recognises two kinds of shape.

**Tokens with a fixed prefix** are replaced with `[API_KEY]` wherever they appear: AWS access key IDs (`AKIA` / `ASIA`), Google API keys (`AIza`), GitHub (`ghp_` and siblings, `github_pat_`), GitLab (`glpat-`), Slack (`xox*-`), Stripe (`sk_live_` and siblings), OpenAI / Anthropic / OpenRouter (`sk-`), Groq (`gsk_`), Tavily (`tvly-`), HuggingFace (`hf_`), npm (`npm_`), Replicate (`r8_`), Google OAuth access tokens (`ya29.`, including the service-account form `ya29.c.`), PyPI (`pypi-`), xAI (`xai-`), Perplexity (`pplx-`), DigitalOcean (`dop_v1_`), Mailgun (`key-` plus 32 hex characters), SendGrid, Telegram bot tokens, Slack / Discord webhook URLs, JWTs and PEM private keys.

**Secrets recognised by where they sit**: `Bearer` / `Basic` credentials, `Cookie` headers and session cookies, `name = value` pairs whose name contains `secret`, `token`, `password` or `api key`, `user:pass@host` URLs, and URL query parameters whose name ends in `api_key`, `token`, `sig`, `signature`, `secret`, `password`, `pwd` or `credential` (so `X-Amz-Signature`, `X-Amz-Security-Token`, `X-Amz-Credential`, `X-Goog-Signature` and `x-api-key` in a presigned URL are covered), plus the bare names `key` and `auth`.

**Known gap: a bare AWS secret access key.** The 40-character secret that pairs with an `AKIA…` key ID has no prefix and no fixed structure (it is 40 characters of base64 alphabet), so on its own it cannot be told apart from a hash, a commit id or any other long random string. A rule loose enough to catch it would also redact every 40-character identifier on a page, so the filter deliberately does not try. It is still redacted when it follows a recognisable label (`AWS_SECRET_ACCESS_KEY=…`, `aws_secret_access_key: …`, `"secretAccessKey": "…"`), which is how it normally appears in configuration files, shell history and error messages. If you paste one without any label, redact it yourself before sending.
