// Category suggestions, icons and the Categories dialog. A category is plain text on
// each entry; this module only decides which names are offered (the ones already
// used, the ones the user added, and a starter set) and which icon each one shows.
import { cleanCategories, isCustomCategoryName, uniqueIgnoringCase, categoriesByUse, MAX_CUSTOM_CATEGORIES } from './logic.js';
import { el } from './ui.js';
import { ICON_CHOICES, isIconKey, emojiOfIcon, pixelKeyForName, emojiForName, pixelIcon } from './icons.js';

export const CATEGORIES_KEY = 'categories';
const DEFAULT_CATEGORIES = {
  expense: ['Food', 'Groceries', 'Transport', 'Housing', 'Utilities', 'Health', 'Fun', 'Shopping', 'Other'],
  income: ['Salary', 'Bonus', 'Interest', 'Gift', 'Refund', 'Other'],
};
const NONE_ADDED = { expense: [], income: [], icons: {} };

const $ = id => document.getElementById(id);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const isPixelLook = () => document.documentElement.dataset.look !== 'modern';

// What this module needs from the app, handed over by startCategoryManager.
let app = null;

/**
 * @returns {{ expense: string[], income: string[], icons: Record<string, string> }} the
 *   categories the user added, and the icons chosen for categories (by lowercase name)
 */
export function readCategories() {
  try {
    return cleanCategories(JSON.parse(localStorage.getItem(CATEGORIES_KEY))) ?? NONE_ADDED;
  } catch {
    // ponytail: unreadable list treated as empty; it only holds suggestion names, and
    // entries keep their categories. Quarantine it like the other data if that changes.
    return NONE_ADDED;
  }
}

// --- Icons ----------------------------------------------------------------------
// A category shows the icon chosen for it in the Categories window, else one its name
// suggests, else its first letter. The retro looks draw pixel art, never emoji.

const iconKey = name => name.trim().toLowerCase();
const chosenIcon = name => {
  const key = readCategories().icons[iconKey(name)];
  return isIconKey(key) ? key : null;
};

/** @returns {string | null} the emoji for a category, for the modern look and plain text */
export function categoryEmoji(name) {
  const key = chosenIcon(name);
  return key ? emojiOfIcon(key) : emojiForName(name);
}

/** @returns {HTMLSpanElement} the icon shown next to a category */
export function iconFor(name) {
  const pixel = isPixelLook() ? pixelIcon(chosenIcon(name) ?? pixelKeyForName(name)) : null;
  const emoji = isPixelLook() ? null : categoryEmoji(name);
  const icon = pixel
    ? el('span', { className: 'icon pixel' }, pixel)
    : el('span', { className: emoji ? 'icon' : 'icon letter', textContent: emoji ?? name.trim().charAt(0).toUpperCase() });
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

let iconTarget = ''; // the category the icon window is open for

function openIconDialog(name) {
  iconTarget = name;
  const chosen = chosenIcon(name);
  $('icon-title').textContent = `Icon for ${name}`;
  $('icon-grid').replaceChildren(...ICON_CHOICES.map(({ key, label, emoji }) => {
    const button = el('button', { type: 'button', className: 'icon-choice', title: label, onclick: () => chooseIcon(key) },
      isPixelLook() ? pixelIcon(key) : emoji);
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(key === chosen));
    return button;
  }));
  $('icon-dialog').showModal();
}

// null goes back to the icon the name suggests (or the letter).
function chooseIcon(key) {
  const added = readCategories();
  const name = iconKey(iconTarget);
  const others = Object.entries(added.icons).filter(([other]) => other !== name);
  const icons = Object.fromEntries(key ? [...others, [name, key]] : others);
  if (!app.writeItem(CATEGORIES_KEY, JSON.stringify({ ...added, icons }))) return;
  $('icon-dialog').close();
  renderList();
  // The list was redrawn, so put focus back on the category just changed.
  [...$('category-list').querySelectorAll('.pick-icon')].find(button => button.dataset.name === iconTarget)?.focus();
}

// Most used first, then `extra` (names the caller knows from elsewhere), then the ones
// the user added, then the starter set. Transfers have no categories: they get none.
export const knownCategories = (movements, kind, extra = []) => uniqueIgnoringCase([
  ...categoriesByUse(movements, kind),
  ...extra,
  ...(readCategories()[kind] ?? []),
  ...(DEFAULT_CATEGORIES[kind] ?? []),
]);

const form = () => $('categories-form');
const selectedKind = () => form().elements.kind.value;

