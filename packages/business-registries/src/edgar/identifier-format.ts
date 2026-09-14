export const EIN_DASHED_TOKEN = "EIN dashed" as const;

const NINE_DIGITS_RE = /^\d{9}$/u;

/** The IRS employer identification number is written "XX-XXXXXXX" wherever it
 *  identifies a party — including on the cover page of the filings EDGAR
 *  itself hosts — but the submissions API returns it unpunctuated
 *  ("942404110"). Anything else (already dashed, malformed) is returned
 *  untouched, which also makes the punctuation idempotent.
 *
 *  https://www.irs.gov/businesses/employer-identification-number */
export const formatEinDashed = (ein: string): string =>
  NINE_DIGITS_RE.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein;
