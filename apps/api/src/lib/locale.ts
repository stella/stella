/**
 * Extract the preferred language from an Accept-Language header.
 * Returns the first supported language prefix, or "en".
 *
 * The frontend sends a simple language string (e.g. "cs") via
 * the auth client's Accept-Language header. The parsing also
 * handles standard browser Accept-Language values with quality
 * weights (e.g. "cs,en-US;q=0.9,en;q=0.8").
 */

const SUPPORTED_LANGS = [
  "en",
  "cs",
  "de",
  "es",
  "et",
  "fr",
  "hu",
  "lt",
  "lv",
  "pl",
  "pt-BR",
  "sk",
] as const;

export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export const extractLangFromRequest = (
  request: Request | undefined,
): SupportedLang => {
  const header = request?.headers.get("Accept-Language");

  if (!header) {
    return "en";
  }

  for (const part of header.split(",")) {
    const lang = part.split(";")[0]?.trim().replace("_", "-");
    if (!lang) {
      continue;
    }

    const exactMatch = SUPPORTED_LANGS.find((l) => l === lang);
    if (exactMatch) {
      return exactMatch;
    }

    const prefix = lang.split("-").at(0);
    const match = SUPPORTED_LANGS.find((l) => l === prefix);

    if (match) {
      return match;
    }

    if (prefix === "pt") {
      return "pt-BR";
    }
  }

  return "en";
};
