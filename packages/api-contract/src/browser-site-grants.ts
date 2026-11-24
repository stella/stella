import { BROWSER_CONTROL_LIMITS } from "./browser-control";

/**
 * A user's standing approval for browser actions on one website. The key is
 * the exact origin (scheme, host and port), never a host pattern, so a grant
 * for `https://example.com` covers neither `https://www.example.com` nor
 * `http://example.com` nor `https://example.com:8443`.
 *
 * A grant turns a browser step the chat's permission level would ask about
 * into one that runs, on a computer and on stella's models alike
 * (`browser-step-gate.ts`): only when the page the step acts on is the
 * granted origin as the browser itself last reported it, never a URL the
 * model supplied. It never lifts Plan or a sign-in, and never the API's
 * approval gate for `use-browser`: the user's own browser applies it when it
 * answers an approval card.
 */
export const BROWSER_SITE_GRANTS_MAX = 100;

/** Why the API refused to store a website approval. */
export const BROWSER_SITE_GRANT_REFUSAL_CODE = {
  /** The user already allows `BROWSER_SITE_GRANTS_MAX` websites. */
  limitReached: "browser_site_grant_limit_reached",
  /** The address is not a plain HTTPS one, so it names no grantable site. */
  notHttps: "browser_site_grant_not_https",
} as const;

/** Longest stored origin; an origin is a prefix of a URL the extension accepts. */
export const BROWSER_SITE_GRANT_ORIGIN_CHARS = 512;

/**
 * The origin a site grant for `rawUrl` is keyed on, or null when the URL
 * cannot hold one: only HTTPS, without embedded credentials. The origin is
 * the URL parser's own serialization (lowercase host, default port elided),
 * so two spellings of the same site key the same grant.
 */
export const browserSiteGrantOrigin = (rawUrl: string): string | null => {
  if (rawUrl.length > BROWSER_CONTROL_LIMITS.urlChars) {
    return null;
  }
  const url = URL.parse(rawUrl);
  if (
    url?.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.origin.length > BROWSER_SITE_GRANT_ORIGIN_CHARS
  ) {
    return null;
  }
  return url.origin;
};

/**
 * Whether `rawUrl` is on a granted origin. A URL that cannot hold a grant
 * (not HTTPS, credentials, unparsable) is never on one.
 */
export const isOnGrantedBrowserSite = (
  rawUrl: string,
  grantedOrigins: ReadonlySet<string>,
): boolean => {
  const origin = browserSiteGrantOrigin(rawUrl);
  return origin !== null && grantedOrigins.has(origin);
};

/** The host people recognise a site grant by, for labels. */
export const browserSiteGrantHost = (origin: string): string =>
  URL.parse(origin)?.host ?? origin;
