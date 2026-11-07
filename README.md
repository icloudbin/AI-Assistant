# AI Assistant

A Chromium side-panel extension (Manifest V3, Chrome 116 or newer) that answers questions about the current page, attached files and your own prompts, using DeepSeek, Groq or OpenRouter with your own API key. A Tavily key is optional and adds web research. The version is in `manifest.json`.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): release notes, newest first.
- [docs/updating-and-backup.md](docs/updating-and-backup.md): updating without losing settings, Settings Backup, key management.
- [docs/packaging.md](docs/packaging.md): the file checklist and `node scripts/check-package.mjs`.
- [docs/features.md](docs/features.md): file uploads, voice input, rendering, Fact Check.
- [privacy-policy.md](privacy-policy.md): privacy policy.

## Structure
```
AI-Assistant/
├── manifest.json
├── README.md
├── CHANGELOG.md
├── privacy-policy.md
├── background.js
├── content.js
├── models.js
├── storage-keys.js
├── auto-web-research.js
├── request-keep-alive.js
├── attachments.js
├── conversation-store.js
├── settings-storage.js
├── settings-crypto.js
├── translate-lines.js
├── translation-selection.js
├── url-safety.js
├── i18n.js
├── providers/
│   ├── messages.js
│   └── openai-compatible.js
├── privacy/
│   └── pii-filter.js
├── options/
│   ├── options.html
│   ├── options.js
│   └── settings-import.js
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   ├── sidepanel.js
│   ├── dialogs.js
│   ├── mic-permission.html
│   ├── mic-permission.css
│   ├── mic-permission.js
│   ├── attachment-budget.js
│   ├── history-manager.js
│   └── rendering/
│       └── markdown.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── docs/
│   ├── features.md
│   ├── packaging.md
│   └── updating-and-backup.md
└── scripts/
    ├── README.md
    ├── build-package.mjs
    ├── check-package.mjs
    ├── e2e-attachments.mjs
    ├── e2e-chat-flow.mjs
    ├── e2e-drop-image.mjs
    ├── e2e-import-settings.mjs
    ├── e2e-page-privacy.mjs
    ├── e2e-pii-render.mjs
    ├── e2e-restore-history.mjs
    ├── e2e-tabs-permission.mjs
    ├── e2e-two-windows.mjs
    ├── test-attachment-budget.mjs
    ├── test-auto-web-research.mjs
    ├── test-chrome-browser.mjs
    ├── test-content-visibility.mjs
    ├── test-conversation-store.mjs
    ├── test-extension-e2e.mjs
    ├── test-history-manager.mjs
    ├── test-markdown-heading.mjs
    ├── test-markdown-render.mjs
    ├── test-models.mjs
    ├── test-openai-compatible.mjs
    ├── test-options-backup.mjs
    ├── test-outbound-pii.mjs
    ├── test-pii-filter.mjs
    ├── test-pii-name-perf.mjs
    ├── test-pii-restore.mjs
    ├── test-providers-messages.mjs
    ├── test-request-keep-alive.mjs
    ├── test-settings-crypto.mjs
    ├── test-settings-import.mjs
    ├── test-settings-storage-keys.mjs
    ├── test-sidepanel-context.py
    ├── test-stop-streaming.mjs
    ├── test-translate-replay.mjs
    ├── test-translation-paragraphs.mjs
    ├── test-untrusted-boundary.mjs
    └── test-url-safety.mjs
```

## Deployment
1. brave://extensions → Developer mode → Load unpacked → select the AI-Assistant-main folder
2. For updates, do NOT click "Remove" first — removing an extension permanently deletes all of its stored data (see [docs/updating-and-backup.md](docs/updating-and-backup.md))
3. Click the toolbar icon to open the side panel; click "Settings" to paste and save an API key
4. After changing code: reload the extension card; reopen the side panel; refresh existing web pages
