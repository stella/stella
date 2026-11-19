const historyMethods = window.__STELLA_HISTORY__;

if (historyMethods) {
  window.history.replaceState = historyMethods.replaceState;
  window.history.pushState = historyMethods.pushState;
}
