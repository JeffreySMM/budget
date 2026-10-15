// Run: node test.mjs
import assert from 'node:assert/strict';
import {
  parseAmount, isValidMovement, normalizeCategory, shiftMonth,
  totalsByCategory, totalsByMonth, windowEnd, mergeById, niceMax, isValidInitial, readBackup,
  withDefaults, sumCents, balance, isValidBill, billStatus, mergeBills,
  isValidLimit, limitStatus, findCategoryClash, mergeLimits, uniqueIgnoringCase,
  cleanSnapshot, mergeSnapshots, hashText, isSheetUrl, cleanCategories, isCustomCategoryName,
} from './logic.js';

const expense = (over = {}) => ({ id: 'a', date: '2026-10-09', cents: 1250, category: 'Food', note: '', ...over });

// parseAmount: major units in, integer minor units out
assert.equal(parseAmount('12.5'), 1250);
assert.equal(parseAmount('19.99'), 1999); // 19.99 * 100 === 1998.9999999999998
assert.equal(parseAmount('0'), null);
assert.equal(parseAmount('-3'), null);
assert.equal(parseAmount(''), null);
assert.equal(parseAmount('1,234'), null);
assert.equal(parseAmount('1e400'), null);

// isValidMovement: the import trust boundary
assert.equal(isValidMovement(expense()), true);
assert.equal(isValidMovement(null), false);
assert.equal(isValidMovement(expense({ id: '' })), false);
assert.equal(isValidMovement(expense({ date: '2026-02-31' })), false);
assert.equal(isValidMovement(expense({ date: '10/09/2026' })), false);
assert.equal(isValidMovement(expense({ cents: 12.5 })), false);
assert.equal(isValidMovement(expense({ cents: -1 })), false);
assert.equal(isValidMovement(expense({ category: '' })), false);
assert.equal(isValidMovement(expense({ category: 'x'.repeat(41) })), false);
assert.equal(isValidMovement(expense({ note: 5 })), false);

// normalizeCategory: reuse existing spelling so "food" and "Food" do not split
assert.equal(normalizeCategory('  food ', ['Food', 'Rent']), 'Food');
assert.equal(normalizeCategory('Pets', ['Food']), 'Pets');
assert.equal(normalizeCategory('   ', ['Food']), 'Other');

// shiftMonth: crosses year boundaries
assert.equal(shiftMonth('2026-01', -1), '2025-12');
assert.equal(shiftMonth('2026-12', 1), '2027-01');
assert.equal(shiftMonth('2026-10', -11), '2025-11');

// totalsByCategory: summed, largest first
assert.deepEqual(
  totalsByCategory([
    expense({ category: 'Food', cents: 100 }),
    expense({ category: 'Rent', cents: 900 }),
    expense({ category: 'Food', cents: 250 }),
  ]),
  [{ category: 'Rent', cents: 900 }, { category: 'Food', cents: 350 }],
);
assert.deepEqual(totalsByCategory([]), []);

// totalsByMonth: fixed window ending at the given month, empty months are zero
assert.deepEqual(
  totalsByMonth([
    expense({ date: '2026-10-01', cents: 100 }),
    expense({ date: '2026-10-31', cents: 50 }),
    expense({ date: '2026-08-15', cents: 700 }),
    expense({ date: '2026-07-15', cents: 999 }), // outside the window
  ], '2026-10', 3),
  [{ month: '2026-08', cents: 700 }, { month: '2026-09', cents: 0 }, { month: '2026-10', cents: 150 }],
);

// windowEnd: stays on the current month until the selection leaves the window
assert.equal(windowEnd('2026-03', '2026-10', 12), '2026-10');
assert.equal(windowEnd('2025-11', '2026-10', 12), '2026-10');
assert.equal(windowEnd('2025-10', '2026-10', 12), '2025-10');
assert.equal(windowEnd('2026-12', '2026-10', 12), '2026-12');

// mergeById: existing records win, originals untouched
const existing = [expense({ id: 'a', cents: 1 })];
const merged = mergeById(existing, [expense({ id: 'a', cents: 2 }), expense({ id: 'b', cents: 3 })]);
assert.deepEqual(merged.map(e => [e.id, e.cents]), [['a', 1], ['b', 3]]);
assert.equal(existing.length, 1);

// niceMax: axis ceiling on a 1/2/5 step
assert.equal(niceMax(0), 1);
assert.equal(niceMax(100), 100);
assert.equal(niceMax(123), 200);
assert.equal(niceMax(4200), 5000);
assert.equal(niceMax(51000), 100000);

