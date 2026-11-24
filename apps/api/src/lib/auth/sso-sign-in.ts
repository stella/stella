import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthMiddleware } from "@better-auth/core/api";
import {
  defineRequestState,
  getCurrentAdapter,
  tryGetCurrentAuthEndpointContext,
} from "@better-auth/core/context";
import { APIError } from "@better-auth/core/error";
import { isAPIError } from "@better-auth/core/utils/is-api-error";
import type {
  SSOOptions,
  SSOUserResolution,
  SSOUserResolutionContext,
  SSOUserResolutionInput,
} from "@better-auth/sso";
import { sso } from "@better-auth/sso";
import { getSessionFromCtx } from "better-auth/api";
import { panic } from "better-result";
import * as v from "valibot";

import { SSO_PROVIDER_ID_PATTERN } from "@/api/db/auth-schema";
import type { DatabaseHookContext } from "@/api/lib/auth/database-hook-context";
import { isSessionCreatingAuthPath } from "@/api/lib/auth/session-path-classification";
import type { SafeId } from "@/api/lib/branded-types";
import { isEnterpriseSsoDeployed } from "@/api/lib/db/sso-access";
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
const SSO_SAML_ACS_PATH_PREFIX = "/sso/saml2/sp/acs/";
const SSO_SAML_METADATA_PATH = "/sso/saml2/sp/metadata";

const SSO_PROVIDER_ID = new RegExp(SSO_PROVIDER_ID_PATTERN, "u");

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
  if (path === undefined) {
    return undefined;
  }
  let prefix: string | undefined;
  if (path.startsWith(SSO_CALLBACK_PATH_PREFIX)) {
    prefix = SSO_CALLBACK_PATH_PREFIX;
  } else if (path.startsWith(SSO_SAML_ACS_PATH_PREFIX)) {
    prefix = SSO_SAML_ACS_PATH_PREFIX;
  }
  if (prefix === undefined) {
    return undefined;
  }
  const fromPath = path.slice(prefix.length);
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
  providerReplaced: "sso_provider_replaced",
  nonceMismatch: "sso_nonce_mismatch",
} as const;

/**
 * The one error code an SSO failure carries back to the browser whenever it
 * is not one of the refusals above: identity provider, token and state
 * failures alike, so the return URL never repeats what a provider said.
 */
const SSO_SIGN_IN_FAILED = "sso_sign_in_failed";

const PUBLIC_SSO_ERRORS: ReadonlySet<string> = new Set([
  ...Object.values(SSO_REJECTION_CODE),
  SSO_SIGN_IN_FAILED,
]);

/** The public error for a failure code the callback produced. */
const publicSsoError = (code: string): string =>
  PUBLIC_SSO_ERRORS.has(code) ? code : SSO_SIGN_IN_FAILED;

const NONCE_SCOPE = "stella:sso-nonce:v1:";

/**
 * The nonce an authorization request carries, derived from its state with
 * the auth secret, so the callback can recompute it without storing it. The
 * state itself is bound to the browser that started the sign-in.
 */
const stateNonce = (secret: string, state: string): string =>
  new Bun.CryptoHasher("sha256", secret)
    .update(`${NONCE_SCOPE}${state}`)
    .digest()
    .toBase64({ alphabet: "base64url", omitPadding: true });

/** Whether the verified ID token's nonce is the one the request's state names. */
const carriesStateNonce = (claims: Record<string, unknown>): boolean => {
  const endpoint = tryGetCurrentAuthEndpointContext();
  const query: unknown = endpoint?.query;
  const state = isRecord(query) ? query["state"] : undefined;
  if (endpoint === undefined || typeof state !== "string" || state === "") {
    return false;
  }
  const nonce = claims["nonce"];
  return (
    typeof nonce === "string" &&
    nonce === stateNonce(endpoint.context.secret, state)
  );
};

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

/**
 * The provider row this request's callback verified for `providerId`; a
 * write the callback did not verify is refused.
 */
