import {
  oauthProvider,
  type ClientDiscovery,
  type OAuthOptions,
  type OAuthProviderExtension,
  type Scope,
  type SchemaClient,
} from "@better-auth/oauth-provider";
import type { HookEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { panic } from "better-result";

import type { McpOAuthScope } from "@stll/api-contract";

import { isVerifiedClientMetadataDocument } from "@/api/lib/auth/oauth-consent-info";
import { OAUTH_CLIENT_REGISTRATION_PATH } from "@/api/lib/oauth-loopback-registration";
import { isRecord } from "@/api/lib/type-guards";

export const OAUTH_REGISTRATION_SCOPE_POLICY = {
  openid: "open",
  profile: "open",
  email: "open",
  offline_access: "open",
  "stella:search": "open",
  "stella:read": "open",
  "stella:templates": "open",
  "stella:documents_write": "open",
  "stella:matters_write": "open",
  "stella:contacts_write": "open",
  "stella:chat": "open",
  "stella:knowledge_write": "open",
  "stella:billing_write": "open",
  "stella:admin_read": "elevated",
  "stella:admin_write": "elevated",
  "stella:onboarding": "open",
  "stella:skills": "open",
  "stella:external_mcps": "elevated",
  "stella:feedback": "open",
  "stella:search_anonymized": "open",
  "stella:read_anonymized": "open",
  "stella:templates_anonymized": "open",
} as const satisfies Record<McpOAuthScope, "open" | "elevated">;

export const OPEN_REGISTRATION_SCOPES = Object.entries(
  OAUTH_REGISTRATION_SCOPE_POLICY,
).flatMap(([scope, policy]) => (policy === "open" ? [scope] : []));

const ELEVATED_REGISTRATION_SCOPES = new Set(
  Object.entries(OAUTH_REGISTRATION_SCOPE_POLICY).flatMap(([scope, policy]) =>
    policy === "elevated" ? [scope] : [],
  ),
);

const OAUTH_AUTHORIZATION_PATH = "/oauth2/authorize";

/**
 * How Stella treats every OAuth provider endpoint. Every endpoint the
 * provider mounts must be listed (enforced by a test), so an endpoint added
 * upstream needs a decision before it ships.
 *
 * - `scope-policy`: runs through `grantableScopes` below.
 * - `disabled`: not reachable over HTTP (`disabledPaths`); Stella has no
 *   caller.
 * - `server-only`: the provider refuses it over HTTP.
 * - `no-scope-change`: neither creates nor edits clients, and can only keep
 *   or narrow scopes already decided by the policy.
 */
export const OAUTH_ENDPOINT_POLICY = {
  [OAUTH_AUTHORIZATION_PATH]: "scope-policy",
  [OAUTH_CLIENT_REGISTRATION_PATH]: "scope-policy",
  "/oauth2/create-client": "disabled",
  "/oauth2/update-client": "disabled",
  "/oauth2/client/rotate-secret": "disabled",
  "/oauth2/delete-client": "disabled",
  "/oauth2/update-consent": "disabled",
  "/admin/oauth2/create-client": "server-only",
  "/admin/oauth2/update-client": "server-only",
  "/admin/oauth2/resources": "server-only",
  "/admin/oauth2/resources/:identifier": "server-only",
  "/admin/oauth2/resources/:identifier/clients/:client_id": "server-only",
  "/oauth2/consent": "no-scope-change",
  "/oauth2/continue": "no-scope-change",
  "/oauth2/token": "no-scope-change",
  "/oauth2/introspect": "no-scope-change",
  "/oauth2/revoke": "no-scope-change",
  "/oauth2/userinfo": "no-scope-change",
  "/oauth2/end-session": "no-scope-change",
  "/oauth2/end-session/confirm": "no-scope-change",
  "/oauth2/get-client": "no-scope-change",
  "/oauth2/public-client": "no-scope-change",
  "/oauth2/public-client-prelogin": "no-scope-change",
  "/oauth2/get-clients": "no-scope-change",
  "/oauth2/get-consent": "no-scope-change",
  "/oauth2/get-consents": "no-scope-change",
  "/oauth2/delete-consent": "no-scope-change",
  "/oauth2/consent-info": "no-scope-change",
} as const satisfies Record<
  string,
  "scope-policy" | "disabled" | "server-only" | "no-scope-change"
>;

export const OAUTH_DISABLED_PATHS = Object.entries(
  OAUTH_ENDPOINT_POLICY,
).flatMap(([path, policy]) => (policy === "disabled" ? [path] : []));

export const OAUTH_SCOPE_POLICY_PATHS: ReadonlySet<string> = new Set(
  Object.entries(OAUTH_ENDPOINT_POLICY).flatMap(([path, policy]) =>
    policy === "scope-policy" ? [path] : [],
  ),
);

export type OAuthScopePolicyContext = {
  /** Stella's own https origins (see `getVerifiedOAuthOrigins`). */
  readonly verifiedOrigins: readonly string[];
  /** The provider's scope list, its default for a client without one. */
  readonly providerScopes: readonly string[];
};

/** What the scope decision reads of a client (a stored one or a candidate). */
export type OAuthScopeClient = {
  readonly clientId: string;
  readonly clientDiscoveryId?: string | null | undefined;
  readonly scopes?: readonly string[] | undefined;
};

/**
 * The scopes an authorization for `client` may carry. `requested` is the
 * request's scope list, or `undefined` when the request names none, in which
 * case the client's own scope list (or the provider's) applies. Elevated
 * scopes remain only for a client identified by a verified client metadata
 * document.
 */
export const grantableScopes = (
  client: OAuthScopeClient,
  requested: readonly string[] | undefined,
  policy: OAuthScopePolicyContext,
): string[] => {
  const candidates = requested ?? client.scopes ?? policy.providerScopes;
  const mayHoldElevated =
    Boolean(client.clientDiscoveryId) &&
    isVerifiedClientMetadataDocument(client.clientId, policy.verifiedOrigins);
  return candidates.filter(
    (scope) => mayHoldElevated || !ELEVATED_REGISTRATION_SCOPES.has(scope),
  );
};

/** Mirrors the provider's choice of parameter source for `/oauth2/authorize`. */
const readsAuthorizationBody = (ctx: {
  readonly method?: string | undefined;
}): boolean => {
  if (ctx.method !== "POST") {
    return false;
  }
  const settings: unknown = Reflect.get(ctx, "authorizeSettings");
  return (
    settings === undefined ||
    settings === null ||
    (isRecord(settings) && settings["isAuthorize"] === true)
  );
};

/** A hook result that leaves the request as it is. */
const UNCHANGED = { context: {} };

const createScopePolicyMiddleware = (
  policy: OAuthScopePolicyContext,
  discoveries: readonly ClientDiscovery[],
) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === OAUTH_CLIENT_REGISTRATION_PATH) {
      const body: unknown = ctx.body;
      if (!isRecord(body) || typeof body["scope"] !== "string") {
        return UNCHANGED;
      }
      const downscopedScope = body["scope"]
        .split(" ")
        .filter((scope) => !ELEVATED_REGISTRATION_SCOPES.has(scope))
        .join(" ");
      return { context: { body: { scope: downscopedScope } } };
    }
    if (ctx.path !== OAUTH_AUTHORIZATION_PATH) {
      return UNCHANGED;
    }
    const fromBody = readsAuthorizationBody(ctx);
    const parameters: unknown = fromBody ? ctx.body : ctx.query;
    if (!isRecord(parameters) || typeof parameters["client_id"] !== "string") {
      return UNCHANGED;
    }
    const clientId = parameters["client_id"];
    const scope = parameters["scope"];
    if (scope !== undefined && typeof scope !== "string") {
      // The provider refuses a non-string scope outright.
      return UNCHANGED;
    }
    const requested =
      scope === undefined
        ? undefined
        : scope.split(" ").filter((value) => value.length > 0);
    const stored = await ctx.context.adapter.findOne<
      SchemaClient<readonly Scope[]>
    >({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    if (!stored && requested === undefined) {
      // A client not stored yet is resolved by a discovery, which applies
      // the same policy to the scope list the provider falls back to.
      return UNCHANGED;
    }
    const client: OAuthScopeClient = stored ?? {
      clientId,
      clientDiscoveryId:
        discoveries.find((discovery) => discovery.matches(clientId))?.id ??
        null,
      scopes: undefined,
    };
    const grantable = grantableScopes(client, requested, policy).join(" ");
    if (grantable === scope) {
      return UNCHANGED;
    }
    return fromBody
      ? { context: { body: { scope: grantable } } }
      : { context: { query: { scope: grantable } } };
  });

