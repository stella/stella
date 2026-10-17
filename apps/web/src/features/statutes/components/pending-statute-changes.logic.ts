import { isPublicLegislationPageCountry } from "@stll/api-contract/legislation-publication";
import {
  createStatutePath,
  createStatuteSlug,
} from "@stll/api-contract/statute-route";
import { COUNTRY_ALPHA3_BY_CODE, isCountryCode } from "@stll/country-codes";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

const eliCountrySegment = (country: string): string | null => {
  const countryCode = country.toUpperCase();
  if (!isCountryCode(countryCode)) {
    return null;
  }

  const alpha3 = COUNTRY_ALPHA3_BY_CODE[countryCode];
  return isPublicLegislationPageCountry(alpha3) ? alpha3.toLowerCase() : null;
};

/** An amendment identifier is linked only when it names a usable destination. */
export const resolveAmendmentHref = (
  identifier: string,
): string | undefined => {
  const normalized = identifier.trim().toLowerCase();
  const country = /^eli\/([a-z]{2})\//u.exec(normalized)?.at(1);
  const countrySegment =
    country === undefined ? null : eliCountrySegment(country);
  if (countrySegment !== null) {
    const slug = createStatuteSlug({ eli: normalized, title: "" });
    if (slug !== null) {
      return createStatutePath({
        country: countrySegment,
        slug,
      });
    }
  }

  return sanitizeHref(identifier);
};
