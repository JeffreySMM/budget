// Pure expense logic. No DOM, no storage: imported by index.html and test.mjs.
// Amounts are integer minor units (cents) so sums never drift.

/**
 * A movement is money leaving (expense) or entering (income) an account.
 * @typedef {object} Movement
 * @property {string} id
 * @property {string} date      YYYY-MM-DD, local calendar day
 * @property {number} cents     positive integer, minor units; the kind gives the direction
 * @property {string} category
 * @property {string} note
 * @property {string} [account] key of ACCOUNTS; absent on records saved before accounts existed
 * @property {string} [kind]    'expense' | 'income' | 'transfer'; absent on records saved before income existed
 * @property {string} [toAccount] transfers only: the account the money goes to
 */

// Account id -> label. The order is the display order.
export const ACCOUNTS = { spending: 'Spending', savings: 'Savings' };
// Where records and amounts from before accounts existed belong.
export const DEFAULT_ACCOUNT = 'spending';
const KINDS = ['expense', 'income', 'transfer'];
// Transfers have no categories of their own.
const CATEGORY_KINDS = ['expense', 'income'];
const DEFAULT_KIND = 'expense';

const isAccount = id => typeof id === 'string' && Object.hasOwn(ACCOUNTS, id);
export const isIncome = movement => movement.kind === 'income';
// A transfer moves money between the user's own accounts: never spending or income.
export const isTransfer = movement => movement.kind === 'transfer';
// Records saved before kinds existed have none and are expenses.
export const isExpense = movement => movement.kind === undefined || movement.kind === 'expense';

// Fills fields that older records lack, so the rest of the app can rely on them.
export const withDefaults = movement => ({
  ...movement,
  account: movement.account ?? DEFAULT_ACCOUNT,
  kind: movement.kind ?? DEFAULT_KIND,
});

export const MAX_CATEGORY = 40;
export const MAX_NOTE = 100;
const MAX_ID = 64;
const FALLBACK_CATEGORY = 'Other';

export function parseAmount(input) {
  const cents = Math.round(Number(String(input).trim()) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// Round-trips through Date so impossible days like 2026-02-31 are rejected.
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function isValidMovement(e) {
  return !!e && typeof e === 'object'
    && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= MAX_ID
    && isIsoDate(e.date)
    && Number.isSafeInteger(e.cents) && e.cents > 0
    && typeof e.category === 'string' && e.category.length > 0 && e.category.length <= MAX_CATEGORY
    && typeof e.note === 'string' && e.note.length <= MAX_NOTE
    && (e.account === undefined || isAccount(e.account))
    && (e.kind === undefined || KINDS.includes(e.kind))
    // A transfer names the other account it goes to; nothing else names a second account.
    && (e.kind === 'transfer'
      ? isAccount(e.toAccount) && e.toAccount !== (e.account ?? DEFAULT_ACCOUNT)
      : e.toAccount === undefined);
}

/**
 * A fixed cost expected every month, e.g. rent. Not money itself: it is checked
 * against the month's expenses to see whether it has been paid.
 * @typedef {object} Bill
 * @property {string} id
 * @property {string} category  a payment is an expense in this category
 * @property {number} cents     expected amount, positive integer
 * @property {string} account   key of ACCOUNTS it is paid from
 */
const isId = id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;
// Saved categories are trimmed, so a stored "Rent " could never match an expense.
const isCategoryName = c => typeof c === 'string' && c.length > 0 && c.length <= MAX_CATEGORY && c === c.trim();

// Categories the user adds are joined with | in the Google Sheet, so | cannot be part of one.
export const isCustomCategoryName = c => isCategoryName(c) && !c.includes('|');
export const MAX_CUSTOM_CATEGORIES = 100;

/**
 * Categories the user added, per kind, cleaned. Null when the source has none at
 * all (an older backup or Sheet), so the caller keeps the ones it already has.
 * @returns {{ expense: string[], income: string[] } | null}
 */
export function cleanCategories(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = list => (Array.isArray(list)
    ? uniqueIgnoringCase(list.filter(isCustomCategoryName)).slice(0, MAX_CUSTOM_CATEGORIES)
    : []);
  return Object.fromEntries(CATEGORY_KINDS.map(kind => [kind, clean(value[kind])]));
}

export function isValidBill(b) {
  return !!b && typeof b === 'object'
    && isId(b.id)
    && isCategoryName(b.category)
    && Number.isSafeInteger(b.cents) && b.cents > 0
    && isAccount(b.account);
}

// Matches max="1000000000000" on the dialog input, so any stored value can be re-saved.
const MAX_INITIAL_CENTS = 1e14;

export const isValidInitial = cents => Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_INITIAL_CENTS;

/**
 * Accepts every backup shape the app has written: a bare array of expenses,
 * `{ initialCents, expenses }` (one amount, before accounts existed), and
 * `{ initials: { [account]: cents }, bills, limits, expenses }`. Rows, bills
 * and limits are returned unvalidated.
 * @param {unknown} parsed
 * @returns {{ rows: unknown[], initials: Record<string, number | null>, bills: unknown[], limits: unknown[] } | null}
 *   null when it is not a backup
 */
export function readBackup(parsed) {
  const rows = Array.isArray(parsed) ? parsed : parsed?.expenses;
  if (!Array.isArray(rows)) return null;
  const initials = Object.fromEntries(Object.keys(ACCOUNTS).map(account => {
    const legacy = account === DEFAULT_ACCOUNT ? parsed.initialCents : null;
    const cents = parsed.initials?.[account] ?? legacy;
    return [account, isValidInitial(cents) ? cents : null];
  }));
  const listOf = key => (Array.isArray(parsed[key]) ? parsed[key] : []);
  return { rows, initials, bills: listOf('bills'), limits: listOf('limits') };
}

export function normalizeCategory(input, known) {
  const name = String(input).trim();
  if (!name) return FALLBACK_CATEGORY;
  return known.find(k => k.toLowerCase() === name.toLowerCase()) ?? name;
}

export function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7);
}

