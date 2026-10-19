import type { InvoiceLanguage } from "@stll/api-contract";

const LANGUAGE_BY_COUNTRY: Readonly<
  Record<string, InvoiceLanguage | undefined>
> = {
  AE: "ar",
  AR: "es",
  AT: "de",
  BR: "pt-BR",
  CZ: "cs",
  CZE: "cs",
  DE: "de",
  DEU: "de",
  EE: "et",
  ES: "es",
  FR: "fr",
  HU: "hu",
  LT: "lt",
  LV: "lv",
  PL: "pl",
  PT: "pt-BR",
  SA: "ar",
  SK: "sk",
  SVK: "sk",
};

/** Resolve a supported invoice language from an ISO seller country code. */
export const invoiceLanguageForCountry = (
  country: string | null,
): InvoiceLanguage => {
  if (country === null) {
    return "en";
  }
  const normalized = country.trim().toUpperCase();
  return LANGUAGE_BY_COUNTRY[normalized] ?? "en";
};