// isValidInitial: positive integer cents only
assert.equal(isValidInitial(5000000), true);
assert.equal(isValidInitial(0), false);
assert.equal(isValidInitial(12.5), false);
assert.equal(isValidInitial('5000'), false);
assert.equal(isValidInitial(1e14), true);
assert.equal(isValidInitial(1e14 + 1), false); // above what the dialog input accepts

// Accounts: the field is optional on older records, but must be a known account when present
assert.equal(isValidMovement(expense({ account: 'savings' })), true);
assert.equal(isValidMovement(expense({ account: 'offshore' })), false);
assert.equal(isValidMovement(expense({ account: 'constructor' })), false);
assert.equal(isValidMovement(expense({ account: 7 })), false);
assert.equal(withDefaults(expense()).account, 'spending');
assert.equal(withDefaults(expense({ account: 'savings' })).account, 'savings');
assert.equal(sumCents([expense({ cents: 100 }), expense({ cents: 250 })]), 350);
assert.equal(sumCents([]), 0);

// Kinds: a movement is an expense or income; older records have no kind and are expenses
assert.equal(isValidMovement(expense({ kind: 'income' })), true);
assert.equal(isValidMovement(expense({ kind: 'expense' })), true);
assert.equal(isValidMovement(expense({ kind: 'transfer' })), false);
assert.equal(isValidMovement(expense({ kind: 'constructor' })), false);
assert.equal(withDefaults(expense()).kind, 'expense');
assert.equal(withDefaults(expense({ kind: 'income' })).kind, 'income');

// balance: initial + income − expenses; no initial amount counts as zero
assert.deepEqual(
  balance(10000, [expense({ cents: 2500 }), expense({ cents: 4000, kind: 'income' }), expense({ cents: 500, kind: 'expense' })]),
  { income: 4000, spent: 3000, available: 14000, left: 11000 },
);
assert.deepEqual(balance(null, [expense({ cents: 300 })]), { income: 0, spent: 300, available: 0, left: -300 });
assert.deepEqual(balance(null, []), { income: 0, spent: 0, available: 0, left: 0 });

// readBackup: every backup shape the app has ever written still imports
const noInitials = { spending: null, savings: null };
assert.deepEqual(readBackup([expense()]), { rows: [expense()], initials: noInitials, bills: [], limits: [] });
assert.deepEqual(
  readBackup({ initialCents: 5000000, expenses: [expense()] }), // single amount, before accounts: it was spending
  { rows: [expense()], initials: { spending: 5000000, savings: null }, bills: [], limits: [] },
);
assert.deepEqual(
  readBackup({ initials: { spending: 100, savings: 200 }, expenses: [] }),
  { rows: [], initials: { spending: 100, savings: 200 }, bills: [], limits: [] },
);
assert.deepEqual(readBackup({ initials: { savings: -1 }, initialCents: 300, expenses: [] }).initials, { spending: 300, savings: null });
assert.deepEqual(readBackup({ initials: 'nope', expenses: [] }).initials, noInitials);
assert.deepEqual(readBackup({ initialCents: -1, expenses: [] }), { rows: [], initials: noInitials, bills: [], limits: [] });
assert.deepEqual(readBackup({ expenses: [], bills: [{ id: 'x' }] }).bills, [{ id: 'x' }]); // rows come back unvalidated
assert.deepEqual(readBackup({ expenses: [], bills: 'nope' }).bills, []);
assert.deepEqual(readBackup({ expenses: [], limits: [{ id: 'x' }] }).limits, [{ id: 'x' }]);
assert.deepEqual(readBackup({ expenses: [], limits: {} }).limits, []);

// isValidBill: the bill template a monthly payment is checked against
const bill = (over = {}) => ({ id: 'r', category: 'Rent', cents: 1650000, account: 'spending', ...over });
assert.equal(isValidBill(bill()), true);
assert.equal(isValidBill(null), false);
assert.equal(isValidBill(bill({ id: '' })), false);
assert.equal(isValidBill(bill({ category: '' })), false);
assert.equal(isValidBill(bill({ category: 'Rent ' })), false);
assert.equal(isValidBill(bill({ cents: 0 })), false);
assert.equal(isValidBill(bill({ account: undefined })), false);
assert.equal(isValidBill(bill({ account: 'constructor' })), false);

