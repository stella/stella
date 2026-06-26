// Single source of truth for landing locales. Derived from @stll/locales — the
// same package the app uses — so the landing's supported languages always equal
// the app's UI locales and cannot drift. Adding a UI locale to @stll/locales
// surfaces it here automatically (it then needs a message catalog, which the
// i18n gate enforces).
//
// og:locale and writing direction are not part of @stll/locales, so they live
// here keyed by Locale; a missing entry fails typecheck if the app adds a locale.

import { UI_LOCALES, displayLanguageName, type UiLocale } from "@stll/locales";

export const defaultLocale: UiLocale = "en";

export type Locale = UiLocale;

export type LocaleConfig = {
  /** URL path segment ("" for the default locale, served at root). */
  path: string;
  /** Native name (autonym), for a language switcher. */
  label: string;
  /** BCP-47 code for the <html lang> attribute and hreflang. */
  hreflang: string;
  /** Open Graph locale (og:locale). */
  og: string;
  /** Writing direction for the <html dir> attribute. */
  dir: "ltr" | "rtl";
};

const OG_LOCALE: Record<Locale, string> = {
  ar: "ar_AR",
  cs: "cs_CZ",
  de: "de_DE",
  en: "en_US",
  es: "es_ES",
  et: "et_EE",
  fr: "fr_FR",
  hu: "hu_HU",
  lt: "lt_LT",
  lv: "lv_LV",
  pl: "pl_PL",
  "pt-BR": "pt_BR",
  sk: "sk_SK",
};

const RTL_LOCALES = new Set<Locale>(["ar"]);

const toPath = (tag: Locale): string =>
  tag === defaultLocale ? "" : tag.toLowerCase();

export const locales = Object.fromEntries(
  UI_LOCALES.map((tag) => [
    tag,
    {
      path: toPath(tag),
      label: displayLanguageName(tag),
      hreflang: tag,
      og: OG_LOCALE[tag],
      dir: RTL_LOCALES.has(tag) ? "rtl" : "ltr",
    } satisfies LocaleConfig,
  ]),
) as Record<Locale, LocaleConfig>;

export const localeCodes = Object.keys(locales) as Locale[];

export const isLocale = (value: string): value is Locale => value in locales;
