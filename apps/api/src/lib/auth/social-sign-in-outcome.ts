import type { SocialSignInOutcome } from "@/api/lib/observability/request-metrics";
import { isRecord } from "@/api/lib/type-guards";

const KNOWN_PROVIDERS = new Set(["google", "microsoft"]);

/** The provider dimension: a known provider id, otherwise `other`. */
export const socialSignInProvider = (provider: unknown): string =>
  typeof provider === "string" && KNOWN_PROVIDERS.has(provider)
    ? provider
    : "other";

/**
 * Reads the outcome from the redirect the callback answers with. Better Auth
 * reports every callback failure as a redirect to its error URL carrying an
 * `error` code, and a completed sign-in or link as a redirect elsewhere. Only
 * a redirect to the error URL counts as a failure, so a caller-chosen
 * callback URL cannot pose as one.
 */
export const classifySocialCallback = (
  returned: unknown,
  errorUrl: string,
): SocialSignInOutcome => {
  // Better Auth's redirect is an APIError: a numeric `statusCode` and the
  // response `headers` carrying `location`.
  if (!isRecord(returned)) {
    return "failed";
  }
  const headers = returned["headers"];
  const location = headers instanceof Headers ? headers.get("location") : null;
  if (returned["statusCode"] !== 302 || location === null) {
    return "failed";
  }
  const target = URL.parse(location, errorUrl);
  const expected = URL.parse(errorUrl);
  if (
    target === null ||
    expected === null ||
    target.origin !== expected.origin ||
    target.pathname !== expected.pathname
  ) {
    return "completed";
  }
  switch (target.searchParams.get("error") ?? "") {
    case "account_not_linked":
      return "account_not_linked";
    case "identity_not_allowed":
      return "identity_not_allowed";
    default:
      return "failed";
  }
};
