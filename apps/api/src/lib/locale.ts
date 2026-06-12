/**
 * Extract the preferred language from an Accept-Language header.
 * Returns the first supported language prefix, or "en".
 *
 * The frontend sends a simple language string (e.g. "cs") via
 * the auth client's Accept-Language header. The parsing also
 * handles standard browser Accept-Language values with quality
 * weights (e.g. "cs,en-US;q=0.9,en;q=0.8").
 */

import { resolveUiLocale } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

export type SupportedLang = UiLocale;

export const extractLangFromRequest = (
  request: Request | undefined,
): SupportedLang => {
  const header = request?.headers.get("Accept-Language");

  if (!header) {
    return "en";
  }

  for (const part of header.split(",")) {
    const lang = part.split(";")[0]?.trim();
    if (!lang) {
      continue;
    }

    const resolved = resolveUiLocale(lang);
    if (resolved) {
      return resolved;
    }
  }

  return "en";
};
