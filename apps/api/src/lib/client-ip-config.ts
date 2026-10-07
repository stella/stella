export const SIGNUP_RATE_LIMIT_IP_SOURCE = {
  direct: "direct",
  trustedProxy: "trusted_proxy",
} as const;

export type SignupRateLimitIpSource =
  (typeof SIGNUP_RATE_LIMIT_IP_SOURCE)[keyof typeof SIGNUP_RATE_LIMIT_IP_SOURCE];

/** The header the API sets to the resolved client address on every request. */
export const AUTH_CLIENT_ADDRESS_HEADER = "x-stella-client-address";

/*
 * Headers the edge adds, a contract with the infrastructure repository
 * (modules/cdn/tests/frontend-viewer-address.tftest.hcl and
 * modules/ecs/tests/client-address.tftest.hcl hold the same table). Rename a
 * header on both sides in one change.
 *
 *   header                     added by                        API env key
 *   x-stella-origin-verify     API distribution                STELLA_ORIGIN_VERIFY_SECRET
 *   cloudfront-viewer-address  API distribution                STELLA_CLIENT_ADDRESS_HEADER
 *   x-stella-frontend-verify   frontend distribution           STELLA_FRONTEND_VERIFY_SECRET
 *   x-stella-viewer-address    frontend /api/* function, bare  (none; read beside the line above)
 */

/** The header the edge adds to prove a request came through it. */
export const ORIGIN_VERIFY_HEADER = "x-stella-origin-verify";

/**
 * The header the frontend distribution adds to prove the frontend address
 * header came from its own /api/* function.
 */
export const FRONTEND_VERIFY_HEADER = "x-stella-frontend-verify";

/**
 * The header the frontend distribution's /api/* function sets to the
 * browser's bare address, replacing any value the browser sent.
 */
export const FRONTEND_ADDRESS_HEADER = "x-stella-viewer-address";
