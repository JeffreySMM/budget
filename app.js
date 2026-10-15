import {
  MAX_CATEGORY, MAX_NOTE, parseAmount, isValidMovement, normalizeCategory, shiftMonth,
  totalsByCategory, totalsByMonth, windowEnd, niceMax, isValidInitial,
  ACCOUNTS, DEFAULT_ACCOUNT, withDefaults, sumCents, isIncome, isExpense, balance,
  isValidBill, billStatus, isSameBillSlot,
  isValidLimit, limitStatus, findCategoryClash, uniqueIgnoringCase,
  cleanSnapshot, mergeSnapshots,
} from './logic.js';
import { startSheetSync, scheduleSheetSync } from './sheet.js';

const STORAGE_KEY = 'expenses'; // name predates income; holds every movement
const BILLS_KEY = 'bills';
const LIMITS_KEY = 'limits';
// Spending keeps the original key, so an amount saved before accounts existed still applies.
const initialKey = account => (account === DEFAULT_ACCOUNT ? 'initialCents' : `initialCents.${account}`);
const TREND_MONTHS = 12;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const STATUS_MS = 4000;
const ERROR_MS = 10000;
const REVOKE_URL_MS = 10000;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_CATEGORIES = {
  expense: ['Food', 'Groceries', 'Transport', 'Housing', 'Utilities', 'Health', 'Fun', 'Shopping', 'Other'],
  income: ['Salary', 'Bonus', 'Interest', 'Gift', 'Refund', 'Other'],
};

const $ = id => document.getElementById(id);
const form = $('expense-form');
const monthInput = $('month');
const statusBox = $('status');
const initialDialog = $('initial-dialog');
const initialInput = $('initial-form').elements.initial;
const billDialog = $('bill-dialog');
const billForm = $('bill-form');
const limitDialog = $('limit-dialog');
const limitForm = $('limit-form');

let selectedMonth = today().slice(0, 7);
let selectedAccount = DEFAULT_ACCOUNT;
let statusTimer = 0;

// Every piece of user text goes through here as a property (textContent),
// never as markup.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

function today() {
  const now = new Date();
  const pad = part => String(part).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// randomUUID needs HTTPS or localhost; the fallback keeps plain-HTTP LAN testing working.
const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const money = cents => (cents / 100).toLocaleString(undefined, {
  minimumFractionDigits: cents % 100 ? 2 : 0,
  maximumFractionDigits: 2,
});
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compact = cents => compactNumber.format(cents / 100);
// Date-only ISO strings parse as UTC, so format in UTC to stay on the same day.
const formatDate = (isoDate, options) =>
  new Date(isoDate).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
const longMonth = month => formatDate(`${month}-01`, { month: 'long', year: 'numeric' });
const shortMonth = month => formatDate(`${month}-01`, { month: 'short' });
const shortMonthYear = month => formatDate(`${month}-01`, { month: 'short', year: 'numeric' });

// The live region stays in the page and is emptied, not hidden, so screen
// readers announce each message. Everything fades on its own; a tap is faster.
function clearStatus() {
  clearTimeout(statusTimer);
  statusBox.textContent = '';
}

function showStatus(message, isError = false) {
  clearStatus();
  statusBox.textContent = message;
  statusBox.classList.toggle('error', isError);
  statusTimer = setTimeout(clearStatus, isError ? ERROR_MS : STATUS_MS);
}

// ponytail: localStorage, whole list re-read on every render and before every
// write (so two open tabs cannot overwrite each other). Good to roughly 5 MB,
// tens of thousands of movements; move to IndexedDB if it gets slow or full.
function readList(key, isValid, normalize) {
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed) && parsed.every(isValid)) return parsed.map(normalize);

  // Damaged data: park the original under its own key before anything can
  // overwrite it. If that fails, the throw stops the app with the data intact.
  const backupKey = `${key}.damaged.${Date.now()}`;
  localStorage.setItem(backupKey, raw);
  const salvaged = Array.isArray(parsed) ? parsed.filter(isValid).map(normalize) : [];
  localStorage.setItem(key, JSON.stringify(salvaged));
  // Blocking on purpose: too important to be a toast the next message replaces.
  alert(`Stored ${key} data was damaged. Kept ${salvaged.length} records; the original is saved in this browser as "${backupKey}".`);
  return salvaged;
}

