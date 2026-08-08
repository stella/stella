/**
 * The one place that decides what the session cookie is called.
 *
 * `auth.ts` configures better-auth and everything that has to *read* the
 * resulting cookie — agent auth, the smoke-session store, the dev seed — sits
 * outside that config and cannot import it. Each of them used to rebuild the
 * name by hand, so the rule lived in four places and stayed correct by
 * discipline; a disagreement surfaces only as an unexplained 401.
 *
 * The policy below is the producer, not a reconstruction of one. `auth.ts`
 * feeds better-auth from these exact values, which is what keeps the readers
 * honest:
 *   - the prefix is always passed explicitly, so better-auth's own default
 *     never enters the picture and cannot change under us on an upgrade;
 *   - `useSecureCookies` travels with it, because better-auth prepends
 *     `__Secure-` exactly when that flag is on. Deriving the flag separately in
 *     each reader is how the secure prefix goes missing.
 *
 * Lives apart from `auth.ts` on purpose: importing that module constructs the
 * auth client, and a script that only needs a cookie name must not pay for it.
 */

import { env } from "@/api/env";

/**
 * The prefix used outside dev. Passed to better-auth explicitly rather than
 * relying on its default being this value.
 */
const PRODUCTION_PREFIX = "better-auth";

/** The prefix used locally when nothing overrides it. */
const STELLA_DEV_PREFIX = "stella-dev";

/** better-auth prepends this whenever `useSecureCookies` is on. */
const SECURE_COOKIE_PREFIX = "__Secure-";

const SESSION_COOKIE_SUFFIX = ".session_token";

type AuthCookiePolicy = {
  cookiePrefix: string;
  useSecureCookies: boolean;
};

/**
 * The cookie settings better-auth is configured with. `auth.ts` spreads this
 * into `advanced`; readers derive names from it. There is no third source.
 *
 * `BETTER_AUTH_COOKIE_PREFIX` is a dev-only knob: the dev runner sets it per
 * worktree so two local APIs cannot read each other's cookies.
 */
export const authCookiePolicy = (): AuthCookiePolicy => ({
  cookiePrefix: env.isDev
    ? (env.BETTER_AUTH_COOKIE_PREFIX ?? STELLA_DEV_PREFIX)
    : PRODUCTION_PREFIX,
  useSecureCookies: !env.isDev,
});

/**
 * The cookie name an API on `port` uses. The dev runner sets a per-port prefix
 * and injects it only into its own children, so a script started outside it
 * cannot read the value from its own environment.
 */
export const sessionCookieNameForDevPort = (port: string): string =>
  `${STELLA_DEV_PREFIX}-${port}${SESSION_COOKIE_SUFFIX}`;

/** The session cookie name that {@link authCookiePolicy} produces. */
export const sessionCookieName = (): string => {
  const { cookiePrefix, useSecureCookies } = authCookiePolicy();
  const securePrefix = useSecureCookies ? SECURE_COOKIE_PREFIX : "";
  return `${securePrefix}${cookiePrefix}${SESSION_COOKIE_SUFFIX}`;
};
