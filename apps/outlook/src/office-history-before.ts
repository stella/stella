const history = window.history;

window.__STELLA_HISTORY__ = {
  pushState: history.pushState.bind(history),
  replaceState: history.replaceState.bind(history),
};