const readStored = () => readList(STORAGE_KEY, isValidMovement, withDefaults);
const readBills = () => readList(BILLS_KEY, isValidBill, bill => bill);
const readLimits = () => readList(LIMITS_KEY, isValidLimit, limit => limit);

function writeItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    showStatus(`Could not save: ${error.message}`, true);
    return false;
  }
}

const writeStored = movements => writeItem(STORAGE_KEY, JSON.stringify(movements));
const writeBills = bills => writeItem(BILLS_KEY, JSON.stringify(bills));
const writeLimits = limits => writeItem(LIMITS_KEY, JSON.stringify(limits));

// The starting amount an account's expenses are subtracted from; null until the user sets one.
function readInitial(account) {
  const cents = Number(localStorage.getItem(initialKey(account)));
  return isValidInitial(cents) ? cents : null;
}

function writeInitial(account, cents) {
  if (cents === null) {
    localStorage.removeItem(initialKey(account));
    return true;
  }
  return writeItem(initialKey(account), String(cents));
}

// An empty field removes the initial amount.
function saveInitial(account, raw) {
  if (raw.trim() === '') return writeInitial(account, null);
  const cents = parseAmount(raw);
  if (cents === null) {
    showStatus('Enter an initial amount above zero.', true);
    return false;
  }
  return writeInitial(account, cents);
}

/** @returns {import('./logic.js').Snapshot} everything stored, as in a backup file */
const readSnapshot = () => ({
  initials: Object.fromEntries(Object.keys(ACCOUNTS).map(account => [account, readInitial(account)])),
  bills: readBills(),
  limits: readLimits(),
  expenses: readStored(),
});

