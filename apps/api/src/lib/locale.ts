/**
 * Extract the preferred language from an Accept-Language header.
 *
 * The frontend sends either a simple language string (e.g. "cs") via the auth
 * client's Accept-Language header, or a full formatting tag with Unicode
 * extensions (e.g. "ar-u-ca-gregory-nu-arab"). The parsing also handles
 * standard browser Accept-Language values with quality weights
 * (e.g. "cs,en-US;q=0.9,en;q=0.8").
 */

const SUPPORTED_LANGS = [
  "en",
  "ar",
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

/** Match a single BCP-47 tag (sans quality weight) to a supported language. */
const matchSupportedLang = (tag: string): SupportedLang | undefined => {
  const exact = SUPPORTED_LANGS.find((l) => l === tag);
  if (exact) {
    return exact;
  }
  const prefix = tag.split("-").at(0);
  const match = SUPPORTED_LANGS.find((l) => l === prefix);
  if (match) {
    return match;
  }
  return prefix === "pt" ? "pt-BR" : undefined;
};

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

/**
 * Like extractLangFromRequest, but preserves Unicode (`-u-`) extensions
 * (calendar, numbering system) so server-side Intl formatting matches the
 * client's locale settings. Returns a canonical BCP-47 tag whose base language
 * is supported, or "en".
 */
export const extractFormattingLocale = (
  request: Request | undefined,
): string => {
  const header = request?.headers.get("Accept-Language");
  if (!header) {
    return "en";
  }
  for (const tag of acceptLanguageTags(header)) {
    const match = matchSupportedLang(tag);
    if (!match) {
      continue;
    }
    // The base is supported; keep the full tag (with `-u-` extensions) when it
    // is a well-formed locale, else fall back to the matched base language.
    try {
      return new Intl.Locale(tag).toString();
    } catch {
      return match;
    }
  }
  return "en";
};
