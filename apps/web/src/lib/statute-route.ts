/**
 * Jurisdiction the statutes browser opens on when the current route carries
 * none (the shell's statutes link is reachable from country-less pages).
 */
export const STATUTES_DEFAULT_COUNTRY = "cze";

/**
 * Jurisdictions the statutes browser covers, as route segments, with the
 * region code their names are rendered from. Order is the picker's order.
 */
export const STATUTE_COUNTRIES = {
  cze: { region: "CZ" },
  svk: { region: "SK" },
} as const satisfies Record<string, { region: string }>;

export type StatuteCountry = keyof typeof STATUTE_COUNTRIES;

export const isStatuteCountry = (value: string): value is StatuteCountry =>
  Object.hasOwn(STATUTE_COUNTRIES, value);

const COUNTRY_SEGMENT_PATTERN = /^[a-z]{2,3}$/u;

/** Country segment for a statutes URL: lower-case ISO code, or the default. */
export const toStatuteCountrySegment = (country: string | null): string => {
  const segment = country?.trim().toLowerCase() ?? "";

  return COUNTRY_SEGMENT_PATTERN.test(segment)
    ? segment
    : STATUTES_DEFAULT_COUNTRY;
};

export const createStatuteIndexPath = (
  country: string | null,
): `/law/${string}/statutes` =>
  `/law/${toStatuteCountrySegment(country)}/statutes`;

export const createStatutePath = ({
  country,
  documentId,
}: {
  country: string | null;
  documentId: string;
}): `/law/${string}/statutes/${string}` =>
  `${createStatuteIndexPath(country)}/${documentId}`;