// Replaces everything stored, all or nothing: if a write fails (storage full,
// already reported by writeItem), the earlier ones are undone, so a mix of old
// and new data is never left behind, or sent to the Sheet.
function writeSnapshot(snapshot) {
  const keys = [STORAGE_KEY, BILLS_KEY, LIMITS_KEY, ...Object.keys(ACCOUNTS).map(initialKey)];
  const previous = keys.map(key => [key, localStorage.getItem(key)]);
  const isWritten = writeStored(snapshot.expenses) && writeBills(snapshot.bills) && writeLimits(snapshot.limits)
    && Object.entries(snapshot.initials).every(([account, cents]) => writeInitial(account, cents));
  if (!isWritten) {
    previous.forEach(([key, value]) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
  }
  return isWritten;
}

// Balances count every movement of the account, whatever month is selected.
function balanceOf(account, movements) {
  const initial = readInitial(account);
  return { initial, ...balance(initial, movements.filter(m => m.account === account)) };
}

const leftText = left => (left < 0 ? `Over by ${money(-left)}` : `${money(left)} left`);
// U+2212 minus: reads as "minus" to screen readers, unlike a hyphen.
const signedMoney = movement => `${isIncome(movement) ? '+' : '−'}${money(movement.cents)}`;

const knownCategories = (movements, kind) => [...new Set([
  ...movements.filter(m => m.kind === kind).map(m => m.category),
  ...DEFAULT_CATEGORIES[kind],
])];

function renderHero(expenses, monthIncome) {
  $('hero-income').textContent = monthIncome > 0 ? `Income ${money(monthIncome)}` : '';
  const [previous, current] = totalsByMonth(expenses, selectedMonth, 2);
  const difference = current.cents - previous.cents;
  const direction = difference > 0 ? 'more than' : 'less than';
  $('hero-account').textContent = ACCOUNTS[selectedAccount];
  $('hero-month').textContent = longMonth(selectedMonth);
  $('hero-total').textContent = money(current.cents);
  $('hero-delta').textContent = previous.cents === 0 ? ''
    : difference === 0 ? `Same as ${shortMonth(previous.month)}`
    : `${money(Math.abs(difference))} ${direction} ${shortMonth(previous.month)}`;
}

// Each switch segment carries its account's balance, so both are visible at once.
function renderAccountNotes(movements) {
  Object.keys(ACCOUNTS).forEach(account => {
    const { available, left } = balanceOf(account, movements);
    $(`account-note-${account}`).textContent = available > 0 ? leftText(left) : 'No balance yet';
  });
}

// A balance needs money to measure against: an initial amount, income, or both.
function renderBalance(movements) {
  const { initial, income, spent, available, left } = balanceOf(selectedAccount, movements);
  const hasBalance = available > 0;
  $('balance-title').textContent = `${ACCOUNTS[selectedAccount]} balance`;
  $('balance-empty').hidden = hasBalance;
  $('balance-set').hidden = !hasBalance;
  $('edit-initial').textContent = initial === null ? 'Set initial amount' : 'Edit initial amount';
  if (!hasBalance) return;

  const fill = $('balance-fill');
  fill.style.width = `${Math.min(100, (spent / available) * 100)}%`;
  fill.classList.toggle('over', left < 0);
  $('balance-left').textContent = leftText(left);
  const sources = income > 0 ? ` (initial ${money(initial ?? 0)} + income ${money(income)})` : '';
  $('balance-detail').textContent = `${money(spent)} spent of ${money(available)}${sources}, all months`;
}

// Bills of the selected account, checked against the selected month.
function renderBills(movements) {
  const bills = readBills().filter(b => b.account === selectedAccount);
  const { rows, monthly, toPay } = billStatus(bills, movements, selectedMonth);
  const items = [...rows].sort((a, b) => b.bill.cents - a.bill.cents).map(({ bill, paidCents, isPaid }) => {
    const edit = el('button', { type: 'button', className: 'ghost', textContent: '✎', title: 'Edit bill', onclick: () => openBillDialog(bill) });
    edit.setAttribute('aria-label', `Edit ${bill.category} bill`);
    const paidText = paidCents === bill.cents ? '✓ Paid' : `✓ Paid ${money(paidCents)}`;
    const status = isPaid
      ? el('span', { className: 'status paid', textContent: paidText })
      : el('button', { type: 'button', className: 'status', textContent: 'Pay', onclick: () => payBill(bill) });
    if (!isPaid) status.setAttribute('aria-label', `Pay ${bill.category} ${money(bill.cents)}`);
    return el('li', {},
      el('span', { className: 'what', textContent: bill.category, title: bill.category }),
      el('span', { className: 'num', textContent: money(bill.cents) }),
      status,
      edit,
    );
  });
  $('bill-list').replaceChildren(...items);
  $('no-bills').hidden = items.length > 0;

  const month = shortMonth(selectedMonth);
  const due = toPay > 0 ? `${money(toPay)} still to pay in ${month}` : `all paid in ${month}`;
  $('bill-summary').textContent = items.length > 0 ? `${money(monthly)} a month · ${due}` : '';
  const { available, left } = balanceOf(selectedAccount, movements);
  $('bill-after').textContent = toPay > 0 && available > 0 ? `${leftText(left - toPay)} after paying them` : '';
}

// Limits of the selected account, measured against the selected month.
function renderLimits(movements) {
  const limits = readLimits().filter(l => l.account === selectedAccount);
  const { rows, total, spent, left } = limitStatus(limits, movements, selectedMonth);
  const items = rows.map(row => {
    const { limit } = row;
    const edit = el('button', { type: 'button', className: 'ghost', textContent: '✎', title: 'Edit limit', onclick: () => openLimitDialog(limit) });
    edit.setAttribute('aria-label', `Edit ${limit.name} limit`);
    const fill = el('div', { className: row.left < 0 ? 'over' : '' });
    fill.style.width = `${Math.min(100, (row.spent / limit.cents) * 100)}%`;
    const meter = el('div', { className: 'meter' }, fill);
    meter.setAttribute('aria-hidden', 'true'); // the text above and below carries the same numbers
    return el('li', {},
      el('div', { className: 'limit-head' },
        el('strong', { textContent: limit.name, title: limit.name }),
        el('span', { className: 'limit-left', textContent: leftText(row.left) }),
        edit,
      ),
      meter,
      el('p', { className: 'sub', textContent: `${money(row.spent)} of ${money(limit.cents)} spent · ${limit.categories.join(', ')}` }),
    );
  });
  $('limit-list').replaceChildren(...items);
  $('no-limits').hidden = items.length > 0;
  $('limit-summary').textContent = items.length > 1
    ? `All limits: ${money(spent)} of ${money(total)} spent in ${shortMonth(selectedMonth)} · ${leftText(left)}`
    : '';
}

function renderCategories(inMonth) {
  const totals = totalsByCategory(inMonth);
  const monthTotal = sumCents(inMonth);
  const largest = totals[0]?.cents ?? 0;
  const rows = totals.map(({ category, cents }) => {
    const bar = el('div', { className: 'bar' });
    bar.style.width = `${(cents / largest) * 100}%`;
    const barCell = el('td', { className: 'bar-cell' }, bar);
    barCell.setAttribute('aria-hidden', 'true');
    return el('tr', {},
      el('th', { scope: 'row', textContent: category, title: category }),
      barCell,
      el('td', { className: 'num', textContent: money(cents) }),
      el('td', { className: 'num share', textContent: `${Math.round((cents / monthTotal) * 100)}%` }),
    );
  });
  $('by-category').replaceChildren(...rows);
  $('no-categories').hidden = rows.length > 0;
}

function renderTrend(expenses) {
  const end = windowEnd(selectedMonth, today().slice(0, 7), TREND_MONTHS);
  const months = totalsByMonth(expenses, end, TREND_MONTHS);
  const peak = Math.max(...months.map(m => m.cents));
  const ceiling = niceMax(peak / 100) * 100;
  const hadFocus = $('trend-columns').contains(document.activeElement);

  const columns = months.map(({ month, cents }) => {
    const isSelected = month === selectedMonth;
    const bar = el('span', { className: 'bar' });
    bar.style.height = cents > 0 ? `max(2px, ${(cents / ceiling) * 100}%)` : '0';
    const column = el('button', { type: 'button', className: 'column', onclick: () => selectMonth(month) },
      el('span', { className: 'plot' }, bar),
      el('span', { className: 'tick', textContent: shortMonth(month) }),
    );
    column.setAttribute('aria-pressed', String(isSelected));
    column.setAttribute('aria-label', `${longMonth(month)}: ${money(cents)}`);
    column.dataset.tip = `${money(cents)} · ${shortMonthYear(month)}`;
    return column;
  });

  $('trend-range').textContent = `${shortMonthYear(months[0].month)} – ${shortMonthYear(end)}`;
  $('trend-axis').replaceChildren(...[ceiling, ceiling / 2, 0].map(tick => el('span', { textContent: compact(tick) })));
  $('trend-columns').replaceChildren(...columns);
  $('trend').hidden = peak === 0;
  $('no-trend').hidden = peak > 0;
  if (hadFocus) columns.find(c => c.getAttribute('aria-pressed') === 'true')?.focus();
}

function renderList(inMonth) {
  // Reverse first so same-day movements show newest first after the stable sort.
  const newestFirst = [...inMonth].reverse().sort((a, b) => b.date.localeCompare(a.date));
  const items = newestFirst.map(movement => {
    const amount = signedMoney(movement);
    const edit = el('button', { type: 'button', className: 'ghost', textContent: '✎', title: 'Edit or delete', onclick: () => startEdit(movement) });
    edit.setAttribute('aria-label', `Edit or delete ${movement.category} ${amount}`);
    return el('li', {},
      el('span', { className: 'day', textContent: formatDate(movement.date, { month: 'short', day: 'numeric' }) }),
      el('span', { className: 'what' },
        el('strong', { textContent: movement.category }),
        movement.note && el('span', { textContent: movement.note }),
      ),
      el('span', { className: isIncome(movement) ? 'num income' : 'num', textContent: amount }),
      edit,
    );
  });
  $('expense-list').replaceChildren(...items);
  $('no-expenses').hidden = items.length > 0;
}

// The account switch and the month scope everything except the balances.
// Charts and the month total are about spending, so they take expenses only;
// the list shows every movement and the balances add income back in.
function render() {
  const movements = readStored();
  const inAccount = movements.filter(m => m.account === selectedAccount);
  const expenses = inAccount.filter(isExpense);
  const inMonth = inAccount.filter(m => m.date.startsWith(selectedMonth));
  monthInput.value = selectedMonth;
  renderAccountNotes(movements);
  renderHero(expenses, sumCents(inMonth.filter(isIncome)));
  renderBalance(movements);
  renderBills(movements);
  renderLimits(movements);
  renderCategories(inMonth.filter(isExpense));
  renderTrend(expenses);
  renderList(inMonth);
  syncForm();
  scheduleSheetSync();
}

function selectMonth(month) {
  if (MONTH_PATTERN.test(month)) selectedMonth = month;
  render();
}

// Labels follow edit state and account; category suggestions follow the chosen type.
function syncForm() {
  const isEditing = 'editing' in form.dataset;
  $('form-title').textContent = isEditing ? 'Edit movement' : 'Add movement';
  $('save').textContent = isEditing ? 'Save' : `Add to ${ACCOUNTS[selectedAccount]}`;
  $('delete-editing').hidden = !isEditing;
  $('cancel-edit').hidden = !isEditing;
  const suggestions = knownCategories(readStored(), form.elements.kind.value);
  $('categories').replaceChildren(...suggestions.map(value => el('option', { value })));
}

function resetForm() {
  // Delete and Cancel vanish below; if one of them had focus, hand it to Save.
  // Focus outside the form (the account switch) is left alone.
  const shouldRefocus = 'editing' in form.dataset && form.contains(document.activeElement);
  form.reset();
  delete form.dataset.editing;
  form.elements.date.value = today();
  syncForm();
  if (shouldRefocus) $('save').focus();
}

function selectAccount(account) {
  selectedAccount = account;
  // An expense open for editing belongs to the account being left; a half-typed new one is kept.
  if ('editing' in form.dataset) resetForm();
  render();
}

function startEdit(movement) {
  form.dataset.editing = movement.id;
  form.elements.kind.value = movement.kind;
  form.elements.amount.value = String(movement.cents / 100);
  form.elements.category.value = movement.category;
  form.elements.date.value = movement.date;
  form.elements.note.value = movement.note;
  syncForm();
  form.scrollIntoView({ block: 'center' });
  form.elements.amount.focus();
}

// Pay fills the form instead of saving at once, so a bill that varies
// (electricity) can be corrected, and the date checked, before it is recorded.
function payBill(bill) {
  resetForm();
  form.elements.amount.value = String(bill.cents / 100);
  form.elements.category.value = bill.category;
  if (selectedMonth !== today().slice(0, 7)) form.elements.date.value = `${selectedMonth}-01`;
  form.scrollIntoView({ block: 'center' });
  $('save').focus();
}

function openBillDialog(bill = null) {
  billForm.reset();
  if (bill) billForm.dataset.editing = bill.id;
  else delete billForm.dataset.editing;
  billForm.elements.category.setCustomValidity('');
  billForm.elements.category.value = bill?.category ?? '';
  billForm.elements.amount.value = bill ? String(bill.cents / 100) : '';
  $('bill-title').textContent = bill ? 'Edit bill' : 'Add bill';
  $('delete-bill').hidden = !bill;
  const suggestions = knownCategories(readStored(), 'expense');
  $('bill-categories').replaceChildren(...suggestions.map(value => el('option', { value })));
  billDialog.showModal();
}

// Saving or deleting re-renders the list, removing the Edit button the dialog
// would hand focus back to; the card's Add button is always there.
function finishDialog(dialog, addButtonId) {
  dialog.close();
  render();
  $(addButtonId).focus();
}

const limitErrorFields = () => [limitForm.elements.name, limitForm.elements.extra];
// Any edit may fix the reported problem, so clear it and let Save check again.
const clearLimitErrors = () => limitErrorFields().forEach(input => input.setCustomValidity(''));

function rejectField(input, message) {
  input.setCustomValidity(message);
  input.reportValidity();
}

function openLimitDialog(limit = null) {
  limitForm.reset();
  clearLimitErrors();
  if (limit) limitForm.dataset.editing = limit.id;
  else delete limitForm.dataset.editing;
  limitForm.elements.name.value = limit?.name ?? '';
  limitForm.elements.amount.value = limit ? String(limit.cents / 100) : '';
  $('limit-title').textContent = limit ? 'Edit limit' : 'Add limit';
  $('delete-limit').hidden = !limit;

  // Categories held by other limits are shown but locked, so one expense never counts twice.
  const others = readLimits().filter(l => l.account === selectedAccount && l.id !== limit?.id);
  const holderOf = category => others.find(l => l.categories.some(c => c.toLowerCase() === category.toLowerCase()));
  const options = uniqueIgnoringCase([...(limit?.categories ?? []), ...knownCategories(readStored(), 'expense')]);
  $('limit-categories').replaceChildren(
    el('legend', { textContent: 'Categories it covers' }),
    ...options.map(category => {
      const holder = holderOf(category);
      const box = el('input', {
        type: 'checkbox', name: 'category', value: category,
        checked: limit?.categories.includes(category) ?? false, disabled: Boolean(holder),
      });
      return el('label', {}, box, holder ? `${category} · in ${holder.name}` : category);
    }),
  );
  limitDialog.showModal();
}

function removeMovement(movement) {
  if (!confirm(`Delete ${movement.category} ${signedMoney(movement)}?`)) return;
  if (!writeStored(readStored().filter(m => m.id !== movement.id))) return;
  if (form.dataset.editing === movement.id) resetForm();
  render();
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(form);
  const movements = readStored();
  const edited = movements.find(m => m.id === form.dataset.editing);
  const kind = String(data.get('kind'));
  const candidate = {
    id: form.dataset.editing || newId(),
    account: edited?.account ?? selectedAccount, // editing never moves a movement between accounts
    kind,
    date: String(data.get('date')),
    cents: parseAmount(data.get('amount')),
    category: normalizeCategory(data.get('category'), knownCategories(movements, kind)).slice(0, MAX_CATEGORY),
    note: String(data.get('note')).trim().slice(0, MAX_NOTE),
  };
  if (!isValidMovement(candidate)) {
    showStatus('Enter an amount above zero and a valid date.', true);
    return;
  }
  // A movement being edited may have been deleted in another tab: add it back.
  const isUpdate = movements.some(m => m.id === candidate.id);
  const next = isUpdate ? movements.map(m => (m.id === candidate.id ? candidate : m)) : [...movements, candidate];
  if (!writeStored(next)) return;
  navigator.storage?.persist?.(); // ask the browser not to evict the data
  selectedMonth = candidate.date.slice(0, 7);
  resetForm();
  render();
  showStatus(`Saved ${signedMoney(candidate)} · ${candidate.category}`);
});

