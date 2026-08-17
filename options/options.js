// options.js — Option A: same directory as options.html
const apiKeyInput = document.getElementById("apiKey");
const msgEl = document.getElementById("msg");

chrome.storage.local.get("apiKey", ({ apiKey }) => {
  if (apiKey) apiKeyInput.value = apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    msgEl.style.color = "#f55b5b";
    msgEl.textContent = "Key cannot be empty";
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  msgEl.style.color = "#4ade80";
  msgEl.textContent = "Saved ✓";
  setTimeout(() => (msgEl.textContent = ""), 1500);
});