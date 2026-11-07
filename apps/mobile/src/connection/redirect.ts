import { MOBILE_REDIRECT_PATH } from "@stll/api-contract/mobile-client";

/**
 * The path a link names, without scheme, query or fragment. String work
 * rather than `URL`, whose React Native implementation lacks `pathname`.
 */
const pathOf = (link: string): string => {
  const [target = ""] = link.split(/[?#]/u, 1);
  return `/${target.replace(/^[a-z][\d+.a-z-]*:/iu, "").replace(/^\/+/u, "")}`;
};

/**
 * Whether a link the app was opened with is a sign-in redirect. The browser
 * session that started sign-in consumes it; on Android the router receives
 * it too, and it names no screen.
 */
export const isSignInRedirect = (link: string): boolean =>
  pathOf(link) === MOBILE_REDIRECT_PATH;