// billStatus: paid once an expense in the bill's category lands in that month and account
const bills = [bill(), bill({ id: 'e', category: 'Electricity', cents: 120000 }), bill({ id: 'p', category: 'Phone', cents: 60000 })];
const october = billStatus(bills, [
  expense({ category: 'rent', cents: 1650000, date: '2026-10-03', account: 'spending', kind: 'expense' }), // any letter case
  expense({ category: 'Electricity', cents: 118000, date: '2026-09-28', account: 'spending' }), // September
  expense({ category: 'Phone', cents: 60000, date: '2026-10-05', account: 'savings' }), // other account
  expense({ category: 'Phone', cents: 60000, date: '2026-10-05', account: 'spending', kind: 'income' }), // income pays nothing
], '2026-10');
assert.deepEqual(october.rows.map(r => [r.bill.id, r.isPaid, r.paidCents]), [['r', true, 1650000], ['e', false, 0], ['p', false, 0]]);
assert.equal(october.monthly, 1830000);
assert.equal(october.toPay, 180000);
assert.deepEqual(billStatus([], [], '2026-10'), { rows: [], monthly: 0, toPay: 0 });

// mergeBills: skips known ids, and categories already billed in that account,
// because paid status is matched by category
const merged2 = mergeBills([bill()], [
  bill({ id: 'r2', category: 'RENT' }), // same category, other letter case
  bill({ id: 'r', category: 'Rent2' }), // same id
  bill({ id: 'g', category: 'Gym' }),
  bill({ id: 'g2', category: 'gym' }), // duplicate within the incoming list
  bill({ id: 's', account: 'savings' }), // Rent, but in the other account
]);
assert.deepEqual(merged2.map(b => b.id), ['r', 'g', 's']);

// uniqueIgnoringCase: first spelling wins
assert.deepEqual(uniqueIgnoringCase(['Food', 'food', 'Fun', 'FOOD']), ['Food', 'Fun']);

// isValidLimit: a monthly amount over one or more categories
const limit = (over = {}) => ({ id: 'g', name: 'Groceries', cents: 500000, categories: ['Groceries'], account: 'spending', ...over });
assert.equal(isValidLimit(limit()), true);
assert.equal(isValidLimit(null), false);
assert.equal(isValidLimit(limit({ name: '' })), false);
assert.equal(isValidLimit(limit({ cents: 0 })), false);
assert.equal(isValidLimit(limit({ account: 'offshore' })), false);
assert.equal(isValidLimit(limit({ categories: [] })), false);
assert.equal(isValidLimit(limit({ categories: 'Groceries' })), false);
assert.equal(isValidLimit(limit({ categories: ['Food', 'food'] })), false);
assert.equal(isValidLimit(limit({ categories: ['Food '] })), false);

// limitStatus: this month's expenses in the limit's account and categories
const personal = limit({ id: 'p', name: 'Personal', cents: 900000, categories: ['Food', 'Restaurants', 'Shopping'] });
const limits = limitStatus([limit(), personal], [
  expense({ category: 'groceries', cents: 180000, date: '2026-10-02', account: 'spending' }), // any letter case
  expense({ category: 'Restaurants', cents: 700000, date: '2026-10-05', account: 'spending' }),
  expense({ category: 'Shopping', cents: 300000, date: '2026-10-06', account: 'spending' }),
  expense({ category: 'Food', cents: 50000, date: '2026-09-30', account: 'spending' }), // September
  expense({ category: 'Food', cents: 50000, date: '2026-10-06', account: 'savings' }), // other account
  expense({ category: 'Food', cents: 50000, date: '2026-10-06', account: 'spending', kind: 'income' }), // income
  expense({ category: 'Rent', cents: 1650000, date: '2026-10-03', account: 'spending' }), // not covered
], '2026-10');
assert.deepEqual(limits.rows.map(r => [r.limit.id, r.spent, r.left]), [['g', 180000, 320000], ['p', 1000000, -100000]]);
assert.deepEqual([limits.total, limits.spent, limits.left], [1400000, 1180000, 220000]);
assert.deepEqual(limitStatus([], [], '2026-10'), { rows: [], total: 0, spent: 0, left: 0 });

// findCategoryClash: spending may count against one limit only
assert.equal(findCategoryClash(limit({ id: 'new', categories: ['Pets'] }), [limit(), personal]), null);
assert.deepEqual(
  findCategoryClash(limit({ id: 'new', categories: ['Pets', 'shopping'] }), [limit(), personal]),
  { other: personal, category: 'shopping' },
);
assert.equal(findCategoryClash(personal, [limit(), personal]), null); // editing itself
assert.equal(findCategoryClash(limit({ id: 'new', account: 'savings' }), [limit()]), null); // other account

// mergeLimits: skips known ids and limits that would share a category
const merged3 = mergeLimits([limit()], [
  limit({ name: 'Renamed' }), // same id
  limit({ id: 'g2', categories: ['GROCERIES'] }), // category already covered
  personal,
  limit({ id: 'p2', categories: ['Food'] }), // clashes with personal, added just before
]);
assert.deepEqual(merged3.map(l => l.id), ['g', 'p']);

