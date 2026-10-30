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
├── models.js
├── background.js
├── content.js
├── storage-keys.js
├── conversation-store.js
├── settings-storage.js
├── settings-crypto.js
├── providers/
│   ├── messages.js
│   └── openai-compatible.js
├── privacy/
│   └── pii-filter.js
├── translate-lines.js
├── translation-selection.js
├── url-safety.js
├── sensitive-sites.js
├── i18n.js
├── README.md
├── CHANGELOG.md
├── privacy-policy.md
├── docs/
│   ├── updating-and-backup.md
│   ├── packaging.md
│   └── features.md
├── icons/
│   └── icon16.png / icon48.png / icon128.png (declared in manifest.json's "icons" and "action.default_icon" fields)
├── options/
│   └── options.html / options.js
├── scripts/
│   ├── check-package.mjs
│   ├── test-pii-filter.mjs
│   ├── test-outbound-pii.mjs
│   ├── test-url-safety.mjs
│   ├── test-translation-paragraphs.mjs
│   ├── test-conversation-store.mjs
│   ├── test-providers-messages.mjs
│   ├── test-openai-compatible.mjs
│   ├── test-markdown-render.mjs
│   ├── test-history-manager.mjs
│   ├── test-attachment-budget.mjs
│   ├── test-extension-e2e.mjs
│   └── test-sidepanel-context.py
└── sidepanel/
    ├── sidepanel.html
    ├── sidepanel.css
    ├── sidepanel.js
    ├── mic-permission.html  ← opened as its own tab for the mic permission grant, see "Voice input" in docs/features.md
    ├── mic-permission.css
    ├── mic-permission.js
    ├── rendering/
    │   └── markdown.js
    ├── attachment-budget.js
    └── history-manager.js
```

## Deployment
1. brave://extensions → Developer mode → Load unpacked → select the AI-Assistant-main folder
2. For updates, do NOT click "Remove" first — removing an extension permanently deletes all of its stored data (see [docs/updating-and-backup.md](docs/updating-and-backup.md))
3. Click the toolbar icon to open the side panel; click "Settings" to paste and save an API key
4. After changing code: reload the extension card; reopen the side panel; refresh existing web pages
