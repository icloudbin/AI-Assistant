# Validation checklist (file names must match exactly, UTF-8, no .txt suffix)
Every file below is imported or loaded at runtime and must be present in any package and tracked by git:

- Root: `manifest.json`, `background.js`, `content.js`, `models.js`, `storage-keys.js`, `i18n.js`, `settings-storage.js`, `settings-crypto.js`, `translate-lines.js`, `url-safety.js`, `sensitive-sites.js`, `conversation-store.js` (imported by the side panel)
- `providers/`: `messages.js`, `openai-compatible.js` (imported by background.js)
- `privacy/`: `pii-filter.js` (imported by background.js)
- `options/`: `options.html`, `options.js` (the page's styles are inline; there is no options.css)
- `sidepanel/`: `sidepanel.html`, `sidepanel.css`, `sidepanel.js`, `mic-permission.html`, `mic-permission.css`, `mic-permission.js`, `rendering/markdown.js`, `history-manager.js`
- `icons/`: `icon16.png`, `icon48.png`, `icon128.png`

**Run before every build or commit:** `node scripts/check-package.mjs`. It follows every static `import` from the manifest entry points, fails if a required file is missing, and (in a git checkout) fails if one is untracked or git-ignored. `background.js` imports `privacy/pii-filter.js`, `settings-crypto.js` (via settings-storage), `translate-lines.js` and `url-safety.js`; a package built from git without them makes the service worker fail to load. It also checks that the page-text limit has a single definition: `MAX_PAGE_CONTEXT_CHARS` in `models.js` (imported by `background.js` and `sidepanel/sidepanel.js`), and that `content.js`, which cannot import it, uses the same value. `.gitignore` keeps build artifacts (`*.zip`, `*.crx`, `*.pem`, `dist/`) out of version control.
