import { type CountryCode, isCountryCode } from "@stll/country-codes";

/**
 * Added by the CDN at the edge when the distribution's origin request
 * policy forwards CloudFront's generated headers. Absent when the API is
 * reached directly (local dev, tests, self-hosted deployments without a
 * geo-aware proxy), in which case no country is recorded.
 */
export const VIEWER_COUNTRY_HEADER = "cloudfront-viewer-country";

type RequestContextLike = {
  request?: Request | undefined;
  headers?: Headers | undefined;
};

/**
 * Resolve the signup country advertised by the edge, used to suggest
 * practice jurisdictions during onboarding. Returns undefined for any
 * value that is not a known ISO 3166-1 alpha-2 code (CloudFront also
 * emits pseudo-codes such as "ZZ" for unknown locations).
 */
export const detectedCountryFromRequestContext = (
  ctx: RequestContextLike | null | undefined,
): CountryCode | undefined => {
  const raw =
    ctx?.request?.headers.get(VIEWER_COUNTRY_HEADER) ??
    ctx?.headers?.get(VIEWER_COUNTRY_HEADER);
  if (!raw) {
    return undefined;
  }
  const candidate = raw.toUpperCase();
  return isCountryCode(candidate) ? candidate : undefined;
};
