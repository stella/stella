import {
  oauthProvider,
  type OAuthOptions,
  type Scope,
  type SchemaClient,
} from "@better-auth/oauth-provider";
import type { HookEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import type { McpOAuthScope } from "@stll/api-contract";

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

const registrationScopePolicy = createAuthMiddleware(async (ctx) => {
  if (ctx.path === OAUTH_CLIENT_REGISTRATION_PATH) {
    const body: unknown = ctx.body;
    if (!isRecord(body) || typeof body["scope"] !== "string") {
      return;
    }
    const downscopedScope = body["scope"]
      .split(" ")
      .filter((scope) => !ELEVATED_REGISTRATION_SCOPES.has(scope))
      .join(" ");
    return { context: { body: { scope: downscopedScope } } };
  }
  if (ctx.path !== OAUTH_AUTHORIZATION_PATH) {
    return;
  }
  const body: unknown = ctx.body;
  const fromBody =
    ctx.method === "POST" &&
    isRecord(body) &&
    typeof body["client_id"] === "string";
  const parameters: unknown = fromBody ? body : ctx.query;
  if (
    !isRecord(parameters) ||
    typeof parameters["client_id"] !== "string" ||
    typeof parameters["scope"] !== "string"
  ) {
    return;
  }
  const requestedScopes = parameters["scope"].split(" ");
  if (
    !requestedScopes.some((scope) => ELEVATED_REGISTRATION_SCOPES.has(scope))
  ) {
    return;
  }
  const client = await ctx.context.adapter.findOne<
    SchemaClient<readonly Scope[]>
  >({
    model: "oauthClient",
    where: [{ field: "clientId", value: parameters["client_id"] }],
  });
  if (!client?.scopes) {
    return;
  }
  const allowedScopes = client.scopes;
  const downscopedScope = requestedScopes
    .filter(
      (scope) =>
        !ELEVATED_REGISTRATION_SCOPES.has(scope) ||
        allowedScopes.includes(scope),
    )
    .join(" ");
  if (downscopedScope === parameters["scope"]) {
    return;
  }
  return fromBody
    ? { context: { body: { scope: downscopedScope } } }
    : { context: { query: { scope: downscopedScope } } };
});

export const createStellaOAuthProvider = <O extends OAuthOptions<Scope[]>>(
  options: O,
) => {
  const provider = oauthProvider(options);
  // Registration has its own capability policy; discovery retains the
  // provider's policy. Both endpoints use the provider's persistence path.
  const registration = oauthProvider({
    ...options,
    clientRegistrationDefaultScopes: OPEN_REGISTRATION_SCOPES,
    clientRegistrationAllowedScopes: OPEN_REGISTRATION_SCOPES,
  });
  return {
    ...provider,
    hooks: {
      ...provider.hooks,
      before: [
        ...provider.hooks.before,
        {
          matcher: (ctx: HookEndpointContext) =>
            ctx.path === OAUTH_CLIENT_REGISTRATION_PATH ||
            ctx.path === OAUTH_AUTHORIZATION_PATH,
          handler: registrationScopePolicy,
        },
      ],
    },
    endpoints: {
      ...provider.endpoints,
      registerOAuthClient: registration.endpoints.registerOAuthClient,
    },
  };
};
