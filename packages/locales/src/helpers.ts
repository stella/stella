// Locale-resolution and display helpers derived from the canonical
// {@link LANGUAGES} list. These replace the per-consumer copies that used to
// live in the web i18n store, the API Accept-Language parser, and the
// transactional email translator.

import { isLanguageCode, LANGUAGES, UI_LOCALES } from "./languages.js";
import type { Language, LanguageCode, UiLocale } from "./languages.js";

const UI_LOCALE_SET: ReadonlySet<string> = new Set(UI_LOCALES);

const LANGUAGE_BY_CODE: ReadonlyMap<string, Language> = new Map(
  LANGUAGES.map((language) => [language.code, language]),
);

export const isUiLocale = (value: unknown): value is UiLocale =>
  typeof value === "string" && UI_LOCALE_SET.has(value);

const normalizeLocaleTag = (value: string): string => value.replace("_", "-");

/**
 * Resolves an arbitrary locale string to a shipped UI-locale tag, or `null`.
 *
 * Behaviour preserved from the previous per-consumer copies:
 * 1. exact match against a UI-locale tag (e.g. `"pt-BR"`),
 * 2. base-code prefix match (e.g. `"de-AT"` -> `"de"`),
 * 3. the Portuguese special case: any `pt*` tag maps to `"pt-BR"`.
 */
export const resolveUiLocale = (value: string): UiLocale | null => {
  const normalized = normalizeLocaleTag(value);
  if (isUiLocale(normalized)) {
    return normalized;
  }

  const prefix = normalized.split("-").at(0);
  if (!prefix) {
    return null;
  }

  if (isUiLocale(prefix)) {
    return prefix;
  }

  if (prefix === "pt") {
    return "pt-BR";
  }

  return null;
};

/**
 * Canonicalizes a (possibly regional) language tag to its ISO 639-1 base
 * code if that base code is a known living language, else `null`. Used to
 * map template-language input (`"pt-BR"`, `"EN-gb"`) onto {@link LANGUAGES}.
 */
export const toLanguageCode = (value: string): LanguageCode | null => {
  const prefix = normalizeLocaleTag(value.trim())
    .split("-")
    .at(0)
    ?.toLowerCase();
  if (!prefix) {
    return null;
  }
  return isLanguageCode(prefix) ? prefix : null;
};

type DisplayLanguageNameOptions = {
  /** "english" uses {@link Language.englishName}; "endonym" uses the autonym.
   *  Defaults to "endonym". */
  prefer?: "english" | "endonym";
  /** Locale to localize names Intl falls back to (for codes not in the
   *  canonical list). Defaults to "en". */
  displayLocale?: string;
};

/**
 * Human-readable name for a language tag. Prefers the canonical-list entry
 * (`endonym` by default, `englishName` on request); for tags outside the
 * list it falls back to `Intl.DisplayNames`, then to the upper-cased tag.
 */
export const displayLanguageName = (
  tag: string,
  options: DisplayLanguageNameOptions = {},
): string => {
  const { prefer = "endonym", displayLocale = "en" } = options;
  const code = toLanguageCode(tag);
  if (code) {
    const entry = LANGUAGE_BY_CODE.get(code);
    if (entry) {
      return prefer === "english" ? entry.englishName : entry.endonym;
    }
  }

  try {
    const intlName = new Intl.DisplayNames([displayLocale], {
      type: "language",
    }).of(tag);
    if (intlName) {
      return intlName;
    }
  } catch {
    // Structurally malformed tags make Intl throw; fall through.
  }

  return tag.toUpperCase();
};
