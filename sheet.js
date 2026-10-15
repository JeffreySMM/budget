// Everything about the optional Google Sheet copy: talking to the Apps Script
// web app (apps-script/Code.gs), deciding what to send and take, and the
// settings dialog.
//
// Local storage stays the working copy, so the app is instant and works offline.
// Changes go to the Sheet shortly after they happen; the Sheet is read when the
// app opens or comes back into view. If both sides changed since the last sync,
// this device's copy of every entry it holds wins, and the Sheet only adds the
// entries it lacks. Nothing is dropped, but an entry deleted on one device can
// come back from another device that still has it.
// ponytail: whole-device-wins merge; a per-entry baseline would keep the Sheet's
// edits to entries this device did not touch, if that ever matters.
import { cleanSnapshot, mergeSnapshots, hashText, isSheetUrl } from './logic.js';

const SETTINGS_KEY = 'sync';
const TIMEOUT_MS = 20000;
const PUSH_DELAY_MS = 2000;
const CONFLICT_RETRIES = 2;
const LOCAL_ONLY_TEXT = 'Data stays on this device. Export a backup now and then.';

const $ = id => document.getElementById(id);

// What this module needs from the app, handed over by startSheetSync.
let app = null;
let pushTimer = 0;
let isSyncing = false;
let isSyncQueued = false;

async function call(settings, request) {
  let response = null;
  try {
    response = await fetch(settings.url, {
      method: 'POST',
      // Plain text keeps this a "simple" request: Apps Script cannot answer a CORS preflight.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...request, secret: settings.secret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A wrong URL or a web app not open to "Anyone" also lands here: Google answers
    // with a sign-in page the browser does not hand to the app.
    throw new Error(error.name === 'TimeoutError'
      ? 'Google took too long to answer'
      : 'could not reach the Sheet. Check the connection, the URL, and that web app access is "Anyone"');
  }
  const reply = await response.json().catch(() => null);
  if (!reply) throw new Error('the Sheet did not answer. Check the URL and that web app access is "Anyone"');
  if (!reply.ok && reply.error !== 'conflict') throw new Error(reply.error || 'the Sheet refused the request');
  return reply;
}

/** @returns {Promise<{ version: string, data: unknown }>} data is null for a Sheet never synced */
async function pull(settings) {
  const reply = await call(settings, { action: 'pull' });
  return { version: String(reply.version ?? ''), data: reply.data ?? null };
}

/**
 * Replaces the Sheet's content, unless it changed since `baseVersion` was read.
 * @returns {Promise<{ conflict: boolean, version: string }>}
 */
async function push(settings, baseVersion, data) {
  const reply = await call(settings, { action: 'push', baseVersion, data });
  return { conflict: reply.error === 'conflict', version: String(reply.version ?? '') };
}

/** @returns {{ url: string, secret: string, version: string, hash: number | null } | null} */
function readSettings() {
  let settings = null;
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    settings = null; // unreadable: treated as not connected; connecting again rewrites it
  }
  return isSheetUrl(settings?.url) && typeof settings.secret === 'string' ? settings : null;
}

const writeSettings = settings => app.writeItem(SETTINGS_KEY, JSON.stringify(settings));
const snapshotHash = () => hashText(JSON.stringify(app.readSnapshot()));
const showState = message => { $('sheet-state').textContent = message; };

// Called after every render: local changes go to the Sheet once editing pauses.
export function scheduleSheetSync() {
  const settings = app && readSettings();
  if (!settings) return;
  if (isSyncing) {
    isSyncQueued = true; // looked at again when the running sync ends
    return;
  }
  if (snapshotHash() === settings.hash) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync(), PUSH_DELAY_MS);
}