export const sumCents = expenses => expenses.reduce((sum, e) => sum + e.cents, 0);

// What an account holds: initial amount (none counts as zero), plus income and
// transfers in, minus expenses and transfers out. `movements` may span all accounts.
// hasBalance: there is something to measure against, not only expenses.
export function balance(initialCents, movements, account) {
  const own = movements.filter(m => (m.account ?? DEFAULT_ACCOUNT) === account);
  const income = sumCents(own.filter(isIncome));
  const spent = sumCents(own.filter(isExpense));
  const movedOut = sumCents(own.filter(isTransfer));
  const movedIn = sumCents(movements.filter(m => isTransfer(m) && m.toAccount === account));
  const available = (initialCents ?? 0) + income + movedIn - movedOut;
  const hasBalance = (initialCents ?? null) !== null || income + movedIn + movedOut > 0;
  return { income, spent, movedIn, movedOut, available, left: available - spent, hasBalance };
}

// A bill counts as paid for the month once any expense in its category is
// recorded in that month and account; the amount may differ from the bill's.
export function billStatus(bills, movements, month) {
  const rows = bills.map(bill => {
    const payments = movements.filter(m => isExpense(m) && m.account === bill.account
      && m.date.startsWith(month) && m.category.toLowerCase() === bill.category.toLowerCase());
    return { bill, paidCents: sumCents(payments), isPaid: payments.length > 0 };
  });
  const unpaid = rows.filter(row => !row.isPaid).map(row => row.bill);
  return { rows, monthly: sumCents(bills), toPay: sumCents(unpaid) };
}

// Paid status is matched by category, so one account cannot hold two bills in one category.
export const isSameBillSlot = (a, b) =>
  a.account === b.account && a.category.toLowerCase() === b.category.toLowerCase();

// Like mergeById, but also skips bills whose slot is already taken.
export function mergeBills(existing, incoming) {
  return incoming.reduce((merged, bill) =>
    (merged.some(b => b.id === bill.id || isSameBillSlot(b, bill)) ? merged : [...merged, bill]), existing);
}

const sameIgnoringCase = (a, b) => a.toLowerCase() === b.toLowerCase();

export const uniqueIgnoringCase = list =>
  list.filter((item, index) => list.findIndex(other => sameIgnoringCase(other, item)) === index);

// The categories used by movements of one kind, most used first (ties keep the order
// first seen), so the likeliest choice is offered first.
export function categoriesByUse(movements, kind) {
  const counts = movements
    .filter(m => (m.kind ?? DEFAULT_KIND) === kind)
    .reduce((tally, m) => tally.set(m.category, (tally.get(m.category) ?? 0) + 1), new Map());
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
}

/**
 * A monthly spending limit over a group of expense categories,
 * e.g. Personal: 9,000 for Food, Restaurants, Hobbies and Shopping.
 * @typedef {object} Limit
 * @property {string} id
 * @property {string} name
 * @property {number} cents         allowed per month, positive integer
 * @property {string[]} categories  at least one, no two equal ignoring letter case
 * @property {string} account       key of ACCOUNTS
 */
const MAX_LIMIT_CATEGORIES = 50;

export function isValidLimit(l) {
  return !!l && typeof l === 'object'
    && isId(l.id)
    && isCategoryName(l.name)
    && Number.isSafeInteger(l.cents) && l.cents > 0
    && isAccount(l.account)
    && Array.isArray(l.categories) && l.categories.length > 0 && l.categories.length <= MAX_LIMIT_CATEGORIES
    && l.categories.every(isCategoryName)
    && uniqueIgnoringCase(l.categories).length === l.categories.length;
}

