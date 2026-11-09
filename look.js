// Runs in <head>, before the page is drawn, so the chosen look shows without a flash
// of another one. The choice is per device; app.js has the switch.
try {
  const look = localStorage.getItem('look');
  document.documentElement.dataset.look = look === 'retro' || look === 'mac' ? look : 'modern';
} catch {
  document.documentElement.dataset.look = 'modern'; // storage blocked: default look
}