const verifiedProviderRecord = async (providerId: unknown): Promise<string> => {
  const verified = await authenticatedProvider.get();
  if (verified === undefined || verified.providerId !== providerId) {
    throw new APIError("UNAUTHORIZED", {
      message: "The SSO sign-in could not be verified.",
    });
  }
  return verified.recordId;
};

/**
 * Whether this request's SSO user resolution admitted a sign-in through
 * `providerId`: only an address the signed ID token verifies is admitted.
 */
export const isResolvedSsoSignIn = async (
  providerId: string | undefined,
): Promise<boolean> => {
  const verified = await authenticatedProvider.get();
  return verified !== undefined && verified.providerId === providerId;
};

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
  const { source } = input.providerReference;
  if (source.type !== "persisted") {
    return reject(SSO_REJECTION_CODE.unavailable);
  }
  let email: string | undefined;
  switch (input.protocol) {
    case "oidc": {
      // The signed ID token decides verification. With a user-info endpoint the
      // plugin reads the profile, and its `email_verified`, from that unsigned
      // response, which may omit the claim; only its address must match.
      email = verifiedIdTokenEmail(input.verifiedIdTokenClaims);
      if (
        email === undefined ||
        normalizeEmail(input.providerUser.email) !== email
      ) {
        return reject(SSO_REJECTION_CODE.emailUnverified);
      }
      if (!carriesStateNonce(input.verifiedIdTokenClaims)) {
        return reject(SSO_REJECTION_CODE.nonceMismatch);
      }
      break;
    }
    case "saml": {
      // SAML assertions are signature-verified, timestamp-checked, and
      // InResponseTo-validated by the plugin before reaching resolveUser.
      const rawEmail = input.providerUser.email;
      email =
        typeof rawEmail === "string" && rawEmail.includes("@")
          ? normalizeEmail(rawEmail)
          : undefined;
      if (email === undefined) {
        return reject(SSO_REJECTION_CODE.emailUnverified);
      }
      break;
    }
  }

  const bound = await database.findOne<{
    id: string;
    ssoProviderId: string | null;
  }>({
    model: "account",
    where: [
      { field: "providerId", value: input.providerId },
      { field: "accountId", value: input.accountKey.accountId },
    ],
    select: ["id", "ssoProviderId"],
  });
  // An identity belongs to the provider generation that created it: a later
  // row reusing the provider id (another issuer, another organization) does
  // not inherit it.
  if (bound !== null && bound.ssoProviderId !== source.recordId) {
    return reject(SSO_REJECTION_CODE.providerReplaced);
  }
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
 * The `sso_provider_id` a session is created with, whatever the data says:
 *
 * - on a provider's callback, the provider row the callback verified; a
 *   callback whose verified provider is missing or differs refuses the
 *   session;
 * - on any other sign-in endpoint, null: it authenticates anew, whatever
 *   session the request already carries;
 * - elsewhere, the stored provenance of the session the request is signed in
 *   with, when the new session is that user's: Better Auth replaces the
 *   signed-in session when it enrolls or removes a second factor, and the
 *   replacement authenticates no differently. Null when the request carries
 *   no session, as on a pending sign-in's second step.
 */
