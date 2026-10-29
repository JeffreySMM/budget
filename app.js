import {
  MAX_CATEGORY, MAX_NOTE, parseAmount, isValidMovement, normalizeCategory, shiftMonth,
  totalsByCategory, totalsByMonth, windowEnd, niceMax,
  ACCOUNTS, DEFAULT_ACCOUNT, sumCents, isIncome, isExpense, isTransfer, balance,
  isValidBill, billStatus, isSameBillSlot,
  isValidLimit, limitStatus, findCategoryClash, uniqueIgnoringCase, correctionTo,
} from './logic.js';
import { $, el, showStatus, rejectField } from './ui.js';
import {
  readStored, readBills, readLimits, writeItem, writeStored, writeBills, writeLimits,
  readInitial, saveInitial, readSnapshot, writeSnapshot,
} from './store.js';
import { startSheetSync, scheduleSheetSync } from './sheet.js';
import {
  knownCategories, categoryIcon, startCategoryManager,
  fillCategorySelect, chooseCategory, syncNewCategoryField, chosenCategory, isNewCategoryChosen,
} from './categories.js';
import { categorySlots, donutSvg } from './donut.js';
import { pixelIcon } from './pixel-icons.js';
import { startBackup } from './backup.js';

const TREND_MONTHS = 12;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const TRANSFER_CATEGORY = 'Transfer';
const ADJUSTMENT_CATEGORY = 'Adjustment';
const LIMIT_WARN_SHARE = 0.8; // a limit turns amber once this much of it is spent

const form = $('expense-form');
const movementDialog = $('movement-dialog');
const monthInput = $('month');
const initialDialog = $('initial-dialog');
const initialInput = $('initial-form').elements.initial;
const correctDialog = $('correct-dialog');
const correctInput = $('correct-form').elements.amount;
const billDialog = $('bill-dialog');
const billForm = $('bill-form');
const limitDialog = $('limit-dialog');
const limitForm = $('limit-form');

let selectedMonth = today().slice(0, 7);
let selectedAccount = DEFAULT_ACCOUNT;

