const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A third party's cross-site form POST to one fixed path. */
type CrossSiteFormPost = { origin: string; pathname: string };

type BrowserOriginGuardInput = {
  allowedOrigins: readonly (string | RegExp)[];
  /** Admitted by origin and path only; every other mutation is held to `allowedOrigins`. */
  crossSiteFormPosts: readonly CrossSiteFormPost[];
  method: string;
  origin: string | null;
  pathname: string;
  secFetchSite: string | null;
};

export const isAllowedBrowserOrigin = (
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
  crossSiteFormPosts,
  method,
  origin,
  pathname,
  secFetchSite,
}: BrowserOriginGuardInput): boolean => {
  const normalizedMethod = method.toUpperCase();
  if (SAFE_METHODS.has(normalizedMethod)) {
    return false;
  }
  if (origin !== null) {
    const admittedFormPost =
      normalizedMethod === "POST" &&
      crossSiteFormPosts.some(
        (formPost) =>
          formPost.origin === origin && formPost.pathname === pathname,
      );
    return !admittedFormPost && !isAllowedBrowserOrigin(origin, allowedOrigins);
  }
  return secFetchSite === "same-site" || secFetchSite === "cross-site";
};
