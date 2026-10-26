import { apiKey } from "@better-auth/api-key";
import { createCimdClientDiscovery } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { createAuthEndpoint } from "@better-auth/core/api";
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type {
  AuthContext,
  BetterAuthPlugin,
  HookEndpointContext,
} from "better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { getSessionFromCtx } from "better-auth/api";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  getOAuthState,
  isAPIError,
} from "better-auth/api";
import {
  emailOTP,
  jwt,
  lastLoginMethod,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { panic, Result } from "better-result";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";

import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";
import {
  PROFESSIONAL_USE_REQUIRED_CODE,
  PROFESSIONAL_USE_STATUS,
} from "@stll/api-contract/professional-use";
import { BETTER_AUTH_ORGANIZATION_OPTIONS } from "@stll/auth-model";
import { errorOutputLogger } from "@stll/errors";
import { ac, assignableRoles, roles } from "@stll/permissions";
import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";
import { isUuid } from "@stll/uuid-codec";

import {
  member,
  session as authSession,
  user as authUser,
} from "@/api/db/auth-schema";
import {
  authorizeOwnerSyntheticSession,
  bindOwnerSyntheticSessionAuthorityReader,
  isPartnerOAuthClient,
  rlsDb,
  rootDb,
} from "@/api/db/root";
import {
  featureEnrolments,
  userProfessionalUseAcceptances,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import { env } from "@/api/env";
import { appendSetCookieHeaders } from "@/api/http/context";
import type { RequestContext, ResponseHeaders } from "@/api/http/context";
import { status } from "@/api/http/status";
import type { HttpStatusResponse } from "@/api/http/status";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { captureError, detached } from "@/api/lib/analytics/capture";
import { getServerAnalytics } from "@/api/lib/analytics/client";
import { API_KEY_PLUGIN_CONFIGS } from "@/api/lib/api-key-plugin-configs";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditExecutionContext } from "@/api/lib/audit-log";
import {
  AUTH_DATABASE_ADAPTER_OPTIONS,
  AUTH_DATABASE_ID_OPTIONS,
  AUTH_SESSION_STORAGE_OPTIONS,
  AUTH_VERIFICATION_STORAGE_OPTIONS,
} from "@/api/lib/auth-adapter-options";
import {
  CredentialIssuanceFence,
  isPendingTwoFactorSignIn,
} from "@/api/lib/auth-artifacts";
import { revokeCredentialsForAccessReset } from "@/api/lib/auth/access-reset-revocation";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import { createAgentUserPlugin } from "@/api/lib/auth/agent-auth-user";
import { authCookiePolicy } from "@/api/lib/auth/auth-cookie-name";
import {
  AUTH_API_PATH,
  getAuthEndpointUrl,
  getAuthIssuerUrl,
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth/auth-paths";
import {
  createAuthRefusalLogPlugin,
  markAuthRequestRoute,
} from "@/api/lib/auth/auth-request-observability";
import {
  CLIENT_METADATA_VALIDATION_SCHEMA_PLUGIN,
  recordClientMetadataValidated,
  withStaleIfError,
} from "@/api/lib/auth/cimd-stale-if-error";
import { sendManageOtp } from "@/api/lib/auth/confirmation-email";
import {
  checkConfiguredDemoAccountAccess,
  checkDemoAccountOperation,
  getDemoAccountConfig,
} from "@/api/lib/auth/demo-account";
import {
  createDemoAuthSessionGuard,
  createDemoSessionPolicy,
  requireDemoAccountAccess,
} from "@/api/lib/auth/demo-account-hooks";
import {
  createDemoSessionFilter,
  warnDemoAccountConfiguration,
} from "@/api/lib/auth/demo-account-policy";
import {
  EMAIL_OTP_ALLOWED_ATTEMPTS,
  emailOtpPromotionEmail,
  requireEmailOtpResetConfirmation,
} from "@/api/lib/auth/email-otp-reset-confirmation";
import {
  handoffStepUpRefusal,
  requiresHandoffStepUpForAuthPath,
} from "@/api/lib/auth/handoff-step-up-policy";
import type { HandoffAccessMetadata } from "@/api/lib/auth/handoff-step-up-policy";
import {
  type createWebHandoffService,
  webHandoffFailure,
} from "@/api/lib/auth/mcp-web-handoff";
import { createMcpWebHandoffPlugin } from "@/api/lib/auth/mcp-web-handoff-plugin";
import { getWebHandoffService } from "@/api/lib/auth/mcp-web-handoff-service";
import type {
  MemberAuthorization,
  MemberAuthorizationLookup,
} from "@/api/lib/auth/member-authorization";
import type {
  MemberCaller,
  SessionMemberCaller,
  WorkspaceCaller,
} from "@/api/lib/auth/member-caller";
import { sendNewDeviceNotice } from "@/api/lib/auth/new-device-notice";
import {
  createOAuthConsentInfoPlugin,
  getVerifiedOAuthOrigins,
} from "@/api/lib/auth/oauth-consent-info";
import { withOwnClientDocuments } from "@/api/lib/auth/oauth-own-client-documents";
import {
  createStellaOAuthProvider,
  OAUTH_DISABLED_PATHS,
} from "@/api/lib/auth/oauth-registration-policy";
import { resolveEmailAndPasswordOptions } from "@/api/lib/auth/password-sign-in-options";
import {
  professionalUseColumns,
  professionalUseStateOf,
  readCreationAcceptance,
  readUserProfessionalUse,
  recordOrganizationProfessionalUse,
  recordUserProfessionalUseAtCreation,
  requireUserCreationOrigin,
} from "@/api/lib/auth/professional-use";
import type { UserProfessionalUseState } from "@/api/lib/auth/professional-use";
import {
  admitOpenClient,
  authorizationClientId,
  REGISTRATION_RETENTION_SCHEMA_PLUGIN,
  requireAuthRetention,
  withAuthRetention,
} from "@/api/lib/auth/registration-adapter";
import { createAuthRequestBudgetHook } from "@/api/lib/auth/request-budget-hooks";
import {
  checkConfiguredReviewAccountAccess,
  getReviewAccountConfig,
  isReviewAccountConfigured,
} from "@/api/lib/auth/review-account";
import {
  createReviewAccountDatabaseHooks,
  createReviewAccountPlugin,
  createReviewAccountUserPlugin,
  requireReviewAccountAccess,
  REVIEW_ACCOUNT_SIGN_IN_BUDGET,
} from "@/api/lib/auth/review-account-plugin";
import { REVIEW_ACCOUNT_OPERATION } from "@/api/lib/auth/review-account-policy";
import { getServiceOAuthClaims } from "@/api/lib/auth/service-client";
import { createSessionBearer } from "@/api/lib/auth/session-bearer";
import {
  carriesSessionCredential,
  skippableSessionCookieOf,
} from "@/api/lib/auth/session-credential";
import { findOtherSessionDevices } from "@/api/lib/auth/session-history";
import {
  createSessionLifetime,
  decidePinnedSessionLifetime,
  SESSION_LIFETIME_FIELDS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import {
  isSecondFactorAuthSessionPath,
  isSessionCreatingAuthPath,
} from "@/api/lib/auth/session-path-classification";
import { createSessionTokenRedactionPlugin } from "@/api/lib/auth/session-token-redaction";
import {
  DISCONNECTED_SIGN_IN_MESSAGE,
  endSessionWithoutLinkedAccount,
  firstFactorRequirement,
  recordSecondFactorRequirement,
  sessionLinkedAccountRequirement,
} from "@/api/lib/auth/sign-in-account-provider";
import {
  createMicrosoftProfileMapper,
  createSocialIdentityValidation,
  SOCIAL_ACCOUNT_LINKING_OPTIONS,
} from "@/api/lib/auth/social-identity-policy";
import { createSocialLinkHintPlugin } from "@/api/lib/auth/social-link-hint";
import {
  classifySocialCallback,
  socialCallbackErrorUrl,
  socialSignInProvider,
} from "@/api/lib/auth/social-sign-in-outcome";
import { readCurrentLiveSseSessions } from "@/api/lib/auth/sse-session-liveness-reader";
import { withoutTrustedDeviceBypass } from "@/api/lib/auth/two-factor-trusted-device";
import { unlinkAccountWithConfirmation } from "@/api/lib/auth/unlink-account-runtime";
import { AUTH_USER_ADDITIONAL_FIELDS } from "@/api/lib/auth/user-additional-fields";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  consumeDesktopLinkGrant,
  createDesktopLinkGrant,
} from "@/api/lib/business-registries/desktop/link-grant-store";
import type {
  ConsumeDesktopLinkGrantOptions,
  CreateDesktopLinkGrantOptions,
} from "@/api/lib/business-registries/desktop/link-grant-store";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";
import {
  findAccountIdByEmail,
  hasAccountForProvider,
  hasCredentialAccount,
} from "@/api/lib/db/account-row";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  resolveWorkspaceMemberAccess,
  resolveWorkspaceMemberAuthority,
} from "@/api/lib/db/member-authority";
import { readBounded } from "@/api/lib/db/read-bounded";
import { getDemoAccountOtpOverride } from "@/api/lib/demo-account-otp";
import { detectedCountryFromRequestContext } from "@/api/lib/detected-country";
import { DEV_INSPECTOR_ORIGINS, frontendOrigins } from "@/api/lib/dev-origins";
import { stashDevOtp } from "@/api/lib/dev-otp-store";
import { ensureDefaultDocumentTypes } from "@/api/lib/document-types/defaults";
import {
  isTransactionalEmailConfigured,
  sendNewDeviceLoginEmail,
  sendOrganizationInvitation,
  sendOTPEmail,
} from "@/api/lib/email/email";
import { handoffCommittedEntityDeletionCleanupBatch } from "@/api/lib/entity-deletion-cleanup-handoff";
import { enqueueEntityDeletionCleanup } from "@/api/lib/entity-deletion-cleanup-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  buildFeatureAccessSnapshot,
  featureAccessReadPlan,
} from "@/api/lib/feature-access/snapshot";
import {
  AUTH_RATE_LIMITS,
  EMAIL_OTP_MIN_RESPONSE_DURATION_MS,
} from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  mapMembershipInvariantError,
  ownerRequiredError,
} from "@/api/lib/membership-role-invariants";
import { resolveLoopbackClientRegistrationOverride } from "@/api/lib/oauth-loopback-registration";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { bridgeOauthUiInteraction } from "@/api/lib/oauth-ui-fragment";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  enrichRequestContext,
  getRequestContext,
} from "@/api/lib/observability/request-context";
import { createOrganizationLifecycleHooks } from "@/api/lib/organization-lifecycle-hooks";
import type { NewMembership } from "@/api/lib/organization-lifecycle-hooks";
import {
  completeOrganizationDeletion,
  OrganizationStorageTeardownBoundError,
} from "@/api/lib/organization-storage-teardown";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  AUTH_FRAMEWORK_BUDGET_RULES,
  observeFrameworkAuthStorage,
} from "@/api/lib/rate-limit/auth-framework-budget";
import {
  AUTH_REQUEST_IP_RULE_OVERRIDES,
  type AuthRequestBudgetFrameworkApi,
} from "@/api/lib/rate-limit/auth-request-budget";
import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import {
  createAccountAttemptBudget,
  createOtpAccountLimitPlugin,
} from "@/api/lib/rate-limit/otp-account-budget";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";
import { memoizePerRequest } from "@/api/lib/request-memo";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
  parseAuthProviderId,
} from "@/api/lib/safe-id-boundaries";
import { typedPgArray } from "@/api/lib/search/sql";
import {
  assertSelfhostBootstrapSignUp,
  assertSelfhostEmailOtpAllowed,
  isSelfhostLocalPasswordAuthEnabled,
  shouldHandleSelfhostBootstrapPath,
} from "@/api/lib/selfhost-auth";
import {
  evaluateNewAccountOtpPolicy,
  isDisposableEmailAddress,
} from "@/api/lib/signup-abuse";
import { revokeUserSseAccess } from "@/api/lib/sse";
import { createSyntheticPrincipalAuthHooks } from "@/api/lib/synthetic-principal/auth-hooks";
import { isSyntheticSessionPrincipal } from "@/api/lib/synthetic-principal/constants";
import {
  checkSyntheticPrincipalAccess,
  syntheticPrincipalAuthConfig,
} from "@/api/lib/synthetic-principal/policy";
import { readSyntheticSessionAuthority } from "@/api/lib/synthetic-principal/session-authority";
import { includes, isRecord } from "@/api/lib/type-guards";
import {
  checkMemberAdmission,
  MEMBER_CAPACITY_REACHED_ERROR_CODE,
} from "@/api/lib/usage/member-capacity";
import { recordNewOrganizationAccessStateOnOwner } from "@/api/lib/usage/organization-access-state-owner";
import {
  hasRenewingHostedSubscription,
  ORGANIZATION_DELETION_REFUSAL_CODE,
} from "@/api/lib/usage/renewing-hosted-subscription";
import { normalizeUserShortcutsField } from "@/api/lib/user-shortcuts";
import {
  memberReachesMatterSql,
  readAuthorizedWorkspaces,
} from "@/api/lib/workspaces/authorized-workspace-ids";
import {
  getMcpResourceUrl,
  MCP_ALL_RESOURCE_SCOPES,
  MCP_MEMBER_ID_CLAIM,
  MCP_OAUTH_SCOPES,
} from "@/api/mcp/constants";
import { isLocalDevOpen, runtimeMode } from "@/api/runtime-mode";

export { resolveWorkspaceMemberAccess, resolveWorkspaceMemberAuthority };

/** Access token lifetime in seconds (15 minutes). */
const syntheticSessionAuthorityReader =
  bindOwnerSyntheticSessionAuthorityReader(readSyntheticSessionAuthority);

const ACCESS_TOKEN_EXPIRES_IN = 15 * 60;

/** Refresh token lifetime in seconds (30 days). */
const REFRESH_TOKEN_EXPIRES_IN = 30 * 24 * 60 * 60;
// A lost rotation response can be replayed idempotently within this window.
const REFRESH_TOKEN_REUSE_INTERVAL = 30;

const SEND_VERIFICATION_OTP_PATH = "/email-otp/send-verification-otp";
const PREFERRED_NAME_MAX_LENGTH = 120;
const WORD_EDIT_SHORTCUT_MAX_LENGTH = 16;

/** Passwordless email-OTP sign-in path (not a better-auth credential path). */
const SIGN_IN_EMAIL_OTP_PATH = "/sign-in/email-otp";

export const createSocialProvider = <T extends object>(provider: T) => ({
  ...provider,
  disableIdTokenSignIn: true,
});

type SocialProviderSettings = {
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  microsoftClientId: string | undefined;
  microsoftClientSecret: string | undefined;
  microsoftTenantId: string | undefined;
};

export const createSocialProviders = (settings: SocialProviderSettings) => ({
  ...(settings.googleClientId && settings.googleClientSecret
    ? {
        google: createSocialProvider({
          clientId: settings.googleClientId,
          clientSecret: settings.googleClientSecret,
        }),
      }
    : {}),
  ...(settings.microsoftClientId &&
  settings.microsoftClientSecret &&
  settings.microsoftTenantId
    ? {
        microsoft: createSocialProvider({
          clientId: settings.microsoftClientId,
          clientSecret: settings.microsoftClientSecret,
          tenantId: settings.microsoftTenantId,
          mapProfileToUser: createMicrosoftProfileMapper(
            settings.microsoftTenantId,
          ),
        }),
      }
    : {}),
});

type SignInEmailOtpBody = {
  email: string;
  type: "sign-in";
};

const isSignInEmailOtpBody = (body: unknown): body is SignInEmailOtpBody => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  return (
    "type" in body &&
    body.type === "sign-in" &&
    "email" in body &&
    typeof body.email === "string"
  );
};

const authAccountExists = async (normalizedEmail: string): Promise<boolean> =>
  (await findAccountIdByEmail(normalizedEmail)) !== undefined;

export const NEW_ACCOUNT_OTP_RATE_LIMIT_MODE = {
  bypassed: "bypassed",
  enforced: "enforced",
} as const;