function today() {
  const now = new Date();
  const pad = part => String(part).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// randomUUID needs HTTPS or localhost; the fallback keeps plain-HTTP LAN testing working.
const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const CURRENCY = 'NT$'; // New Taiwan dollar, written the way it is in Taiwan
const money = cents => `${CURRENCY}${(cents / 100).toLocaleString(undefined, {
  minimumFractionDigits: cents % 100 ? 2 : 0,
  maximumFractionDigits: 2,
})}`;
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compact = cents => compactNumber.format(cents / 100);
// Date-only ISO strings parse as UTC, so format in UTC to stay on the same day.
const formatDate = (isoDate, options) =>
  new Date(isoDate).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
const longMonth = month => formatDate(`${month}-01`, { month: 'long', year: 'numeric' });
const shortMonth = month => formatDate(`${month}-01`, { month: 'short' });
const shortMonthYear = month => formatDate(`${month}-01`, { month: 'short', year: 'numeric' });

// Balances count every movement of the account, whatever month is selected.
function balanceOf(account, movements) {
  const initial = readInitial(account);
  return { initial, ...balance(initial, movements, account) };
}

const leftText = left => (left < 0 ? `Over by ${money(-left)}` : `${money(left)} left`);
const otherAccount = account => Object.keys(ACCOUNTS).find(other => other !== account);

// Seen from `account`: a transfer is money out of one account and into the other.
// U+2212 minus: reads as "minus" to screen readers, unlike a hyphen.
function signedMoney(movement, account = movement.account) {
  const isMoneyIn = isIncome(movement) || (isTransfer(movement) && movement.toAccount === account);
  return `${isMoneyIn ? '+' : '−'}${money(movement.cents)}`;
}

// What a movement is called in lists and messages: a transfer says where the money went.
function titleOf(movement, account = movement.account) {
  if (!isTransfer(movement)) return movement.category;
  return movement.toAccount === account ? `From ${ACCOUNTS[movement.account]}` : `To ${ACCOUNTS[movement.toAccount]}`;
}

function amountClassOf(movement) {
  if (isTransfer(movement)) return 'num transfer';
  return isIncome(movement) ? 'num income' : 'num';
}

// Compared with the month before, e.g. "4,640 more than Sep"; empty when there is nothing to compare.
function monthDelta(previous, current) {
  if (previous.cents === 0) return '';
  const difference = current.cents - previous.cents;
  if (difference === 0) return `same as ${shortMonth(previous.month)}`;
  return `${money(Math.abs(difference))} ${difference > 0 ? 'more' : 'less'} than ${shortMonth(previous.month)}`;
}

// Each switch segment carries its account's balance, so both are visible at once.
function renderAccountNotes(movements) {
  Object.keys(ACCOUNTS).forEach(account => {
    const { hasBalance, left } = balanceOf(account, movements);
    $(`account-note-${account}`).textContent = hasBalance ? leftText(left) : 'No balance yet';
  });
}

// Where the money came from, once there is more than an initial amount.
function balanceSources(initial, income, movedIn, movedOut) {
  if (income + movedIn + movedOut === 0) return '';
  const parts = [`initial ${money(initial ?? 0)}`];
  if (income > 0) parts.push(`+ income ${money(income)}`);
  if (movedIn > 0) parts.push(`+ moved in ${money(movedIn)}`);
  if (movedOut > 0) parts.push(`− moved out ${money(movedOut)}`);
  return ` (${parts.join(' ')})`;
}

// The summary card: what is left is the big number, with this month's spending and
// income under it. Without a balance (nothing to measure against yet: no initial
// amount, income or transfers) the month's spending is the big number instead.
function renderSummary(movements, expenses, monthIncome) {
  const { initial, income, spent, movedIn, movedOut, available, left, hasBalance } = balanceOf(selectedAccount, movements);
  const [previous, current] = totalsByMonth(expenses, selectedMonth, 2);
  const month = longMonth(selectedMonth);
  const delta = monthDelta(previous, current);
  const isNothingYet = !hasBalance && current.cents === 0;
  $('summary-label').textContent = `${ACCOUNTS[selectedAccount]} · ${hasBalance ? 'left to spend' : `spent in ${month}`}`;
  $('summary-value').textContent = hasBalance ? leftText(left) : (isNothingYet ? 'Nothing yet' : money(current.cents));
  $('summary-value').classList.toggle('is-empty', isNothingYet);
  $('summary-value').classList.toggle('is-over', hasBalance && left < 0);
  const spentLine = hasBalance ? `Spent in ${shortMonth(selectedMonth)}: ${money(current.cents)}` : '';
  $('month-spent').textContent = [spentLine, delta].filter(Boolean).join(' · ');
  $('hero-income').textContent = monthIncome > 0 ? `Income in ${shortMonth(selectedMonth)}: ${money(monthIncome)}` : '';
  $('balance-empty').hidden = hasBalance;
  $('balance-set').hidden = !hasBalance;
  $('edit-initial').textContent = initial === null ? 'Set initial amount' : 'Edit initial amount';
  $('correct-balance').hidden = !hasBalance;
  $('balance-detail').textContent = ''; // emptied lines take no room
  if (!hasBalance) return;

  const fill = $('balance-fill');
  fill.style.width = `${available > 0 ? Math.min(100, (spent / available) * 100) : 100}%`;
  fill.classList.toggle('over', left < 0);
  $('balance-detail').textContent =
    `${money(spent)} spent of ${money(available)}${balanceSources(initial, income, movedIn, movedOut)}, all months`;
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
      el('span', { className: 'what', title: bill.category }, iconFor(bill.category), bill.category),
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
  const { hasBalance, left } = balanceOf(selectedAccount, movements);
  $('bill-after').textContent = toPay > 0 && hasBalance ? `${leftText(left - toPay)} after paying them` : '';
}

// Limits of the selected account, measured against the selected month.
function renderLimits(movements) {
  const limits = readLimits().filter(l => l.account === selectedAccount);
  const { rows, total, spent, left } = limitStatus(limits, movements, selectedMonth);
  const items = rows.map(row => {
    const { limit } = row;
    const edit = el('button', { type: 'button', className: 'ghost', textContent: '✎', title: 'Edit limit', onclick: () => openLimitDialog(limit) });
    edit.setAttribute('aria-label', `Edit ${limit.name} limit`);
    // Amber from 80% used, red when over; the text says the same ("Only … left", "Over by …").
    const isNearly = row.left >= 0 && row.spent >= limit.cents * LIMIT_WARN_SHARE;
    const fill = el('div', { className: row.left < 0 ? 'over' : (isNearly ? 'warn' : '') });
    fill.style.width = `${Math.min(100, (row.spent / limit.cents) * 100)}%`;
    const meter = el('div', { className: 'meter' }, fill);
    meter.setAttribute('aria-hidden', 'true'); // the text above and below carries the same numbers
    return el('li', {},
      el('div', { className: 'limit-head' },
        el('strong', { textContent: limit.name, title: limit.name }),
        el('span', { className: 'limit-left', textContent: isNearly ? `Only ${money(row.left)} left` : leftText(row.left) }),
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

// Ring for the month at a glance; the list under it names every category with its amount.
function renderCategories(inMonth, expenses) {
  const totals = totalsByCategory(inMonth);
  const monthTotal = sumCents(inMonth);
  const slots = categorySlots(expenses);
  const colourOf = category => (slots.has(category) ? `s${slots.get(category)}` : 'other');
  const coloured = totals.filter(t => slots.has(t.category)).sort((a, b) => slots.get(a.category) - slots.get(b.category));
  const otherCents = sumCents(totals.filter(t => !slots.has(t.category)));
  const slices = [
    ...coloured.map(({ category, cents }) => ({ cents, colour: colourOf(category) })),
    ...(otherCents > 0 ? [{ cents: otherCents, colour: 'other' }] : []),
  ];
  $('donut').replaceChildren(...(monthTotal > 0 ? [donutSvg(slices, monthTotal)] : []));
  $('donut-total').textContent = money(monthTotal);
  const rows = totals.map(({ category, cents }) => {
    const swatch = el('span', { className: `swatch ${colourOf(category)}` });
    swatch.setAttribute('aria-hidden', 'true');
    return el('tr', {},
      el('th', { scope: 'row', title: category }, swatch, iconFor(category), category),
      el('td', { className: 'num', textContent: money(cents) }),
      el('td', { className: 'num share', textContent: `${Math.round((cents / monthTotal) * 100)}%` }),
    );
  });
  $('by-category').replaceChildren(...rows);
  $('donut-wrap').hidden = rows.length === 0;
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

// Each row is one button: tapping anywhere on it opens the movement for editing.
// "Today", "Yesterday", or a weekday and date: the heading over each day's movements.
function dayHeading(isoDate) {
  const todayIso = today();
  if (isoDate === todayIso) return 'Today';
  const yesterday = new Date(`${todayIso}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (isoDate === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  return formatDate(isoDate, { weekday: 'short', month: 'short', day: 'numeric' });
}

// A small round badge: the category's emoji, or its first letter.
function iconFor(name) {
  const isRetro = document.documentElement.dataset.look === 'retro';
  const pixel = isRetro ? pixelIcon(name) : null;
  const emoji = isRetro ? null : categoryIcon(name); // retro: pixel art or the letter, never emoji
  const letter = name.trim().charAt(0).toUpperCase();
  const icon = pixel
    ? el('span', { className: 'icon pixel' }, pixel)
    : el('span', { className: emoji ? 'icon' : 'icon letter', textContent: emoji ?? letter });
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function movementRow(movement) {
  const title = titleOf(movement, selectedAccount);
  const amount = signedMoney(movement, selectedAccount);
  const day = formatDate(movement.date, { month: 'short', day: 'numeric' });
  const row = el('button', { type: 'button', className: 'row', onclick: () => startEdit(movement) },
    iconFor(isTransfer(movement) ? TRANSFER_CATEGORY : movement.category),
    el('span', { className: 'what' },
      el('strong', { textContent: title }),
      movement.note && el('span', { textContent: movement.note }),
    ),
    el('span', { className: amountClassOf(movement), textContent: amount }),
  );
  row.setAttribute('aria-label', `${title} ${amount}, ${day}. Edit`);
  return el('li', {}, row);
}

// Grouped by day, newest first, like a bank statement; tapping a row opens it for editing.
function renderList(inMonth) {
  // Reverse first so same-day movements show newest first after the stable sort.
  const newestFirst = [...inMonth].reverse().sort((a, b) => b.date.localeCompare(a.date));
  const days = [...new Set(newestFirst.map(m => m.date))];
  const groups = days.map(date => el('li', { className: 'day-group' },
    el('h3', { className: 'day-heading', textContent: dayHeading(date) }),
    el('ul', {}, ...newestFirst.filter(m => m.date === date).map(movementRow)),
  ));
  $('expense-list').replaceChildren(...groups);
  $('no-expenses').hidden = groups.length > 0;
}

// The account switch and the month scope everything except the balances. A transfer
// shows in the lists of both accounts it touches; charts and the month total count
// expenses only, and the balances add income and transfers in.
function render() {
  const movements = readStored();
  const inAccount = movements.filter(m => m.account === selectedAccount || m.toAccount === selectedAccount);
  const expenses = inAccount.filter(isExpense);
  const inMonth = inAccount.filter(m => m.date.startsWith(selectedMonth));
  monthInput.value = selectedMonth;
  renderAccountNotes(movements);
  renderSummary(movements, expenses, sumCents(inMonth.filter(isIncome)));
  renderBills(movements);
  renderLimits(movements);
  renderCategories(inMonth.filter(isExpense), expenses);
  renderTrend(expenses);
  renderList(inMonth);
  syncForm();
  scheduleSheetSync();
}

function selectMonth(month) {
  if (MONTH_PATTERN.test(month)) selectedMonth = month;
  render();
}

function selectAccount(account) {
  selectedAccount = account; // the movement window is modal, so nothing is open for editing here
  render();
}

// --- Movement window ----------------------------------------------------------

const editedMovement = () => readStored().find(m => m.id === form.dataset.editing);

// Labels follow the edit state, the account and the chosen type.
function syncForm() {
  const isEditing = 'editing' in form.dataset;
  const kind = form.elements.kind.value;
  const isTransferKind = kind === 'transfer';
  const edited = isEditing ? editedMovement() : undefined;
  const from = isTransferKind ? form.elements.fromAccount.value : edited?.account ?? selectedAccount;
  const to = otherAccount(from);
  let saveLabel = `Add to ${ACCOUNTS[from]}`;
  if (isTransferKind) saveLabel = `Move to ${ACCOUNTS[to]}`;
  if (isEditing) saveLabel = 'Save';
  $('form-title').textContent = isEditing ? 'Edit movement' : 'Add movement';
  $('save').textContent = saveLabel;
  $('delete-editing').hidden = !isEditing;
  $('category-field').hidden = isTransferKind;
  form.elements.category.required = !isTransferKind;
  $('transfer-from').hidden = !isTransferKind;
  $('transfer-hint').hidden = !isTransferKind;
  $('transfer-hint').textContent = `Moves money from ${ACCOUNTS[from]} to ${ACCOUNTS[to]}.`;
  if (!isTransferKind) fillCategorySelect(form.elements.category, categoryNames(readStored(), kind));
  syncNewCategoryField(form.elements.category, $('new-category-field'), form.elements.newCategory, !isTransferKind);
}


// Bills and limits name expense categories too, often before any expense uses them.
const categoryNames = (movements, kind) => knownCategories(movements, kind, kind === 'expense'
  ? [...readBills().map(bill => bill.category), ...readLimits().flatMap(limit => limit.categories)]
  : []);


function resetForm() {
  form.reset();
  delete form.dataset.editing;
  form.elements.date.value = today();
  syncForm();
}

function openMovementDialog() {
  if ('editing' in form.dataset) resetForm(); // a half-typed new movement is kept as a draft; an edit is not
  form.elements.fromAccount.value = selectedAccount; // a transfer starts out from the account on screen
  syncForm();
  movementDialog.showModal();
  form.elements.amount.focus();
}

function startEdit(movement) {
  form.reset();
  form.dataset.editing = movement.id;
  form.elements.kind.value = movement.kind;
  form.elements.fromAccount.value = movement.account;
  form.elements.amount.value = String(movement.cents / 100);
  form.elements.date.value = movement.date;
  form.elements.note.value = movement.note;
  syncForm(); // builds the category list for the movement's kind
  chooseCategory(form.elements.category, isTransfer(movement) ? '' : movement.category);
  movementDialog.showModal(); // no field focused: on a phone the keyboard stays down until needed
}

// Undo puts back only what the action changed, so anything changed since
// (another tab, a sync) is kept.
function undoWith(change) {
  if (!writeStored(change(readStored()))) return;
  render();
  showStatus('Undone');
  // The Undo button just went away with its message; keep keyboard focus near it.
  if (document.activeElement === document.body) $('open-add').focus();
}

const undoAdd = id => () => undoWith(list => list.filter(m => m.id !== id));
const undoEdit = previous => () => undoWith(list => list.map(m => (m.id === previous.id ? previous : m)));
const undoDelete = movement => () => undoWith(list => (list.some(m => m.id === movement.id) ? list : [...list, movement]));

function saveMovement(event) {
  event.preventDefault();
  const data = new FormData(form);
  const movements = readStored();
  const edited = movements.find(m => m.id === form.dataset.editing);
  const kind = String(data.get('kind'));
  // A transfer goes the way chosen in the form; editing never moves anything else between accounts.
  const account = kind === 'transfer' ? String(data.get('fromAccount')) : edited?.account ?? selectedAccount;
  const candidate = {
    id: edited?.id ?? newId(),
    account,
    kind,
    ...(kind === 'transfer' ? { toAccount: otherAccount(account) } : {}),
    date: String(data.get('date')),
    cents: parseAmount(data.get('amount')),
    category: kind === 'transfer'
      ? TRANSFER_CATEGORY
      : normalizeCategory(chosenCategory(form.elements.category, form.elements.newCategory),
        categoryNames(movements, kind)).slice(0, MAX_CATEGORY),
    note: String(data.get('note')).trim().slice(0, MAX_NOTE),
  };
  if (!isValidMovement(candidate)) {
    showStatus('Enter an amount above zero and a valid date.', true);
    return;
  }
  // A movement being edited may have been deleted in another tab: add it back.
  const next = edited ? movements.map(m => (m.id === candidate.id ? candidate : m)) : [...movements, candidate];
  if (!writeStored(next)) return;
  navigator.storage?.persist?.(); // ask the browser not to evict the data
  selectedMonth = candidate.date.slice(0, 7);
  resetForm();
  movementDialog.close();
  render();
  // Worded from the account on screen, like the list (a transfer reads "From Spending" in Savings).
  showStatus(`Saved ${titleOf(candidate, selectedAccount)} ${signedMoney(candidate, selectedAccount)}`, false,
    edited ? undoEdit(edited) : undoAdd(candidate.id));
}

function removeMovement(movement) {
  if (!writeStored(readStored().filter(m => m.id !== movement.id))) return;
  resetForm();
  movementDialog.close();
  render();
  showStatus(`Deleted ${titleOf(movement, selectedAccount)} ${signedMoney(movement, selectedAccount)}`, false, undoDelete(movement));
}

// Pay records the bill as an expense at once: dated today, or the 1st when paying
// a month other than the current one. A bill that varies (electricity) is corrected
// afterwards by tapping the movement in the list.
function payBill(bill) {
  const payment = {
    id: newId(),
    account: bill.account,
    kind: 'expense',
    date: selectedMonth === today().slice(0, 7) ? today() : `${selectedMonth}-01`,
    cents: bill.cents,
    category: bill.category,
    note: '',
  };
  // The Pay button disappears when its row turns to Paid; keep keyboard focus in the list.
  const hadFocus = $('bill-list').contains(document.activeElement);
  if (!writeStored([...readStored(), payment])) return;
  navigator.storage?.persist?.(); // ask the browser not to evict the data
  render();
  if (hadFocus) ($('bill-list').querySelector('button.status') ?? $('add-bill')).focus();
  showStatus(`Paid ${payment.category} ${signedMoney(payment)}`, false, undoAdd(payment.id));
}

form.addEventListener('submit', saveMovement);
form.addEventListener('change', event => {
  if (event.target.name === 'kind') {
    form.elements.category.selectedIndex = 0; // the other type has other categories
    syncForm();
  }
  if (event.target.name === 'fromAccount') syncForm();
  if (event.target.name === 'category') {
    syncNewCategoryField(form.elements.category, $('new-category-field'), form.elements.newCategory);
    if (isNewCategoryChosen(form.elements.category)) form.elements.newCategory.focus();
  }
});
$('open-add').addEventListener('click', openMovementDialog);
$('cancel-movement').addEventListener('click', () => {
  resetForm();
  movementDialog.close();
});
$('delete-editing').addEventListener('click', () => {
  const movement = editedMovement();
  if (movement) {
    removeMovement(movement);
    return;
  }
  resetForm(); // already deleted in another tab
  movementDialog.close();
});
movementDialog.addEventListener('close', () => {
  if ('editing' in form.dataset) resetForm(); // closed with Escape mid-edit: nothing is kept
  // The row that opened an edit is redrawn after a save, so focus would fall to the page.
  if (document.activeElement === document.body) $('open-add').focus();
});

// --- Bills, limits and the initial amount -------------------------------------

function openBillDialog(bill = null) {
  billForm.reset();
  if (bill) billForm.dataset.editing = bill.id;
  else delete billForm.dataset.editing;
  clearBillErrors();
  billForm.elements.amount.value = bill ? String(bill.cents / 100) : '';
  $('bill-title').textContent = bill ? 'Edit bill' : 'Add bill';
  $('delete-bill').hidden = !bill;
  fillCategorySelect(billForm.elements.category, categoryNames(readStored(), 'expense'));
  chooseCategory(billForm.elements.category, bill?.category ?? '');
  syncNewCategoryField(billForm.elements.category, $('new-bill-category-field'), billForm.elements.newCategory);
  billDialog.showModal();
}

// Any edit may fix "There is already a … bill", so clear it and let Save check again.
const clearBillErrors = () =>
  [billForm.elements.category, billForm.elements.newCategory].forEach(field => field.setCustomValidity(''));

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
  const options = uniqueIgnoringCase([...(limit?.categories ?? []), ...categoryNames(readStored(), 'expense')]);
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

$('prev-month').addEventListener('click', () => selectMonth(shiftMonth(selectedMonth, -1)));
$('next-month').addEventListener('click', () => selectMonth(shiftMonth(selectedMonth, 1)));
monthInput.addEventListener('change', () => selectMonth(monthInput.value));

// The dialog is modal, so the selected account cannot change while it is open.
$('edit-initial').addEventListener('click', () => {
  const initial = readInitial(selectedAccount);
  $('initial-title').textContent = `${ACCOUNTS[selectedAccount]} initial amount`;
  initialInput.value = initial === null ? '' : String(initial / 100);
  initialDialog.showModal();
});
$('cancel-initial').addEventListener('click', () => initialDialog.close());
$('correct-balance').addEventListener('click', () => {
  $('correct-title').textContent = `${ACCOUNTS[selectedAccount]} amount now`;
  correctInput.value = String(balanceOf(selectedAccount, readStored()).left / 100);
  correctDialog.showModal();
});
$('cancel-correct').addEventListener('click', () => correctDialog.close());

$('add-bill').addEventListener('click', () => openBillDialog());
$('cancel-bill').addEventListener('click', () => billDialog.close());
billForm.addEventListener('input', clearBillErrors);
billForm.addEventListener('change', event => {
  if (event.target.name !== 'category') return;
  syncNewCategoryField(billForm.elements.category, $('new-bill-category-field'), billForm.elements.newCategory);
  if (isNewCategoryChosen(billForm.elements.category)) billForm.elements.newCategory.focus();
});
billForm.addEventListener('submit', event => {
  event.preventDefault(); // closed by hand, so a taken category can keep it open
  const bills = readBills();
  const editingId = billForm.dataset.editing;
  const { category: select, newCategory: newInput } = billForm.elements;
  const bill = {
    id: editingId || newId(),
    category: normalizeCategory(chosenCategory(select, newInput), categoryNames(readStored(), 'expense')).slice(0, MAX_CATEGORY),
    cents: parseAmount(billForm.elements.amount.value),
    account: bills.find(b => b.id === editingId)?.account ?? selectedAccount,
  };
  if (bills.some(b => b.id !== bill.id && isSameBillSlot(b, bill))) {
    rejectField(isNewCategoryChosen(select) ? newInput : select, `There is already a ${bill.category} bill.`);
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
  const known = [...picked, ...categoryNames(readStored(), 'expense')];
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
// Money that went in or out unrecorded: the difference becomes an Adjustment dated
// today, which can be undone, given a real category later, or deleted.
$('correct-form').addEventListener('submit', () => {
  const actual = Math.round(correctInput.valueAsNumber * 100);
  const change = correctionTo(balanceOf(selectedAccount, readStored()).left, actual);
  if (!change) return; // already right
  const adjustment = {
    id: newId(), account: selectedAccount, ...change, date: today(), category: ADJUSTMENT_CATEGORY, note: '',
  };
  if (!isValidMovement(adjustment)) {
    showStatus('Enter the amount the account has now.', true);
    return;
  }
  if (!writeStored([...readStored(), adjustment])) return;
  selectedMonth = adjustment.date.slice(0, 7); // where the adjustment shows in the list
  render();
  showStatus(`${ACCOUNTS[selectedAccount]} set to ${money(actual)}: ${ADJUSTMENT_CATEGORY} ${signedMoney(adjustment)}`,
    false, undoAdd(adjustment.id));
});

// --- Start ----------------------------------------------------------------------

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

// Windows 95 look: a per-device preference, not synced or backed up; look.js applies
// it before the page is drawn, and this keeps the switch's state in step.
const LOOK_KEY = 'look';
function applyLook(isRetro) {
  document.documentElement.dataset.look = isRetro ? 'retro' : 'modern';
  $('toggle-look').setAttribute('aria-pressed', String(isRetro));
}
$('toggle-look').addEventListener('click', () => {
  const isRetro = document.documentElement.dataset.look !== 'retro';
  if (!writeItem(LOOK_KEY, isRetro ? 'retro' : 'modern')) return;
  applyLook(isRetro);
  render(); // icons differ between the looks
});
applyLook(document.documentElement.dataset.look === 'retro');

resetForm();
render();
// Transfers have no categories of their own: the Categories window shows expense ones then.
const categoryKind = () => (form.elements.kind.value === 'income' ? 'income' : 'expense');
startCategoryManager({ readStored, writeItem, render, rejectField, el, formKind: categoryKind });
startSheetSync({ readSnapshot, writeSnapshot, render, showStatus, rejectField, writeItem });
startBackup({ render, today });
