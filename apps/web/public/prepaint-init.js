/** The OS colour scheme is browser-only; all saved preferences are rendered by SSR. */
(function () {
  const el = document.documentElement;
  if (el.dataset["theme"] !== "system") {
    return;
  }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  el.classList.toggle("dark", dark);
  el.style.colorScheme = dark ? "dark" : "light";
})();