type NewAccountOtpRateLimitMode =
  (typeof NEW_ACCOUNT_OTP_RATE_LIMIT_MODE)[keyof typeof NEW_ACCOUNT_OTP_RATE_LIMIT_MODE];

const NEW_ACCOUNT_EMAIL_OTP_ACTION = {
  continue: "continue",
  suppressOtp: "suppress_otp",
} as const;

type NewAccountEmailOtpAction =
  | { type: typeof NEW_ACCOUNT_EMAIL_OTP_ACTION.continue }
  | { type: typeof NEW_ACCOUNT_EMAIL_OTP_ACTION.suppressOtp };

type EmailOtpResponseScheduleOptions = {
  detach?: (operation: Promise<void>) => void;
  responseDelayMs: number;
  runRequest: () => Promise<void>;
  wait?: (durationMs: number) => Promise<void>;
};

export const runEmailOtpRequestOnResponseSchedule = async ({
  detach = (operation) => detached(operation, "auth.email-otp-delivery"),
  responseDelayMs,
  runRequest,
  wait = Bun.sleep,
}: EmailOtpResponseScheduleOptions): Promise<void> => {
  if (responseDelayMs <= 0) {
    await runRequest();
    return;
  }

  detach(Promise.resolve().then(runRequest));
  await wait(responseDelayMs);
};

type EmailOtpMinimumResponseDurationOptions = {
  path: string | undefined;
  runtimeMode: RuntimeMode;
  type: string;
};

export const getEmailOtpMinimumResponseDuration = ({
  path,
  runtimeMode: mode,
  type,
}: EmailOtpMinimumResponseDurationOptions): number =>
  mode.mode !== RUNTIME_MODE.open &&
  path === SEND_VERIFICATION_OTP_PATH &&
  type === "sign-in"
    ? EMAIL_OTP_MIN_RESPONSE_DURATION_MS
    : 0;

type NewAccountEmailOtpPolicyOptions = {
  accountExists?: (normalizedEmail: string) => Promise<boolean>;
  rateLimitMode?: NewAccountOtpRateLimitMode;
  rateLimitContext?: Pick<RateLimitContext, "increment">;
};

export const checkNewAccountEmailAllowedForCreation = ({
  email,
  path,
}: {
  email: string;
  path: string | undefined;
}): Result<void, APIError> => {
  if (path !== SIGN_IN_EMAIL_OTP_PATH || !isDisposableEmailAddress(email)) {
    return Result.ok(undefined);
  }

  return Result.err(
    new APIError("BAD_REQUEST", {
      code: "DISPOSABLE_EMAIL_NOT_ALLOWED",
      message:
        "Temporary email addresses are not allowed. Use a permanent email address.",
    }),
  );
};

export const getNewAccountEmailOtpAction = async (
  ctx: {
    body?: unknown;
    path: string;
    request?: Request | undefined;
  },
  {
    accountExists = authAccountExists,
    rateLimitMode = env.E2E_DISABLE_AUTH_RATE_LIMIT
      ? NEW_ACCOUNT_OTP_RATE_LIMIT_MODE.bypassed
      : NEW_ACCOUNT_OTP_RATE_LIMIT_MODE.enforced,
    rateLimitContext,
  }: NewAccountEmailOtpPolicyOptions = {},
): Promise<NewAccountEmailOtpAction> => {
  if (
    rateLimitMode === NEW_ACCOUNT_OTP_RATE_LIMIT_MODE.bypassed ||
    ctx.path !== SEND_VERIFICATION_OTP_PATH ||
    !isSignInEmailOtpBody(ctx.body)
  ) {
    return { type: NEW_ACCOUNT_EMAIL_OTP_ACTION.continue };
  }

  const clientIp = ctx.request
    ? (getRequestContext()?.signupRateLimitIp ?? null)
    : null;
  const result = await evaluateNewAccountOtpPolicy({
    accountExists,
    clientIp,
    ...(rateLimitContext ? { context: rateLimitContext } : {}),
    email: ctx.body.email,
  });

  switch (result.status) {
    case "allowed":
      return { type: NEW_ACCOUNT_EMAIL_OTP_ACTION.continue };
    case "rejected":
      // Keep the OTP-request response identical for existing and new accounts.
      // The user.create hook rejects the disposable address only after Better
      // Auth has verified the OTP and is about to create an account.
      return { type: NEW_ACCOUNT_EMAIL_OTP_ACTION.continue };
    case "rate_limited":
      return { type: NEW_ACCOUNT_EMAIL_OTP_ACTION.suppressOtp };
    default:
      result satisfies never;
      return panic(`Unhandled result: ${String(result)}`);
  }
};

const isSocialSignInCallbackPath = (path: string | undefined): boolean =>
  path?.startsWith("/callback/") ?? false;

const isStellaTwoFactorSignInGatePath = (path: string | undefined): boolean =>
  isSecondFactorAuthSessionPath(path);

export { isSessionCreatingAuthPath };

/**
 * Frontend route that presents the second-factor challenge (mirrors the path
 * the email-OTP sign-in step navigates to on `twoFactorRedirect`). Its search
 * schema defaults `redirectTo`, so no query string is required here.
 */
const TWO_FACTOR_CHALLENGE_PATH = "/auth/two-factor";

/**
 * Frontend route that lists the account's active sessions (the settings page
 * hosting the sessions card), linked from the new-device notice.
 */
const ACTIVE_SESSIONS_FRONTEND_PATH = "/settings/account/profile";

/**
 * True when a sign-in endpoint's response body is the two-factor plugin's
 * "challenge pending" marker (`{ twoFactorRedirect: true }`). Narrowed
 * structurally because the marker is injected by the plugin's after-hook and
 * is not part of any endpoint's declared response type.
 */
export const isTwoFactorRedirectResponse = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "twoFactorRedirect" in value &&
  value.twoFactorRedirect === true;

/**
 * Every HTTP endpoint the two-factor plugin registers, by how it uses the
 * caller's session. Each one resolves that session from storage, never from
 * Better Auth's signed cookie snapshot, which trades a short revocation delay
 * for ordinary-request performance (see `resolveAuthoritativeSessionForSensitiveAuthPath`).
 *
 * - `manage`: exposes or replaces second-factor material. The plugin itself
 *   only requires an active session (node_modules/better-auth/dist/plugins/two-factor/index.mjs
 *   and its totp/backup-codes sub-plugins), so Stella also requires a live
 *   session plus a fresh email verification code (see `requireTwoFactorManageOtp`),
 *   mirroring the delete-account flow, so a session cookie alone can neither
 *   remove 2FA, rotate the secret, read back the TOTP secret nor mint backup codes.
 * - `challenge`: completes a sign-in challenge from its challenge cookie, or,
 *   with a live session, finishes enrollment or consumes a backup code.
 *
 * A registry test enumerates the registered plugin, so a new endpoint fails
 * until it is classified here.
 */
export const TWO_FACTOR_SESSION_PATHS = {
  "/two-factor/enable": "manage",
  "/two-factor/disable": "manage",
  "/two-factor/get-totp-uri": "manage",
  "/two-factor/generate-backup-codes": "manage",
  "/two-factor/verify-totp": "challenge",
  "/two-factor/verify-otp": "challenge",
  "/two-factor/verify-backup-code": "challenge",
  "/two-factor/send-otp": "challenge",
} as const satisfies Record<`/two-factor/${string}`, "manage" | "challenge">;

/**
 * Every HTTP endpoint registered by the OAuth provider, classified by whether
 * it reads the caller's browser session. The registry test deliberately also
 * includes server-only endpoints: an upstream endpoint cannot start trusting
 * a browser session without an explicit decision here.
 */
export const OAUTH_PROVIDER_SESSION_PATHS = {
  "/.well-known/oauth-authorization-server": "no-browser-session",
  "/.well-known/openid-configuration": "no-browser-session",
  "/admin/oauth2/create-client": "no-browser-session",
  "/admin/oauth2/resources": "no-browser-session",
  "/admin/oauth2/resources/:identifier": "no-browser-session",
  "/admin/oauth2/resources/:identifier/clients/:client_id":
    "no-browser-session",
  "/admin/oauth2/update-client": "no-browser-session",
  "/oauth2/authorize": "browser-session",
  "/oauth2/client/rotate-secret": "browser-session",
  "/oauth2/consent": "browser-session",
  "/oauth2/continue": "browser-session",
  "/oauth2/create-client": "browser-session",
  "/oauth2/delete-client": "browser-session",
  "/oauth2/delete-consent": "browser-session",
  "/oauth2/end-session": "browser-session",
  "/oauth2/end-session/confirm": "browser-session",
  "/oauth2/get-client": "browser-session",
  "/oauth2/get-clients": "browser-session",
  "/oauth2/get-consent": "browser-session",
  "/oauth2/get-consents": "browser-session",
  "/oauth2/introspect": "no-browser-session",
  "/oauth2/public-client": "browser-session",
  "/oauth2/public-client-prelogin": "no-browser-session",
  "/oauth2/register": "browser-session",
  "/oauth2/revoke": "no-browser-session",
  "/oauth2/token": "no-browser-session",
  "/oauth2/update-client": "browser-session",
  "/oauth2/update-consent": "browser-session",
  "/oauth2/userinfo": "no-browser-session",
} as const satisfies Record<string, "browser-session" | "no-browser-session">;

const isOAuthProviderSessionPath = (
  path: string,
): path is keyof typeof OAUTH_PROVIDER_SESSION_PATHS =>
  Object.hasOwn(OAUTH_PROVIDER_SESSION_PATHS, path);

const isTwoFactorSessionPath = (
  path: string,
): path is keyof typeof TWO_FACTOR_SESSION_PATHS =>
  Object.hasOwn(TWO_FACTOR_SESSION_PATHS, path);

export const TWO_FACTOR_MANAGE_PATHS: ReadonlySet<string> = new Set(
  Object.entries(TWO_FACTOR_SESSION_PATHS)
    .filter(([, use]) => use === "manage")
    .map(([path]) => path),
);

/**
 * These endpoints can either mint durable OAuth credentials or read or change
 * the account's second factor. They must never authorize from the signed
 * cookie snapshot. Resolve their session from storage instead.
 */
export const AUTHORITATIVE_SESSION_PATHS: ReadonlySet<string> = new Set([
  ...Object.keys(TWO_FACTOR_SESSION_PATHS),
  ...Object.entries(OAUTH_PROVIDER_SESSION_PATHS).flatMap(([path, use]) =>
    use === "browser-session" ? [path] : [],
  ),
]);
const SIX_DIGIT_OTP_PATTERN = /^\d{6}$/u;

export const isSixDigitOtpBody = (body: unknown): body is { otp: string } =>
  typeof body === "object" &&
  body !== null &&
  "otp" in body &&
  typeof body.otp === "string" &&
  SIX_DIGIT_OTP_PATTERN.test(body.otp);

type TwoFactorManageSession = Awaited<ReturnType<typeof getSessionFromCtx>>;

type RequireTwoFactorManageOtpArgs = {
  body: unknown;
  session: TwoFactorManageSession;
};

type SensitiveAuthPathContext = {
  body?: unknown;
  context?:
    | {
        authCookies?:
          | {
              sessionData: { name: string };
              sessionToken: { name: string };
            }
          | undefined;
      }
    | undefined;
  headers?: Headers | undefined;
  path?: string | undefined;
  query?: Record<string, unknown> | undefined;
  request?: Request | undefined;
};
type AuthoritativeSessionPathContext = SensitiveAuthPathContext & {
  path: string;
};
/** A `before` hook result whose context Better Auth merges into the endpoint's. */
type StorageSessionHookResult = {
  context: { query: Record<string, unknown> };
};

const removeSessionCookies = (ctx: SensitiveAuthPathContext): void => {
  const headers = ctx.headers;
  const authCookies = ctx.context?.authCookies;
  if (!headers || !authCookies) {
    panic("Authoritative-session hook is missing the auth cookie context");
  }
  const sessionCookieNames = new Set([
    authCookies.sessionToken.name,
    authCookies.sessionData.name,
  ]);
  // Better Auth splits a large session-data cookie into `<name>.<index>`
  // chunks and reassembles them on read, so the chunks go too.
  const sessionDataChunkPrefix = `${authCookies.sessionData.name}.`;
  const isSessionDataChunk = (name: string): boolean =>
    name.startsWith(sessionDataChunkPrefix) &&
    /^\d+$/u.test(name.slice(sessionDataChunkPrefix.length));
  const remainingCookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      const separator = cookie.indexOf("=");
      const name = separator === -1 ? cookie : cookie.slice(0, separator);
      return !sessionCookieNames.has(name) && !isSessionDataChunk(name);
    });
  if (remainingCookies.length === 0) {
    headers.delete("cookie");
    return;
  }
  headers.set("cookie", remainingCookies.join("; "));
};
/**
 * Establish database-backed session state before a sensitive plugin endpoint
 * runs. Better Auth's endpoint middleware reuses a resolved session from this
 * context, so neither the OAuth authorization-code flow nor two-factor
 * rotation can fall back to a signed cookie-cache snapshot.
 *
 * A session absent from storage leaves that context empty, and the endpoint
 * middleware would then read the cookie snapshot again. A two-factor endpoint
 * therefore also gets `disableCookieCache` in its query, which Better Auth's
 * session read honours, so the endpoint sees the same absent session. The
 * returned hook result carries that query; `undefined` means the request
 * continues unchanged.
 */
export const resolveAuthoritativeSessionForSensitiveAuthPath = async <
  TContext extends SensitiveAuthPathContext,
>({
  ctx,
  resolveSession,
}: {
  ctx: TContext;
  resolveSession: (
    ctx: TContext & AuthoritativeSessionPathContext,
  ) => Promise<TwoFactorManageSession>;
}): Promise<Result<StorageSessionHookResult | undefined, APIError>> => {
  const path = ctx.path;
  if (path === undefined || !AUTHORITATIVE_SESSION_PATHS.has(path)) {
    return Result.ok(undefined);
  }
  if (isOAuthProviderSessionPath(path)) {
    // HTTP requests and server-side `auth.api.*` calls alike: whenever the
    // call carries cookies, the endpoint could read the cookie snapshot, so
    // resolve the session from storage. A call without cookies has no
    // snapshot to fall back to.
    if (
      OAUTH_PROVIDER_SESSION_PATHS[path] === "browser-session" &&
      (ctx.headers?.get("cookie") ?? "") !== ""
    ) {
      const session = await resolveSession({ ...ctx, path });
      if (!session) {
        // OAuth authorization queries are signed and survive the login
        // redirect, so pin the absent result by removing only Better Auth's
        // session cookies from the headers the endpoint's middleware reads.
        removeSessionCookies(ctx);
      }
    }
    return Result.ok(undefined);
  }
  if (ctx.request === undefined) {
    panic("Authoritative-session hook ran outside HTTP dispatch");
  }
  const session = await resolveSession({ ...ctx, path });
  if (!isTwoFactorSessionPath(path)) {
    return Result.ok(undefined);
  }
  const storageSession: StorageSessionHookResult = {
    context: { query: { ...ctx.query, disableCookieCache: true } },
  };
  if (TWO_FACTOR_SESSION_PATHS[path] === "challenge") {
    return Result.ok(storageSession);
  }
  const gate = await requireTwoFactorManageOtp({ body: ctx.body, session });
  return gate.map(() => storageSession);
};

/**
 * Requires a live session and a fresh, single-use email verification code
 * before letting any path in `TWO_FACTOR_MANAGE_PATHS` proceed, so a session
 * cookie alone can neither enroll a second factor, disable it, rotate the TOTP
 * secret via re-enable, read back the current TOTP secret, nor mint fresh
 * backup codes. Enrollment is gated like every other transition: binding an
 * authenticator decides who can pass the challenge from then on.
 *
 * Receives the session resolved from storage (this runs in the global
 * `before` hook, ahead of each endpoint's own session middleware) and refuses
 * a request whose session storage no longer holds, such as a revoked one.
 *
 * One deployment shape uses the account password instead: transactional email
 * is optional, so a credential account on an instance without a transport
 * cannot receive a manage code. Passwordless accounts have no independent
 * step-up in that shape and must fail closed instead of authorizing enrollment
 * from the active session alone. An account that already carries a second
 * factor still needs the code for every transition, on every deployment.
 */
