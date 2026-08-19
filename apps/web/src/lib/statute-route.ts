/**
 * Jurisdiction the statutes browser opens on when the current route carries
 * none (the shell's statutes link is reachable from country-less pages).
 */
export const STATUTES_DEFAULT_COUNTRY = "cze";

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
