import { AUTH_API_PATH } from "@/api/lib/auth/auth-paths";

/**
 * Apple answers an authorization with `response_mode=form_post`: a cross-site
 * POST from its own origin to the callback. Better Auth's callback answers
 * that POST only with a redirect to the same callback as a GET, and the GET
 * is where the signed state cookie and the code exchange are checked. The
 * POST therefore grants nothing a plain link to the GET could not, which is
 * why Apple's origin is admitted for this one request and nowhere else.
 */
export const APPLE_FORM_POST = {
  origin: "https://appleid.apple.com",
  pathname: `${AUTH_API_PATH}/callback/apple`,
} as const;

/** Whether the request is a POST to Apple's callback, whatever its origin. */
export const isAppleCallbackPost = (request: Request | undefined): boolean =>
  request?.method === "POST" &&
  URL.parse(request.url)?.pathname === APPLE_FORM_POST.pathname;

/**
 * Better Auth's trusted origins for a request: Apple's origin joins them only
 * for its `form_post` callback. Better Auth checks the origin of a POST that
 * carries any cookie, and a cross-site POST still carries the site's
 * `SameSite=None` cookies (a load balancer's, for one).
 */
export const withAppleFormPostOrigin = (
  request: Request | undefined,
  origins: string[],
): string[] =>
  isAppleCallbackPost(request) ? [...origins, APPLE_FORM_POST.origin] : origins;