const requireTwoFactorManageOtp = async ({
  body,
  session,
}: RequireTwoFactorManageOtpArgs): Promise<Result<void, APIError>> => {
  if (!session) {
    return Result.err(
      new APIError("UNAUTHORIZED", {
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      }),
    );
  }

  if (
    session.user["twoFactorEnabled"] !== true &&
    !isTransactionalEmailConfigured()
  ) {
    if (await hasCredentialAccount(toSafeId<"user">(session.user.id))) {
      return Result.ok(undefined);
    }
    return Result.err(
      new APIError("FORBIDDEN", {
        message:
          "Two-factor enrollment requires transactional email or a password account",
      }),
    );
  }

  if (!isSixDigitOtpBody(body)) {
    return Result.err(
      new APIError("BAD_REQUEST", {
        message:
          "Verification code required to change two-factor authentication settings",
      }),
    );
  }

  const verifyResult = await verifyConfirmationOtp({
    purpose: "two-factor-manage",
    email: session.user.email,
    code: body.otp,
  });

  if (Result.isOk(verifyResult)) {
    return Result.ok(undefined);
  }
  // Only wrong/expired codes are a client error. An infrastructure failure
  // (e.g. the database is down) surfaces as a 500 from verifyConfirmationOtp;
  // preserve that so it is not misreported to the user as an invalid code.
  if (verifyResult.error.status >= 500) {
    return Result.err(
      new APIError("INTERNAL_SERVER_ERROR", {
        message: "Could not verify the two-factor settings change",
      }),
    );
  }
  return Result.err(
    new APIError("BAD_REQUEST", {
      message: "Invalid verification code",
    }),
  );
};

/** TOTP issuer label shown in authenticator apps (e.g. "Stella (user@example.com)"). */
const TWO_FACTOR_ISSUER = "Stella";
const MEMBERSHIP_UPDATE_FAILED = failureSink({
  event: "auth.membership_update_failed",
  expected: [],
});
const MEMBERSHIP_REMOVAL_FAILED = failureSink({
  event: "auth.membership_removal_failed",
  expected: [],
});
const EMAIL_OTP_ACCESS_RESET_REVOCATION_FAILED = failureSink({
  event: "auth.email_otp_access_reset_revocation_failed",
  expected: [],
});

/**
 * Ends every durable credential of an account an email code just proved,
 * while Better Auth promotes it: after its linked providers and sessions are
 * gone and before the new session exists. A failure aborts the sign-in.
 */
const revokeUnprovenCredentials = async (
  internalAdapter: Pick<AuthContext["internalAdapter"], "findUserByEmail">,
  email: string,
): Promise<void> => {
  const found = await internalAdapter.findUserByEmail(email);
  if (!found) {
    return;
  }
  const revoked = await Result.tryPromise(
    async () =>
      await revokeCredentialsForAccessReset(toSafeId<"user">(found.user.id)),
  );
  if (Result.isError(revoked)) {
    observeFailure(revoked.error, {
      sink: EMAIL_OTP_ACCESS_RESET_REVOCATION_FAILED,
      ctx: { source: "email-otp-access-reset" },
    });
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "Could not reset account access.",
    });
  }
};
const SIGN_IN_METHOD_CONFIRMATION_FAILED = failureSink({
  event: "auth.sign_in_method_confirmation_failed",
  expected: [],
});

/** Session lifetime in seconds (7 days). */
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

/** How often the session expiry is refreshed, in seconds (1 day). */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/** Signed session snapshots bound credential acceptance without storage reads. */
export const SESSION_COOKIE_CACHE_MAX_AGE_SECONDS = 60;

const { cookiePrefix, useSecureCookies } = authCookiePolicy();

/**
 * Keeps `user.name` from ever persisting as an empty string.
 *
 * Email-OTP and some social providers leave `name` blank, and the column's
 * `notNull` constraint still admits `""`, which renders as a nameless
 * identity everywhere the user is shown. Blank input resolves to the email
 * local-part instead.
 *
 * On update the payload carries only the changed fields, so `email` is
 * usually absent and no fallback can be derived. There the blank `name` is
 * dropped from the payload rather than written, leaving the stored value
 * intact: no caller has a legitimate reason to clear a display name, and
 * silently keeping the old one cannot break a provider-driven profile sync
 * the way rejecting the write would.
 */
export const ensureDisplayName = <T extends Record<string, unknown>>(
  user: T,
) => {
  const name = typeof user["name"] === "string" ? user["name"].trim() : "";
  if (name.length > 0) {
    return user;
  }
  const email = typeof user["email"] === "string" ? user["email"].trim() : "";
  const localPart = email.split("@").at(0)?.trim() ?? "";
  const fallback = localPart.length > 0 ? localPart : email;
  if (fallback.length > 0) {
    return { ...user, name: fallback };
  }
  const { name: _blankName, ...withoutName } = user;
  return withoutName;
};

/**
 * Validates a timezone identifier via the Intl API: a present value must be a
 * recognised IANA timezone.
 */
const validateTimezoneId = (timezoneId: unknown): Result<void, APIError> => {
  if (typeof timezoneId !== "string" || timezoneId === "UTC") {
    return Result.ok(undefined);
  }
  return Result.try({
    try: () => {
      Intl.DateTimeFormat(undefined, { timeZone: timezoneId });
    },
    catch: () =>
      new APIError("BAD_REQUEST", {
        message: "Invalid timezone identifier",
      }),
  });
};

const normalizeOptionalPreference = (
  value: unknown,
  {
    fieldName,
    maxLength,
  }: {
    fieldName: string;
    maxLength: number;
  },
): Result<string | null | undefined, APIError> => {
  if (value === undefined || value === null) {
    return Result.ok(value);
  }

  if (typeof value !== "string") {
    return Result.err(
      new APIError("BAD_REQUEST", {
        message: `${fieldName} must be a string`,
      }),
    );
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return Result.err(
      new APIError("BAD_REQUEST", {
        message: `${fieldName} is too long`,
      }),
    );
  }

  return Result.ok(trimmed.length > 0 ? trimmed : null);
};

const normalizeUserPreferences = <TUser extends Record<string, unknown>>(
  user: TUser,
) =>
  Result.gen(function* () {
    const preferredName = yield* normalizeOptionalPreference(
      user["preferredName"],
      {
        fieldName: "Preferred name",
        maxLength: PREFERRED_NAME_MAX_LENGTH,
      },
    );
    const wordEditShortcut = yield* normalizeOptionalPreference(
      user["wordEditShortcut"],
      {
        fieldName: "Word edit shortcut",
        maxLength: WORD_EDIT_SHORTCUT_MAX_LENGTH,
      },
    );
    const userShortcuts = yield* normalizeUserShortcutsField(
      user["userShortcuts"],
    );

    return Result.ok({
      ...user,
      ...(preferredName !== undefined ? { preferredName } : {}),
      ...(wordEditShortcut !== undefined ? { wordEditShortcut } : {}),
      ...(userShortcuts !== undefined ? { userShortcuts } : {}),
    });
  });

