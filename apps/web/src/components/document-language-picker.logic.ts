/**
 * Locale mapping and typeahead matching for the document-language pickers.
 * Separate from the component file so the translation dialogs' logic modules
 * (and their tests) can reach it without importing React.
 */

import {
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES,
  type DocumentTranslationTargetLanguageCode,
} from "@stll/api-contract/document-translation";
import { foldToAscii } from "@stll/text-normalize";

const DEFAULT_TARGET_LANG: DocumentTranslationTargetLanguageCode = "EN-GB";
const FALLBACK_SOURCE_LANG: DocumentTranslationTargetLanguageCode = "CS";

/** UI locales whose code differs from the document-language code. */
const LOCALE_TO_LANGUAGE = {
  en: "EN-GB",
} as const satisfies Record<string, DocumentTranslationTargetLanguageCode>;

const isMappedLocale = (
  locale: string,
): locale is keyof typeof LOCALE_TO_LANGUAGE =>
  Object.hasOwn(LOCALE_TO_LANGUAGE, locale);

/** Every language a translation may be produced in, in catalog order. */
export const DOCUMENT_TRANSLATION_TARGET_CODES =
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES.map(({ code }) => code);

export const isDocumentTranslationTargetCode = (
  value: string,
): value is DocumentTranslationTargetLanguageCode =>
  DOCUMENT_TRANSLATION_TARGET_CODES.some((code) => code === value);

const languageForLocale = (
  locale: string,
): DocumentTranslationTargetLanguageCode | null => {
  const mapped = isMappedLocale(locale)
    ? LOCALE_TO_LANGUAGE[locale]
    : locale.toUpperCase();
  return isDocumentTranslationTargetCode(mapped) ? mapped : null;
};

export type DefaultLanguagePair = {
  source: DocumentTranslationTargetLanguageCode;
  target: DocumentTranslationTargetLanguageCode;
};

/**
 * The UI locale is the best guess for the document's language; the target
 * defaults to English unless the source already is.
 */
export const defaultLanguagePair = (locale: string): DefaultLanguagePair => {
  const source = languageForLocale(locale) ?? FALLBACK_SOURCE_LANG;
  const target =
    source === DEFAULT_TARGET_LANG ? FALLBACK_SOURCE_LANG : DEFAULT_TARGET_LANG;
  return { source, target };
};

/** Default a new translation toward the user's UI language when supported. */
export const defaultTargetLanguage = (
  locale: string,
): DocumentTranslationTargetLanguageCode =>
  languageForLocale(locale) ?? DEFAULT_TARGET_LANG;

/**
 * Match key for the picker's typeahead.
 *
 * `foldToAscii` rather than the highlighter's `normalizeSearchText`: mark
 * stripping alone leaves Polish `ł` standing, so typing "lotewski" would miss
 * "Łotewski" in the pl catalog. Folding also keeps Greek, Cyrillic and Arabic
 * names matchable in their own script.
 */
const languageMatchKey = (text: string): string =>
  foldToAscii(text).toLowerCase();

type LanguageQueryCandidate = {
  code: string;
  label: string;
};

/**
 * A language matches on its localized name or its code, diacritics-insensitive
 * and anywhere in the string: "brit" finds "English (British)" and "pt" finds
 * both Portuguese entries.
 */
export const matchesLanguageQuery = (
  { code, label }: LanguageQueryCandidate,
  query: string,
): boolean => {
  const needle = languageMatchKey(query).trim();
  if (needle.length === 0) {
    return true;
  }
  return (
    languageMatchKey(label).includes(needle) ||
    languageMatchKey(code).includes(needle)
  );
};
