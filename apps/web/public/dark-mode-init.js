/**
 * Apply dark mode + palette before first paint to avoid a white
 * flash on dark-mode users. Loaded synchronously (non-module)
 * from index.html so it runs before the SPA bundle. Storage keys
 * are duplicated from src/consts.ts — keep them in sync.
 *
 * Lives here (not inline in index.html) so the frontend CSP can
 * stay strict (script-src 'self') without needing 'unsafe-inline'
 * or per-script hashes.
 */
(function () {
  const t = "stella-ui-theme";
  const p = "stella-ui-palette";
  const d =
    localStorage[t] === "dark" ||
    (localStorage[t] !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const el = document.documentElement;
  if (d) {
    el.classList.add("dark");
    el.style.colorScheme = "dark";
    el.style.backgroundColor = "#0c0c0d";
  }
  const pal = localStorage.getItem(p) || "neutral";
  if (pal !== "neutral") {
    el.classList.add(`palette-${pal}`);
  }
})();