const getSessionActiveOrganizationId = (
  session: unknown,
): string | undefined => {
  if (typeof session !== "object" || session === null) {
    return undefined;
  }

  if (!("activeOrganizationId" in session)) {
    return undefined;
  }

  const value = session.activeOrganizationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Read a validated UUID-shaped route/query workspace solely to fold the common
 * workspace lookup into the membership query. The returned ID is not branded
 * as authorized until resolveMemberAuthorization returns its joined row.
 */
const readInitialWorkspaceId = (
  ...sources: unknown[]
): SafeId<"workspace"> | null => {
  for (const source of sources) {
    if (
      typeof source !== "object" ||
      source === null ||
      !("workspaceId" in source)
    ) {
      continue;
    }
    const value = source.workspaceId;
    if (typeof value === "string" && isUuid(value)) {
      return toSafeId<"workspace">(value);
    }
  }
  return null;
};

const isMcpResourceScope = (
  scope: string,
): scope is (typeof MCP_ALL_RESOURCE_SCOPES)[number] =>
  includes(MCP_ALL_RESOURCE_SCOPES, scope);

// Building an `Intl.DateTimeFormat` re-parses its options every call; cache
// one per language instead of rebuilding it for every new-device-login email.
const newDeviceLoginDateTimeFormatCache = new Map<
  string,
  Intl.DateTimeFormat
>();
const getNewDeviceLoginDateTimeFormat = (lang: string): Intl.DateTimeFormat => {
  let formatter = newDeviceLoginDateTimeFormatCache.get(lang);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(lang, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
    newDeviceLoginDateTimeFormatCache.set(lang, formatter);
  }
  return formatter;
};

/**
 * Extends every `hooks.after` matcher on a plugin so it also fires for the
 * sign-in paths Stella supports that better-auth's two-factor plugin does not
 * gate out of the box, in addition to whatever paths the plugin already
 * matches.
 *
 * better-auth's two-factor plugin only gates the credential sign-in paths
 * (`/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number` — see
 * node_modules/better-auth/dist/plugins/two-factor/index.mjs). Stella also
 * signs users in via passwordless email-OTP (`/sign-in/email-otp`) and social
 * providers (the `/callback/:id` OAuth callback), neither of which the
 * plugin's matcher sees, so its after-hook would never challenge for a second
 * factor on those flows. The handler itself is path-agnostic — it reads
 * `ctx.context.newSession`, honors the trust-device cookie, deletes the
 * pending session, and sets the two-factor challenge cookie — so extending the
 * matcher makes it do its security work on these paths too. The social
 * callback additionally needs the JSON response turned into a browser redirect
 * (see `socialSignInTwoFactorRedirectPlugin`).
 *
 * Generic over `T` (rather than hardcoded to the two-factor plugin's
 * concrete return type) so it stays independently unit-testable with a
 * minimal stub instead of a fully constructed better-auth plugin.
 */
export const withStellaTwoFactorSignInGate = <
  T extends {
    hooks: { after: { matcher: (ctx: HookEndpointContext) => boolean }[] };
  },
>(
  plugin: T,
): T => ({
  ...plugin,
  hooks: {
    ...plugin.hooks,
    after: plugin.hooks.after.map((hook) => ({
      ...hook,
      matcher: (ctx: HookEndpointContext) =>
        hook.matcher(ctx) || isStellaTwoFactorSignInGatePath(ctx.path),
    })),
  },
});

/**
 * Turns the two-factor plugin's pending-challenge JSON response into a 302
 * redirect for the social sign-in callback.
 *
 * The two-factor after-hook (now matching `/callback/:id` via
 * `withStellaTwoFactorSignInGate`) does the security work on an enrolled
 * user's social sign-in: it deletes the freshly created session and sets the
 * two-factor challenge cookie, then returns `{ twoFactorRedirect: true }`. For
 * credential / email-OTP sign-in that JSON body is read by the client fetch,
 * but the social callback is a top-level browser navigation, so the browser
 * would render raw JSON instead of continuing to the challenge. This plugin's
 * after-hook runs after the two-factor hook (it is registered later in the
 * `plugins` array) and, only when a challenge is now pending, replaces the
 * response with a redirect to the frontend two-factor page. The challenge
 * cookie the two-factor hook set is accumulated on the shared response headers,
 * so it rides along on the redirect. When no challenge is pending the original
 * OAuth redirect is left untouched.
 */
const socialSignInTwoFactorRedirectPlugin = {
  id: "stella-social-two-factor-redirect",
  hooks: {
    after: [
      {
        matcher: (ctx: HookEndpointContext) =>
          isSocialSignInCallbackPath(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const returned = await Promise.resolve(ctx.context.returned);
          if (!isTwoFactorRedirectResponse(returned)) {
            return;
          }
          throw ctx.redirect(`${env.FRONTEND_URL}${TWO_FACTOR_CHALLENGE_PATH}`);
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * Whether the current auth request is the organization page's continue step.
 * The provider re-enters its authorize logic from that endpoint under the
 * authorize path, so the step is recognised by the request it answers.
 */
const isOrganizationPageContinuation = (): boolean => {
  const endpoint = tryGetCurrentAuthEndpointContext();
  const request = endpoint?.request;
  if (!request || request.method !== "POST") {
    return false;
  }
  return (
    new URL(request.url).pathname ===
      new URL(getAuthEndpointUrl("oauth2/continue")).pathname &&
    isRecord(endpoint.body) &&
    endpoint.body["postLogin"] === true
  );
};

/**
 * Keeps signed OAuth interaction state, including native-client loopback URIs,
 * out of CDN-visible URLs. It must run after the OAuth provider so it can
 * rewrite both its navigation response and its fetch-mode redirect object.
 */
const oauthUiFragmentBridgePlugin = {
  id: "stella-oauth-ui-fragment-bridge",
  hooks: {
    after: [
      {
        matcher: (ctx: HookEndpointContext) =>
          ctx.path?.startsWith("/oauth2/") ?? false,
        handler: createAuthMiddleware(async (ctx) => {
          bridgeOauthUiInteraction(ctx.context, {
            authOrigin: env.BETTER_AUTH_URL,
            frontendUrl: env.FRONTEND_URL,
          });
          await Promise.resolve();
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * Logs each social callback's outcome (`classifySocialCallback`) as
 * `auth.social_sign_in`, after the two-factor redirect has settled the
 * response the browser receives.
 */
const socialSignInOutcomePlugin = {
  id: "stella-social-sign-in-outcome",
  hooks: {
    after: [
      {
        matcher: (ctx: HookEndpointContext) =>
          isSocialSignInCallbackPath(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          logger.info("auth.social_sign_in", {
            outcome: classifySocialCallback(
              ctx.context.returned,
              socialCallbackErrorUrl(
                await getOAuthState(),
                ctx.context.options.onAPIError?.errorURL ??
                  `${ctx.context.baseURL}/error`,
                ctx.context.baseURL,
              ),
            ),
            provider: socialSignInProvider(ctx.params?.["id"]),
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

// Lazy singleton: `betterAuth()` eagerly resolves the
// database adapter, which accesses `rootDb`. Deferring to
// first use prevents the TDZ error when the test runner
// evaluates this module before db/index.ts finishes.
type CreateAuthOptions = {
  rateLimitStorage?: ReturnType<typeof createAuthRateLimitStorage>;
  rateLimitEnabled?: boolean;
};

const WEB_HANDOFF_MINT_FAILURE_SINK = failureSink({
  event: "mcp_web_handoff.mint_failed",
  expected: [],
});
type WebHandoffMintArgs = Parameters<
  ReturnType<typeof createWebHandoffService>["mint"]
>;
export const mintWebHandoff = async (
  ctx: WebHandoffMintArgs[0],
  paths: readonly string[],
  kind: WebHandoffMintArgs[2],
) => {
  const outcome = await Result.tryPromise({
    try: async () => await getWebHandoffService().mint(ctx, paths, kind),
    catch: webHandoffFailure("mint", "Web handoff could not be created."),
  });
  if (Result.isOk(outcome)) {
    return outcome.value;
  }
  observeFailure(outcome.error, {
    sink: WEB_HANDOFF_MINT_FAILURE_SINK,
    ctx: { operation: "mint" },
  });
  return null;
};

export const createAuth = (
  roleAssignmentPolicy = assignableRoles,
  factoryOptions: CreateAuthOptions = {},
) => {
  const authRateLimitStorage =
    factoryOptions.rateLimitStorage ?? createAuthRateLimitStorage();
  const rateLimitEnabled =
    factoryOptions.rateLimitEnabled ?? !env.E2E_DISABLE_AUTH_RATE_LIMIT;
  const requestBudgetFrameworkApi = {
    readUserId: async (ctx) =>
      (await getAuthoritativeSessionFromCtx(ctx))?.user.id,
    createQuotaError: (retryAfter) =>
      new APIError(
        "TOO_MANY_REQUESTS",
        { message: "Try again later.", code: "TOO_MANY_REQUESTS" },
        { "Retry-After": String(retryAfter) },
      ),
    isAcceptedTokenResponse: (returned) =>
      !isAPIError(returned) &&
      isRecord(returned) &&
      typeof returned["access_token"] === "string" &&
      returned["access_token"].length > 0 &&
      (returned["token_type"] === "Bearer" ||
        returned["token_type"] === "DPoP"),
  } satisfies AuthRequestBudgetFrameworkApi;
  const signInRequestBudget = createAuthRequestBudgetHook({
    type: "authentication",
    storage: authRateLimitStorage,
    enabled: rateLimitEnabled,
    frameworkApi: requestBudgetFrameworkApi,
  });
  const sessionLifetime = createSessionLifetime({
    store: createDatabaseSessionLifetimeStore(rootDb, {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      rotationEnabled: env.SESSION_TOKEN_ROTATION_ENABLED,
      capEnabled: env.SESSION_LIFETIME_CAP_ENABLED,
    }),
  });
  const syntheticAuthHooks = createSyntheticPrincipalAuthHooks();
  const demoConfig = getDemoAccountConfig();
  const reviewConfig = getReviewAccountConfig();
  const resolveSessionAccount = async (userId: SafeId<"user">) =>
    await rootDb.query.user.findFirst({
      where: { id: userId },
      columns: { email: true },
    });
  const reviewDatabaseHooks = createReviewAccountDatabaseHooks(reviewConfig, {
    findUserEmail: async (userId: SafeId<"user">) =>
      (await resolveSessionAccount(userId))?.email,
  });
  const hasSessionMembership = async ({
    userId,
    organizationId,
  }: {
    userId: SafeId<"user">;
    organizationId: SafeId<"organization">;
  }) =>
    Boolean(
      await rootDb.query.member.findFirst({
        where: { userId, organizationId },
        columns: { id: true },
      }),
    );
  // Both accounts are pinned to their organization the same way: a session
  // opens only with a membership there, and always on that organization.
  const demoSessionPolicy = createDemoSessionPolicy({
    config: demoConfig,
    resolveUser: resolveSessionAccount,
    hasMembership: hasSessionMembership,
  });
  const reviewSessionPolicy = createDemoSessionPolicy({
    config: reviewConfig,
    resolveUser: resolveSessionAccount,
    hasMembership: hasSessionMembership,
  });
  const syntheticSessionPolicy = createDemoSessionPolicy({
    config: syntheticPrincipalAuthConfig,
    resolveUser: resolveSessionAccount,
    hasMembership: hasSessionMembership,
  });
  const demoSessionGuard = createDemoAuthSessionGuard(demoConfig);
  warnDemoAccountConfiguration(demoConfig, (attributes) =>
    logger.warn("auth.account_binding_unset", attributes),
  );
  const configuredDemoMode = demoConfig.organizationId ? "bound" : "unbound";
  logger.info("auth.account_policy", {
    mode: demoConfig.email ? configuredDemoMode : "disabled",
  });
  const oauthResources = getBetterAuthOAuthResources();
  const oauthResourceIdentifiers = oauthResources.map(
    ({ identifier }) => identifier,
  );
  const twoFactorPlugin = twoFactor({
    // Stella is passwordless (email OTP is the first factor), so 2FA
    // enable/disable/verify never require a password fallback.
    allowPasswordless: true,
    issuer: TWO_FACTOR_ISSUER,
    // Better Auth 1.7.6 binds trusted-device grants only to a user and expiry.
    // It does not revoke every browser's grant when MFA is disabled or replaced,
    // so an old grant can bypass the new factor. Keep the feature disabled until
    // grants are bound to an enrollment generation.
    trustDeviceMaxAge: 0,
  });

  const twoFactorWithSignInGate = withStellaTwoFactorSignInGate(
    withoutTrustedDeviceBypass(twoFactorPlugin),
  ) satisfies BetterAuthPlugin;

  const refuseBeyondMemberCapacity = async (
    organizationId: SafeId<"organization">,
    kind: "invitation" | "membership",
  ): Promise<void> => {
    const admission = await checkMemberAdmission(rootDb, {
      organizationId,
      kind,
    });
    // Better Auth rejects a request from an organization hook by the
    // APIError it throws.
    if (Result.isError(admission)) {
      throw new APIError("FORBIDDEN", {
        error: admission.error.code ?? MEMBER_CAPACITY_REACHED_ERROR_CODE,
        message: admission.error.message,
      });
    }
  };

  const requireAssignableMemberRole = async (
    organizationId: SafeId<"organization">,
    role: string,
  ) => {
    const endpoint = tryGetCurrentAuthEndpointContext();
    // Inspect the original input as well: the plugin normalizes comma lists
    // before invoking organization hooks.
    const input =
      endpoint && isRecord(endpoint.body) ? endpoint.body["role"] : role;
    if (
      typeof input !== "string" ||
      !isMemberRole(input) ||
      !isMemberRole(role)
    ) {
      throw new APIError("BAD_REQUEST", {
        code: "invalid_member_role",
        message: "Select one product membership role.",
      });
    }
    const headers =
      endpoint?.headers instanceof Headers
        ? endpoint.headers
        : endpoint?.request?.headers;
    if (!headers) {
      throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
    }
    const session = await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!session) {
      throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
    }
    const actor = await rootDb.query.member.findFirst({
      columns: { role: true },
      where: {
        organizationId: { eq: organizationId },
        userId: { eq: session.user.id },
      },
    });
    if (
      !actor ||
      !isMemberRole(actor.role) ||
      !roleAssignmentPolicy(actor.role).includes(role)
    ) {
      throw new APIError("FORBIDDEN", {
        code: "member_role_not_assignable",
        message: "You cannot assign this membership role.",
      });
    }
  };

  const refuseLastOwnerChange = async (
    organizationId: SafeId<"organization">,
    role: string,
  ) => {
    if (role !== "owner") {
      return;
    }
    const [owners] = await rootDb
      .select({ count: count() })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.role, "owner"),
        ),
      );
    if (!owners || owners.count <= 1) {
      throw ownerRequiredError();
    }
  };

  const rawAuthAdapter = drizzleAdapter(rootDb, AUTH_DATABASE_ADAPTER_OPTIONS);
  /**
   * The account and grant a provider token is issued under. Tokens without a
   * user (client credentials) carry no account credential.
   */
  const providerGrantTokenAuthority = (
    model: string,
    data: Record<string, unknown>,
  ) => {
    if (model !== "oauthAccessToken" && model !== "oauthRefreshToken") {
      return undefined;
    }
    const { userId, sessionId, authorizationCodeId } = data;
    if (typeof userId !== "string") {
      return undefined;
    }
    return {
      userId: brandPersistedUserId(userId),
      sessionId: typeof sessionId === "string" ? sessionId : null,
      grantId:
        typeof authorizationCodeId === "string" ? authorizationCodeId : null,
    };
  };

  const membershipAuthAdapter: typeof rawAuthAdapter = (options) => {
    const adapter = withAuthRetention({
      adapter: rawAuthAdapter(options),
      admitClient: async () =>
        await admitOpenClient({
          limit: env.OPEN_CLIENT_REGISTRATION_DAILY_LIMIT,
          now: new Date(),
          execute: async (query) => await rootDb.execute(query),
        }),
      touchClient: async (clientId) => {
        const endpoint = tryGetCurrentAuthEndpointContext();
        if (
          !endpoint?.path ||
          !["/oauth2/authorize", "/oauth2/token"].includes(endpoint.path)
        ) {
          return;
        }
        const touched = await rootDb.execute(
          sql`update oauth_client set updated_at = now() where client_id = ${clientId} returning client_id`,
        );
        if (touched.length === 0) {
          throw new APIError("BAD_REQUEST", {
            message: "Authorization client is unavailable.",
          });
        }
      },
      protectCreate: (raw) => async (args) => {
        const table = requireAuthRetention({ model: args.model });
        const grant = providerGrantTokenAuthority(args.model, args.data);
        const clientId =
          table === "verification"
            ? authorizationClientId(args.data)
            : undefined;
        if (!clientId && grant === undefined) {
          return await raw.create(args);
        }
        return await rootDb.transaction(async (tx) => {
          // The provider writes each token on its own; the fence makes an
          // account reset either delete the token or refuse it.
          if (
            grant !== undefined &&
            (await CredentialIssuanceFence.holdForGrant(tx, grant)) === null
          ) {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_grant",
              error_description: "The authorization is no longer valid.",
            });
          }
          if (clientId) {
            const clients = await tx.execute(
              sql`select client_id from oauth_client where client_id = ${clientId} for key share`,
            );
            if (clients.length === 0) {
              throw new APIError("BAD_REQUEST", {
                message: "Authorization client is unavailable.",
              });
            }
          }
          return await drizzleAdapter(
            tx,
            AUTH_DATABASE_ADAPTER_OPTIONS,
          )(options).create(args);
        });
      },
    });
    return {
      ...adapter,
      // The hook's preflight cannot hold a lock across this plugin write.
      // Translate the database's final refusal at the adapter boundary.
      update: async <T>(args: Parameters<typeof adapter.update>[0]) => {
        const update = await Result.tryPromise({
          try: async () => await adapter.update<T>(args),
          catch: mapMembershipInvariantError,
        });
        if (Result.isError(update)) {
          if (
            !(update.error instanceof APIError) ||
            update.error.statusCode >= 500
          ) {
            observeFailure(update.error, {
              sink: MEMBERSHIP_UPDATE_FAILED,
              ctx: { operation: args.model },
            });
          }
          throw update.error;
        }
        return update.value;
      },
    };
  };

  const organizationLifecycleHooks = createOrganizationLifecycleHooks({
    analytics: getServerAnalytics(),
    // Insert-once on the owner connection, like the seeds below.
    recordAccessState: recordNewOrganizationAccessStateOnOwner,
    // Insert-once on the owner connection, audited in the same transaction.
    // A creator who has not accepted yet records nothing here; the
    // organization is recorded when an owner accepts.
    recordProfessionalUse: async ({
      organizationId,
      userId,
    }: NewMembership) => {
      await withAggregateTransaction(
        rootDb,
        async (tx) =>
          await recordOrganizationProfessionalUse({
            tx,
            organizationId,
            userId,
          }),
      );
    },
    // Idempotent via the (organization_id, key) unique. Runs on the owner
    // connection (`rootDb`), which bypasses RLS the same way the org row's
    // own creation did.
    seedDefaultDocumentTypes: async (organizationId: SafeId<"organization">) =>
      await ensureDefaultDocumentTypes(organizationId, rootDb),
    // Once per membership, on the owner connection that wrote the membership
    // row; the defaults are then the member's own private skills to delete.
    seedMemberDefaults: async (membership: NewMembership) =>
      await rootDb.transaction(
        async (tx) => await seedDefaultSkills({ ...membership, tx }),
      ),
  });

  const organizationPlugin = organization({
    ...BETTER_AUTH_ORGANIZATION_OPTIONS,
    ac,
    roles,
    organizationHooks: {
      ...organizationLifecycleHooks,
      async beforeCreateOrganization({ user }) {
        requireDemoAccountAccess(
          checkConfiguredDemoAccountAccess({
            email: user.email,
            operation: "growth",
          }),
        );
        requireReviewAccountAccess(
          checkConfiguredReviewAccountAccess({
            email: user.email,
            operation: REVIEW_ACCOUNT_OPERATION.createOrganization,
          }),
        );
        await Promise.resolve();
      },
      async beforeDeleteOrganization({ organization: org }) {
        // Complete the deletion here, before the plugin's adapter runs.
        // Everything that names the organization cascades away with it, and
        // those rows are the only description of the objects it owns:
        // object erasure is key-driven from database rows, nothing lists a
        // storage prefix, and the bucket expires only staging and export
        // keys. So the erasure instructions and the cascade have to reach
        // durable storage together, which is what this single transaction
        // gives — it records the instructions into the reference-free
        // tombstone tables, clears the chat rows that own storage, and
        // deletes the organization row itself. The adapter's own delete
        // then finds nothing left and returns the organization it read
        // before this hook, so the endpoint's response is unchanged.
        //
        // Deleting the row here, rather than letting it commit separately,
        // is the point: instructions committed ahead of a cascade that then
        // failed would name a live organization's documents.
        //
        // `org.id` is read off the row the plugin already loaded, so this is
        // where it becomes the ownership id. `rootDb` bypasses row-level
        // security exactly as the plugin's own adapter does.
        const organizationId = brandPersistedOrganizationId(org.id);
        const teardown = await Result.tryPromise({
          try: async () =>
            await rootDb.transaction(async (tx) => {
              // The provider bills a renewing subscription after the
              // organization is gone, so its owner cancels it first. The
              // check holds the entitlement row until the deletion commits.
              if (await hasRenewingHostedSubscription(tx, organizationId)) {
                return { type: "subscription_renews" } as const;
              }
              return {
                type: "deleted",
                teardown: await completeOrganizationDeletion({
                  organizationId,
                  tx,
                }),
              } as const;
            }),
          catch: (cause) => cause,
        });
        if (Result.isError(teardown)) {
          captureError(
            teardown.error,
            handlerErrorContext("lib.beforeDeleteOrganization.teardown_error", {
              organizationId,
            }),
          );
          throw teardown.error instanceof OrganizationStorageTeardownBoundError
            ? new APIError("BAD_REQUEST", {
                error: "organization_storage_too_large",
                message: teardown.error.message,
              })
            : new APIError("INTERNAL_SERVER_ERROR", {
                message: "Failed to delete the organization's stored files",
              });
        }

        if (teardown.value.type === "subscription_renews") {
          throw new APIError("CONFLICT", {
            error: ORGANIZATION_DELETION_REFUSAL_CODE.subscriptionRenews,
            message:
              "Cancel the organization's subscription before deleting the organization.",
          });
        }

        // Redis is not part of the durability contract: the request rows
        // are committed and the cleanup reconciler claims every pending one
        // on its own schedule. Accelerating a bounded prefix keeps a large
        // organization from fanning out an unbounded number of queue calls
        // or holding the response open behind the slowest of them.
        await handoffCommittedEntityDeletionCleanupBatch({
          captureDeliveryError: captureError,
          enqueueCleanup: enqueueEntityDeletionCleanup,
          requestIds: teardown.value.teardown.requestIds,
        });
      },
      // A readable refusal before the plugin writes anything; the
      // `member_organization_capacity` trigger is what holds the bound
      // under concurrent additions.
      async beforeCreateInvitation({ organization: org, invitation, inviter }) {
        await requireAssignableMemberRole(
          brandPersistedOrganizationId(org.id),
          invitation.role,
        );
        requireDemoAccountAccess(
          checkConfiguredDemoAccountAccess({
            email: inviter.email,
            operation: "growth",
          }),
        );
        requireDemoAccountAccess(
          checkConfiguredDemoAccountAccess({
            email: invitation.email,
            operation: "growth",
          }),
        );
        requireReviewAccountAccess(
          checkConfiguredReviewAccountAccess({
            email: inviter.email,
            operation: REVIEW_ACCOUNT_OPERATION.sendInvitation,
          }),
        );
        requireReviewAccountAccess(
          checkConfiguredReviewAccountAccess({
            email: invitation.email,
            operation: REVIEW_ACCOUNT_OPERATION.joinOrganization,
          }),
        );
        await reviewDatabaseHooks.invitationCreateBefore({
          organizationId: org.id,
        });
        await refuseBeyondMemberCapacity(
          brandPersistedOrganizationId(org.id),
          "invitation",
        );
      },
      async beforeAcceptInvitation({ organization: org, user }) {
        requireDemoAccountAccess(
          checkConfiguredDemoAccountAccess({
            email: user.email,
            operation: "growth",
          }),
        );
        requireReviewAccountAccess(
          checkConfiguredReviewAccountAccess({
            email: user.email,
            operation: REVIEW_ACCOUNT_OPERATION.acceptInvitation,
          }),
        );
        await reviewDatabaseHooks.memberCreateBefore({
          organizationId: org.id,
          userId: user.id,
        });
        await refuseBeyondMemberCapacity(
          brandPersistedOrganizationId(org.id),
          "membership",
        );
      },
      async beforeAddMember({ organization: org, user, member: addedMember }) {
        const endpoint = tryGetCurrentAuthEndpointContext();
        if (endpoint?.path === "/organization/create") {
          // Better Auth supplies the creator role, before a membership or
          // browser session exists on the system provisioning path.
          if (
            addedMember.role !== BETTER_AUTH_ORGANIZATION_OPTIONS.creatorRole
          ) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_member_role",
              message: "Select one product membership role.",
            });
          }
          // Better Auth creates the owner membership before its
          // afterCreateOrganization hook. Initialize the fail-closed access
          // row before capacity admission; the lifecycle hook repeats this
          // insert after creation and the owner is idempotent.
          await recordNewOrganizationAccessStateOnOwner(
            brandPersistedOrganizationId(org.id),
          );
        } else {
          await requireAssignableMemberRole(
            brandPersistedOrganizationId(org.id),
            addedMember.role,
          );
        }
        requireDemoAccountAccess(
          checkConfiguredDemoAccountAccess({
            email: user.email,
            operation: "growth",
          }),
        );
        // The review organization holds the review account alone.
        await reviewDatabaseHooks.memberCreateBefore({
          organizationId: org.id,
          userId: user.id,
        });
        // The review account belongs to its own organization only.
        if (org.id !== reviewConfig.organizationId) {
          requireReviewAccountAccess(
            checkConfiguredReviewAccountAccess({
              email: user.email,
              operation: REVIEW_ACCOUNT_OPERATION.joinOrganization,
            }),
          );
        }
        await refuseBeyondMemberCapacity(
          brandPersistedOrganizationId(org.id),
          "membership",
        );
      },
      async beforeUpdateMemberRole({
        member: updatedMember,
        newRole,
        organization: org,
      }) {
        await requireAssignableMemberRole(
          brandPersistedOrganizationId(org.id),
          newRole,
        );
        if (newRole !== "owner") {
          await refuseLastOwnerChange(
            brandPersistedOrganizationId(org.id),
            updatedMember.role,
          );
        }
      },
      async afterRemoveMember({ member: removedMember, organization: org }) {
        const organizationId = brandPersistedOrganizationId(org.id);
        const userId = brandPersistedUserId(removedMember.userId);
        // Membership, credentials and correspondence were removed together in
        // `beforeRemoveMember`'s transaction.
        // Their notification stream for this organization outlives the
        // membership otherwise: it is authorized once at connect time and
        // only re-checked on the next event.
        await revokeUserSseAccess(userId, organizationId);
      },
      async beforeRemoveMember({ member: removedMember, organization: org }) {
        // Branded here, at the boundary: both ids are read off persisted
        // rows by the plugin, not supplied by the caller, so these become ownership
        // ids for the tenant predicates the helper applies.
        const organizationId = brandPersistedOrganizationId(org.id);
        const userId = brandPersistedUserId(removedMember.userId);
        await refuseLastOwnerChange(organizationId, removedMember.role);
        const endpoint = tryGetCurrentAuthEndpointContext();
        const headers =
          endpoint?.headers instanceof Headers
            ? endpoint.headers
            : endpoint?.request?.headers;
        const session = headers
          ? await getAuth().api.getSession({
              headers,
              query: { disableCookieCache: true, disableRefresh: true },
            })
          : null;
        if (!session) {
          throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
        }
        const input =
          endpoint && isRecord(endpoint.body)
            ? endpoint.body["reassign_to"]
            : undefined;
        if (
          input !== undefined &&
          (typeof input !== "string" ||
            parseAuthProviderId<"user">(input) === null)
        ) {
          throw new APIError("BAD_REQUEST", {
            message: "User is not a member of this organization",
          });
        }
        const reassignTo =
          typeof input === "string" ? brandPersistedUserId(input) : undefined;
        const removal = await Result.tryPromise({
          try: async () =>
            await rootDb.transaction(async (tx) => {
              await removeOrganizationMemberInTransaction(tx, {
                organizationId,
                memberId: removedMember.id,
                userId,
                actorUserId: brandPersistedUserId(session.user.id),
                reassignTo,
              });
            }),
          catch: (error) =>
            HandlerError.is(error)
              ? new APIError(
                  error.status === 409 ? "CONFLICT" : "BAD_REQUEST",
                  {
                    message: error.message,
                    ...(error.code === undefined ? {} : { code: error.code }),
                    ...(error.retryable === undefined
                      ? {}
                      : { retryable: error.retryable }),
                  },
                )
              : mapMembershipInvariantError(error),
        });
        if (Result.isError(removal)) {
          if (
            !(removal.error instanceof APIError) ||
            removal.error.statusCode >= 500
          ) {
            observeFailure(removal.error, {
              sink: MEMBERSHIP_REMOVAL_FAILED,
              ctx: { organizationId },
            });
          }
          throw removal.error;
        }
      },
    },
    async sendInvitationEmail(data, request) {
      const inviteLink = `${env.FRONTEND_URL}/auth/accept-invitation/${data.id}`;
      if (isLocalDevOpen()) {
        // oxlint-disable-next-line no-console -- dev-only invitation-link echo for local testing
        console.log(`[DEV] Org invitation for ${data.email}: ${inviteLink}`);
        return;
      }

      const lang = extractLangFromRequest(request);
      await sendOrganizationInvitation({
        email: data.email,
        inviteLink,
        invitedByUsername: data.inviter.user.name,
        organizationName: data.organization.name,
        lang,
      });
    },
  });
  const removalBody = organizationPlugin.endpoints.removeMember.options.body;
  organizationPlugin.endpoints.removeMember.options.body = removalBody.extend({
    reassign_to: removalBody.shape.memberIdOrEmail.optional(),
  });

  const auth = betterAuth({
    // The route table mounts the handler at this path; one constant for both.
    basePath: AUTH_API_PATH,
    logger: errorOutputLogger,
    trustedOrigins: [
      ...frontendOrigins({
        frontendUrl: env.FRONTEND_URL,
        runtimeMode: runtimeMode(),
      }),
      ...(isLocalDevOpen() ? ["chrome-extension://*"] : []),
      ...(isLocalDevOpen() ? DEV_INSPECTOR_ORIGINS : []),
      ...(env.EXTENSION_ORIGIN ? [env.EXTENSION_ORIGIN] : []),
    ],
    disabledPaths: [
      "/token",
      // The API key plugin ships its own HTTP CRUD, and it authorizes on
      // "is this your key" alone — any signed-in member could mint a key for
      // themselves carrying arbitrary permissions, with no org-admin check, no
      // subset validation against their role, and no audit record. Machine-key
      // lifecycle is only allowed through `handlers/api-keys/`, which enforces
      // all three.
      //
      // `disabledPaths` is applied in the HTTP router's `onRequest` hook, so it
      // 404s these routes for external callers while leaving the server-side
      // `auth.api.*` calls those handlers make completely unaffected.
      "/api-key/create",
      "/api-key/update",
      "/api-key/delete",
      "/api-key/get",
      "/api-key/list",
      "/organization/leave",
      // OAuth client management Stella has no use for; see
      // `OAUTH_ENDPOINT_POLICY`.
      ...OAUTH_DISABLED_PATHS,
    ],
    user: {
      additionalFields: AUTH_USER_ADDITIONAL_FIELDS,
      validateUserInfo: createSocialIdentityValidation({
        tenantId: env.MICROSOFT_AUTH_TENANT_ID,
        requireMicrosoftVerifiedEmailClaim:
          env.MICROSOFT_REQUIRE_VERIFIED_EMAIL_CLAIM,
        warn: (attributes) =>
          logger.warn("auth.provider_claims_unavailable", attributes),
      }),
    },
    account: { accountLinking: SOCIAL_ACCOUNT_LINKING_OPTIONS },
    session: {
      additionalFields: SESSION_LIFETIME_FIELDS,
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      ...AUTH_SESSION_STORAGE_OPTIONS,
      // Cached snapshots perform no database work. Their lifetime bounds
      // prior-credential acceptance; startup reads bypass this snapshot.
      // Member and matter authorization remain live per request.
      cookieCache: {
        enabled: true,
        version: sessionLifetime.cookieCacheVersion,
        maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
      },
      // Disable Better Auth's session-freshness gate. It defaults to 1 day
      // (`create-context.mjs`: `freshAge ?? 3600 * 24`) and compares against
      // `session.createdAt`, which `updateAge` never refreshes — so every
      // session older than a day fails it. Two endpoints use it: `list-sessions`
      // and `unlink-account`. `list-sessions` is a read (viewing your own active
      // sessions) that the account page loads eagerly, so the gate turned it
      // into a 403 for any day-old login and crashed the page; and revoking a
      // session — the actual sensitive action — is not freshness-gated anyway,
      // so gating only the read made no sense. Unlinking uses a live session,
      // fresh email code and serialized keep-one check in the before hook.
      // Sensitive flows use Stella's own controls (OTP-verified account
      // deletion, TOTP two-factor). `0` removes the footgun without
      // weakening anything real. Guarded by the freshAge invariant in
      // `auth.test.ts`.
      freshAge: 0,
    },
    advanced: {
      // server.ts resolves the client address once per request and sets this
      // header, so rate limits and session addresses use the same value.
      ipAddress: { ipAddressHeaders: [AUTH_CLIENT_ADDRESS_HEADER] },
      cookiePrefix,
      database: AUTH_DATABASE_ID_OPTIONS,
      useSecureCookies,
    },
    rateLimit: {
      enabled: rateLimitEnabled,
      window: AUTH_RATE_LIMITS.global.window,
      max: AUTH_RATE_LIMITS.global.max,
      customStorage: observeFrameworkAuthStorage(authRateLimitStorage),
      customRules: {
        ...AUTH_REQUEST_IP_RULE_OVERRIDES,
        ...AUTH_FRAMEWORK_BUDGET_RULES,
      },
    },
    verification: AUTH_VERIFICATION_STORAGE_OPTIONS,
    emailAndPassword: resolveEmailAndPasswordOptions({
      localPasswordEnabled: isSelfhostLocalPasswordAuthEnabled(),
      reviewAccountConfigured: isReviewAccountConfigured(),
    }),
    emailVerification: { autoSignInAfterVerification: false },
    databaseHooks: {
      account: {
        create: {
          before: async (account, ctx) => {
            syntheticAuthHooks.accountCreateBefore(account);
            await reviewDatabaseHooks.accountCreateBefore(account, ctx);
          },
        },
      },
      member: {
        create: { before: reviewDatabaseHooks.memberCreateBefore },
      },
      invitation: {
        create: { before: reviewDatabaseHooks.invitationCreateBefore },
      },
      verification: {
        create: {
          // A first-factor sign-in that leaves its second factor pending
          // writes that grant in place of a session; it is held to the same
          // linked-account check, after the insert, and records the account
          // so completing the second factor is held to it too.
          after: async (row, ctx) => {
            if (!ctx || !isPendingTwoFactorSignIn(row.identifier)) {
              return;
            }
            const requirement = firstFactorRequirement(ctx);
            const ended = await endSessionWithoutLinkedAccount({
              requirement,
              userId: toSafeId<"user">(row.value),
              hasAccount: hasAccountForProvider,
              endSession: async () => {
                await ctx.context.internalAdapter.deleteVerificationByIdentifier(
                  row.identifier,
                );
              },
            });
            if (ended) {
              throw new APIError("UNAUTHORIZED", {
                message: DISCONNECTED_SIGN_IN_MESSAGE,
              });
            }
            await recordSecondFactorRequirement(ctx, { row, requirement });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const accountPolicy =
              (await demoSessionPolicy(session)) ??
              (await reviewSessionPolicy(session)) ??
              (await syntheticSessionPolicy(session));
            const data = accountPolicy?.data ?? session;
            const lifetime = decidePinnedSessionLifetime(data);
            return accountPolicy || lifetime
              ? { data: { ...data, ...lifetime } }
              : undefined;
          },
          // Aborting here, before Better Auth sets any cookie, issues neither
          // a session token nor a cached session snapshot for the session.
          after: async (session, ctx) => {
            const ended = await endSessionWithoutLinkedAccount({
              requirement: await sessionLinkedAccountRequirement(ctx),
              userId: toSafeId<"user">(session.userId),
              hasAccount: hasAccountForProvider,
              endSession: async () => {
                await ctx?.context.internalAdapter.deleteSession(session.token);
              },
            });
            if (ended) {
              throw new APIError("UNAUTHORIZED", {
                message: DISCONNECTED_SIGN_IN_MESSAGE,
              });
            }
          },
        },
      },
      user: {
        create: {
          before: async (user, ctx) => {
            // Refuses a creation path that has not decided whether it shows
            // the professional-use statement, before the row is written.
            requireUserCreationOrigin(ctx?.path);
            syntheticAuthHooks.userCreateBefore(user);
            await reviewDatabaseHooks.userCreateBefore(user, ctx);
            const data = Result.gen(function* () {
              yield* checkNewAccountEmailAllowedForCreation({
                email: user.email,
                path: ctx?.path,
              });
              yield* validateTimezoneId(user["timezoneId"]);
              // Email-OTP and some social providers leave `name` blank.
              // The `notNull` schema constraint allows empty strings, which
              // surfaces as a blank "Author" everywhere the user is shown.
              // Default to the email local-part so the column is never empty.
              // Then trim `preferredName` / `wordEditShortcut` (Word author /
              // initials prefs) before persisting.
              return normalizeUserPreferences(ensureDisplayName(user));
            });
            // Better Auth rejects a database hook by the APIError it throws.
            if (Result.isError(data)) {
              throw data.error;
            }
            const detectedCountry = detectedCountryFromRequestContext(ctx);
            return await Promise.resolve({
              data: detectedCountry
                ? { ...data.value, detectedCountry }
                : data.value,
            });
          },
          // Creating the account where the professional-use statement is
          // shown, from a request naming the current version, is the
          // acceptance; otherwise the account accepts on its first
          // interactive sign-in. Insert-once on the owner connection that
          // wrote the user row.
          after: async (user, ctx) => {
            await recordUserProfessionalUseAtCreation(rootDb, {
              userId: brandPersistedUserId(user.id),
              acceptance: await readCreationAcceptance(ctx, getOAuthState),
            });
          },
        },
        update: {
          before: async (user, ctx) => {
            const data = validateTimezoneId(user["timezoneId"]).andThen(() =>
              normalizeUserPreferences(ensureDisplayName(user)),
            );
            if (Result.isError(data)) {
              throw data.error;
            }
            const promotedEmail = emailOtpPromotionEmail(user, ctx);
            if (ctx && promotedEmail !== undefined) {
              await revokeUnprovenCredentials(
                ctx.context.internalAdapter,
                promotedEmail,
              );
            }
            return { data: data.value };
          },
        },
      },
    },
    database: membershipAuthAdapter,
    socialProviders: createSocialProviders({
      googleClientId: env.GOOGLE_AUTH_CLIENT_ID,
      googleClientSecret: env.GOOGLE_AUTH_CLIENT_SECRET,
      microsoftClientId: env.MICROSOFT_AUTH_CLIENT_ID,
      microsoftClientSecret: env.MICROSOFT_AUTH_CLIENT_SECRET,
      microsoftTenantId: env.MICROSOFT_AUTH_TENANT_ID,
    }),
    plugins: [
      {
        id: "sign-in-method-confirmation",
        endpoints: {
          sendSignInMethodConfirmation: createAuthEndpoint(
            "/sign-in-methods/send-otp",
            { method: "POST" },
            async (ctx) => {
              const session = await getAuthoritativeSessionFromCtx(ctx);
              if (!session) {
                throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
              }
              const sent = await sendManageOtp({
                purpose: "unlink-account",
                email: session.user.email,
                request: ctx.request,
              });
              if (Result.isError(sent)) {
                observeFailure(sent.error, {
                  sink: SIGN_IN_METHOD_CONFIRMATION_FAILED,
                });
                throw new APIError(
                  sent.error.status >= 500
                    ? "INTERNAL_SERVER_ERROR"
                    : "BAD_REQUEST",
                  {
                    message: "Could not send confirmation code",
                    cause: sent.error,
                  },
                );
              }
              return ctx.json(sent.value);
            },
          ),
        },
      },
      REGISTRATION_RETENTION_SCHEMA_PLUGIN,
      CLIENT_METADATA_VALIDATION_SCHEMA_PLUGIN,
      sessionLifetime.plugin,
      createMcpWebHandoffPlugin({ service: getWebHandoffService }),
      createAgentUserPlugin(),
      createReviewAccountUserPlugin(reviewConfig),
      createReviewAccountPlugin({
        id: "restricted-monitoring-account",
        config: syntheticPrincipalAuthConfig,
        localPasswordEnabled: true,
        checkAccess: checkSyntheticPrincipalAccess,
        authorizeSession: authorizeOwnerSyntheticSession,
      }),
      createSessionBearer(),
      createDemoSessionFilter(demoConfig),
      createOtpAccountLimitPlugin({
        enabled: rateLimitEnabled,
        context: new RedisRateLimitContext({
          failurePolicy: "fail_open_local",
        }),
        demoAccountEmail: demoConfig.email,
      }),
      createReviewAccountPlugin({
        config: reviewConfig,
        localPasswordEnabled: isSelfhostLocalPasswordAuthEnabled(),
        signInBudget: !rateLimitEnabled
          ? undefined
          : createAccountAttemptBudget(
              new RedisRateLimitContext({ failurePolicy: "fail_open_local" }),
              {
                counterPrefix: "password-account",
                nameFor: () => "auth.password.account",
                budgetFor: () => REVIEW_ACCOUNT_SIGN_IN_BUDGET,
              },
            ),
      }),
      // The after-hook on /get-session signs a `set-auth-jwt` response
      // header on every session resolution by reading the jwks table.
      // Nothing in the repo consumes that header: JWT issuance already
      // goes through the disabled `/token` path above, and MCP bearer
      // verification (mcp/auth.ts) hits the `/jwks` endpoint via its own
      // client, unaffected by this flag. better-auth recommends disabling
      // it when running alongside an oauth provider plugin.
      jwt({
        disableSettingJwtHeader: true,
        // Browser auth is mounted on the web origin, but machine clients use
        // the stable public API issuer. Keep existing MCP/CLI tokens valid
        // across the browser transport cutover.
        jwt: { issuer: getAuthIssuerUrl() },
      }),
      lastLoginMethod(),
      apiKey([...API_KEY_PLUGIN_CONFIGS]),
      emailOTP({
        // Pin the security-relevant OTP parameters explicitly rather than
        // inheriting library defaults, so a better-auth upgrade cannot
        // silently widen the guessing window. These match the current
        // defaults (6 digits, 5-minute expiry, 3 attempts before the code
        // is invalidated); change deliberately, not by dependency drift.
        otpLength: 6,
        expiresIn: 5 * 60,
        allowedAttempts: EMAIL_OTP_ALLOWED_ATTEMPTS,
        storeOTP: "plain",
        // Returning undefined falls back to the plugin's random generator
        // (`opts.generateOTP(...) || defaultOTPGenerator`), so every account
        // except the configured demo account keeps random codes.
        generateOTP: ({ email, type }) =>
          getDemoAccountOtpOverride({ email, type }),
        async sendVerificationOTP({ email, otp, type }, ctx) {
          await runEmailOtpRequestOnResponseSchedule({
            responseDelayMs: getEmailOtpMinimumResponseDuration({
              path: ctx?.path,
              runtimeMode: runtimeMode(),
              type,
            }),
            runRequest: async () => {
              const newAccountOtpAction = await getNewAccountEmailOtpAction({
                body: { email, type },
                path: ctx?.path ?? "",
                request: ctx?.request,
              });
              switch (newAccountOtpAction.type) {
                case NEW_ACCOUNT_EMAIL_OTP_ACTION.continue:
                  break;
                case NEW_ACCOUNT_EMAIL_OTP_ACTION.suppressOtp:
                  // The endpoint still returns its ordinary success response.
                  // The shared response schedule avoids a fast-return timing
                  // signal when delivery is suppressed.
                  return;
                default:
                  newAccountOtpAction satisfies never;
                  panic(
                    `Unhandled new account otp action: ${String(newAccountOtpAction)}`,
                  );
              }

              if (isLocalDevOpen()) {
                // oxlint-disable-next-line no-console -- local development OTP echo (gated on the runtime opt-in; value printed verbatim by design)
                console.log(`[DEV] OTP for ${email}: ${otp} (type: ${type})`);
                stashDevOtp(email, otp);
                return;
              }

              if (getDemoAccountOtpOverride({ email, type }) !== undefined) {
                // The demo account's fixed code is shared out-of-band;
                // nothing to deliver. The shared response schedule above
                // keeps the timing indistinguishable from a real send.
                return;
              }

              if (!isTransactionalEmailConfigured()) {
                throw new APIError("BAD_REQUEST", {
                  message: "Email sign-in is not configured for this instance.",
                });
              }

              const lang = extractLangFromRequest(ctx?.request);
              await sendOTPEmail({ email, otp, type, lang });
            },
          });
        },
      }),
      twoFactorWithSignInGate,
      // Must be registered after `twoFactorWithSignInGate` so its after-hook
      // runs after the two-factor hook has set the pending-challenge response.
      socialSignInTwoFactorRedirectPlugin,
      // After the two-factor redirect, so it counts the response the browser
      // actually receives.
      socialSignInOutcomePlugin,
      organizationPlugin,
      createOAuthConsentInfoPlugin([env.FRONTEND_URL, getAuthIssuerUrl()]),
      createStellaOAuthProvider(
        {
          loginPage: OAUTH_UI_LOGIN_PATH,
          consentPage: OAUTH_UI_CONSENT_PATH,
          scopes: [...MCP_OAUTH_SCOPES],
          resources: oauthResources,
          // The additive bridge/backfill owns resource creation and proves its
          // fixed point before this candidate runs. Runtime seeding would hide
          // a missed migration and add an owner-DB write to auth startup.
          resourceSeedMode: "none",
          enforcePerClientResources: true,
          clientRegistrationDefaultResources: oauthResourceIdentifiers,
          clientRegistrationAllowedResources: oauthResourceIdentifiers,
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          rateLimit: {
            token: AUTH_RATE_LIMITS.oauthToken,
            authorize: AUTH_RATE_LIMITS.oauthAuthorization,
            register: AUTH_RATE_LIMITS.oauthClientRegistration,
          },
          // Hosted MCP clients identify themselves by an https URL `client_id`
          // and skip per-user registration entirely. The transport resolves the
          // host once, refuses any non-public-routable answer, pins that address
          // for the connection, and never follows a redirect; resources and
          // scopes stay bound by the `clientMetadataDocument` registration rules
          // above, so such a client gets no more reach than a registered one.
          extensions: [
            {
              claims: {
                accessToken: async (input) => {
                  const claims = await getServiceOAuthClaims(input);
                  if (Result.isError(claims)) {
                    const error = new APIError("FORBIDDEN", {
                      error: "unauthorized_client",
                      message: claims.error.message,
                    });
                    throw error;
                  }
                  return claims.value;
                },
              },
            },
            {
              clientDiscovery: withStaleIfError(
                createCimdClientDiscovery({
                  fetchClientMetadataResource: withOwnClientDocuments(
                    fetchClientMetadataResource,
                  ),
                  onClientCreated: recordClientMetadataValidated,
                  onClientRefreshed: recordClientMetadataValidated,
                }),
              ),
            },
          ],
          accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
          refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
          refreshTokenReuseInterval: REFRESH_TOKEN_REUSE_INTERVAL,
          clientReference: ({ session }) =>
            getSessionActiveOrganizationId(session),
          // `prompt=select_account` opens the organization step, which names
          // the signed-in account, offers to switch it and lists the
          // memberships to pick from; its continue step clears the prompt.
          // Without the prompt, account selection is never forced.
          selectAccount: {
            page: OAUTH_UI_ORGANIZATION_PATH,
            shouldRedirect: () => false,
          },
          postLogin: {
            page: OAUTH_UI_ORGANIZATION_PATH,
            shouldRedirect: async ({
              scopes,
              session,
              user,
            }): Promise<boolean> => {
              const needsOrganization = scopes.some(isMcpResourceScope);
              if (!needsOrganization) {
                return false;
              }

              const activeOrganizationId =
                getSessionActiveOrganizationId(session);
              // The organization page continues the authorization once the user
              // has picked; the provider asks this predicate again on that step,
              // so the pick itself has to end the redirect.
              if (activeOrganizationId && isOrganizationPageContinuation()) {
                return false;
              }

              // Read the memberships directly: an internal call to the
              // organization list endpoint carries no request method, so the
              // account plugins' organization rules cannot tell it is a read.
              // More than one membership always needs the picker.
              const memberships = await readBounded(
                rootDb
                  .select({ organizationId: member.organizationId })
                  .from(member)
                  .where(eq(member.userId, user.id)),
                1,
              );

              return (
                memberships.type === "overflow" ||
                memberships.rows.length !== 1 ||
                memberships.rows.at(0)?.organizationId !== activeOrganizationId
              );
            },
            consentReferenceId: ({ scopes, session }) => {
              const needsOrganization = scopes.some(isMcpResourceScope);
              if (!needsOrganization) {
                return undefined;
              }

              const activeOrganizationId =
                getSessionActiveOrganizationId(session);
              if (!activeOrganizationId) {
                throw new APIError("BAD_REQUEST", {
                  error: "set_organization",
                  message:
                    "An organization must be selected before granting stella MCP access",
                });
              }

              return activeOrganizationId;
            },
          },
          customAccessTokenClaims: async ({ referenceId, user }) => {
            if (user) {
              requireDemoAccountAccess(
                checkConfiguredDemoAccountAccess({
                  email: user.email,
                  operation: "growth",
                }),
              );
            }
            if (!referenceId || !user) {
              return referenceId ? { org_id: referenceId } : {};
            }
            // The review account's tokens open its own organization only.
            requireReviewAccountAccess(
              checkConfiguredReviewAccountAccess({
                email: user.email,
                operation: REVIEW_ACCOUNT_OPERATION.session,
                organizationId: referenceId,
              }),
            );
            // `member_id` pins the token to the membership row that minted it,
            // so a later membership of the same user in the same organization
            // (removal followed by re-invitation) is a different identity.
            const row = await rootDb
              .select({ id: member.id })
              .from(member)
              .where(
                and(
                  eq(member.userId, user.id),
                  eq(member.organizationId, referenceId),
                ),
              )
              .limit(1)
              .then((rows) => rows.at(0));
            if (!row) {
              throw new APIError("FORBIDDEN", {
                message: "The user is not a member of this organization",
              });
            }
            return { org_id: referenceId, [MCP_MEMBER_ID_CLAIM]: row.id };
          },
        },
        {
          requestBudget: {
            storage: authRateLimitStorage,
            enabled: rateLimitEnabled,
            frameworkApi: requestBudgetFrameworkApi,
          },
          verifiedOrigins: getVerifiedOAuthOrigins([
            env.FRONTEND_URL,
            getAuthIssuerUrl(),
          ]),
          partnerResource: {
            url: getMcpResourceUrl(),
            isPartnerClient: isPartnerOAuthClient,
          },
        },
      ),
      oauthUiFragmentBridgePlugin,
      createSocialLinkHintPlugin(getOAuthState),
      createSessionTokenRedactionPlugin(createAuthMiddleware),
      // Last, so it records the answer every other hook has settled on.
      createAuthRefusalLogPlugin(createAuthMiddleware),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        markAuthRequestRoute(ctx);
        await signInRequestBudget(ctx);
        sessionLifetime.prepare(ctx.context);
        // Better Call gives pathless server-only operations the middleware path "/".
        if (!ctx.path || ctx.path === "/") {
          return undefined;
        }
        if (demoConfig.email) {
          const body: unknown = ctx.body;
          const email = isRecord(body) ? body["email"] : undefined;
          if (
            typeof email === "string" &&
            isSessionCreatingAuthPath(ctx.path)
          ) {
            requireDemoAccountAccess(
              checkConfiguredDemoAccountAccess({ email, operation: "sign-in" }),
            );
          }
          if (
            ctx.path !== "/get-session" &&
            !isSessionCreatingAuthPath(ctx.path) &&
            ctx.path !== SEND_VERIFICATION_OTP_PATH
          ) {
            const { request, ...middlewareContext } = ctx;
            await demoSessionGuard({
              ...middlewareContext,
              ...(request ? { request } : {}),
            });
          }
          const requestedUserId = isRecord(body) ? body["userId"] : undefined;
          if (
            ctx.path === "/api-key/create" &&
            typeof requestedUserId === "string"
          ) {
            const account =
              await ctx.context.internalAdapter.findUserById(requestedUserId);
            if (!account) {
              throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
            }
            const access = checkDemoAccountOperation(account.email);
            if (Result.isError(access)) {
              throw new APIError("FORBIDDEN", {
                code: "account_access_unavailable",
                message: "This operation is unavailable for this account.",
              });
            }
          }
        }
        // Better Call supplies `/` to hooks for server-only, pathless helpers.
        if (ctx.path !== "/" && requiresHandoffStepUpForAuthPath(ctx.path)) {
          const current = await getAuthoritativeSessionFromCtx(ctx);
          if (typeof current?.session["originConsentId"] === "string") {
            throw new APIError("FORBIDDEN", {
              code: MCP_HANDOFF_STEP_UP_REQUIRED,
              message: "Sign in again to continue.",
            });
          }
        }
        await assertSelfhostEmailOtpAllowed(ctx.path);
        if (ctx.path === "/unlink-account") {
          const result = await unlinkAccountWithConfirmation({
            session: await getAuthoritativeSessionFromCtx(ctx),
            body: ctx.body,
            request: ctx.request,
          });
          if (Result.isError(result)) {
            throw result.error;
          }
          return ctx.json({ status: true });
        }
        const resetConfirmation = await requireEmailOtpResetConfirmation({
          path: ctx.path,
          body: ctx.body,
          adapter: ctx.context.adapter,
          internalAdapter: ctx.context.internalAdapter,
        });

        const loopbackRegistration =
          resolveLoopbackClientRegistrationOverride(ctx);
        if (loopbackRegistration) {
          return loopbackRegistration;
        }

        const authoritative = await resetConfirmation.andThenAsync(
          async () =>
            await resolveAuthoritativeSessionForSensitiveAuthPath({
              ctx,
              resolveSession: async ({ path, request }) =>
                await getAuthoritativeSessionFromCtx({ ...ctx, path, request }),
            }),
        );
        // Better Auth rejects a request from a `before` hook by the APIError
        // it throws.
        if (Result.isError(authoritative)) {
          throw authoritative.error;
        }
        if (authoritative.value) {
          return authoritative.value;
        }

        if (!shouldHandleSelfhostBootstrapPath(ctx.path)) {
          return undefined;
        }

        await assertSelfhostBootstrapSignUp(ctx.body);
        return undefined;
      }),
      after: createAuthMiddleware(async (ctx) => {
        const newSession = ctx.context.newSession;
        await sendNewDeviceNotice({
          path: ctx.path,
          newSession: newSession
            ? {
                user: {
                  id: toSafeId<"user">(newSession.user.id),
                  email: newSession.user.email,
                },
                session: {
                  id: newSession.session.id,
                  ipAddress: newSession.session.ipAddress,
                  userAgent: newSession.session.userAgent,
                  createdAt: newSession.session.createdAt,
                },
              }
            : null,
          dependencies: {
            findPreviousSessions: findOtherSessionDevices,
            sendNotice: ({ email, device, ipAddress, createdAt }) => {
              const lang = extractLangFromRequest(ctx.request);
              const formattedTime =
                getNewDeviceLoginDateTimeFormat(lang).format(createdAt);

              ctx.context.runInBackground(
                sendNewDeviceLoginEmail({
                  email,
                  device,
                  ipAddress,
                  time: formattedTime,
                  sessionsUrl: `${env.FRONTEND_URL}${ACTIVE_SESSIONS_FRONTEND_PATH}`,
                  lang,
                }).catch((error: unknown) => {
                  captureError(
                    error,
                    handlerErrorContext("lib.notified", {
                      source: "new-device-login-email",
                    }),
                  );
                  throw error;
                }),
              );
            },
            isTransactionalEmailConfigured,
            isLocalDev: isLocalDevOpen,
            onError: (error) =>
              captureError(
                error,
                handlerErrorContext("lib.auth.notified_error", {
                  source: "new-device-login-hook",
                }),
              ),
          },
        });
      }),
    },
  });
  return auth;
};

let _auth: ReturnType<typeof createAuth> | undefined;

export const getAuth = () => {
  if (_auth) {
    return _auth;
  }
  _auth = createAuth();
  return _auth;
};

/** Read the rate-limit subject at the session validation boundary. */
export const resolveRateLimitSessionUserId = async (headers: Headers) => {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  return session ? toSafeId<"user">(session.user.id) : null;
};

export type { MemberRole } from "@/api/lib/member-roles";

type AuthSessionReadOptions = {
  headers: Headers | Record<string, string>;
  query?: {
    disableCookieCache: true;
    disableRefresh: true;
  };
  returnHeaders: true;
};
/** The caller's session; a request without a session credential skips the lookup. */
const readAuthSession = async (options: AuthSessionReadOptions) => {
  const auth = getAuth();
  const headers =
    options.headers instanceof Headers
      ? options.headers
      : new Headers(options.headers);
  const sessionCookie = await skippableSessionCookieOf(auth);
  if (
    sessionCookie !== null &&
    !carriesSessionCredential(headers, sessionCookie)
  ) {
    return { headers: new Headers(), response: null };
  }
  return await auth.api.getSession(options);
};
type AuthSessionReader = typeof readAuthSession;

type GetSessionAndMemberAuthorizationOptions = {
  getSession?: AuthSessionReader | undefined;
  headers: Headers | Record<string, string>;
  responseHeaders: ResponseHeaders;
  workspaceId?: SafeId<"workspace"> | undefined;
};

const getSessionAndMemberAuthorization = async ({
  getSession = readAuthSession,
  headers,
  responseHeaders,
  workspaceId,
}: GetSessionAndMemberAuthorizationOptions) => {
  const sessionResult = await Result.tryPromise(async () => {
    const resolved = await getSession({
      headers,
      returnHeaders: true,
    });
    appendSetCookieHeaders(responseHeaders, resolved.headers);
    return resolved.response;
  });

  const session = Result.isOk(sessionResult)
    ? sessionResult.value?.session
    : null;
  const user = Result.isOk(sessionResult) ? sessionResult.value?.user : null;
  const activeOrganizationId = getSessionActiveOrganizationId(session);

  const memberAuthorizationResult =
    session && user && activeOrganizationId
      ? await Result.tryPromise(async () => {
          const authorization = await resolveMemberAuthorization(
            {
              userId: toSafeId<"user">(user.id),
              organizationId: toSafeId<"organization">(activeOrganizationId),
              workspaceId,
            },
            rootDb,
          );

          if (!authorization || !isMemberRole(authorization.role)) {
            return null;
          }

          return {
            role: authorization.role,
            workspace: authorization.workspace,
            email: authorization.email,
            emailVerified: authorization.emailVerified,
            userDeleted: authorization.userDeleted,
            enrolledFeatureIds: authorization.enrolledFeatureIds,
            professionalUse: authorization.professionalUse,
          };
        })
      : Result.ok(null);

  return {
    sessionResult,
    memberAuthorizationResult,
  };
};

type AuthRejectionStatus = 401 | 403 | 404 | 500;

// Every access rejection carries the shared JSON error body, so a client can
// tell why it was refused and what to do next.
export const AUTH_REJECTION_BODY = {
  401: { code: "permission_denied", message: "Sign in to continue." },
  403: {
    code: "permission_denied",
    message: "Your role does not allow this action.",
  },
  404: { code: "not_found", message: "Matter not found." },
  500: { code: "internal_error", message: "Could not verify your session." },
} as const satisfies Record<
  AuthRejectionStatus,
  { code: string; message: string }
>;

/**
 * The rejection a signed-in account gets until it accepts the
 * professional-use statement; the web app answers it with the prompt.
 */
const PROFESSIONAL_USE_REJECTION_BODY = {
  code: PROFESSIONAL_USE_REQUIRED_CODE,
  message: "Accept the professional-use statement in stella to continue.",
} as const;

const VALIDATE_AUTH_REJECTION_BODY = {
  401: AUTH_REJECTION_BODY[401],
  403: PROFESSIONAL_USE_REJECTION_BODY,
  500: AUTH_REJECTION_BODY[500],
} as const satisfies Record<
  Extract<
    Awaited<ReturnType<typeof resolveValidateAuth>>,
    { ok: false }
  >["statusCode"],
  { code: string; message: string }
>;

/**
 * Account routes confirm the session still exists in storage. Organization
 * routes may serve the cached cookie snapshot because their member lookup runs
 * live on every request; an account route has no such lookup, so the stored
 * session is the only thing that ends when the session or the account does.
 * The snapshot still supplies the session itself; one indexed read checks it
 * is live, instead of a full uncached session load.
 */
/** A caller an access step admitted, or the answer refusing it. */
export type CallerOutcome<TCaller> =
  | { readonly ok: true; readonly caller: TCaller }
  | {
      readonly ok: false;
      readonly answer: HttpStatusResponse<
        number,
        { readonly code: string; readonly message: string }
      >;
    };

export type SessionCaller = {
  readonly user: { readonly id: SafeId<"user">; readonly email: string };
};

export const authenticateSession = async (
  { request, set }: Pick<RequestContext, "request" | "set">,
  access: HandoffAccessMetadata,
): Promise<CallerOutcome<SessionCaller>> => {
  const sessionResult = await Result.tryPromise(async () => {
    const resolved = await getAuth().api.getSession({
      headers: request.headers,
      returnHeaders: true,
    });
    appendSetCookieHeaders(set.headers, resolved.headers);
    return resolved.response;
  });

  if (Result.isError(sessionResult)) {
    return { ok: false, answer: status(500, AUTH_REJECTION_BODY[500]) };
  }

  const session = sessionResult.value?.session;
  const user = sessionResult.value?.user;
  if (!session || !user) {
    return { ok: false, answer: status(401, AUTH_REJECTION_BODY[401]) };
  }

  // The signed snapshot may outlive its stored session for its cache
  // lifetime; one indexed read confirms the session still exists. Signing
  // out elsewhere deletes the row, and deleting the account cascades.
  // The read goes through the auth layer's own database adapter, which
  // only reaches auth tables.
  const liveResult = await Result.tryPromise(async () => {
    const { adapter } = await getAuth().$context;
    return await adapter.findOne<{ id: string }>({
      model: "session",
      where: [
        { field: "id", value: session.id },
        { field: "userId", value: user.id },
        { field: "expiresAt", operator: "gt", value: new Date() },
      ],
      select: ["id"],
    });
  });
  if (Result.isError(liveResult)) {
    return { ok: false, answer: status(500, AUTH_REJECTION_BODY[500]) };
  }
  if (liveResult.value === null) {
    return { ok: false, answer: status(401, AUTH_REJECTION_BODY[401]) };
  }

  const stepUp = handoffStepUpRefusal({
    originConsentId: session.originConsentId ?? null,
    request,
    access,
  });
  if (stepUp !== undefined) {
    return { ok: false, answer: stepUp };
  }

  const userId = toSafeId<"user">(user.id);
  enrichRequestContext({
    posthogDistinctId: userId,
  });

  return {
    ok: true,
    caller: {
      user: {
        id: userId,
        email: user.email,
      },
    },
  };
};

/**
 * Structural subset of `rootDb` the bounded membership query needs. Tests can
 * pass their PGlite database without importing a test-only type here.
 */
type MemberAuthorizationDb = Pick<typeof rootDb, "select">;

const featureAccessColumns = (organizationId: SafeId<"organization">) => {
  const { enrolmentFeatureIds } = featureAccessReadPlan({ organizationId });
  return {
    emailVerified: authUser.emailVerified,
    userDeleted: sql<boolean>`${authUser.deletedAt} is not null`,
    // Fold enrolments into the member read only when a self-serve decision needs them.
    enrolledFeatureIds:
      enrolmentFeatureIds.length === 0
        ? sql<string[]>`'{}'::text[]`
        : sql<
            string[]
          >`coalesce((select array_agg(${featureEnrolments.featureId}) from ${featureEnrolments} where ${featureEnrolments.organizationId} = ${member.organizationId} and ${featureEnrolments.userId} = ${member.userId} and ${featureEnrolments.featureId} = ANY(${typedPgArray(enrolmentFeatureIds, "text")})), '{}')`,
  };
};

const ACTIVE_WORKSPACE_STATUS = "active";

export const resolveMemberAuthorization = async (
  { organizationId, userId, workspaceId }: MemberAuthorizationLookup,
  db: MemberAuthorizationDb,
): Promise<MemberAuthorization | null> => {
  if (!workspaceId) {
    const row = await db
      .select({
        memberId: member.id,
        role: member.role,
        email: authUser.email,
        ...featureAccessColumns(organizationId),
        ...professionalUseColumns,
      })
      .from(member)
      .innerJoin(authUser, eq(authUser.id, member.userId))
      .leftJoin(
        userProfessionalUseAcceptances,
        eq(userProfessionalUseAcceptances.userId, member.userId),
      )
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, organizationId),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0));

    return row
      ? {
          memberId: row.memberId,
          email: row.email,
          role: row.role,
          workspace: null,
          emailVerified: row.emailVerified,
          userDeleted: row.userDeleted,
          enrolledFeatureIds: row.enrolledFeatureIds,
          professionalUse: professionalUseStateOf(row),
        }
      : null;
  }

  const row = await db
    .select({
      memberId: member.id,
      email: authUser.email,
      role: member.role,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
      ...featureAccessColumns(organizationId),
      ...professionalUseColumns,
    })
    .from(member)
    .innerJoin(authUser, eq(authUser.id, member.userId))
    .leftJoin(
      userProfessionalUseAcceptances,
      eq(userProfessionalUseAcceptances.userId, member.userId),
    )
    .leftJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, member.organizationId),
        memberReachesMatterSql(
          { organizationId: member.organizationId, userId: member.userId },
          workspaces.id,
        ),
      ),
    )
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    )
    .limit(1)
    .then((rows) => rows.at(0));

  if (!row) {
    return null;
  }

  const featureFacts = {
    emailVerified: row.emailVerified,
    userDeleted: row.userDeleted,
    enrolledFeatureIds: row.enrolledFeatureIds,
    professionalUse: professionalUseStateOf(row),
  };
  if (row.workspaceId === null || row.workspaceStatus === null) {
    return {
      memberId: row.memberId,
      email: row.email,
      role: row.role,
      workspace: null,
      ...featureFacts,
    };
  }

  return {
    memberId: row.memberId,
    email: row.email,
    role: row.role,
    workspace: { id: row.workspaceId, status: row.workspaceStatus },
    ...featureFacts,
  };
};

/**
 * {@link resolveMemberAuthorization} for credential boundaries (an MCP
 * session, a machine key, a registry key) that resolve an identity before
 * any request scope exists. Reads through the same connection as the session
 * resolve in this module.
 */
export const resolveCredentialMemberAuthorization = async (
  lookup: MemberAuthorizationLookup,
): Promise<MemberAuthorization | null> =>
  await resolveMemberAuthorization(lookup, rootDb);

/**
 * The signed-in account's own professional-use state, read on the owner
 * connection: the request role has no access to acceptances.
 */
export const readAccountProfessionalUse = async (
  userId: SafeId<"user">,
): Promise<UserProfessionalUseState> =>
  await readUserProfessionalUse(rootDb, userId);

/**
 * Whether the caller still belongs to the organization their session is
 * scoped to. A session with no active organization answers `true`: an account
 * still in onboarding belongs to none yet. Session handlers receive only
 * `user.id`, so the organization is resolved and branded here, at the same
 * boundary the rest of the session identity crosses.
 */
export const isActiveOrganizationMember = async ({
  headers,
  responseHeaders,
  userId,
}: {
  headers: Headers;
  responseHeaders: ResponseHeaders;
  userId: SafeId<"user">;
}): Promise<boolean> => {
  const resolved = await getAuth().api.getSession({
    headers,
    returnHeaders: true,
  });
  appendSetCookieHeaders(responseHeaders, resolved.headers);
  const activeOrganizationId = getSessionActiveOrganizationId(
    resolved.response?.session,
  );
  if (activeOrganizationId === undefined) {
    return true;
  }
  const authorization = await resolveMemberAuthorization(
    {
      organizationId: brandPersistedOrganizationId(activeOrganizationId),
      userId,
    },
    rootDb,
  );
  return authorization !== null;
};

/**
 * Whether one user-channel SSE stream may still receive events. Reads through
 * the owner connection for the same reason the workspace audience does: event
 * delivery must be able to evaluate a member whose access was just removed and
 * who can no longer open an RLS-scoped request of their own.
 */
export const resolveUserRealtimeAuthorization = async (
  {
    organizationId,
    sessionIds,
    userId,
  }: {
    organizationId: SafeId<"organization">;
    sessionIds: readonly string[];
    userId: SafeId<"user">;
  },
  db: MemberAuthorizationDb,
): Promise<ReadonlySet<string>> => {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) {
    return new Set();
  }

  const rows = await db
    .select({ sessionId: authSession.id })
    .from(member)
    .innerJoin(
      authSession,
      and(
        eq(authSession.userId, member.userId),
        inArray(authSession.id, uniqueSessionIds),
        gt(authSession.expiresAt, new Date()),
      ),
    )
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(uniqueSessionIds.length);

  return new Set(rows.map((row) => row.sessionId));
};