export const ssoSessionProvenance = async (
  ctx: DatabaseHookContext,
  userId: SafeId<"user">,
): Promise<{ ssoProviderId: string | null }> => {
  const callbackProviderId = ssoCallbackProviderId(ctx);
  if (callbackProviderId !== undefined) {
    return { ssoProviderId: await verifiedProviderRecord(callbackProviderId) };
  }
  // A session created outside any endpoint, by a server call, replaces no
  // signed-in session and authenticates through no provider.
  if (
    ctx === null ||
    ctx === undefined ||
    isSessionCreatingAuthPath(ctx.path)
  ) {
    return { ssoProviderId: null };
  }
  const signedIn = await getSessionFromCtx(ctx);
  if (signedIn === null || signedIn.user.id !== userId) {
    return { ssoProviderId: null };
  }
  // The stored row, read in the auth layer's current transaction: the
  // provenance is never returned, so the session object does not carry it.
  const adapter = await getCurrentAdapter(ctx.context.adapter);
  const stored = await adapter.findOne<{ ssoProviderId: string | null }>({
    model: "session",
    where: [
      { field: "id", value: signedIn.session.id },
      { field: "userId", value: userId },
    ],
    select: ["ssoProviderId"],
  });
  return { ssoProviderId: stored?.ssoProviderId ?? null };
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

/**
 * The account's provider generation as better-auth sees it: never client
 * input and never returned.
 */
export const SSO_ACCOUNT_FIELDS = {
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

const isSsoAccountWrite = (
  account: Record<string, unknown>,
  ctx: SsoEndpoint | null | undefined,
): boolean => {
  const providerId = account["providerId"];
  return (
    (typeof providerId === "string" && isSsoProviderId(providerId)) ||
    ssoCallbackProviderId(ctx) !== undefined
  );
};

/**
 * Sign-in only needs the identity provider's tokens during the callback and
 * nothing calls the provider afterwards, so keeping them would only add
 * stored credentials.
 */
const clearedTokens = (
  account: Record<string, unknown>,
): IdentityProviderTokensCleared => ({
  ...("accessToken" in account ? { accessToken: null } : {}),
  ...("refreshToken" in account ? { refreshToken: null } : {}),
  ...("idToken" in account ? { idToken: null } : {}),
});

/**
 * The fields an SSO account is updated with, or undefined for any other
 * account: the provider's tokens cleared. The generation never changes.
 */
export const ssoAccountUpdateFields = (
  account: Record<string, unknown>,
  ctx: SsoEndpoint | null | undefined,
): IdentityProviderTokensCleared | undefined =>
  isSsoAccountWrite(account, ctx) ? clearedTokens(account) : undefined;

/**
 * The fields an SSO account is created with, or undefined for any other
 * account: the provider's tokens cleared and the provider generation the
 * callback verified. An SSO account written without a verified generation
 * is refused.
 */
export const ssoAccountCreateFields = async (
  account: Record<string, unknown>,
  ctx: SsoEndpoint | null | undefined,
): Promise<
  (IdentityProviderTokensCleared & { ssoProviderId: string }) | undefined
> => {
  if (!isSsoAccountWrite(account, ctx)) {
    return undefined;
  }
  return {
    ...clearedTokens(account),
    ssoProviderId: await verifiedProviderRecord(account["providerId"]),
  };
};

/**
 * The fields an account created by an SSO sign-in is created with, or
 * undefined on any other endpoint: its address verified, because the
 * resolver admitted the sign-in only for an address the signed ID token
 * verifies, whatever the unsigned user-info response said.
 */
export const ssoUserCreateFields = async (
  ctx: SsoEndpoint | null | undefined,
): Promise<{ emailVerified: true } | undefined> => {
  const callbackProviderId = ssoCallbackProviderId(ctx);
  if (callbackProviderId === undefined) {
    return undefined;
  }
  await verifiedProviderRecord(callbackProviderId);
  return { emailVerified: true };
};

const SSO_OPTIONS = {
  resolveUser: resolveSsoUser,
  // The resolver admits an address only when the signed ID token verifies
  // it; this passes the provider's own verification flag to the account.
  // oxlint-disable-next-line typescript/no-deprecated -- the resolver never relies on the provider flag alone: it requires the signed ID token to verify the same address in one of the provider's verified domains
  trustEmailVerified: true,
  // Membership follows the organization's own invitation and provisioning
  // rules; the plugin never adds members by provider or by domain.
  organizationProvisioning: { disabled: true },
  // An identity provider never rewrites the local name, email or picture.
  defaultOverrideUserInfo: false,
  // Server code writes provider rows; the plugin registers none.
  providersLimit: 0,
  // SAML2Int hardened defaults: SP-initiated only, strict timestamps,
  // InResponseTo replay protection, and no deprecated signature algorithms.
  saml: {
    enableInResponseToValidation: true,
    allowIdpInitiated: false,
    requireTimestamps: true,
    clockSkew: 120_000,
    algorithms: { onDeprecated: "reject" },
    maxResponseSize: 262_144,
    maxMetadataSize: 102_400,
  },
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
    (providerType !== undefined &&
      providerType !== "oidc" &&
      providerType !== "saml") ||
    SSO_SIGN_IN_SEARCH_FIELDS.some((field) => fields[field] !== undefined)
  ) {
    throw new APIError("BAD_REQUEST", {
      message: "Sign in with an SSO provider id.",
    });
  }
  await Promise.resolve();
});

