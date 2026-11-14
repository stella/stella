/**
 * The spellings under which a company, tax, VAT or data box identifier is
 * compared. The screening engine compacts each to upper-case letters and
 * digits; this adds the equivalences the engine cannot know:
 *
 *  - a Czech IČO is eight digits, and registers and people drop its leading
 *    zeros, so a five- to seven-digit number is also read zero-padded;
 *  - a Czech legal person's DIČ is "CZ" and its IČO, and a VAT number carries
 *    its country prefix, so "CZ12345678" is also read as "12345678" (likewise
 *    for the Slovak and other EU prefixes, against the bare number).
 *
 * Both the firm's contacts and the screened parties are read through this, so
 * every equivalence holds in both directions.
 */
const COUNTRY_PREFIXED = /^([A-Z]{2})(\d{5,12})$/u;
const SHORT_NUMBER = /^\d{5,7}$/u;
const ICO_DIGITS = 8;

const compact = (value: string): string =>
  value.toUpperCase().replaceAll(/[^\p{L}\p{N}]/gu, "");

export const identifierVariants = (value: string): string[] => {
  const key = compact(value);
  if (key === "") {
    return [];
  }
  const variants = new Set([key]);
  const prefixed = COUNTRY_PREFIXED.exec(key);
  const digits = prefixed?.[2] ?? key;
  variants.add(digits);
  if (SHORT_NUMBER.test(digits)) {
    variants.add(digits.padStart(ICO_DIGITS, "0"));
  }
  return [...variants];
};
