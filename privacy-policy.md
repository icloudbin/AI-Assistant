Privacy Policy for AI Assistant

Effective Date: October 17, 2026

AI Assistant ("the Extension") is a browser extension that provides AI assistance for webpages, selected webpage text, and user-provided files. This Privacy Policy explains what information the Extension processes, how it is used, and when it is shared with third-party services.

1. Information Stored by the Extension

The Extension stores certain information locally in the user's browser using Chrome's local storage facilities. This may include:

AI provider API keys entered by the user, including an optional Tavily Search API key for web-grounded Fact Check
User-selected AI model and provider settings
Custom prompts configured by the user
Interface language and translation preferences
Voice input language preference
Locally saved conversation history
Privacy filter and page screenshot preferences
Temporary information required to pass a user-initiated context-menu action to the Side Panel

The Extension does not transmit these locally stored settings to the Extension developer's servers.

API keys are stored locally and are used only to authenticate requests to the AI provider selected by the user. API keys are not included in conversation-history backup ZIP files.

2. Webpage Content

When the user requests an operation that requires webpage context, the Extension may access content from the webpage currently being viewed.

Depending on the user's action, this may include:

Webpage text
Webpage title
Webpage URL
Text explicitly selected by the user
Content from the current webpage required for an AI request

Examples include asking questions about the current page, summarizing, translating, explaining, extracting key points, and fact-checking selected text.

The Extension is designed to use the current active webpage and refresh its context when the user changes tabs or navigates to another page.

When the Read current page option is disabled, ordinary questions are not sent with the current webpage content as context.

The quick actions (Summarize, Translate, Explain, Key Points and Fact Check) always read the current page, even when the Read current page option is unchecked, because they operate on that page. The Read current page option is on by default; if the user turns it off, that choice is remembered until they turn it back on. The side panel's context bar shows which page (title and site) would be sent with the next question.