const authorizationRedirectSchema = v.looseObject({
  url: v.string(),
  redirect: v.boolean(),
});

/**
 * Adds the state-derived nonce to the identity provider's authorization URL;
 * the plugin sends none, and the callback refuses an ID token without it.
 */
const bindAuthorizationNonce = createAuthMiddleware(async (ctx) => {
  const returned: unknown = await Promise.resolve(ctx.context.returned);
  const redirect = v.safeParse(authorizationRedirectSchema, returned);
  if (!redirect.success) {
    return undefined;
  }
  const url = new URL(redirect.output.url);
  // SAML AuthnRequest redirects carry SAMLRequest instead of OIDC state.
  if (url.searchParams.has("SAMLRequest")) {
    return undefined;
  }
  const state = url.searchParams.get("state");
  if (state === null || state === "") {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "The SSO sign-in could not be started.",
    });
  }
  url.searchParams.set("nonce", stateNonce(ctx.context.secret, state));
  return ctx.json({ ...redirect.output, url: url.toString() });
});

/**
 * Carries a failed callback back with one stable public code and no
 * provider-supplied description.
 */
const publishCallbackError = createAuthMiddleware(async (ctx) => {
  const returned: unknown = await Promise.resolve(ctx.context.returned);
  if (!isAPIError(returned)) {
    return;
  }
  // A redirect the framework raises carries the context's Headers.
  const headers: unknown = returned.headers;
  const location = headers instanceof Headers ? headers.get("location") : null;
  if (location === null) {
    return;
  }
  // A relative return URL stays relative: it resolves against the origin the
  // browser is on, which this placeholder never replaces.
  const absolute = URL.canParse(location);
  const target = new URL(location, "https://relative.invalid");
  const error = target.searchParams.get("error");
  if (error === null) {
    return;
  }
  target.searchParams.set("error", publicSsoError(error));
  target.searchParams.delete("error_description");
  throw ctx.redirect(
    absolute
      ? target.toString()
      : `${target.pathname}${target.search}${target.hash}`,
  );
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
      acsEndpoint: plugin.endpoints.acsEndpoint,
      spMetadata: plugin.endpoints.spMetadata,
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === SSO_SIGN_IN_PATH ||
            ctx.path === SSO_SAML_METADATA_PATH ||
            (ctx.path?.startsWith(SSO_CALLBACK_PATH_PREFIX) ?? false) ||
            (ctx.path?.startsWith(SSO_SAML_ACS_PATH_PREFIX) ?? false),
          handler: ssoDeploymentGate,
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === SSO_SIGN_IN_PATH,
          handler: bindAuthorizationNonce,
        },
        {
          matcher: (ctx) =>
            (ctx.path?.startsWith(SSO_CALLBACK_PATH_PREFIX) ?? false) ||
            (ctx.path?.startsWith(SSO_SAML_ACS_PATH_PREFIX) ?? false),
          handler: publishCallbackError,
        },
      ],
    },
    schema: plugin.schema,
    options: plugin.options,
  } satisfies BetterAuthPlugin;
};
