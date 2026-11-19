import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthMiddleware } from "@better-auth/core/api";
import { defineRequestState } from "@better-auth/core/context";
import { APIError } from "@better-auth/core/error";
import type {
  SSOOptions,
  SSOUserResolution,
  SSOUserResolutionContext,
  SSOUserResolutionInput,
} from "@better-auth/sso";
import { sso } from "@better-auth/sso";
import { panic } from "better-result";

import { SSO_PROVIDER_ID_PATTERN } from "@/api/db/auth-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { normalizeEmail } from "@/api/lib/email/normalized-email";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Organization single sign-on (OIDC) through `@better-auth/sso`. Only the
 * sign-in and the provider-specific callback are mounted: provider
 * management, the shared callback, SAML and single logout are not, so a
 * provider row can only come from server code and every SSO session comes
 * back through the callback that names its provider.
 */

/** The sign-in endpoint; it takes a provider id and nothing that searches. */
const SSO_SIGN_IN_PATH = "/sign-in/sso";
const SSO_CALLBACK_PATH_PREFIX = "/sso/callback/";

const SSO_PROVIDER_ID = new RegExp(SSO_PROVIDER_ID_PATTERN, "u");

/** Whether organization SSO is deployed; read per call like every flag. */
export const isEnterpriseSsoDeployed = (): boolean =>
  isDeploymentFeatureEnabled("FEATURE_ENTERPRISE_SSO");

/** Whether `providerId` names an SSO provider rather than a social one. */
const isSsoProviderId = (providerId: string): boolean =>
  SSO_PROVIDER_ID.test(providerId);

type SsoEndpoint = { path?: string | undefined; params?: unknown };

/**
 * The provider whose callback the endpoint is. A request carries the
 * provider in its path (`/sso/callback/sso_acme`), a server call in its
 * params; any other endpoint answers undefined.
 */
export const ssoCallbackProviderId = (
  ctx: SsoEndpoint | null | undefined,
): string | undefined => {
  const path = ctx?.path;
  if (path === undefined || !path.startsWith(SSO_CALLBACK_PATH_PREFIX)) {
    return undefined;
  }
  const fromPath = path.slice(SSO_CALLBACK_PATH_PREFIX.length);
  const fromParams = isRecord(ctx?.params)
    ? ctx.params["providerId"]
    : undefined;
  const providerId = fromPath === ":providerId" ? fromParams : fromPath;
  return typeof providerId === "string" && providerId !== ""
    ? providerId
    : panic(`SSO callback without a provider: ${path}`);
};

/** Why an SSO sign-in was refused; the callback redirects with this code. */
const SSO_REJECTION_CODE = {
  unavailable: "sso_unavailable",
  protocolUnavailable: "sso_protocol_unavailable",
  emailUnverified: "sso_email_unverified",
  emailDomainNotAllowed: "sso_email_domain_not_allowed",
  accountLinkUnavailable: "sso_account_link_unavailable",
} as const;

const reject = (
  code: (typeof SSO_REJECTION_CODE)[keyof typeof SSO_REJECTION_CODE],
): SSOUserResolution => ({ action: "reject", code });

type AuthenticatedProvider = { providerId: string; recordId: string };

/**
 * The provider row this request's sign-in was verified against, set by the
 * user resolution inside the callback's transaction and read when the
 * session is created later in the same request.
 */
const authenticatedProvider = defineRequestState<
  AuthenticatedProvider | undefined
>(() => undefined);

/** The domains, comma-separated in the provider row, it may create accounts for. */
const providerDomains = (domainList: string): ReadonlySet<string> =>
  new Set(
    domainList
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  );

const verifiedIdTokenEmail = (claims: Record<string, unknown>) => {
  const email = claims["email"];
  return typeof email === "string" && claims["email_verified"] === true
    ? normalizeEmail(email)
    : undefined;
};

/**
 * Decides who an SSO sign-in is. An identity already bound to this provider
 * (provider id and subject) signs in as its account. Otherwise it may only
 * create a new account: never link one that exists, which waits for domain
 * verification, and only for an address the ID token itself verifies (the
 * user-info response is not signed) in one of the provider's domains.
 */
const resolveSsoUser = async (
  input: SSOUserResolutionInput,
  { database }: SSOUserResolutionContext,
): Promise<SSOUserResolution> => {
  if (!isEnterpriseSsoDeployed()) {
    return reject(SSO_REJECTION_CODE.unavailable);
  }
  if (input.protocol !== "oidc") {
    return reject(SSO_REJECTION_CODE.protocolUnavailable);
  }
  const { source } = input.providerReference;
  if (source.type !== "persisted") {
    return reject(SSO_REJECTION_CODE.unavailable);
  }
  const email = verifiedIdTokenEmail(input.verifiedIdTokenClaims);
  if (
    email === undefined ||
    input.providerUser.emailVerified !== true ||
    normalizeEmail(input.providerUser.email) !== email
  ) {
    return reject(SSO_REJECTION_CODE.emailUnverified);
  }

  const bound = await database.findOne<{ id: string }>({
    model: "account",
    where: [
      { field: "providerId", value: input.providerId },
      { field: "accountId", value: input.accountKey.accountId },
    ],
    select: ["id"],
  });
  if (bound === null) {
    const provider = await database.findOne<{ domain: string }>({
      model: "ssoProvider",
      where: [
        { field: "id", value: source.recordId },
        { field: "providerId", value: input.providerId },
      ],
      select: ["domain"],
    });
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (provider === null || !providerDomains(provider.domain).has(domain)) {
      return reject(SSO_REJECTION_CODE.emailDomainNotAllowed);
    }
    const existing = await database.findOne<{ id: string }>({
      model: "user",
      where: [{ field: "email", value: email }],
      select: ["id"],
    });
    if (existing !== null) {
      return reject(SSO_REJECTION_CODE.accountLinkUnavailable);
    }
  }

  await authenticatedProvider.set({
    providerId: input.providerId,
    recordId: source.recordId,
  });
  return { action: "continue" };
};

