// Export and import of a backup file: everything in one JSON file, merged on import.
import { cleanSnapshot, mergeSnapshots } from './logic.js';
import { $, el, showStatus } from './ui.js';
import { readSnapshot, writeSnapshot } from './store.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const REVOKE_URL_MS = 10000;

/**
 * @param {{ render: () => void, today: () => string }} app
 */
export function startBackup({ render, today }) {
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
}
