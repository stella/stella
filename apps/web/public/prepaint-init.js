/**
 * Apply document-level presentation state before first paint: colour
 * scheme + palette (avoids a white flash for dark-mode users) and the
 * writing direction + language (avoids an LTR/English flash for RTL
 * users). Loaded synchronously (non-module) from index.html so it runs
 * before the SPA bundle. Storage keys and the RTL locale set are
 * duplicated from src/consts.ts and src/i18n/i18n-store.ts — keep them
 * in sync; i18n-store.test.ts guards the RTL set.
 *
 * Lives here (not inline in index.html) so the frontend CSP can
 * stay strict (script-src 'self') without needing 'unsafe-inline'
 * or per-script hashes.
 *
 * The root element is server-rendered as lang="en" dir="ltr" and carries
 * suppressHydrationWarning, so mutating it here does not produce a
 * hydration error. The i18n store re-applies the same values after it
 * rehydrates; this only moves the change earlier, before first paint.
 */
(function () {
  const el = document.documentElement;

  const t = "stella-ui-theme";
  const p = "stella-ui-palette";
  const d =
    localStorage[t] === "dark" ||
    (localStorage[t] !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  if (d) {
    el.classList.add("dark");
    el.style.colorScheme = "dark";
    el.style.backgroundColor = "#0c0c0d";
  }
  const pal = localStorage.getItem(p) || "neutral";
  if (pal !== "neutral") {
    el.classList.add(`palette-${pal}`);
  }

  // Right-to-left UI locales. Every other shipped locale is LTR, so only
  // this set has to stay in sync with LANG_DIR in src/i18n/i18n-store.ts.
  const RTL = ["ar"];

  const persisted = (function () {
    try {
      const raw = localStorage.getItem("stella-i18n");
      if (!raw) {
        return null;
      }
      const lang = JSON.parse(raw)?.state?.lang;
      return typeof lang === "string" ? lang : null;
    } catch {
      // Malformed or unreadable storage: fall through to browser detection
      // rather than blocking first paint.
      return null;
    }
  })();

  // Mirrors detectLang() in src/i18n/i18n-store.ts: first browser locale
  // whose base subtag is a shipped RTL locale wins. Only RTL locales are
  // resolved here because LTR is already the server-rendered default.
  const detected = (function () {
    const languages = navigator.languages || [];
    for (const candidate of languages) {
      const base = String(candidate).replace("_", "-").split("-")[0];
      if (RTL.includes(base)) {
        return base;
      }
    }
    return null;
  })();

  const lang = persisted || detected;
  if (lang && RTL.includes(lang)) {
    el.lang = lang;
    el.dir = "rtl";
  }
})();