function renderList() {
  const kind = selectedKind();
  const added = readCategories()[kind];
  const movements = app.readStored();
  const isUsed = name => movements.some(m => m.kind === kind && sameName(m.category, name));
  const names = knownCategories(movements, kind).sort((a, b) => a.localeCompare(b));
  $('category-list').replaceChildren(...names.map(name => {
    // Only a category this user added, and no entry uses, can be removed: the others
    // would keep coming back from the starter set or from the entries.
    const isRemovable = added.some(c => sameName(c, name)) && !isUsed(name);
    const pick = el('button', { type: 'button', className: 'pick-icon ghost', onclick: () => openIconDialog(name) },
      iconFor(name), name);
    pick.dataset.name = name;
    pick.setAttribute('aria-label', `${name}, choose icon`);
    if (!isRemovable) return el('li', {}, pick);
    const removeButton = el('button', {
      type: 'button', textContent: '×', title: `Remove ${name}`, onclick: () => removeCategory(kind, name),
    });
    removeButton.setAttribute('aria-label', `Remove ${name}`);
    return el('li', { className: 'removable' }, pick, removeButton);
  }));
}

function problemWith(name, kind, added) {
  if (!name) return 'Type a name for the new category.';
  if (!isCustomCategoryName(name)) return 'Use up to 40 characters, without |.';
  const existing = knownCategories(app.readStored(), kind).find(c => sameName(c, name));
  if (existing) return `${existing} is already in the list.`;
  if (added[kind].length >= MAX_CUSTOM_CATEGORIES) return `You can add up to ${MAX_CUSTOM_CATEGORIES} categories of each type.`;
  return '';
}

function addCategory(event) {
  event.preventDefault(); // stays open, so several can be added in a row
  const input = form().elements.name;
  const kind = selectedKind();
  const name = input.value.trim();
  const added = readCategories();
  const problem = problemWith(name, kind, added);
  if (problem) {
    app.rejectField(input, problem);
    return;
  }
  if (!app.writeItem(CATEGORIES_KEY, JSON.stringify({ ...added, [kind]: [...added[kind], name] }))) return;
  input.value = '';
  renderList();
  input.focus();
}

function removeCategory(kind, name) {
  const added = readCategories();
  const next = { ...added, [kind]: added[kind].filter(c => !sameName(c, name)) };
  if (app.writeItem(CATEGORIES_KEY, JSON.stringify(next))) renderList();
  form().elements.name.focus(); // the removed chip took its button, and focus, with it
}

/**
 * Wires the Categories dialog.
 * @param {{ readStored: Function, writeItem: Function, render: Function, rejectField: Function,
 *   el: Function, formKind: () => string }} appParts formKind: the type chosen in the movement form
 */
export function startCategoryManager(appParts) {
  app = appParts;
  const dialog = $('categories-dialog');
  $('open-categories').addEventListener('click', () => {
    form().reset();
    form().elements.name.setCustomValidity('');
    form().elements.kind.value = app.formKind();
    renderList();
    dialog.showModal();
  });
  form().addEventListener('submit', addCategory);
  form().addEventListener('input', () => form().elements.name.setCustomValidity(''));
  form().addEventListener('change', event => {
    if (event.target.name === 'kind') renderList();
  });
  $('close-categories').addEventListener('click', () => dialog.close());
  $('icon-default').addEventListener('click', () => chooseIcon(null));
  $('cancel-icon').addEventListener('click', () => $('icon-dialog').close());
  // New categories appear in every suggestion list, and go to the Google Sheet.
  dialog.addEventListener('close', () => app.render());
}

// --- Category lists -------------------------------------------------------------
// The phone's own picker opens when the field is tapped: every known category, then
// "New category…", which shows a box to type a name that is not in the list yet.

export const isNewCategoryChosen = select => select.selectedOptions[0]?.dataset.isNew === 'true';

// Redrawn on every render, so it keeps whatever is chosen at the time.
export function fillCategorySelect(select, names) {
  const keepNew = isNewCategoryChosen(select);
  const current = keepNew ? '' : select.value;
  const placeholder = el('option', { value: '', textContent: 'Choose…', disabled: true, defaultSelected: true });
  const newOption = el('option', { value: 'new-category', textContent: 'New category…' });
  newOption.dataset.isNew = 'true';
  const optionFor = name => el('option', { value: name, textContent: `${categoryEmoji(name) ?? '•'}  ${name}` });
  select.replaceChildren(placeholder, ...names.map(optionFor), newOption);
  if (keepNew) newOption.selected = true;
  else chooseCategory(select, current);
}

// Selects `name`, adding it first if the list lacks it; an empty name leaves nothing chosen.
export function chooseCategory(select, name) {
  if (!name) {
    select.selectedIndex = 0;
    return;
  }
  const match = [...select.options].find(option =>
    option.dataset.isNew !== 'true' && option.value.toLowerCase() === name.toLowerCase());
  const option = match ?? select.insertBefore(el('option', { value: name, textContent: name }), select.options[1] ?? null);
  option.selected = true;
}

export function syncNewCategoryField(select, field, input, isShown = true) {
  const isNew = isShown && isNewCategoryChosen(select);
  field.hidden = !isNew;
  input.required = isNew;
}

// The category chosen in the list, or the new name typed under it.
export const chosenCategory = (select, newInput) => (isNewCategoryChosen(select) ? newInput.value : select.value);