type WorkspaceRealtimeAudienceLookup = {
  sessionIds: readonly string[];
  workspaceId: SafeId<"workspace">;
};

/**
 * Resolve the current audience for one workspace event in a single bounded
 * authorization query. This deliberately reads through the owner connection:
 * event delivery is a system boundary that must evaluate every connected user,
 * including users whose membership was just removed and can no longer open an
 * RLS-scoped request of their own.
 */
export const resolveWorkspaceRealtimeAudience = async (
  { sessionIds, workspaceId }: WorkspaceRealtimeAudienceLookup,
  db: MemberAuthorizationDb,
) => {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) {
    return new Set<string>();
  }

  const rows = await db
    .select({ sessionId: authSession.id })
    .from(member)
    .innerJoin(
      authSession,
      and(
        eq(authSession.userId, member.userId),
        inArray(authSession.id, uniqueSessionIds),
        gt(authSession.expiresAt, new Date()),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, member.organizationId),
        eq(workspaces.status, ACTIVE_WORKSPACE_STATUS),
        memberReachesMatterSql(
          { organizationId: member.organizationId, userId: member.userId },
          workspaces.id,
        ),
      ),
    )
    .limit(uniqueSessionIds.length);

  return new Set(rows.map((row) => row.sessionId));
};

/**
 * The event stream's connection authorizers, both on the owner connection for
 * the reasons given on each resolver.
 */