// Spending against each limit in one month: that account's expenses in the covered categories.
export function limitStatus(limits, movements, month) {
  const rows = limits.map(limit => {
    const covers = category => limit.categories.some(c => sameIgnoringCase(c, category));
    const spent = sumCents(movements.filter(m => isExpense(m) && m.account === limit.account
      && m.date.startsWith(month) && covers(m.category)));
    return { limit, spent, left: limit.cents - spent };
  });
  const total = sumCents(limits);
  const spent = rows.reduce((sum, row) => sum + row.spent, 0);
  return { rows, total, spent, left: total - spent };
}

// An expense may count against one limit only, so limits in an account may not
// share a category. Returns the first shared category and the limit holding it.
export function findCategoryClash(limit, limits) {
  return limits
    .filter(other => other.id !== limit.id && other.account === limit.account)
    .map(other => ({ other, category: limit.categories.find(c => other.categories.some(o => sameIgnoringCase(o, c))) }))
    .find(clash => clash.category !== undefined) ?? null;
}

// Like mergeById, but also skips limits that would share a category with one already kept.
export function mergeLimits(existing, incoming) {
  return incoming.reduce((merged, limit) =>
    (merged.some(l => l.id === limit.id) || findCategoryClash(limit, merged) ? merged : [...merged, limit]), existing);
}

export function totalsByCategory(expenses) {
  const categories = [...new Set(expenses.map(e => e.category))];
  return categories
    .map(category => ({ category, cents: sumCents(expenses.filter(e => e.category === category)) }))
    .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category));
}

export function totalsByMonth(expenses, endMonth, count) {
  return Array.from({ length: count }, (_, i) => {
    const month = shiftMonth(endMonth, i - count + 1);
    return { month, cents: sumCents(expenses.filter(e => e.date.startsWith(month))) };
  });
}

// Last month of the trend window: the current month, unless the selected month
// falls outside that window, in which case the window slides to end on it.
export function windowEnd(selectedMonth, currentMonth, count) {
  const windowStart = shiftMonth(currentMonth, 1 - count);
  return selectedMonth < windowStart || selectedMonth > currentMonth ? selectedMonth : currentMonth;
}

export function mergeById(existing, incoming) {
  const seen = new Set(existing.map(e => e.id));
  const fresh = incoming.filter(e => !seen.has(e.id) && seen.add(e.id));
  return [...existing, ...fresh];
}

export function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map(step => step * magnitude).find(ceiling => ceiling >= value);
}

/**
 * Everything the app stores, in one object: what a backup file and the Google Sheet hold.
 * @typedef {{ initials: Record<string, number | null>, bills: Bill[], limits: Limit[], expenses: Movement[],
 *   categories: { expense: string[], income: string[] } | null }} Snapshot categories: the ones the user added
 */

/**
 * Validated, normalised copy of a backup file or of the Sheet's data, with unknown fields dropped.
 * @returns {{ snapshot: Snapshot, invalid: number } | null} null when it is not a backup at all
 */
export function cleanSnapshot(parsed) {
  const backup = readBackup(parsed);
  if (!backup) return null;
  const expenses = backup.rows
    .filter(isValidMovement)
    .map(({ id, date, cents, category, note, account, kind, toAccount }) => withDefaults({
      id, date, cents, category, note, account, kind, ...(toAccount === undefined ? {} : { toAccount }),
    }));
  const bills = backup.bills
    .filter(isValidBill)
    .map(({ id, category, cents, account }) => ({ id, category, cents, account }));
  const limits = backup.limits
    .filter(isValidLimit)
    .map(({ id, name, cents, categories, account }) => ({ id, name, cents, categories: [...categories], account }));
  const invalid = backup.rows.length - expenses.length + backup.bills.length - bills.length
    + backup.limits.length - limits.length;
  const categories = cleanCategories(parsed.categories);
  return { snapshot: { initials: backup.initials, bills, limits, expenses, categories }, invalid };
}

// Everything in `local` is kept as it is; `remote` only adds what local lacks.
export function mergeSnapshots(local, remote) {
  return {
    initials: Object.fromEntries(Object.keys(ACCOUNTS).map(account =>
      [account, local.initials[account] ?? remote.initials[account] ?? null])),
    bills: mergeBills(local.bills, remote.bills),
    limits: mergeLimits(local.limits, remote.limits),
    expenses: mergeById(local.expenses, remote.expenses),
    // Added categories from both sides; a side without any (null) adds nothing.
    categories: Object.fromEntries(CATEGORY_KINDS.map(kind => [kind, uniqueIgnoringCase([
      ...(local.categories?.[kind] ?? []),
      ...(remote.categories?.[kind] ?? []),
    ]).slice(0, MAX_CUSTOM_CATEGORIES)])),
  };
}

// djb2: a cheap fingerprint to tell whether stored data changed since the last sync.
export function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash;
}

// Only an Apps Script web app URL, so the sync password is never sent anywhere else.
const SHEET_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#]+|macros)\/s\/[\w-]+\/exec$/;
export const isSheetUrl = url => typeof url === 'string' && SHEET_URL.test(url);
