/**
 * Extract the preferred language from an Accept-Language header.
 *
 * The frontend sends a simple message language (e.g. "cs") through
 * Accept-Language and a full formatting tag through the dedicated formatting
 * header. Legacy clients may still send a formatting tag with Unicode
 * extensions (e.g. "ar-u-ca-gregory-nu-arab") in Accept-Language. Parsing
 * also handles browser quality weights (e.g. "cs,en-US;q=0.9,en;q=0.8").
 */

import { resolveUiLocale } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

export type SupportedLang = UiLocale;

export const FORMATTING_LOCALE_HEADER = "x-stella-formatting-locale";

/** Match a single BCP-47 tag (sans quality weight) to a supported language.
 *  Delegates to the central `@stll/locales` resolver (exact tag, base-code
 *  prefix, and the Portuguese `pt*` -> `pt-BR` special case). */
const matchSupportedLang = (tag: string): SupportedLang | undefined =>
  resolveUiLocale(tag) ?? undefined;

const acceptLanguageTags = (header: string): string[] =>
  header
    .split(",")
    .map((part) => part.split(";")[0]?.trim().replace("_", "-") ?? "")
    .filter((tag) => tag.length > 0);

export const extractLangFromRequest = (
  request: Request | undefined,
): SupportedLang => {
  const header = request?.headers.get("Accept-Language");
  if (!header) {
    return "en";
  }
  for (const tag of acceptLanguageTags(header)) {
    const match = matchSupportedLang(tag);
    if (match) {
      return match;
    }
  }
  return "en";
};

const matchFormattingLocale = (tag: string): string | undefined => {
  const match = matchSupportedLang(tag);
  if (!match) {
    return undefined;
  }

  // The base is supported; keep the full tag (with `-u-` extensions) when it
  // is a well-formed locale, else fall back to the matched base language.
  try {
    return new Intl.Locale(tag).toString();
  } catch {
    return match;
  }
};

/**
 * Reads the explicit formatting header first, then falls back to
 * Accept-Language for legacy clients. Preserves Unicode (`-u-`) extensions so
 * server-side Intl formatting matches the client's locale settings. Returns a
 * canonical BCP-47 tag whose base language is supported, or "en".
 */
export const extractFormattingLocale = (
  request: Request | undefined,
): string => {
  const formattingLocale = request?.headers.get(FORMATTING_LOCALE_HEADER);
  const explicitLocale = formattingLocale
    ? matchFormattingLocale(formattingLocale)
    : undefined;
  if (explicitLocale) {
    return explicitLocale;
  }

  const header = request?.headers.get("Accept-Language");
  if (!header) {
    return "en";
  }
  for (const tag of acceptLanguageTags(header)) {
    const locale = matchFormattingLocale(tag);
    if (locale) {
      return locale;
    }
  }
  return "en";
};
