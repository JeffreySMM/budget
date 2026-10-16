// Category suggestions and the Categories dialog. A category is plain text on each
// entry; this module only decides which names are offered: the ones already used,
// the ones the user added, and a starter set.
import { cleanCategories, isCustomCategoryName, uniqueIgnoringCase, categoriesByUse, MAX_CUSTOM_CATEGORIES } from './logic.js';

export const CATEGORIES_KEY = 'categories';
const DEFAULT_CATEGORIES = {
  expense: ['Food', 'Groceries', 'Transport', 'Housing', 'Utilities', 'Health', 'Fun', 'Shopping', 'Other'],
  income: ['Salary', 'Bonus', 'Interest', 'Gift', 'Refund', 'Other'],
};
const NONE_ADDED = { expense: [], income: [] };

// Icons for common category names, matched ignoring letter case. Others get their
// first letter in a circle (see iconFor in app.js).
const CATEGORY_ICONS = {
  food: '🍽️', groceries: '🛒', supermarket: '🛒', restaurants: '🍜', restaurant: '🍜', 'eating out': '🍜',
  coffee: '☕', drinks: '🍹', snacks: '🍿',
  transport: '🚌', taxi: '🚕', fuel: '⛽', gas: '⛽', parking: '🅿️', car: '🚗', travel: '✈️',
  housing: '🏠', rent: '🏠', utilities: '💡', electricity: '⚡', water: '💧', internet: '🌐', phone: '📱',
  health: '🩺', medical: '🩺', pharmacy: '💊', gym: '🏋️', sports: '⚽', insurance: '🛡️',
  fun: '🎉', entertainment: '🎬', hobbies: '🎨', books: '📚', education: '🎓', subscriptions: '🔁',
  shopping: '🛍️', clothes: '👕', gifts: '🎁', pets: '🐾', kids: '🧸', other: '📦',
  salary: '💼', bonus: '🎁', interest: '🏦', gift: '🎁', refund: '↩️', transfer: '⇄',
};

/** @returns {string | null} an emoji for a common category name */
export const categoryIcon = name => CATEGORY_ICONS[name.trim().toLowerCase()] ?? null;

const $ = id => document.getElementById(id);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// What this module needs from the app, handed over by startCategoryManager.
let app = null;

/** @returns {{ expense: string[], income: string[] }} the categories the user added */
export function readCategories() {
  try {
    return cleanCategories(JSON.parse(localStorage.getItem(CATEGORIES_KEY))) ?? NONE_ADDED;
  } catch {
    // ponytail: unreadable list treated as empty; it only holds suggestion names, and
    // entries keep their categories. Quarantine it like the other data if that changes.
    return NONE_ADDED;
  }
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
    const label = `${categoryIcon(name) ?? '•'} ${name}`;
    if (!isRemovable) return app.el('li', { textContent: label });
    const removeButton = app.el('button', {
      type: 'button', textContent: '×', title: `Remove ${name}`, onclick: () => removeCategory(kind, name),
    });
    removeButton.setAttribute('aria-label', `Remove ${name}`);
    return app.el('li', { className: 'removable' }, label, removeButton);
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
  // New categories appear in every suggestion list, and go to the Google Sheet.
  dialog.addEventListener('close', () => app.render());
}