export const realtimeAuthorizers = {
  sessions: readCurrentLiveSseSessions,
  user: async (
    lookup: Parameters<typeof resolveUserRealtimeAuthorization>[0],
  ) => await resolveUserRealtimeAuthorization(lookup, rootDb),
  workspace: async (lookup: WorkspaceRealtimeAudienceLookup) =>
    await resolveWorkspaceRealtimeAudience(lookup, rootDb),
};

/**
 * Per-request memoization of the member resolution.
 *
 * Gates that run ahead of a route (feature access, capability requests) and
 * the route's own access step read the same caller; memoizing per request
 * makes that one session, member-role and org-settings lookup however many
 * of them ask. The cache is a `WeakMap` keyed on the
 * raw `Request` object: it never survives past the request that created
 * it (no explicit eviction needed) and never leaks across requests, so a
 * revoked session is still re-checked in full on the very next request.
 *
 * `resolveValidateAuth`'s return type is intentionally left for TypeScript
 * to infer (no hand-written `ValidateAuthValue`/`ValidateAuthResolution`
 * annotation). `scopedDb`/`safeDb` come from the membership-scoped database
 * factories, which are generic over the concrete transaction type; annotating
 * the resolve's return type with e.g. `ReturnType<typeof createMembershipScopedDb>`
 * collapses that generic to its default constraint (a minimal structural
 * type used only so test PGlite databases satisfy it) instead of the
 * concrete transaction type this call site actually infers from `rlsDb`.
 * Letting inference flow keeps the real (wide) transaction type, which is
 * what every handler's `ctx.scopedDb`/`ctx.safeDb` callback expects.
 */
