/**
 * @OnlyCurrentDoc
 * The tag above limits this script to the one spreadsheet it is attached to.
 * Without it, Google would grant it read and write access to every spreadsheet
 * in your Drive.
 */

/**
 * Budget app <-> Google Sheet sync. Paste this whole file into the Sheet's Apps Script editor.
 *
 * Setup, once:
 * 1. Create a Google Sheet. Use a personal Google account if a work account's
 *    admin blocks web apps that "Anyone" can reach.
 * 2. In the Sheet: Extensions > Apps Script. Delete what is in the editor, paste
 *    this whole file, and click Save.
 * 3. Project Settings (gear icon, left) > Script Properties > Add script property.
 *    Property: BUDGET_SECRET. Value: a long password, 20+ characters (let a
 *    password manager make one). Save script properties.
 * 4. Deploy > New deployment > gear next to "Select type" > Web app.
 *    Execute as: Me. Who has access: Anyone. Click Deploy and authorise access:
 *    pick your account; on "Google hasn't verified this app" choose
 *    Advanced > Go to (project name). Copy the Web app URL (it ends in /exec).
 * 5. In the Budget app: "Google Sheet" button at the bottom > paste the URL and
 *    the password > Save and sync. Repeat step 5 on each device.
 *
 * After changing this file later: Deploy > Manage deployments > pencil icon >
 * Version: New version > Deploy. The URL stays the same.
 *
 * The Sheet gets four tabs: Movements, Bills, Limits and Settings. Add and delete
 * entries in the app. Correcting a date (YYYY-MM-DD), amount, category or note in
 * the Sheet is fine: a device picks it up when it next syncs, as long as that
 * device has no changes of its own waiting to be sent; if it has, its copy of
 * every entry wins and the correction is overwritten. Leave the id column alone
 * and do not add rows by hand: a row without a valid id or amount stops the sync
 * until it is fixed or deleted.
 */

const SECRET_PROPERTY = 'BUDGET_SECRET';
const ACCOUNTS = ['spending', 'savings']; // must match ACCOUNTS in logic.js
const TABS = {
  Movements: ['id', 'date', 'amount', 'kind', 'account', 'category', 'note'],
  Bills: ['id', 'category', 'amount', 'account'],
  Limits: ['id', 'name', 'amount', 'categories', 'account'],
  Settings: ['key', 'value'],
};
// Money columns stay numbers so they can be summed in the Sheet; all others are stored as text.
const NUMBER_COLUMNS = ['amount', 'value'];
const CATEGORY_SEPARATOR = ' | ';
const LOCK_TIMEOUT_MS = 30000;

function doGet() {
  return reply({ ok: true, message: 'Budget sync is running. Paste this URL into the app.' });
}

function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    if (!isAuthorised(request.secret)) return reply({ ok: false, error: 'wrong password' });
    // One request at a time, so two devices' pushes cannot interleave.
    const lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      if (request.action === 'pull') return reply(Object.assign({ ok: true }, readAll()));
      if (request.action === 'push') return reply(push(request));
      return reply({ ok: false, error: 'unknown action' });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function isAuthorised(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);
  if (!expected) throw new Error('the script property BUDGET_SECRET is not set (setup step 3)');
  return typeof secret === 'string' && secret === expected;
}

// Writes only if the Sheet still holds what the device last read; otherwise the
// device has to pull, merge and push again.
function push(request) {
  if (request.baseVersion !== readAll().version) return { ok: false, error: 'conflict' };
  const tabs = rowsFor(request.data); // throws on bad data before any tab is touched
  Object.keys(tabs).forEach(name => writeTab(name, tabs[name]));
  // Make the writes visible before the lock is released, so the next request reads them.
  SpreadsheetApp.flush();
  return { ok: true, version: readAll().version };
}