// Reads the Sheet, takes in what changed there, and sends what changed here.
async function reconcile(settings, retriesLeft) {
  const remote = await pull(settings);
  const cleaned = remote.data === null ? null : cleanSnapshot(remote.data);
  if (remote.data !== null && !cleaned) throw new Error('the Sheet data could not be read');
  // Pushing would overwrite rows that could not be read, so stop until they are fixed.
  if (cleaned?.invalid > 0) {
    const rows = cleaned.invalid === 1 ? '1 row in the Sheet is' : `${cleaned.invalid} rows in the Sheet are`;
    throw new Error(`${rows} incomplete or invalid; fix or delete them, then sync again`);
  }

  const local = app.readSnapshot();
  const isLocalChanged = hashText(JSON.stringify(local)) !== settings.hash;
  let state = settings;
  if (cleaned && remote.version !== settings.version) {
    // A Sheet written by an older script has no categories: keep the ones here.
    const incoming = { ...cleaned.snapshot, categories: cleaned.snapshot.categories ?? local.categories };
    const next = isLocalChanged ? mergeSnapshots(local, incoming) : incoming;
    if (!app.writeSnapshot(next)) throw new Error('could not save the Sheet data on this device');
    // Saved at once, so a push that fails below does not make every retry merge
    // and redraw again. The hash moves only if nothing here was waiting to be sent.
    state = { ...settings, version: remote.version, hash: isLocalChanged ? settings.hash : snapshotHash() };
    saveState(state);
    app.render();
  }
  if (cleaned && !isLocalChanged) return undefined; // nothing to send

  // Hash exactly what is sent: edits made while waiting for Google stay unsent and go next time.
  const sent = app.readSnapshot();
  const pushed = await push(state, remote.version, sent);
  if (pushed.conflict) {
    // Another device wrote in between: read again and merge with that.
    if (retriesLeft === 0) throw new Error('the Sheet kept changing; try again');
    return reconcile(state, retriesLeft - 1);
  }
  saveState({ ...state, version: pushed.version, hash: hashText(JSON.stringify(sent)) });
  return undefined;
}

function saveState(state) {
  if (!writeSettings(state)) throw new Error('could not save the sync state on this device');
}

async function sync({ isRequested = false } = {}) {
  const settings = readSettings();
  if (!settings) return;
  if (isSyncing) {
    isSyncQueued = true;
    return;
  }
  if (!navigator.onLine) {
    showState('Offline: changes go to the Google Sheet when back online.');
    return;
  }
  isSyncing = true;
  clearTimeout(pushTimer);
  showState('Syncing with Google Sheet…');
  try {
    await reconcile(settings, CONFLICT_RETRIES);
    const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    showState(`Synced with Google Sheet at ${time}.`);
    if (isRequested) app.showStatus('Synced with Google Sheet');
  } catch (error) {
    // Nothing is lost: tried again on the next change, on reopening, or when back online.
    showState(`Not synced: ${error.message}.`);
    if (isRequested) app.showStatus(`Not synced: ${error.message}`, true);
  } finally {
    isSyncing = false;
    if (isSyncQueued) {
      isSyncQueued = false;
      scheduleSheetSync();
    }
  }
}

function openDialog() {
  const form = $('sheet-form');
  const settings = readSettings();
  form.reset();
  form.elements.url.setCustomValidity('');
  form.elements.url.value = settings?.url ?? '';
  form.elements.secret.value = settings?.secret ?? '';
  $('sheet-now').hidden = !settings;
  $('sheet-disconnect').hidden = !settings;
  $('sheet-dialog').showModal();
}

function saveDialog(event) {
  event.preventDefault(); // closed by hand, so a bad URL can keep it open
  const form = $('sheet-form');
  const urlInput = form.elements.url;
  const url = urlInput.value.trim();
  if (!isSheetUrl(url)) {
    app.rejectField(urlInput, 'Paste the Web app URL from Apps Script. It starts with https://script.google.com and ends in /exec.');
    return;
  }
  // Another Sheet starts fresh: what is on this device is merged with what it holds.
  const previous = readSettings();
  const isSameSheet = previous?.url === url;
  const settings = {
    url,
    secret: form.elements.secret.value,
    version: isSameSheet ? previous.version : '',
    hash: isSameSheet ? previous.hash : null,
  };
  if (!writeSettings(settings)) return;
  $('sheet-dialog').close();
  sync({ isRequested: true });
}

function disconnect() {
  if (!confirm('Stop syncing with the Google Sheet? Your data stays on this device and in the Sheet.')) return;
  localStorage.removeItem(SETTINGS_KEY);
  clearTimeout(pushTimer);
  $('sheet-dialog').close();
  showState(LOCAL_ONLY_TEXT);
}

/**
 * Wires the dialog and starts syncing if a Sheet is connected.
 * @param {{ readSnapshot: Function, writeSnapshot: Function, render: Function,
 *   showStatus: Function, rejectField: Function, writeItem: Function }} appParts
 */
export function startSheetSync(appParts) {
  app = appParts;
  $('open-sheet').addEventListener('click', openDialog);
  $('cancel-sheet').addEventListener('click', () => $('sheet-dialog').close());
  $('sheet-form').elements.url.addEventListener('input', event => event.target.setCustomValidity(''));
  $('sheet-form').addEventListener('submit', saveDialog);
  $('sheet-now').addEventListener('click', () => {
    $('sheet-dialog').close();
    sync({ isRequested: true });
  });
  $('sheet-disconnect').addEventListener('click', disconnect);
  // Another device may have changed the Sheet while this one was in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
  window.addEventListener('online', () => sync());

  showState(readSettings() ? 'Connected to Google Sheet.' : LOCAL_ONLY_TEXT);
  sync();
}