form.addEventListener('change', event => {
  if (event.target.name === 'kind') syncForm();
});

$('cancel-edit').addEventListener('click', resetForm);
$('delete-editing').addEventListener('click', () => {
  const movement = readStored().find(m => m.id === form.dataset.editing);
  if (movement) removeMovement(movement);
  else resetForm(); // already deleted in another tab
});
$('prev-month').addEventListener('click', () => selectMonth(shiftMonth(selectedMonth, -1)));
$('next-month').addEventListener('click', () => selectMonth(shiftMonth(selectedMonth, 1)));
monthInput.addEventListener('change', () => selectMonth(monthInput.value));
statusBox.addEventListener('click', clearStatus);

// The dialog is modal, so the selected account cannot change while it is open.
$('edit-initial').addEventListener('click', () => {
  const initial = readInitial(selectedAccount);
  $('initial-title').textContent = `${ACCOUNTS[selectedAccount]} initial amount`;
  initialInput.value = initial === null ? '' : String(initial / 100);
  initialDialog.showModal();
});
$('cancel-initial').addEventListener('click', () => initialDialog.close());

$('add-bill').addEventListener('click', () => openBillDialog());
$('cancel-bill').addEventListener('click', () => billDialog.close());
billForm.elements.category.addEventListener('input', event => event.target.setCustomValidity(''));
billForm.addEventListener('submit', event => {
  event.preventDefault(); // closed by hand, so a taken category can keep it open
  const bills = readBills();
  const editingId = billForm.dataset.editing;
  const categoryInput = billForm.elements.category;
  const bill = {
    id: editingId || newId(),
    category: normalizeCategory(categoryInput.value, knownCategories(readStored(), 'expense')).slice(0, MAX_CATEGORY),
    cents: parseAmount(billForm.elements.amount.value),
    account: bills.find(b => b.id === editingId)?.account ?? selectedAccount,
  };
  if (bills.some(b => b.id !== bill.id && isSameBillSlot(b, bill))) {
    categoryInput.setCustomValidity(`There is already a ${bill.category} bill.`);
    categoryInput.reportValidity();
    return;
  }
  if (!isValidBill(bill)) {
    showStatus('Enter a category and an amount above zero.', true);
    return;
  }
  const exists = bills.some(b => b.id === bill.id);
  const next = exists ? bills.map(b => (b.id === bill.id ? bill : b)) : [...bills, bill];
  if (writeBills(next)) finishDialog(billDialog, 'add-bill');
});
$('delete-bill').addEventListener('click', () => {
  const bills = readBills();
  const bill = bills.find(b => b.id === billForm.dataset.editing);
  if (!bill) {
    finishDialog(billDialog, 'add-bill'); // already deleted in another tab
    return;
  }
  if (!confirm(`Delete the ${bill.category} bill? Payments already recorded stay.`)) return;
  if (writeBills(bills.filter(b => b.id !== bill.id))) finishDialog(billDialog, 'add-bill');
});

