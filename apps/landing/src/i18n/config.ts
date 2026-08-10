// Single source of truth for landing locales. Derived from @stll/locales — the
// same package the app uses — so the landing's supported languages always equal
// the app's UI locales and cannot drift. Adding a UI locale to @stll/locales
// surfaces it here automatically (it then needs a message catalog, which the
// i18n gate enforces).
//
// og:locale is landing-specific, so it lives here keyed by Locale; a missing
// entry fails typecheck if the app adds a locale.

import { panic } from "better-result";

import {
  UI_LOCALES,
  displayLanguageName,
  getUiLocaleDirection,
  type TextDirection,
  type UiLocale,
} from "@stll/locales";

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
  dir: TextDirection;
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

const toPath = (tag: Locale): string =>
  tag === defaultLocale ? "" : tag.toLowerCase();

const isCompleteLocaleRecord = (
  value: Partial<Record<Locale, LocaleConfig>>,
): value is Record<Locale, LocaleConfig> =>
  UI_LOCALES.every((tag) => tag in value);

const buildLocales = (): Record<Locale, LocaleConfig> => {
  const result: Partial<Record<Locale, LocaleConfig>> = {};
  for (const tag of UI_LOCALES) {
    result[tag] = {
      path: toPath(tag),
      label: displayLanguageName(tag),
      hreflang: tag,
      og: OG_LOCALE[tag],
      dir: getUiLocaleDirection(tag),
    };
  }
  if (!isCompleteLocaleRecord(result)) {
    panic("landing locales are missing a UI locale entry");
  }
  return result;
};

export const locales = buildLocales();

export const localeCodes: readonly Locale[] = UI_LOCALES;

export const isLocale = (value: string): value is Locale => value in locales;
