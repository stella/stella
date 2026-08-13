const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type BrowserOriginGuardInput = {
  allowedOrigins: readonly (string | RegExp)[];
  method: string;
  origin: string | null;
  secFetchSite: string | null;
};

const originMatches = (
  origin: string,
  allowedOrigins: BrowserOriginGuardInput["allowedOrigins"],
): boolean =>
  allowedOrigins.some((allowed) =>
    typeof allowed === "string" ? allowed === origin : allowed.test(origin),
  );

/**
 * Reject browser mutations from an origin the API does not trust. Requests
 * without browser provenance remain available to webhooks, CLI, and agents.
 */
export const shouldRejectBrowserMutation = ({
  allowedOrigins,
  method,
  origin,
  secFetchSite,
}: BrowserOriginGuardInput): boolean => {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return false;
  }
  if (origin !== null) {
    return !originMatches(origin, allowedOrigins);
  }
  return secFetchSite === "same-site" || secFetchSite === "cross-site";
};
