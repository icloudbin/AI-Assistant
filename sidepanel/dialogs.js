// sidepanel/dialogs.js
//
// The modal questions the panel asks the user (S-08):
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
