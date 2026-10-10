import { getCurrentAuthEndpointContext } from "@better-auth/core/context";
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
import {
  isLoopbackRedirectUri,
  OAUTH_CLIENT_REGISTRATION_PATH,
} from "@/api/lib/oauth-loopback-registration";
import {
  createAuthRequestBudgetMiddleware,
  isAuthRequestBudgetPath,
} from "@/api/lib/rate-limit/auth-request-budget";
import type { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import { isRecord } from "@/api/lib/type-guards";

export const OAUTH_REGISTRATION_SCOPE_POLICY = {
  openid: "open",
  profile: "open",
  email: "open",
  offline_access: "open",
  "stella:search": "open",
  "stella:read": "open",
  "stella:law_read": "open",
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

const isNativeRedirectUri = (redirectUri: string): boolean => {
  const url = URL.parse(redirectUri);
  return (
    isLoopbackRedirectUri(redirectUri) ||
    (url !== null && url.protocol !== "https:" && url.protocol !== "http:")
  );
};

/** RFC 8252 §8.6: a native redirect requires a fresh public-client grant. */
export const requiresNativeClientConsent = (
  client: Pick<SchemaClient<readonly Scope[]>, "tokenEndpointAuthMethod">,
  redirectUri: string,
): boolean => {
  if (client.tokenEndpointAuthMethod !== "none") {
    return false;
  }
  return isNativeRedirectUri(redirectUri);
};

const nativeConsentPrompt = (
  client: Pick<
    SchemaClient<readonly Scope[]>,
    "tokenEndpointAuthMethod"
  > | null,
  parameters: Record<string, unknown>,
): string | undefined => {
  const redirectUri = parameters["redirect_uri"];
  const prompt = parameters["prompt"];
  if (
    client === null ||
    typeof redirectUri !== "string" ||
    !requiresNativeClientConsent(client, redirectUri)
  ) {
    return undefined;
  }
  if (
    prompt !== undefined &&
    (typeof prompt !== "string" || prompt.trim().length === 0)
  ) {
    return undefined;
  }
  // The consent endpoint consumes this signed prompt before issuing a code.
  // Login and account-selection prompts survive. Non-interactive requests use
  // the provider's interaction-required response through the post-login gate.
  const prompts =
    prompt === undefined
      ? []
      : prompt
          .split(" ")
          .map((value) => value.trim())
          .filter(Boolean);
  if (prompts.length > 0 && prompts.every((value) => value === "none")) {
    return "none";
  }
  return [...new Set([...prompts, "consent"])].join(" ");
};

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

/** Consent and login continuations dispatch authorize with explicit settings. */
const isInitialAuthorization = (ctx: object): boolean => {
  const settings: unknown = Reflect.get(ctx, "authorizeSettings");
  return (
    settings === undefined ||
    settings === null ||
    (isRecord(settings) && settings["isAuthorize"] === true)
  );
};

/** Mirrors the provider's choice of parameter source for `/oauth2/authorize`. */
const readsAuthorizationBody = (ctx: {
  readonly method?: string | undefined;
}): boolean => ctx.method === "POST" && isInitialAuthorization(ctx);

/** A hook result that leaves the request as it is. */
const UNCHANGED = { context: {} };

type NativeAuthorizationClientOptions = {
  clientId: string;
  stored: SchemaClient<Scope[]> | null;
  redirectUri: unknown;
  discoveries: readonly ClientDiscovery[];
};

const resolveNativeAuthorizationClient = async (
  ctx: Parameters<ClientDiscovery["resolve"]>[0],
  {
    clientId,
    stored,
    redirectUri,
    discoveries,
  }: NativeAuthorizationClientOptions,
): Promise<SchemaClient<Scope[]> | null> => {
  if (typeof redirectUri !== "string" || !isNativeRedirectUri(redirectUri)) {
    return stored;
  }
  // Resolve metadata before deciding consent: the discovery may change the
  // client's authentication method. Its request cache also serves the provider.
  const discoveryId = stored?.clientDiscoveryId;
  if (stored && !discoveryId) {
    return stored;
  }
  for (const discovery of discoveries) {
    if (discoveryId && discovery.id !== discoveryId) {
      continue;
    }
    if (!discovery.matches(clientId)) {
      continue;
    }
    const resolved = await discovery.resolve(ctx, clientId, stored);
    if (resolved || discoveryId) {
      return resolved;
    }
  }
  return null;
};

type OAuthPolicyMiddlewareOptions = {
  policy: OAuthScopePolicyContext;
  discoveries: readonly ClientDiscovery[];
  noInteractionRequests: WeakSet<Request>;
};

const createOAuthPolicyMiddleware = ({
  policy,
  discoveries,
  noInteractionRequests,
}: OAuthPolicyMiddlewareOptions) =>
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
    const stored = await ctx.context.adapter.findOne<SchemaClient<Scope[]>>({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    const resolved = await resolveNativeAuthorizationClient(ctx, {
      stored,
      clientId,
      redirectUri: parameters["redirect_uri"],
      discoveries,
    });
    if (!resolved && requested === undefined) {
      // A client not stored yet is resolved by a discovery, which applies
      // the same policy to the scope list the provider falls back to.
      return UNCHANGED;
    }
    const client: OAuthScopeClient = resolved ?? {
      clientId,
      clientDiscoveryId:
        discoveries.find((discovery) => discovery.matches(clientId))?.id ??
        null,
      scopes: undefined,
    };
    const grantable = grantableScopes(client, requested, policy).join(" ");
    const consentPrompt = isInitialAuthorization(ctx)
      ? nativeConsentPrompt(resolved, parameters)
      : undefined;
    if (consentPrompt === "none" && ctx.request) {
      noInteractionRequests.add(ctx.request);
    }
    if (grantable === scope && consentPrompt === undefined) {
      return UNCHANGED;
    }
    const authorizationPolicy = {
      scope: grantable,
      ...(consentPrompt === undefined ? {} : { prompt: consentPrompt }),
    };
    return fromBody
      ? { context: { body: authorizationPolicy } }
      : { context: { query: authorizationPolicy } };
  });

const withScopePolicy = (
  discovery: ClientDiscovery,
  policy: OAuthScopePolicyContext,
): ClientDiscovery => {
  const requests = new WeakMap<
    Request,
    Map<string, ReturnType<ClientDiscovery["resolve"]>>
  >();
  return {
    ...discovery,
    resolve: async (ctx, clientId, existing) => {
      const cached = ctx.request
        ? requests.get(ctx.request)?.get(clientId)
        : undefined;
      if (cached !== undefined) {
        return await cached;
      }
      const resolution = (async () => {
        const client = await discovery.resolve(ctx, clientId, existing);
        return client
          ? { ...client, scopes: grantableScopes(client, undefined, policy) }
          : null;
      })();
      if (ctx.request) {
        const clients =
          requests.get(ctx.request) ??
          new Map<string, ReturnType<ClientDiscovery["resolve"]>>();
        clients.set(clientId, resolution);
        requests.set(ctx.request, clients);
      }
      return await resolution;
    },
  };
};

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

type StellaOAuthProviderOptions = OAuthOptions<Scope[]> &
  Required<Pick<OAuthOptions<Scope[]>, "scopes" | "extensions" | "postLogin">>;

export const createStellaOAuthProvider = (
  options: StellaOAuthProviderOptions,
  {
    verifiedOrigins,
    requestBudget,
  }: {
    verifiedOrigins: readonly string[];
    requestBudget: {
      storage: ReturnType<typeof createAuthRateLimitStorage>;
      enabled: boolean;
    };
  },
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
  const noInteractionRequests = new WeakSet<Request>();
  const policyOptions = {
    ...options,
    extensions,
    postLogin: {
      ...options.postLogin,
      shouldRedirect: async (context) => {
        const { request } = getCurrentAuthEndpointContext();
        // The provider validates the client, redirect, PKCE and session before
        // this gate, then answers prompt=none with interaction_required.
        if (request && noInteractionRequests.has(request)) {
          return true;
        }
        return await options.postLogin.shouldRedirect(context);
      },
    } satisfies typeof options.postLogin,
  };
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
        {
          matcher: (ctx: HookEndpointContext) =>
            isAuthRequestBudgetPath(ctx.path ?? "") &&
            (ctx.path?.startsWith("/oauth2/") ?? false),
          handler: createAuthRequestBudgetMiddleware({
            ...requestBudget,
            type: "oauth",
            providerOptions: policyOptions,
          }),
        },
        ...provider.hooks.before,
        {
          matcher: (ctx: HookEndpointContext) =>
            OAUTH_SCOPE_POLICY_PATHS.has(ctx.path ?? ""),
          handler: createOAuthPolicyMiddleware({
            policy,
            discoveries,
            noInteractionRequests,
          }),
        },
      ],
    },
    endpoints: {
      ...provider.endpoints,
      registerOAuthClient: registration.endpoints.registerOAuthClient,
    },
  };
};
