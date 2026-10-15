// Small DOM helpers and the status message ("toast") shared by the app's modules.
const STATUS_MS = 4000;
const LONG_STATUS_MS = 10000; // errors, and messages offering Undo, stay longer

export const $ = id => document.getElementById(id);

// Every piece of user text goes through here as a property (textContent),
// never as markup.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

export function rejectField(input, message) {
  input.setCustomValidity(message);
  input.reportValidity();
}

const statusBox = $('status');
let statusTimer = 0;

// The message is a manual popover, so it sits in the top layer with the dialogs
// instead of behind an open one. Showing it again puts it above any dialog opened
// since. Browsers without popovers keep it in the page as before.
function raiseStatus() {
  if (!statusBox.showPopover) return;
  if (statusBox.matches(':popover-open')) statusBox.hidePopover();
  statusBox.showPopover();
}

// The live region stays open and is emptied, not hidden, so screen readers
// announce each message. Everything fades on its own; a tap is faster.
export function clearStatus() {
  clearTimeout(statusTimer);
  statusBox.textContent = '';
}

/** @param {(() => void) | null} [undo] adds an Undo button that runs it */
export function showStatus(message, isError = false, undo = null) {
  clearStatus();
  raiseStatus();
  statusBox.textContent = message;
  if (undo) statusBox.append(' ', el('button', { type: 'button', className: 'undo', textContent: 'Undo', onclick: undo }));
  statusBox.classList.toggle('error', isError);
  statusTimer = setTimeout(clearStatus, isError || undo ? LONG_STATUS_MS : STATUS_MS);
}

// A tap on the message closes it, except a tap on its Undo button, which shows its own result.
statusBox.addEventListener('click', event => {
  if (!event.target.closest('button')) clearStatus();
});
raiseStatus(); // open (and empty) from the start, so the first message is announced too
