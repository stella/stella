/**
 * The one place that knows what the session cookie is called.
 *
 * The name is produced in one direction and consumed in another: `auth.ts`
 * hands better-auth a `cookiePrefix` and a `useSecureCookies` flag, while
 * readers outside that config — agent auth, the smoke-session store, the dev
 * seed — have to reconstruct the name better-auth ends up using. Every reader
 * currently rebuilds that string by hand, so the rule lives in four places and
 * is kept in step by discipline alone. A disagreement surfaces only as an
 * unexplained 401, which is expensive to trace.
 *
 * Two rules have to be mirrored, and both are easy to forget:
 *   - the prefix is `BETTER_AUTH_COOKIE_PREFIX` in dev (the dev runner sets it
 *     per worktree so two local APIs cannot read each other's cookies), and
 *     better-auth's own default otherwise;
 *   - better-auth prepends `__Secure-` whenever `useSecureCookies` is on, which
 *     `auth.ts` ties to `!env.isDev`.
 *
 * Lives apart from `auth.ts` on purpose: importing that module constructs the
 * auth client, and a script that only needs a cookie name must not pay for it.
 */

import { env } from "@/api/env";

/** better-auth's own default when no prefix is configured. */
const BETTER_AUTH_DEFAULT_PREFIX = "better-auth";

/** The prefix used when running locally without an explicit override. */
const STELLA_DEV_PREFIX = "stella-dev";

/** better-auth prepends this whenever `useSecureCookies` is on. */
const SECURE_COOKIE_PREFIX = "__Secure-";

const SESSION_COOKIE_SUFFIX = ".session_token";

/**
 * What `auth.ts` passes better-auth as `cookiePrefix`.
 *
 * `undefined` outside dev is deliberate: production takes better-auth's own
 * default, which makes `BETTER_AUTH_COOKIE_PREFIX` a local-only knob.
 */
export const authCookiePrefixOverride = (): string | undefined =>
  env.isDev ? (env.BETTER_AUTH_COOKIE_PREFIX ?? STELLA_DEV_PREFIX) : undefined;

/**
 * The session cookie name that configuration actually produces. Read this
 * rather than rebuilding the string.
 */
export const sessionCookieName = (): string => {
  const prefix = authCookiePrefixOverride() ?? BETTER_AUTH_DEFAULT_PREFIX;
  // `useSecureCookies` is `!env.isDev`, so the secure prefix appears exactly
  // when the override does not.
  const securePrefix = env.isDev ? "" : SECURE_COOKIE_PREFIX;
  return `${securePrefix}${prefix}${SESSION_COOKIE_SUFFIX}`;
};
