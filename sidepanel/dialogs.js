// sidepanel/dialogs.js
//
// The modal questions the panel asks the user (S-05, S-08):
//   showPageChoiceDialog   first run: should the assistant read the page at all?
//   showPageConfirmDialog  before a page (or a sensitive page) is sent
//   showNoticeDialog       a one-time heads-up that needs a "continue" (microphone, images)
//
// Every function returns a promise and never rejects. Esc, and a programmatic
// dismissDialog(), resolve with the SAFE answer (nothing is sent, nothing is
// chosen, nothing is attached), and the safe button is the one that has the focus,
// so a stray Enter cannot approve anything. All text is put in with textContent:
// page titles come from web pages and must never be parsed as markup.

import { t } from "../i18n.js";

// id -> () => void, which closes that dialog with its safe answer.
const openDialogs = new Map();

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(id, label, className = "") {
  const el = make("button", className, label);
  el.type = "button";
  el.id = id;
  return el;
}

function openModal(id, safeAnswer, build) {
  return new Promise((resolve) => {
    // Never stack two copies of the same question: the older one is answered "no".
    openDialogs.get(id)?.();
    const dialog = make("dialog", "ai-dialog");
    dialog.id = id;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (openDialogs.get(id) === dismiss) openDialogs.delete(id);
      try { dialog.close(); } catch { /* not open */ }
      dialog.remove();
      resolve(value);
    };
    const dismiss = () => finish(safeAnswer);
    openDialogs.set(id, dismiss);
    // Esc: answer "no" ourselves instead of letting the browser close the dialog silently.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismiss();
    });
    try {
      build(dialog, finish);
      document.body.appendChild(dialog);
      dialog.showModal();
    } catch (err) {
      console.warn("[AI Assistant] Unable to show a dialog:", err);
      dismiss();
    }
  });
}

// Closes one open dialog with its safe answer (a request was stopped, the choice
// was made in another window, ...). A no-op when it is not open.
export function dismissDialog(id) {
  openDialogs.get(id)?.();
}

export function dismissAllDialogs() {
  for (const dismiss of [...openDialogs.values()]) dismiss();
}

export function isDialogOpen(id) {
  return openDialogs.has(id);
}

export const PAGE_CHOICE_DIALOG_ID = "pageChoiceDialog";
export const PAGE_CONFIRM_DIALOG_ID = "pageConfirmDialog";

// -> "off" | "ask" | "on" | null (decide later)
export function showPageChoiceDialog({ lang }) {
  return openModal(PAGE_CHOICE_DIALOG_ID, null, (dialog, finish) => {
    dialog.setAttribute("aria-labelledby", "pageChoiceTitle");
    const title = make("h3", "", t(lang, "pageChoice_title"));
    title.id = "pageChoiceTitle";
    dialog.append(title, make("p", "", t(lang, "pageChoice_body")));
    const options = make("div", "ai-choice");
    for (const mode of ["off", "ask", "on"]) {
      const choice = button(`pageChoice_${mode}`, "", "ai-choice-btn");
      choice.append(make("strong", "", t(lang, `readCurrentPage_${mode}`)), make("span", "", t(lang, `pageChoice_${mode}_desc`)));
      choice.addEventListener("click", () => finish(mode));
      if (mode === "ask") choice.autofocus = true;
      options.append(choice);
    }
    const later = button("pageChoice_later", t(lang, "pageChoice_later"), "ai-link-btn");
    later.addEventListener("click", () => finish(null));
    const actions = make("div", "ai-dialog-actions");
    actions.append(later);
    dialog.append(options, actions);
  });
}

// -> { choice: "send" | "without" | "cancel", remember: boolean }
//   sensitive     stronger wording for a webmail / banking / ... page
//   allowWithout  offer "Send without page" (an ordinary question can still be asked)
//   visuals       a screenshot and images of the page would go too
export function showPageConfirmDialog({ lang, sensitive, title, host, model, allowWithout, visuals }) {
  return openModal(PAGE_CONFIRM_DIALOG_ID, { choice: "cancel", remember: false }, (dialog, finish) => {
    dialog.setAttribute("aria-labelledby", "pageConfirmTitle");
    const heading = make("h3", "", t(lang, sensitive ? "pageConfirm_title_sensitive" : "pageConfirm_title_ask"));
    heading.id = "pageConfirmTitle";
    dialog.append(heading);
    if (sensitive) dialog.append(make("p", "ai-dialog-warning", t(lang, "pageConfirm_sensitiveWarning")));
    dialog.append(make("p", "", t(lang, "pageConfirm_body_template", { title: title || host, host, model })));
    if (visuals) dialog.append(make("p", "ai-dialog-muted", t(lang, "pageConfirm_visualsNote")));
    const remember = document.createElement("input");
    remember.type = "checkbox";
    remember.id = "pageConfirmRemember";
    const rememberRow = make("label", "ai-dialog-check");
    rememberRow.append(remember, make("span", "", t(lang, "pageConfirm_remember")));
    dialog.append(rememberRow, make("p", "ai-dialog-muted", t(lang, "pageConfirm_manageHint")));

    const cancel = button("pageConfirmCancel", t(lang, "dialog_cancel"));
    cancel.autofocus = true; // the safe choice is the default one
    cancel.addEventListener("click", () => finish({ choice: "cancel", remember: false }));
    const actions = make("div", "ai-dialog-actions");
    actions.append(cancel);
    if (allowWithout) {
      const without = button("pageConfirmWithout", t(lang, "pageConfirm_withoutPage"));
      // Sending the question WITHOUT the page is not a reason to trust the site.
      without.addEventListener("click", () => finish({ choice: "without", remember: false }));
      actions.append(without);
    }
    const send = button("pageConfirmSend", t(lang, "pageConfirm_send"), "primary");
    send.addEventListener("click", () => finish({ choice: "send", remember: remember.checked }));
    actions.append(send);
    dialog.append(actions);
  });
}

// -> true when the user continues, false on Cancel / Esc.
export function showNoticeDialog({ lang, id, title, body, confirmLabel }) {
  return openModal(id, false, (dialog, finish) => {
    dialog.setAttribute("aria-labelledby", `${id}Title`);
    const heading = make("h3", "", title);
    heading.id = `${id}Title`;
    dialog.append(heading, make("p", "", body));
    const cancel = button(`${id}Cancel`, t(lang, "dialog_cancel"));
    cancel.autofocus = true;
    cancel.addEventListener("click", () => finish(false));
    const confirm = button(`${id}Confirm`, confirmLabel || t(lang, "dialog_continue"), "primary");
    confirm.addEventListener("click", () => finish(true));
    const actions = make("div", "ai-dialog-actions");
    actions.append(cancel, confirm);
    dialog.append(actions);
  });
}