Webmail and online-banking/payment sites (for example Gmail, Outlook, Proton Mail, PayPal and major banks, plus self-hosted mail pages recognised by the extension's mail extractors) are treated as sensitive: for ordinary questions the page is not sent, even when Read current page is on, unless the user clicks "Send this site this session" in the context bar. That permission applies only to that site and only until the side panel is closed. The quick actions are explicit actions on the page and still read it. The site list is a heuristic and does not cover every mail or banking site.

Page screenshot and images: only if the user turns on "Page screenshot and images" in Settings (off by default), the quick actions also capture a screenshot of the visible part of the current tab and up to a few of the page's images and send them to the selected AI provider. These images are sent as they appear, including any personal information visible on the page; the privacy filter described below cannot redact images. Images the user attaches themselves are sent as described in section 3.

Privacy filter: unless the user turns it off in Settings (on by default), the Extension locally replaces recognisable personal and sensitive text (such as emails, phone numbers, card and ID numbers, IP addresses, API keys, tokens, passwords and clearly labelled names) with placeholders before the question, page text, attachment text and conversation history are sent to an AI provider or to Tavily. The filter is pattern based and is a safety net, not a guarantee. Locally stored history keeps the original text.

Images in AI replies: remote images that appear in an AI reply are not loaded automatically. They are fetched, through the Extension, only when the user clicks the placeholder.

3. User-Provided Files

The Extension allows users to attach supported files, including images, text, HTML, and ZIP files containing supported text or HTML content.

When a user submits a request involving an attachment, the relevant file content or image data may be sent to the AI provider selected by the user as part of that request.

Files are processed within the Extension and are not uploaded to a server operated by the Extension developer.

4. Conversation History

Conversation history is stored locally in the user's browser.

When a user asks a follow-up question, relevant conversation history may be included in the request sent to the selected AI provider to maintain conversational context.

The Extension does not maintain a separate developer-operated database of conversation history.

Users can delete locally stored conversation history through the Extension's History Management settings.

Users can also export conversation history to a local ZIP backup file and restore it later. Backup and restore operations are performed locally by the Extension.

5. Custom Prompts

Users may configure a custom prompt in the Extension settings.

When a user submits an AI request, the configured custom prompt may be included in the request sent to the selected AI provider.

Custom prompts are stored locally in the user's browser and are not sent to the Extension developer's servers.

6. Third-Party AI Services

The Extension does not provide its own AI inference server. Depending on the model selected by the user, requests may be sent directly from the Extension to one of the following third-party services:

DeepSeek — https://api.deepseek.com
Groq — https://api.groq.com
OpenRouter — https://openrouter.ai
- Tavily — https://api.tavily.com (only when the user has added a Tavily API key; used for online research such as Fact Check, Explain, and automatic lookups for questions the current page cannot answer)

The information sent to the selected provider may include the user's question, relevant conversation history, custom prompt, webpage context, selected webpage text, and attached images or extracted file content.

The selected provider processes that information according to its own privacy policy, terms, retention practices, and applicable laws. Users should review the privacy policy of the AI provider they choose.

The Extension does not send a request to all providers simultaneously. A request is sent only to the provider associated with the model selected by the user.

7. API Keys

Users provide their own API keys for supported AI services.

API keys are stored locally in the browser and are used to authenticate requests sent directly to the corresponding AI provider.

The Extension developer does not receive, store, or operate a central database of user API keys.

Users are responsible for protecting their API keys and complying with the terms and usage policies of the corresponding AI provider.

8. Voice Input

The Extension provides optional English and Mandarin voice input using the browser's Speech Recognition API.

Voice input is used to convert speech into text for the user's question. The resulting transcript is inserted into the question input and may be sent to the selected AI provider when the user submits the request.

The Extension does not intentionally store audio recordings.

Depending on the browser and its speech-recognition implementation, speech processing may involve a browser-provided speech recognition service. Such processing is subject to the applicable browser/provider privacy practices.

9. Context Menu Actions

When a user selects webpage text and explicitly chooses an AI action from the browser context menu, the selected text is passed to the Extension for the requested operation.

Supported actions include:

Summarize
Translate
Explain
Fact Check

The selected text is used only for the user-requested operation. The Extension does not automatically process all webpage selections or monitor right-click activity.

10. Data Sharing

The Extension does not sell user data.

The Extension does not share user data with advertisers, data brokers, or analytics providers.

User information may be transmitted to the third-party AI provider explicitly selected by the user, as necessary to fulfill the user's AI request.

The Extension developer does not operate a backend service that receives or stores the user's webpage content, conversations, attached files, or API keys. When online Fact Check is enabled, selected factual claims are sent directly from the extension service worker to Tavily for web search; the returned search evidence is then sent to the selected AI provider for analysis.

11. Browsing History and Tracking

The Extension does not intentionally collect or maintain the user's browsing history.

The Extension may access the currently active tab and webpage when needed for a requested AI operation. It uses this information to ensure that page-related requests are associated with the webpage the user is currently viewing.

The Extension does not use webpage access to create advertising profiles, track browsing behavior, record clicks or keystrokes, or monitor the user's activity across websites.

12. Data Security

The Extension is designed to keep user settings and conversation history in the browser's local storage.

However, when information is sent to a third-party AI provider, that provider's systems and security practices apply to the transmitted information. Users should avoid submitting information they do not want to send to the selected third-party service.

13. User Control

Users can control whether webpage content is included in ordinary AI requests through the Read current page setting.

Users can also:

Delete local conversation history
Change or remove stored API keys
Change AI providers and models
Change custom prompts
Remove attached files before submitting a request
Export or restore local conversation history
14. Children's Privacy

The Extension is not specifically directed toward children and does not knowingly collect personal information from children.

15. Changes to This Privacy Policy

This Privacy Policy may be updated when the Extension's data practices or functionality change. The updated version will be published at the same policy URL, and the effective date will be updated accordingly.

16. Contact

For questions regarding this Privacy Policy or the Extension's data practices, please leave a message on GitHub.