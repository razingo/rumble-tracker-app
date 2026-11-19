// In-app message and confirmation dialogs, in place of the browser's alert() and confirm().
import { $, esc } from './core.js';

let queue = Promise.resolve(); // one dialog at a time

/**
 * Shows a dialog and resolves to the value of the button pressed (null when closed with Esc).
 * message: plain text; blank lines start new paragraphs. buttons: [{ label, value, primary?, danger? }].
 */
export function showDialog({ title, message, buttons }) {
  const run = () => new Promise((resolve) => {
    const dlg = $('#messageDialog');
    const paragraphs = String(message || '').split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    dlg.innerHTML = `<form method="dialog" class="nt-form msg-form">
      ${title ? `<div class="nt-head"><h2>${esc(title)}</h2></div>` : ''}
      <div class="msg-body">${paragraphs}</div>
      <div class="msg-actions">${buttons.map((b, i) => `<button value="${i}" class="${b.primary ? `btn${b.danger ? ' danger' : ''}` : 'chip'}">${esc(b.label)}</button>`).join('')}</div>
    </form>`;
    dlg.addEventListener('close', () => {
      const i = Number(dlg.returnValue);
      resolve(Number.isInteger(i) && buttons[i] ? buttons[i].value : null);
    }, { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    (dlg.querySelector('.btn') || dlg.querySelector('button'))?.focus();
  });
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

/** Resolves to true when confirmed. */
export async function confirmDialog(message, { title, ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return (await showDialog({ title, message, buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: true, danger }] })) === true;
}

/** A message with an OK button. */
export async function alertDialog(message, { title } = {}) {
  await showDialog({ title, message, buttons: [{ label: 'OK', value: true, primary: true }] });
}
