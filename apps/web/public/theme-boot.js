/* global window, document */
// Applies the cached theme before first paint to avoid a light/dark flash.
(function () {
  try {
    var pref = localStorage.getItem('rs.theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch {
    /* storage unavailable: keep the default */
  }
})();