/**
 * The `sso_provider_id` a session is created with: the provider row the
 * request's callback verified, on that provider's callback only, and null on
 * every other endpoint whatever the data says. A callback whose verified
 * provider is missing or differs refuses the session.
 */
export const ssoSessionProvenance = async (
  ctx: SsoEndpoint | null | undefined,
): Promise<{ ssoProviderId: string | null }> => {
  const callbackProviderId = ssoCallbackProviderId(ctx);
  if (callbackProviderId === undefined) {
    return { ssoProviderId: null };
  }
  const verified = await authenticatedProvider.get();
  if (verified === undefined || verified.providerId !== callbackProviderId) {
    throw new APIError("UNAUTHORIZED", {
      message: "The SSO sign-in could not be verified.",
    });
  }
  return { ssoProviderId: verified.recordId };
};

/**
 * The session's provenance column as better-auth sees it: never client
 * input and never returned, so the decision reads only the stored row.
 */
export const SSO_SESSION_FIELDS = {
  ssoProviderId: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
} as const;

type IdentityProviderTokensCleared = {
  accessToken?: null;
  refreshToken?: null;
  idToken?: null;
};

/**
 * The fields that clear the identity provider's tokens from an SSO account
 * write, or undefined for any other account. Sign-in only needs the tokens
 * during the callback and nothing calls the provider afterwards, so keeping
 * them would only add stored credentials.
 */
export const withoutIdentityProviderTokens = (
  account: Record<string, unknown>,
  ctx: SsoEndpoint | null | undefined,
): IdentityProviderTokensCleared | undefined => {
  const providerId = account["providerId"];
  const isSsoAccount =
    (typeof providerId === "string" && isSsoProviderId(providerId)) ||
    ssoCallbackProviderId(ctx) !== undefined;
  if (!isSsoAccount) {
    return undefined;
  }
  return {
    ...("accessToken" in account ? { accessToken: null } : {}),
    ...("refreshToken" in account ? { refreshToken: null } : {}),
    ...("idToken" in account ? { idToken: null } : {}),
  };
};

const SSO_OPTIONS = {
  resolveUser: resolveSsoUser,
  // The resolver admits an address only when the signed ID token verifies
  // it; this lets the shared identity policy see that verification too.
  trustEmailVerified: true,
  // Membership follows the organization's own invitation and provisioning
  // rules; the plugin never adds members by provider or by domain.
  organizationProvisioning: { disabled: true },
  // An identity provider never rewrites the local name, email or picture.
  defaultOverrideUserInfo: false,
  // Server code writes provider rows; the plugin registers none.
  providersLimit: 0,
} satisfies SSOOptions;

/** Sign-in fields that look a provider up instead of naming it. */
const SSO_SIGN_IN_SEARCH_FIELDS = ["domain", "organizationSlug"] as const;

/**
 * Hides both endpoints while SSO is not deployed, and holds sign-in to a
 * provider id: looking a provider up by email domain scans every provider.
 * The email may still travel as the identity provider's login hint.
 */
const ssoDeploymentGate = createAuthMiddleware(async (ctx) => {
  if (!isEnterpriseSsoDeployed()) {
    throw new APIError("NOT_FOUND", { message: "Not found." });
  }
  if (ctx.path !== SSO_SIGN_IN_PATH) {
    return;
  }
  const body: unknown = ctx.body;
  const fields = isRecord(body) ? body : {};
  const providerId = fields["providerId"];
  const providerType = fields["providerType"];
  if (
    typeof providerId !== "string" ||
    !isSsoProviderId(providerId) ||
    (providerType !== undefined && providerType !== "oidc") ||
    SSO_SIGN_IN_SEARCH_FIELDS.some((field) => fields[field] !== undefined)
  ) {
    throw new APIError("BAD_REQUEST", {
      message: "Sign in with an SSO provider id.",
    });
  }
  await Promise.resolve();
});

/**
 * The SSO plugin with only its OIDC sign-in and per-provider callback
 * mounted. Its schema still declares the provider model the adapter reads.
 */
export const createSsoSignInPlugin = () => {
  const plugin = sso(SSO_OPTIONS);
  return {
    id: plugin.id,
    version: plugin.version,
    endpoints: {
      signInSSO: plugin.endpoints.signInSSO,
      callbackSSO: plugin.endpoints.callbackSSO,
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === SSO_SIGN_IN_PATH ||
            (ctx.path?.startsWith(SSO_CALLBACK_PATH_PREFIX) ?? false),
          handler: ssoDeploymentGate,
        },
      ],
    },
    schema: plugin.schema,
    options: plugin.options,
  } satisfies BetterAuthPlugin;
};
