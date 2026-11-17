/** The OS colour scheme is browser-only; all saved preferences are rendered by SSR. */
(function () {
  const el = document.documentElement;
  const theme = el.dataset["theme"];
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (theme === "system") {
    el.classList.toggle("dark", dark);
    el.style.colorScheme = dark ? "dark" : "light";
  }
  // Dark windows paint near-black before the stylesheet arrives.
  if (dark) {
    el.style.backgroundColor = "#0c0c0d";
  }
})();
