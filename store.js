// Everything the app keeps on the device, in localStorage.
import {
  isValidMovement, withDefaults, isValidBill, isValidLimit, isValidInitial, parseAmount,
  ACCOUNTS, DEFAULT_ACCOUNT,
} from './logic.js';
import { readCategories, CATEGORIES_KEY } from './categories.js';
import { showStatus } from './ui.js';

const STORAGE_KEY = 'expenses'; // name predates income; holds every movement
const BILLS_KEY = 'bills';
const LIMITS_KEY = 'limits';
// Spending keeps the original key, so an amount saved before accounts existed still applies.
const initialKey = account => (account === DEFAULT_ACCOUNT ? 'initialCents' : `initialCents.${account}`);

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

export const readStored = () => readList(STORAGE_KEY, isValidMovement, withDefaults);
export const readBills = () => readList(BILLS_KEY, isValidBill, bill => bill);
export const readLimits = () => readList(LIMITS_KEY, isValidLimit, limit => limit);

export function writeItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    showStatus(`Could not save: ${error.message}`, true);
    return false;
  }
}

export const writeStored = movements => writeItem(STORAGE_KEY, JSON.stringify(movements));
export const writeBills = bills => writeItem(BILLS_KEY, JSON.stringify(bills));
export const writeLimits = limits => writeItem(LIMITS_KEY, JSON.stringify(limits));

// The starting amount of an account; null until the user sets one.
export function readInitial(account) {
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
export function saveInitial(account, raw) {
  if (raw.trim() === '') return writeInitial(account, null);
  const cents = parseAmount(raw);
  if (cents === null) {
    showStatus('Enter an initial amount above zero.', true);
    return false;
  }
  return writeInitial(account, cents);
}

/** @returns {import('./logic.js').Snapshot} everything stored, as in a backup file */
export const readSnapshot = () => ({
  initials: Object.fromEntries(Object.keys(ACCOUNTS).map(account => [account, readInitial(account)])),
  bills: readBills(),
  limits: readLimits(),
  expenses: readStored(),
  categories: readCategories(),
});

// Replaces everything stored, all or nothing: if a write fails (storage full,
// already reported by writeItem), the earlier ones are undone, so a mix of old
// and new data is never left behind, or sent to the Sheet.
export function writeSnapshot(snapshot) {
  const keys = [STORAGE_KEY, BILLS_KEY, LIMITS_KEY, CATEGORIES_KEY, ...Object.keys(ACCOUNTS).map(initialKey)];
  const previous = keys.map(key => [key, localStorage.getItem(key)]);
  const isWritten = writeStored(snapshot.expenses) && writeBills(snapshot.bills) && writeLimits(snapshot.limits)
    && writeItem(CATEGORIES_KEY, JSON.stringify(snapshot.categories ?? readCategories()))
    && Object.entries(snapshot.initials).every(([account, cents]) => writeInitial(account, cents));
  if (!isWritten) {
    previous.forEach(([key, value]) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
  }
  return isWritten;
}
