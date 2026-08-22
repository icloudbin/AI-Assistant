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

#Here is the list of the features:
1. Chat with DeepSeek directly from the Brave side panel.
2. Current-page context with automatic updates — Reads and uses the content of the active web page as AI context; when enabled, the page context automatically refreshes when switching tabs or navigating.
3. Custom Prompt — Configure a custom system prompt from the Settings page.
4. Conversation History & Local Storage — Save and reopen previous conversations locally in the browser, with options to export, restore, or permanently delete the history (settings are also stored locally).
5. Rich HTML Responses — AI Markdown responses are converted into sanitized, formatted HTML.
6. Model Selection — Supports selecting the available DeepSeek models.


