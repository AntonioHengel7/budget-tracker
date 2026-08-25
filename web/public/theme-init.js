// Anti-FOUC theme bootstrap: applies a previously-chosen theme before first
// paint, so the page never flashes the wrong color scheme. Runs as a
// same-origin external <script src="/theme-init.js"> (referenced from
// index.html) rather than an inline <script> block, so the app's CSP
// (issue #76) can enforce `script-src 'self'` without `'unsafe-inline'`.
(function () {
  var stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
})();
