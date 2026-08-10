/**
 * Apply document-level presentation state before first paint: colour
 * scheme + palette (avoids a white flash for dark-mode users) and the
 * writing direction + language (avoids an LTR/English flash for RTL
 * users). Loaded synchronously (non-module) from index.html so it runs
 * before the SPA bundle. The locale metadata below is generated from
 * @stll/locales because this classic script cannot import the package.
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

  const THEME_STORAGE_KEY = "stella-ui-theme";
  const PALETTE_STORAGE_KEY = "stella-ui-palette";
  const I18N_STORAGE_KEY = "stella-i18n";
  const PALETTES = ["nord", "flexoki"];
  const getStorageValue = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const storedTheme = getStorageValue(THEME_STORAGE_KEY);
  const d =
    storedTheme === "dark" ||
    (storedTheme !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  if (d) {
    el.classList.add("dark");
    el.style.colorScheme = "dark";
    el.style.backgroundColor = "#0c0c0d";
  }
  const palette = getStorageValue(PALETTE_STORAGE_KEY);
  if (palette && PALETTES.includes(palette)) {
    el.classList.add(`palette-${palette}`);
  }

  // <generated:ui-locales>
  // Generated from @stll/locales. Run `bun run typegen` after changing
  // the canonical UI locale contract.
  const UI_LOCALES = [
    "ar",
    "cs",
    "de",
    "en",
    "et",
    "fr",
    "hu",
    "lv",
    "lt",
    "pl",
    "pt-BR",
    "sk",
    "es",
  ];
  const RTL_LOCALES = ["ar"];
  // </generated:ui-locales>

  const resolveUiLocale = (value) => {
    const normalized = String(value).replace("_", "-");
    if (UI_LOCALES.includes(normalized)) {
      return normalized;
    }

    const prefix = normalized.split("-")[0];
    if (UI_LOCALES.includes(prefix)) {
      return prefix;
    }
    return prefix === "pt" ? "pt-BR" : null;
  };

  const persisted = (function () {
    try {
      const raw = getStorageValue(I18N_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const lang = JSON.parse(raw)?.state?.lang;
      return typeof lang === "string" ? resolveUiLocale(lang) : null;
    } catch {
      // Malformed or unreadable storage: fall through to browser detection
      // rather than blocking first paint.
      return null;
    }
  })();

  // Mirrors detectLang() in src/i18n/i18n-store.ts: the first browser locale
  // that resolves to any shipped UI locale wins. A supported LTR preference
  // must stop the search before a lower-priority RTL preference.
  const detected = (function () {
    const languages = navigator.languages || [];
    for (const candidate of languages) {
      const lang = resolveUiLocale(candidate);
      if (lang) {
        return lang;
      }
    }
    return null;
  })();

  const lang = persisted || detected;
  if (lang && RTL_LOCALES.includes(lang)) {
    el.lang = lang;
    el.dir = "rtl";
  }
})();
