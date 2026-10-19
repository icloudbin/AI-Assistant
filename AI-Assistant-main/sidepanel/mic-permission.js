// sidepanel/mic-permission.js
import { getStoredLanguage, applyStaticTranslations, t } from "../i18n.js";

// Match the side panel's theme so this tab doesn't look out of place.
(async function loadTheme() {
  try {
    const stored = await chrome.storage.local.get("themePreference");
    const pref = stored.themePreference || "device";
    const resolved = pref === "device"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : pref;
    document.documentElement.dataset.theme = resolved;
  } catch {
    // Not fatal - the page just keeps its default dark styling.
  }
})();

// This tab is short-lived (it closes itself once permission is granted), so
// unlike options.js/sidepanel.js it only needs a one-time snapshot of the
// language, not a live chrome.storage.onChanged listener.
let currentLang = "en";
(async function loadLanguage() {
  currentLang = await getStoredLanguage();
  applyStaticTranslations(currentLang);
})();

const requestBtn = document.getElementById("requestBtn");
const stateEl = document.getElementById("state");

async function requestMic() {
  stateEl.textContent = "";
  stateEl.className = "state";
  requestBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the prompt to record the permission grant; release the
    // mic immediately so no recording indicator lingers on this tab.
    stream.getTracks().forEach((track) => track.stop());
    stateEl.textContent = t(currentLang, "micPermission_success");
    stateEl.className = "state ok";
    setTimeout(() => window.close(), 500);
  } catch (err) {
    requestBtn.disabled = false;
    if (err.name === "NotAllowedError") {
      stateEl.textContent = t(currentLang, "micPermission_blocked");
    } else if (err.name === "NotFoundError") {
      stateEl.textContent = t(currentLang, "micPermission_notFound");
    } else {
      stateEl.textContent = t(currentLang, "micPermission_genericError_template", { detail: err.message || err.name });
    }
    stateEl.className = "state error";
  }
}

requestBtn.addEventListener("click", requestMic);
// Try immediately on load too, so granting access often takes a single click
// in the permission prompt rather than a click here plus the prompt.
requestMic();
