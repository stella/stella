// A redirect target is safe only when it is a relative path whose second
// character is neither "/" nor "\": browsers normalize both "//host" and
// "/\host" (and "\/host") to a protocol-relative external origin, so the
// "//"-only check is insufficient to prevent open redirects. URL parsers also
// drop tabs and newlines ("/\t/host" reads as "//host"), so control characters
// are refused outright.
const RELATIVE_PATH = /^\/(?![/\\])/u;

const REDIRECT_BASE = "https://redirect.invalid";

/**
 * The target as the browser will resolve it: dot segments ("/x/../auth",
 * "/x/%2e%2e/auth") removed and backslashes read as slashes. The resolved
 * form is checked again, so "/x/..//host" cannot become "//host". `undefined`
 * when the target is not a same-origin relative path.
 */
export const canonicalRedirectPath = (value: string): string | undefined => {
  if (
    !RELATIVE_PATH.test(value) ||
    /\p{Cc}/u.test(value) ||
    !URL.canParse(value, REDIRECT_BASE)
  ) {
    return undefined;
  }
  const url = new URL(value, REDIRECT_BASE);
  const canonical = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === REDIRECT_BASE && RELATIVE_PATH.test(canonical)
    ? canonical
    : undefined;
};
