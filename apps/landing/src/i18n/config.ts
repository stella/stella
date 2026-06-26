// Single source of truth for landing locales. Drives Astro i18n routing, the
// translation helpers, hreflang/canonical/OG SEO, and the localized sitemap.
//
// Starter set: en (default, no prefix), es, pt-BR. Adding a locale = add an
// entry here + a message catalog; routing and SEO pick it up automatically.

export const defaultLocale = "en";

export type Locale = "en" | "es" | "pt-BR" | "ar";

export type LocaleConfig = {
  /** URL path segment ("" for the default locale, served at root). */
  path: string;
  /** Native name, for a language switcher. */
  label: string;
  /** BCP-47 code for the <html lang> attribute and hreflang. */
  hreflang: string;
  /** Open Graph locale (og:locale). */
  og: string;
  /** Writing direction for the <html dir> attribute. */
  dir: "ltr" | "rtl";
};

export const locales: Record<Locale, LocaleConfig> = {
  en: { path: "", label: "English", hreflang: "en", og: "en_US", dir: "ltr" },
  es: { path: "es", label: "Español", hreflang: "es", og: "es_ES", dir: "ltr" },
  "pt-BR": {
    path: "pt-br",
    label: "Português (BR)",
    hreflang: "pt-BR",
    og: "pt_BR",
    dir: "ltr",
  },
  ar: { path: "ar", label: "العربية", hreflang: "ar", og: "ar_AR", dir: "rtl" },
};

export const localeCodes = Object.keys(locales) as Locale[];

export const isLocale = (value: string): value is Locale => value in locales;