// cleanSnapshot: validates and normalises a backup file or the Sheet's data; unknown fields dropped
const cleaned = cleanSnapshot({
  initials: { spending: 100 },
  bills: [bill(), { id: '' }],
  limits: [limit({ extra: 'dropped' })],
  expenses: [expense({ extra: 'dropped' }), { bad: true }],
});
assert.equal(cleaned.invalid, 2);
assert.deepEqual(cleaned.snapshot.initials, { spending: 100, savings: null });
assert.deepEqual(cleaned.snapshot.expenses, [withDefaults(expense())]);
assert.deepEqual(cleaned.snapshot.bills, [bill()]);
assert.deepEqual(cleaned.snapshot.limits, [limit()]);
assert.equal(cleanSnapshot('nope'), null);

// mergeSnapshots: everything local is kept; remote only adds what local lacks
const mergedSnapshot = mergeSnapshots(
  { initials: { spending: 1, savings: null }, bills: [bill()], limits: [], expenses: [expense({ id: 'a', cents: 1 })] },
  {
    initials: { spending: 2, savings: 3 },
    bills: [bill({ id: 'r2', category: 'rent' }), bill({ id: 'ph', category: 'Phone' })],
    limits: [limit()],
    expenses: [expense({ id: 'a', cents: 2 }), expense({ id: 'b' })],
  },
);
assert.deepEqual(mergedSnapshot.initials, { spending: 1, savings: 3 });
assert.deepEqual(mergedSnapshot.bills.map(b => b.id), ['r', 'ph']);
assert.deepEqual(mergedSnapshot.limits.map(l => l.id), ['g']);
assert.deepEqual(mergedSnapshot.expenses.map(e => [e.id, e.cents]), [['a', 1], ['b', 1250]]);

// Custom categories: cleaned like everything else; null when a source has none at all,
// so an older backup or Sheet never wipes the categories a device already has
assert.equal(isCustomCategoryName('Coffee'), true);
assert.equal(isCustomCategoryName('A|B'), false); // | separates categories in the Sheet
assert.equal(isCustomCategoryName(' Pad'), false);
assert.equal(cleanCategories(undefined), null);
assert.equal(cleanCategories(['Coffee']), null);
assert.deepEqual(
  cleanCategories({ expense: ['Coffee', 'coffee', ' Pad', 'A|B', 7, ''], income: 'Tips' }),
  { expense: ['Coffee'], income: [] },
);
assert.equal(cleanSnapshot([expense()]).snapshot.categories, null); // bare-array backup
assert.deepEqual(
  cleanSnapshot({ expenses: [], categories: { income: ['Tips'] } }).snapshot.categories,
  { expense: [], income: ['Tips'] },
);
const base = { initials: { spending: null, savings: null }, bills: [], limits: [], expenses: [] };
assert.deepEqual(
  mergeSnapshots(
    { ...base, categories: { expense: ['Coffee'], income: [] } },
    { ...base, categories: { expense: ['coffee', 'Pets'], income: ['Tips'] } },
  ).categories,
  { expense: ['Coffee', 'Pets'], income: ['Tips'] },
);
assert.deepEqual(
  mergeSnapshots({ ...base, categories: { expense: ['Coffee'], income: [] } }, { ...base, categories: null }).categories,
  { expense: ['Coffee'], income: [] },
);

// hashText: same text, same number; any change, different number
assert.equal(hashText('{"a":1}'), hashText('{"a":1}'));
assert.notEqual(hashText('{"a":1}'), hashText('{"a":2}'));
assert.ok(Number.isSafeInteger(hashText('')));

// isSheetUrl: only an Apps Script web app URL, so the password is never sent elsewhere
assert.equal(isSheetUrl('https://script.google.com/macros/s/AKfycb-x_9/exec'), true);
assert.equal(isSheetUrl('https://script.google.com/a/macros/example.com/s/AKfycb/exec'), true);
assert.equal(isSheetUrl('http://script.google.com/macros/s/AKfycb/exec'), false);
assert.equal(isSheetUrl('https://script.google.com.evil.example/macros/s/AKfycb/exec'), false);
assert.equal(isSheetUrl('https://script.google.com/macros/s/AKfycb/dev'), false);
assert.equal(isSheetUrl('https://script.google.com/macros/s/AKfycb/exec?x=1'), false);
assert.equal(isSheetUrl(undefined), false);
assert.equal(readBackup({ initialCents: 5000000 }), null);
assert.equal(readBackup(null), null);
assert.equal(readBackup('nope'), null);

process.stdout.write('ok\n');
