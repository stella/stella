import { UI_LOCALES } from "./languages.js";
import type { UiLocale } from "./languages.js";

export type TextDirection = "ltr" | "rtl";

type RtlUiLocale = "ar";

type UiLocaleDirections = {
  readonly [Locale in UiLocale]: Locale extends RtlUiLocale ? "rtl" : "ltr";
};

export const UI_LOCALE_DIRECTIONS: UiLocaleDirections = {
  en: "ltr",
  ar: "rtl",
  cs: "ltr",
  de: "ltr",
  es: "ltr",
  et: "ltr",
  fr: "ltr",
  hu: "ltr",
  lt: "ltr",
  lv: "ltr",
  pl: "ltr",
  "pt-BR": "ltr",
  sk: "ltr",
};

export const getUiLocaleDirection = (locale: UiLocale): TextDirection =>
  UI_LOCALE_DIRECTIONS[locale];

export const RTL_UI_LOCALES: UiLocale[] = UI_LOCALES.filter(
  (locale) => UI_LOCALE_DIRECTIONS[locale] === "rtl",
);