$('add-limit').addEventListener('click', () => openLimitDialog());
$('cancel-limit').addEventListener('click', () => limitDialog.close());
limitForm.addEventListener('input', clearLimitErrors);
limitForm.addEventListener('change', clearLimitErrors);
limitForm.addEventListener('submit', event => {
  event.preventDefault(); // closed by hand, so a problem can keep it open
  const limits = readLimits();
  const editingId = limitForm.dataset.editing;
  const { name: nameInput, amount: amountInput, extra: extraInput } = limitForm.elements;
  const picked = new FormData(limitForm).getAll('category').map(String);
  const typed = extraInput.value.split(',').map(category => category.trim()).filter(Boolean);
  const known = [...picked, ...knownCategories(readStored(), 'expense')];
  const limit = {
    id: editingId || newId(),
    name: nameInput.value.trim().slice(0, MAX_CATEGORY),
    cents: parseAmount(amountInput.value),
    // Trim again after cutting to length: a cut can end on a space, which isValidLimit rejects.
    categories: uniqueIgnoringCase([...picked, ...typed].map(c => normalizeCategory(c, known).slice(0, MAX_CATEGORY).trim())),
    account: limits.find(l => l.id === editingId)?.account ?? selectedAccount,
  };
  if (!limit.name) {
    rejectField(nameInput, 'Enter a name.');
    return;
  }
  if (limit.categories.length === 0) {
    rejectField(extraInput, 'Pick or type at least one category.');
    return;
  }
  const clash = findCategoryClash(limit, limits);
  if (clash) {
    rejectField(extraInput, `${clash.category} is already in ${clash.other.name}.`);
    return;
  }
  // Name, amount and empty categories are checked above or by the browser;
  // what is left is too many categories, so say so and keep what was typed.
  if (!isValidLimit(limit)) {
    rejectField(extraInput, 'Use at most 50 categories per limit.');
    return;
  }
  const exists = limits.some(l => l.id === limit.id);
  const next = exists ? limits.map(l => (l.id === limit.id ? limit : l)) : [...limits, limit];
  if (writeLimits(next)) finishDialog(limitDialog, 'add-limit');
});
$('delete-limit').addEventListener('click', () => {
  const limits = readLimits();
  const limit = limits.find(l => l.id === limitForm.dataset.editing);
  if (!limit) {
    finishDialog(limitDialog, 'add-limit'); // already deleted in another tab
    return;
  }
  if (!confirm(`Delete the ${limit.name} limit? Expenses stay as they are.`)) return;
  if (writeLimits(limits.filter(l => l.id !== limit.id))) finishDialog(limitDialog, 'add-limit');
});
// method="dialog" closes the dialog after this handler; Escape closes it without saving.
$('initial-form').addEventListener('submit', () => {
  if (saveInitial(selectedAccount, initialInput.value)) render();
});

