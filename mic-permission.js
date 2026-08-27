// sidepanel/mic-permission.js
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
    stateEl.textContent = "Microphone allowed — closing this tab…";
    stateEl.className = "state ok";
    setTimeout(() => window.close(), 500);
  } catch (err) {
    requestBtn.disabled = false;
    if (err.name === "NotAllowedError") {
      stateEl.textContent = "Microphone access was blocked. Click the site info icon in the address bar, allow the microphone, then try again.";
    } else if (err.name === "NotFoundError") {
      stateEl.textContent = "No microphone was found on this device.";
    } else {
      stateEl.textContent = `Could not access the microphone: ${err.message || err.name}`;
    }
    stateEl.className = "state error";
  }
}

requestBtn.addEventListener("click", requestMic);
// Try immediately on load too, so granting access often takes a single click
// in the permission prompt rather than a click here plus the prompt.
requestMic();