type ResolveValidateAuthOptions = {
  getSession?: AuthSessionReader | undefined;
  request: Request;
  server: Parameters<typeof createAuditRecorder>[0]["server"];
  initialWorkspaceId: SafeId<"workspace"> | null;
  responseHeaders: ResponseHeaders;
};

type FeatureAccessFacts = Pick<
  MemberAuthorization,
  "email" | "emailVerified" | "userDeleted" | "enrolledFeatureIds"
>;

/**
 * The caller's feature-access snapshot from the facts the member lookup read.
 * A deleted account keeps neither identity nor enrolments, exactly as the
 * standalone resolver treats a membership whose user is deleted.
 */
export const featureAccessSnapshotFromAuthorization = ({
  organizationId,
  userId,
  authorization,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  authorization: FeatureAccessFacts;
}) =>
  buildFeatureAccessSnapshot({
    organizationId,
    userId,
    identity: authorization.userDeleted
      ? null
      : {
          email: authorization.email,
          emailVerified: authorization.emailVerified,
        },
    enrolments: authorization.userDeleted
      ? []
      : authorization.enrolledFeatureIds.map((featureId) => ({
          featureId,
          organizationId,
          userId,
        })),
  });

// Keep the concrete transaction in named declarations without expanding the
// full database schema into every auth macro.
type AuthScopedDb = ReturnType<
  typeof createMembershipScopedDb<TransactionOf<typeof rlsDb>>
