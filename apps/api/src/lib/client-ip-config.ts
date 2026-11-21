export const SIGNUP_RATE_LIMIT_IP_SOURCE = {
  direct: "direct",
  trustedProxy: "trusted_proxy",
} as const;

export type SignupRateLimitIpSource =
  (typeof SIGNUP_RATE_LIMIT_IP_SOURCE)[keyof typeof SIGNUP_RATE_LIMIT_IP_SOURCE];

/** The header the API sets to the resolved client address on every request. */
export const AUTH_CLIENT_ADDRESS_HEADER = "x-stella-client-address";

/*
 * Headers the edge adds. The deployment configuration uses the same names;
 * rename a header on both sides in one change.
 *
 *   header                     API env key
 *   x-stella-origin-verify     STELLA_ORIGIN_VERIFY_SECRET
 *                             STELLA_ORIGIN_VERIFY_SECRET_PREVIOUS
 *   cloudfront-viewer-address  STELLA_CLIENT_ADDRESS_HEADER
 */

/** The header the edge adds to prove a request came through it. */
export const ORIGIN_VERIFY_HEADER = "x-stella-origin-verify";
