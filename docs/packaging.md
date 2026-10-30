# Validation checklist (file names must match exactly, UTF-8, no .txt suffix)
Every file below is imported or loaded at runtime and must be present in any package and tracked by git:

- Root: `manifest.json`, `background.js`, `content.js`, `models.js`, `storage-keys.js`, `i18n.js`, `settings-storage.js`, `settings-crypto.js`, `translate-lines.js`, `url-safety.js`, `sensitive-sites.js`, `conversation-store.js` (imported by the side panel)
- `providers/`: `messages.js`, `openai-compatible.js` (imported by background.js)
- `privacy/`: `pii-filter.js` (imported by background.js)
- `options/`: `options.html`, `options.js` (the page's styles are inline; there is no options.css)
- `sidepanel/`: `sidepanel.html`, `sidepanel.css`, `sidepanel.js`, `history-manager.js`, `attachment-budget.js`, `mic-permission.html`, `mic-permission.css`, `mic-permission.js`, `rendering/markdown.js`
- `icons/`: `icon16.png`, `icon48.png`, `icon128.png`

**Run before every build or commit:** `node scripts/check-package.mjs`. It follows every static `import` from the manifest entry points, fails if a required file is missing, and (in a git checkout) fails if one is untracked or git-ignored. `background.js` imports `privacy/pii-filter.js`, `settings-crypto.js` (via settings-storage), `translate-lines.js` and `url-safety.js`; a package built from git without them makes the service worker fail to load. It also checks that the page-text limit has a single definition: `MAX_PAGE_CONTEXT_CHARS` in `models.js` (imported by `background.js` and `sidepanel/sidepanel.js`), and that `content.js`, which cannot import it, uses the same value. `.gitignore` keeps build artifacts (`*.zip`, `*.crx`, `*.pem`, `dist/`) out of version control.

**Build the store zip:** `node scripts/build-package.mjs`. It runs the check above, then writes `dist/AI_Assistant-v<version>.zip` containing exactly this file list. The zip writer is pure Node (no external tools): entry names always use forward slashes and there are no directory entries — do not replace it with PowerShell's `Compress-Archive`, which on Windows PowerShell 5.1 writes backslash separators (e.g. `sidepanel\sidepanel.js`) that the Chrome Web Store rejects. Before reporting success the script re-parses the finished archive and verifies every entry name against the required list, that no entry name contains a backslash, and that every entry's CRC-32 and decompressed bytes match the source file.
