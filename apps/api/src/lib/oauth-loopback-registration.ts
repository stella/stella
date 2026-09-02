/**
 * Dynamic client registration for clients that redirect to a loopback address.
 *
 * `@better-auth/oauth-provider` defaults an unstated `application_type` to
 * `web`, and a web client may not register an `http://` loopback redirect, so
 * registration fails with `invalid_redirect_uri`. MCP clients register the
 * RFC 8252 section 7.3 loopback callback and never send `application_type`,
 * which locks the whole ecosystem out of dynamic registration.
 *
 * A registration whose redirect URIs are all loopback is therefore declared
 * `native` before the provider applies its default. The https requirement is
 * untouched for every genuine non-loopback host, and a request that states its
 * own `application_type` is passed through exactly as sent.
 */

/** Better Auth's registration endpoint, as seen by an auth `before` hook. */
export const OAUTH_CLIENT_REGISTRATION_PATH = "/oauth2/register";

const NATIVE_APPLICATION_TYPE = "native";

/**
 * The exact hosts the provider accepts for a native `http://` redirect. RFC
 * 8252 section 8.3 prefers the two literals, but clients in the wild register
 * `localhost` too and the provider allows it.
 */
const LOOPBACK_REDIRECT_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

/**
 * An RFC 8252 section 7.3 loopback callback: `http://` on a loopback host, with
 * the port chosen by the client at runtime. `https://` loopback, any other
 * host, a trailing-dot `localhost`, and an unparseable URI are all excluded.
 */
export const isLoopbackRedirectUri = (redirectUri: string): boolean => {
  const url = URL.parse(redirectUri);
  return (
    url?.protocol === "http:" && LOOPBACK_REDIRECT_HOSTNAMES.has(url.hostname)
  );
};

type ClientRegistrationBody = {
  application_type?: unknown;
  redirect_uris?: unknown;
};

const isClientRegistrationBody = (
  body: unknown,
): body is ClientRegistrationBody => typeof body === "object" && body !== null;

/**
 * `"native"` when a registration request carries only loopback redirect URIs
 * and states no `application_type`; `undefined` whenever the provider's own
 * default must stand. A mixed list keeps the default: one non-loopback URI on
 * the request is exactly the case the https rule exists for.
 */
export const resolveLoopbackApplicationType = (
  body: unknown,
): typeof NATIVE_APPLICATION_TYPE | undefined => {
  if (!isClientRegistrationBody(body) || body.application_type !== undefined) {
    return undefined;
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return undefined;
  }
  const allLoopback = redirectUris.every(
    (uri) => typeof uri === "string" && isLoopbackRedirectUri(uri),
  );
  return allLoopback ? NATIVE_APPLICATION_TYPE : undefined;
};

type ClientRegistrationHookContext = {
  body?: unknown;
  path?: string | undefined;
};

type LoopbackClientRegistrationOverride = {
  context: { body: { application_type: typeof NATIVE_APPLICATION_TYPE } };
};

/**
 * Better Auth merges a `before` hook's returned `context` into the endpoint
 * context, so naming only `application_type` leaves the rest of the
 * registration body as the client sent it.
 */
export const resolveLoopbackClientRegistrationOverride = (
  ctx: ClientRegistrationHookContext,
): LoopbackClientRegistrationOverride | undefined => {
  if (ctx.path !== OAUTH_CLIENT_REGISTRATION_PATH) {
    return undefined;
  }
  const applicationType = resolveLoopbackApplicationType(ctx.body);
  if (applicationType === undefined) {
    return undefined;
  }
  return { context: { body: { application_type: applicationType } } };
};