>;
type AuthSafeDb = ReturnType<
  typeof createMembershipSafeDb<TransactionOf<typeof rlsDb>>
>;

const createAuthDatabases = (
  databaseIdentity: Parameters<
    typeof createMembershipScopedDb<TransactionOf<typeof rlsDb>>
  >[1],
): { scopedDb: AuthScopedDb; safeDb: AuthSafeDb } => ({
  scopedDb: createMembershipScopedDb(rlsDb, databaseIdentity),
  safeDb: createMembershipSafeDb(rlsDb, databaseIdentity),
});

type AuthWorkspaceAccessOptions = {
  initialAccess: {
    workspaceId: SafeId<"workspace">;
    workspace: AccessibleWorkspace | null;
  } | null;
  loadWorkspace: (
    workspaceId: SafeId<"workspace">,
    ownerDb: MemberAuthorizationDb,
  ) => Promise<AccessibleWorkspace | null>;
  onAuthorizedWorkspace: (workspaceId: SafeId<"workspace">) => void;
};

/** `ownerDb` is the owner connection, handed to `loadWorkspace` for target lookups. */
const createAuthWorkspaceAccess = (
  {
    initialAccess,
    loadWorkspace,
    onAuthorizedWorkspace,
  }: AuthWorkspaceAccessOptions,
  ownerDb: MemberAuthorizationDb,
) => {
  const accessPromises = new Map<
    SafeId<"workspace">,
    Promise<AccessibleWorkspace | null>
  >();
  if (initialAccess) {
    accessPromises.set(
      initialAccess.workspaceId,
      Promise.resolve(initialAccess.workspace),
    );
  }
  return async (
    workspaceId: SafeId<"workspace">,
  ): Promise<AccessibleWorkspace | null> => {
    let access = accessPromises.get(workspaceId);
    if (!access) {
      access = loadWorkspace(workspaceId, ownerDb);
      accessPromises.set(workspaceId, access);
    }
    const workspace = await access;
    if (workspace) {
      onAuthorizedWorkspace(workspace.id);
    }
    return workspace;
  };
};

const readOrganizationWorkspaces = async (
  scopedDb: AuthScopedDb,
  organizationId: SafeId<"organization">,
): Promise<AccessibleWorkspace[]> => {
  const outcome = await scopedDb(
    async (tx) => await readAuthorizedWorkspaces(tx, { organizationId }),
  );
  if (outcome.isErr()) {
    const { error } = outcome;
    throw error;
  }
  return outcome.value.workspaces;
};

const hasSyntheticSessionAuthority = async (current: {
  session: { id: string };
  user: { id: string };
}) => {
  const sessionId = current.session.id;
  const userId = brandPersistedUserId(current.user.id);
  return (
    !isSyntheticSessionPrincipal({ sessionId, principalId: userId }) ||
    (await syntheticSessionAuthorityReader({ sessionId, userId })) !== null
  );
};

const resolveValidateAuth = async ({
  getSession,
  request,
  server,
  initialWorkspaceId,
  responseHeaders,
}: ResolveValidateAuthOptions) => {
  const { sessionResult, memberAuthorizationResult } =
    await getSessionAndMemberAuthorization({
      getSession,
      headers: request.headers,
      responseHeaders,
      workspaceId: initialWorkspaceId ?? undefined,
    });

  if (Result.isError(sessionResult)) {
    return { ok: false as const, statusCode: 500 as const };
  }
  const session = sessionResult.value?.session;
  const user = sessionResult.value?.user;
  const rawOrgId = session?.activeOrganizationId;

  if (!session || !user || !rawOrgId) {
    return { ok: false as const, statusCode: 401 as const };
  }

  if (!(await hasSyntheticSessionAuthority({ session, user }))) {
    return { ok: false as const, statusCode: 401 as const };
  }

  if (Result.isError(memberAuthorizationResult)) {
    return { ok: false as const, statusCode: 500 as const };
  }

  const authorization = memberAuthorizationResult.value;
  if (!authorization) {
    return { ok: false as const, statusCode: 401 as const };
  }
  // A signed-in session uses the product only once the account has accepted
  // the professional-use statement. An account created where it was not
  // shown (agent provisioning, the operator command) accepts on its first
  // interactive sign-in. MCP and machine credentials never resolve here.
  switch (authorization.professionalUse.status) {
    case PROFESSIONAL_USE_STATUS.accepted:
      break;
    case PROFESSIONAL_USE_STATUS.required:
      return { ok: false as const, statusCode: 403 as const };
    default:
      authorization.professionalUse satisfies never;
      return panic("Unhandled professional-use state");
  }
  const { role } = authorization;
  const memberRole = sessionMemberRole(role);
  const activeOrganizationId = toSafeId<"organization">(rawOrgId);
  const userId = toSafeId<"user">(user.id);
  // Feature access comes from the member lookup above, so gated routes and
  // handlers reuse it instead of resolving it with queries of their own.
  const featureAccessSnapshot = featureAccessSnapshotFromAuthorization({
    organizationId: activeOrganizationId,
    userId,
    authorization,
  });

  enrichRequestContext({
    posthogDistinctId: userId,
    organizationId: activeOrganizationId,
  });

  // Read before the request scope exists, at the same boundary as the
  // membership lookup above, so it goes through the same connection.
  const orgSettings = await loadOrgSettingsForAuth(rootDb, {
    organizationId: activeOrganizationId,
    userId,
  });
  const {
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    managedAIResidency,
  } = orgSettings;

  // Preserve the bounded workspace authorization already proved by the
  // membership lookup for the lifetime of this request's transactions. This
  // matters for operations such as self-removal: later statements must finish
  // their cleanup and audit work after the membership row is deleted.
  const serverValidatedWorkspaceIds = authorization.workspace
    ? [authorization.workspace.id]
    : [];
  const validatedWorkspaceIdSet = new Set(serverValidatedWorkspaceIds);
  const pinServerValidatedWorkspaceId = (
    workspaceId: SafeId<"workspace">,
  ): boolean => {
    if (!validatedWorkspaceIdSet.has(workspaceId)) {
      return false;
    }
    if (!serverValidatedWorkspaceIds.includes(workspaceId)) {
      serverValidatedWorkspaceIds.push(workspaceId);
    }
    return true;
  };
  const databaseIdentity = {
    featureAccessSnapshot,
    organizationId: activeOrganizationId,
    serverValidatedWorkspaceIds,
    userId,
  };
  const { scopedDb, safeDb } = createAuthDatabases(databaseIdentity);

  let accessibleWorkspacesPromise: Promise<AccessibleWorkspace[]> | null = null;
  const getAccessibleWorkspaces = async (): Promise<AccessibleWorkspace[]> => {
    accessibleWorkspacesPromise ??= readOrganizationWorkspaces(
      scopedDb,
      activeOrganizationId,
    ).then((items) => {
      for (const workspace of items) {
        validatedWorkspaceIdSet.add(workspace.id);
      }
      return items;
    });
    return await accessibleWorkspacesPromise;
  };

  let activeWorkspaceIdsPromise: Promise<SafeId<"workspace">[]> | null = null;
  const getActiveWorkspaceIds = async (): Promise<SafeId<"workspace">[]> => {
    activeWorkspaceIdsPromise ??= getAccessibleWorkspaces().then((items) => {
      const activeWorkspaceIds: SafeId<"workspace">[] = [];
      for (const item of items) {
        if (item.status !== "deleting") {
          activeWorkspaceIds.push(item.id);
        }
      }
      return activeWorkspaceIds;
    });
    return await activeWorkspaceIdsPromise;
  };

  const getWorkspaceAccess = createAuthWorkspaceAccess(
    {
      initialAccess: initialWorkspaceId
        ? {
            workspaceId: initialWorkspaceId,
            workspace: authorization.workspace,
          }
        : null,
      loadWorkspace: async (
        workspaceId: SafeId<"workspace">,
        ownerDb: MemberAuthorizationDb,
      ) => {
        if (accessibleWorkspacesPromise) {
          const items = await accessibleWorkspacesPromise;
          return items.find((item) => item.id === workspaceId) ?? null;
        }
        const targetAuthorization = await resolveMemberAuthorization(
          { organizationId: activeOrganizationId, userId, workspaceId },
          ownerDb,
        );
        return targetAuthorization?.workspace?.id === workspaceId
          ? targetAuthorization.workspace
          : null;
      },
      onAuthorizedWorkspace: (workspaceId: SafeId<"workspace">) => {
        // Keep only proved targets available to later transactions in this request.
        validatedWorkspaceIdSet.add(workspaceId);
        pinServerValidatedWorkspaceId(workspaceId);
      },
    },
    rootDb,
  );

  const recorderBindings = {
    organizationId: activeOrganizationId,
    workspaceId: null,
    userId,
    request,
    server,
  };

  const caller: SessionMemberCaller = {
    user: {
      id: toSafeId<"user">(user.id),
      email: user.email,
    },
    session: {
      id: session.id,
      activeOrganizationId,
      originConsentId: session.originConsentId ?? null,
    },
    getActiveWorkspaceIds,
    getAccessibleWorkspaces,
    getWorkspaceAccess,
    pinServerValidatedWorkspaceId,
    scopedDb,
    safeDb,
    memberRole,
    featureAccessSnapshot,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    managedAIResidency,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: (opts) =>
      createAuditRecorder({
        ...recorderBindings,
        ...(opts?.execution ? { execution: opts.execution } : {}),
        workspaceId:
          opts && "workspaceId" in opts ? (opts.workspaceId ?? null) : null,
      }),
  };
  return { ok: true as const, value: caller };
};

/** The member a browser session proved for this request. */
export type ValidateAuthValue = SessionMemberCaller;

type ValidateAuthResolution = Awaited<ReturnType<typeof resolveValidateAuth>>;

const createRequestAuthResolver = (getSession?: AuthSessionReader) => {
  const validateAuthResolutionCache = new WeakMap<
    Request,
    Promise<ValidateAuthResolution>
  >();

  return async ({
    params,
    query,
    request,
    server,
    set,
  }: Pick<RequestContext, "request" | "server" | "set"> & {
    // Read only as workspace-id sources, so a pre-validation transform context fits too.
    params: unknown;
    query: unknown;
  }) =>
    await memoizePerRequest(
      validateAuthResolutionCache,
      request,
      async () =>
        await resolveValidateAuth({
          getSession,
          request,
          server,
          initialWorkspaceId: readInitialWorkspaceId(params, query),
          responseHeaders: set.headers,
        }),
    );
};

/** Share the request's authorization with gates that must run before validation. */
export const resolveRequestAuth = createRequestAuthResolver();

const bindWorkspaceRecorder = (
  ctx: {
    session: { activeOrganizationId: SafeId<"organization"> };
    user: { id: SafeId<"user"> };
    request: Request;
    server: Parameters<typeof createAuditRecorder>[0]["server"];
  },
  workspaceId: SafeId<"workspace">,
) => {
  const recorderBindings = {
    organizationId: ctx.session.activeOrganizationId,
    workspaceId,
    userId: ctx.user.id,
    request: ctx.request,
    server: ctx.server,
  };

  return {
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: (opts?: {
      execution?: AuditExecutionContext;
      workspaceId?: SafeId<"workspace"> | null;
    }) =>
      createAuditRecorder({
        ...recorderBindings,
        ...(opts?.execution ? { execution: opts.execution } : {}),
        workspaceId:
          opts && "workspaceId" in opts
            ? (opts.workspaceId ?? null)
            : workspaceId,
      }),
  };
};

/**
 * Member access for a request: a signed-in member of the active organization,
 * with the request-scoped databases and lookups every org handler uses.
 */
export const createMemberAuthenticator = ({
  getSession,
}: { getSession?: AuthSessionReader } = {}) => {
  const resolveAuth = getSession
    ? createRequestAuthResolver(getSession)
    : resolveRequestAuth;

  return async (
    ctx: Pick<
      RequestContext,
      "request" | "server" | "set" | "params" | "query"
    >,
    access: HandoffAccessMetadata,
  ): Promise<CallerOutcome<ValidateAuthValue>> => {
    const result = await resolveAuth(ctx);
    if (!result.ok) {
      return {
        ok: false,
        answer: status(
          result.statusCode,
          VALIDATE_AUTH_REJECTION_BODY[result.statusCode],
        ),
      };
    }
    const stepUp = handoffStepUpRefusal({
      originConsentId: result.value.session.originConsentId,
      request: ctx.request,
      access,
    });
    return stepUp === undefined
      ? { ok: true, caller: result.value }
      : { ok: false, answer: stepUp };
  };
};

export const authenticateMember = createMemberAuthenticator();

export type {
  MemberCaller,
  SessionMemberCaller,
  WorkspaceCaller,
} from "@/api/lib/auth/member-caller";

/** Which matter statuses a workspace route admits; archived only where it says so. */
export type WorkspaceStatusAccess = "active" | "active-or-archived";

/**
 * Matter access for a member: the matter the validated `:workspaceId` names
 * must be one the member may use, in a status the route admits. Its audit
 * recorder defaults to that matter.
 */
export const authorizeWorkspace = async (
  memberCaller: MemberCaller,
  { request, server }: Pick<RequestContext, "request" | "server">,
  workspaceId: SafeId<"workspace">,
  admitted: WorkspaceStatusAccess,
): Promise<CallerOutcome<WorkspaceCaller>> => {
  const workspace = await memberCaller.getWorkspaceAccess(workspaceId);
  const admittedStatus =
    workspace?.status === "active" ||
    (admitted === "active-or-archived" && workspace?.status === "archived");
  if (!admittedStatus) {
    return { ok: false, answer: status(404, AUTH_REJECTION_BODY[404]) };
  }
  return {
    ok: true,
    caller: {
      workspaceId,
      ...bindWorkspaceRecorder(
        {
          session: memberCaller.session,
          user: memberCaller.user,
          request,
          server,
        },
        workspaceId,
      ),
    },
  };
};

export const issueDesktopAccountGrant = async (
  options: Omit<CreateDesktopLinkGrantOptions, "db">,
) => await createDesktopLinkGrant({ ...options, db: rootDb });

export const claimDesktopAccountGrant = async (
  options: Omit<ConsumeDesktopLinkGrantOptions, "db">,
) => await consumeDesktopLinkGrant({ ...options, db: rootDb });
