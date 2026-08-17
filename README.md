<!-- README.md —— For this update, replace the entire package, especially manifest.json -->
# Structure (three sidepanel files in the subdirectory, all other files in the root; matches import "../models.js")
deepseek-assistant/
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