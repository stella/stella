/**
 * How long a browser may reuse the preflight of a public, bearer-or-anonymous
 * endpoint (the MCP transport and the OAuth discovery documents). Browsers cap
 * it lower on their own; the value only has to outlast a working session.
 */
export const PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS = 86_400;

const ALLOW_CREDENTIALS_HEADER = "access-control-allow-credentials";
const VARY_HEADER = "vary";
const ORIGIN_VARY_TOKEN = "origin";

type ResponseHeaders = {
  headers: Record<string, string | number | boolean | undefined>;
};

/**
 * The global CORS layer stamps `Access-Control-Allow-Credentials: true` on every
 * response as a default header. These endpoints answer
 * `Access-Control-Allow-Origin: *` and never read cookies, and a browser refuses
 * a credentialed request answered with a wildcard origin, so the combination is
 * dropped. Matched case-insensitively: the header comes from a plugin default,
 * and a casing change there must not silently restore the pairing.
 */
export const dropCredentialedCors = (set: ResponseHeaders) => {
  set.headers = Object.fromEntries(
    Object.entries(set.headers).filter(
      ([key]) => key.toLowerCase() !== ALLOW_CREDENTIALS_HEADER,
    ),
  );
};

/**
 * A public document answered with `Access-Control-Allow-Origin: *` is the same
 * bytes for every origin, so the `Vary: Origin` the global CORS layer adds only
 * splits a shared cache into one copy per calling origin. Other `Vary` tokens
 * are kept.
 */
export const dropOriginBoundCors = (set: ResponseHeaders) => {
  dropCredentialedCors(set);
  set.headers = Object.fromEntries(
    Object.entries(set.headers).flatMap(([key, value]) => {
      if (key.toLowerCase() !== VARY_HEADER || typeof value !== "string") {
        return [[key, value]];
      }
      const kept = value
        .split(",")
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length > 0 && token.toLowerCase() !== ORIGIN_VARY_TOKEN,
        );
      return kept.length === 0 ? [] : [[key, kept.join(", ")]];
    }),
  );
};
