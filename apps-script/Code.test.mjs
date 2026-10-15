// Run: node apps-script/Code.test.mjs
// Exercises Code.gs against in-memory stand-ins for the Google services it uses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TIME_ZONE = 'Asia/Taipei';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A sheet as Google keeps it: text-formatted columns store strings as given,
// other columns turn date-looking text into dates, as Sheets does.
function fakeSheet() {
  let cells = [];
  const textColumns = new Set();
  const store = (column, value) =>
    (!textColumns.has(column) && typeof value === 'string' && ISO_DATE.test(value)
      ? new Date(`${value}T00:00:00+08:00`)
      : value);
  return {
    cells: () => cells,
    getDataRange: () => ({ getValues: () => (cells.length ? cells.map(row => [...row]) : [['']]) }),
    clearContents: () => { cells = []; },
    getRange: (row, column, rowCount, columnCount) => ({
      setNumberFormat: format => { if (format === '@') textColumns.add(column - 1); },
      setValues: values => {
        assert.equal(values.length, rowCount);
        values.forEach((rowValues, r) => {
          assert.equal(rowValues.length, columnCount);
          cells[row - 1 + r] = rowValues.map((value, c) => store(column - 1 + c, value));
        });
      },
    }),
    setFrozenRows: () => {},
  };
}

// Loads Code.gs with a fresh, empty spreadsheet. Also used by local end-to-end checks.
export function loadScript(secret = 'a long test password') {
  const sheets = new Map();
  const spreadsheet = {
    getSheetByName: name => sheets.get(name) ?? null,
    insertSheet: name => sheets.set(name, fakeSheet()).get(name),
    getSpreadsheetTimeZone: () => TIME_ZONE,
  };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => (key === 'BUDGET_SECRET' ? secret : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, text) => [...createHash(algorithm).update(text, 'utf8').digest()],
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      formatDate: (date, timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(date),
    },
  });
  vm.runInContext(readFileSync(new URL('./Code.gs', import.meta.url), 'utf8'), context);
  return {
    sheets,
    post: body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text),
    get: () => JSON.parse(context.doGet().text),
  };
}

function runChecks() {
  const secret = 'a long test password';
  const { post, get, sheets } = loadScript(secret);
  const snapshot = {
    initials: { spending: 4000000, savings: null },
    expenses: [
      { id: 'm1', date: '2026-10-09', cents: 1250, category: 'Food', note: 'lunch, "with quotes"', account: 'spending', kind: 'expense' },
      { id: 'm2', date: '2026-10-01', cents: 5000000, category: 'Salary', note: '', account: 'savings', kind: 'income' },
    ],
    bills: [{ id: 'b1', category: 'Rent', cents: 1650000, account: 'spending' }],
    limits: [{ id: 'l1', name: 'Personal', cents: 900000, categories: ['Food', 'Restaurants'], account: 'spending' }],
  };

  assert.equal(get().ok, true); // opening the URL in a browser shows it is running
  assert.deepEqual(post({ secret: 'guess', action: 'pull' }), { ok: false, error: 'wrong password' });
  assert.deepEqual(post({ secret, action: 'pull' }), { ok: true, version: '', data: null }); // new Sheet

  // Round trip: what the app pushes comes back unchanged
  const pushed = post({ secret, action: 'push', baseVersion: '', data: snapshot });
  assert.equal(pushed.ok, true);
  const pulled = post({ secret, action: 'pull' });
  assert.equal(pulled.version, pushed.version);
  assert.deepEqual(pulled.data, snapshot);

  // Amounts are numbers in the Sheet so they can be summed; dates stay text.
  // Rows are spread into local arrays: Code.gs runs in its own realm, whose
  // arrays never strictly equal this file's.
  const movements = sheets.get('Movements').cells();
  assert.deepEqual([...movements[0]], ['id', 'date', 'amount', 'kind', 'account', 'category', 'note']);
  assert.deepEqual([...movements[2]].slice(0, 3), ['m2', '2026-10-01', 50000]);

  // A push based on an old version is refused and changes nothing
  assert.deepEqual(post({ secret, action: 'push', baseVersion: 'old', data: { ...snapshot, expenses: [] } }), { ok: false, error: 'conflict' });
  assert.equal(post({ secret, action: 'pull' }).data.expenses.length, 2);

  // Malformed data is refused before any tab is touched
  const before = post({ secret, action: 'pull' });
  const badLimit = { ...snapshot, limits: [{ id: 'l2', name: 'Bad', cents: 100, account: 'spending' }] };
  assert.match(post({ secret, action: 'push', baseVersion: before.version, data: badLimit }).error, /without categories/);
  assert.match(post({ secret, action: 'push', baseVersion: before.version, data: { ...snapshot, bills: null } }).error, /wrong shape/);
  const badAmount = { ...snapshot, expenses: [{ ...snapshot.expenses[0], cents: 12.5 }] };
  assert.match(post({ secret, action: 'push', baseVersion: before.version, data: badAmount }).error, /whole number/);
  assert.equal(post({ secret, action: 'pull' }).version, before.version);

  // Hand edits count as a change: a date typed as a real date, blank kind and account
  movements[1][1] = new Date('2026-10-11T00:00:00+08:00');
  movements[1][3] = '';
  movements[1][4] = '';
  const edited = post({ secret, action: 'pull' });
  assert.notEqual(edited.version, pushed.version);
  assert.deepEqual(edited.data.expenses[0], { id: 'm1', date: '2026-10-11', cents: 1250, category: 'Food', note: 'lunch, "with quotes"' });

  // Custom categories travel in the Settings tab. A Sheet written without them reports
  // none at all, so the app keeps the categories it has.
  assert.equal('categories' in edited.data, false);
  const withCategories = { ...snapshot, categories: { expense: ['Coffee', '3/4'], income: ['Tips'] } };
  assert.equal(post({ secret, action: 'push', baseVersion: edited.version, data: withCategories }).ok, true);
  const withCategoriesPulled = post({ secret, action: 'pull' });
  assert.deepEqual(withCategoriesPulled.data.categories, withCategories.categories);
  const badCategories = { ...snapshot, categories: { expense: 'Coffee' } };
  assert.match(post({ secret, action: 'push', baseVersion: withCategoriesPulled.version, data: badCategories }).error, /categories/);

  // A missing password property is reported, not treated as "no password"
  assert.match(loadScript(null).post({ secret: '', action: 'pull' }).error, /BUDGET_SECRET/);

  process.stdout.write('ok\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runChecks();
