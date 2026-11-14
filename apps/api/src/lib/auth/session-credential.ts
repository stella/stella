/**
 * Whether a session lookup can be skipped because the request carries
 * nothing Better Auth resolves a session from.
 *
 * Better Auth's `getSession` (cookie cache on) answers `null` before it reads
 * anything when the session cookie is absent, so on a request without a
 * credential the lookup is pure cost; on an anonymous or refused request it
 * dominates the pipeline. The credential is its session cookie.
 */

/** What this check reads from an auth instance. */
type SessionCredentialAuth = {
  readonly $context: Promise<{
    readonly authCookies: { readonly sessionToken: { readonly name: string } };
    readonly options: {
      readonly session?: {
        readonly cookieCache?: { readonly enabled?: boolean };
      };
    };
  }>;
};

/**
 * Each auth instance's session cookie name, as Better Auth itself names it,
 * or `null` when its cookie cache is off: `getSession` then also expires a
 * stale cache cookie on a request without a session, so it must always run.
 */
const skippableCookieByAuth = new WeakMap<
  SessionCredentialAuth,
  string | null
>();

export const skippableSessionCookieOf = async (
  auth: SessionCredentialAuth,
): Promise<string | null> => {
  const known = skippableCookieByAuth.get(auth);
  if (known !== undefined) {
    return known;
  }
  const { authCookies, options } = await auth.$context;
  const name =
    options.session?.cookieCache?.enabled === true
      ? authCookies.sessionToken.name
      : null;
  skippableCookieByAuth.set(auth, name);
  return name;
};

/**
 * Whether `headers` carry the session cookie.
 * The cookie match is deliberately loose: a false positive only costs the
 * lookup, a false negative would refuse a signed-in caller.
 */
export const carriesSessionCredential = (
  headers: Headers,
  sessionCookie: string,
): boolean => headers.get("cookie")?.includes(`${sessionCookie}=`) === true;
