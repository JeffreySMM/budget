// Runs in <head>, before the page is drawn, so the chosen look shows without a flash
// of the other one. The choice is per device; app.js has the switch.
try {
  document.documentElement.dataset.look = localStorage.getItem('look') === 'retro' ? 'retro' : 'modern';
} catch {
  document.documentElement.dataset.look = 'modern'; // storage blocked: default look
}
