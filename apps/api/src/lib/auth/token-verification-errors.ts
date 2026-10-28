import { isRecord } from "@/api/lib/type-guards";

/**
 * Whether a failure from the provider's `verifyBearerToken` rejects the token
 * itself. A genuine rejection surfaces as a better-call `APIError` with an
 * `UNAUTHORIZED` (401) status: expired tokens, invalid signatures, wrong
 * audience/issuer, no matching key, and a missing payload all take that
 * shape. Anything else (a JWKS fetch error re-thrown as a plain `Error`, a jose
 * JWKS timeout) is an infrastructure fault and must not be reported to the
 * caller as a bad token.
 */
export const isTokenRejectionError = (error: unknown): boolean =>
  isRecord(error) &&
  error["name"] === "APIError" &&
  (error["status"] === "UNAUTHORIZED" || error["statusCode"] === 401);