const withScopePolicy = (
  discovery: ClientDiscovery,
  policy: OAuthScopePolicyContext,
): ClientDiscovery => ({
  ...discovery,
  resolve: async (ctx, clientId, existing) => {
    const client = await discovery.resolve(ctx, clientId, existing);
    return client
      ? { ...client, scopes: grantableScopes(client, undefined, policy) }
      : null;
  },
});

const extensionsWithScopePolicy = (
  extensions: readonly OAuthProviderExtension[],
  policy: OAuthScopePolicyContext,
): OAuthProviderExtension[] =>
  extensions.map((extension) => {
    const { clientDiscovery } = extension;
    if (!clientDiscovery) {
      return extension;
    }
    return {
      ...extension,
      clientDiscovery: Array.isArray(clientDiscovery)
        ? clientDiscovery.map((discovery) => withScopePolicy(discovery, policy))
        : withScopePolicy(clientDiscovery, policy),
    };
  });

export const createStellaOAuthProvider = <
  O extends OAuthOptions<Scope[]> &
    Required<Pick<OAuthOptions<Scope[]>, "scopes" | "extensions">>,
>(
  options: O,
  { verifiedOrigins }: { verifiedOrigins: readonly string[] },
) => {
  if (options.requestUriResolver) {
    // The scope policy reads the request's own parameters; a resolved
    // request object would replace them after the policy ran.
    panic("OAuth request_uri resolution is not supported");
  }
  const policy: OAuthScopePolicyContext = {
    verifiedOrigins,
    providerScopes: options.scopes,
  };
  const extensions = extensionsWithScopePolicy(options.extensions, policy);
  const policyOptions: O = { ...options, extensions };
  const provider = oauthProvider(policyOptions);
  // Registration has its own capability policy; discovery retains the
  // provider's policy. Both endpoints use the provider's persistence path.
  const registration = oauthProvider({
    ...policyOptions,
    clientRegistrationDefaultScopes: OPEN_REGISTRATION_SCOPES,
    clientRegistrationAllowedScopes: OPEN_REGISTRATION_SCOPES,
  });
  const discoveries = extensions.flatMap((extension) => {
    const { clientDiscovery } = extension;
    if (!clientDiscovery) {
      return [];
    }
    return Array.isArray(clientDiscovery) ? clientDiscovery : [clientDiscovery];
  });
  return {
    ...provider,
    hooks: {
      ...provider.hooks,
      before: [
        ...provider.hooks.before,
        {
          matcher: (ctx: HookEndpointContext) =>
            OAUTH_SCOPE_POLICY_PATHS.has(ctx.path ?? ""),
          handler: createScopePolicyMiddleware(policy, discoveries),
        },
      ],
    },
    endpoints: {
      ...provider.endpoints,
      registerOAuthClient: registration.endpoints.registerOAuthClient,
    },
  };
};