// All rows are built and checked first, so a malformed request cannot leave the
// Sheet with some tabs replaced and others not.
function rowsFor(data) {
  const isList = value => Array.isArray(value);
  if (!data || !isList(data.expenses) || !isList(data.bills) || !isList(data.limits) || !data.initials) {
    throw new Error('the data sent has the wrong shape');
  }
  const amount = cents => {
    if (!Number.isSafeInteger(cents)) throw new Error('the data sent has an amount that is not a whole number of cents');
    return toAmount(cents);
  };
  return {
    Movements: data.expenses.map(m => [m.id, m.date, amount(m.cents), m.kind, m.account, m.category, m.note]),
    Bills: data.bills.map(b => [b.id, b.category, amount(b.cents), b.account]),
    Limits: data.limits.map(l => {
      if (!isList(l.categories)) throw new Error('the data sent has a limit without categories');
      return [l.id, l.name, amount(l.cents), l.categories.join(CATEGORY_SEPARATOR), l.account];
    }),
    Settings: ACCOUNTS.map(account => {
      const cents = data.initials[account];
      return ['initial.' + account, cents === null || cents === undefined ? '' : amount(cents)];
    }),
  };
}

// The version is a digest of the content, so edits made by hand in the Sheet count as changes too.
function readAll() {
  if (!spreadsheet().getSheetByName('Movements')) return { version: '', data: null };
  const settings = {};
  readTab('Settings').forEach(row => { settings[text(row.key)] = row.value; });
  const initials = {};
  ACCOUNTS.forEach(account => {
    const value = settings['initial.' + account];
    initials[account] = value === '' || value === undefined ? null : toCents(value);
  });
  const data = {
    initials: initials,
    expenses: readTab('Movements').map(row => ({
      id: text(row.id),
      date: dateText(row.date),
      cents: toCents(row.amount),
      kind: text(row.kind) || undefined, // blank: the app treats it as an expense
      account: text(row.account) || undefined, // blank: the app puts it in Spending
      category: text(row.category),
      note: text(row.note),
    })),
    bills: readTab('Bills').map(row => ({
      id: text(row.id),
      category: text(row.category),
      cents: toCents(row.amount),
      account: text(row.account),
    })),
    limits: readTab('Limits').map(row => ({
      id: text(row.id),
      name: text(row.name),
      cents: toCents(row.amount),
      categories: text(row.categories).split(CATEGORY_SEPARATOR.trim()).map(c => c.trim()).filter(c => c !== ''),
      account: text(row.account),
    })),
  };
  return { version: digest(JSON.stringify(data)), data: data };
}

// Rows as objects keyed by column name, found by header, so reordered columns still read correctly.
function readTab(name) {
  const sheet = spreadsheet().getSheetByName(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(text);
  return values.slice(1)
    .filter(row => row.some(cell => text(cell) !== ''))
    .map(row => {
      const record = {};
      TABS[name].forEach(column => {
        const index = header.indexOf(column);
        record[column] = index === -1 ? '' : row[index];
      });
      return record;
    });
}

function writeTab(name, rows) {
  const sheet = spreadsheet().getSheetByName(name) || spreadsheet().insertSheet(name);
  const columns = TABS[name];
  const values = [columns].concat(rows);
  sheet.clearContents();
  // Text format stops Sheets turning ids into numbers and dates into date cells.
  columns.forEach((column, index) => {
    if (NUMBER_COLUMNS.indexOf(column) === -1) sheet.getRange(1, index + 1, values.length, 1).setNumberFormat('@');
  });
  sheet.getRange(1, 1, values.length, columns.length).setValues(values);
  sheet.setFrozenRows(1);
}

function spreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// A date typed by hand becomes a date cell; read it back in the Sheet's own time zone.
function dateText(value) {
  return Object.prototype.toString.call(value) === '[object Date]'
    ? Utilities.formatDate(value, spreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd')
    : text(value);
}

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function toAmount(cents) {
  return cents / 100;
}

function digest(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, value, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function reply(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