// ponytail: plain anchor download. If an installed iOS app refuses it, switch
// to navigator.share({ files }).
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(readSnapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: `budget-${today()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_MS);
});

$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const [file] = event.target.files;
  event.target.value = ''; // so picking the same file again still fires change
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    showStatus('Import failed: file is larger than 5 MB.', true);
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    showStatus(`Import failed: ${error.message}`, true);
    return;
  }
  const cleaned = cleanSnapshot(parsed);
  if (!cleaned) {
    showStatus('Import failed: not a Budget backup file.', true);
    return;
  }
  // Same rule as syncing: what is already on this device wins.
  const local = readSnapshot();
  const merged = mergeSnapshots(local, cleaned.snapshot);
  const isSaved = writeSnapshot(merged);
  render();
  if (!isSaved) return; // writeItem already reported why
  const added = key => merged[key].length - local[key].length;
  const incoming = cleaned.snapshot.expenses.length + cleaned.snapshot.bills.length + cleaned.snapshot.limits.length;
  const skipped = incoming - added('expenses') - added('bills') - added('limits');
  showStatus(
    // Duplicates: same id, or a bill/limit category this device already has.
    `Imported ${added('expenses')} movements, ${added('bills')} bills and ${added('limits')} limits; skipped ${skipped} duplicates and ${cleaned.invalid} invalid.`,
    cleaned.invalid > 0,
  );
});


window.addEventListener('error', event => showStatus(`Something went wrong: ${event.message}`, true));
window.addEventListener('unhandledrejection', event => showStatus(`Something went wrong: ${event.reason?.message ?? event.reason}`, true));
window.addEventListener('storage', render); // another tab changed the data

// Registered before the first render so a storage failure cannot skip it.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch(error => showStatus(`Offline mode unavailable: ${error.message}`, true));
}

// Built once, never re-rendered: replacing a focused radio would drop keyboard focus.
$('accounts').append(...Object.entries(ACCOUNTS).map(([account, label]) => el('label', {},
  el('input', { type: 'radio', name: 'account', value: account, checked: account === selectedAccount }),
  el('span', { textContent: label }),
  el('small', { id: `account-note-${account}` }),
)));
$('accounts').addEventListener('change', event => selectAccount(event.target.value));

resetForm();
render();
startSheetSync({ readSnapshot, writeSnapshot, render, showStatus, rejectField, writeItem });
