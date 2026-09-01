import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { getSessionFromCtx } from "better-auth/api";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import {
  bearer,
  emailOTP,
  jwt,
  lastLoginMethod,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { panic, Result } from "better-result";
import { and, eq, exists, inArray, isNotNull, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { BETTER_AUTH_ORGANIZATION_OPTIONS } from "@stll/auth-model";
import { ac, roles } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { member, user as authUser } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { env } from "@/api/env";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { getAnalytics } from "@/api/lib/analytics/client";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditExecutionContext } from "@/api/lib/audit-log";
import {
  AUTH_DATABASE_ADAPTER_OPTIONS,
  AUTH_DATABASE_ID_OPTIONS,
  AUTH_SESSION_STORAGE_OPTIONS,
  AUTH_VERIFICATION_STORAGE_OPTIONS,
} from "@/api/lib/auth-adapter-options";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";
import { authCookiePolicy } from "@/api/lib/auth-cookie-name";
import {
  getAuthIssuerUrl,
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth-paths";
import { AUTH_USER_ADDITIONAL_FIELDS } from "@/api/lib/auth-user-additional-fields";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";
import { isUuid, tUuid } from "@/api/lib/custom-schema";
import { getDemoAccountOtpOverride } from "@/api/lib/demo-account-otp";
import { detached } from "@/api/lib/detached";
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
import {
  AUTH_RATE_LIMITS,
  EMAIL_OTP_MIN_RESPONSE_DURATION_MS,
  LIMITS,
} from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import {
  MACHINE_API_KEY_CONFIG_ID,
  MACHINE_API_KEY_EXPIRY,
  MACHINE_API_KEY_LENGTH,
  MACHINE_API_KEY_NAME_MAX_LENGTH,
  MACHINE_API_KEY_PREFIX,
  MACHINE_API_KEY_RATE_LIMIT,
  MACHINE_API_KEY_START_LENGTH,
} from "@/api/lib/machine-api-key-config";
import { isMemberRole } from "@/api/lib/member-roles";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { bridgeOauthUiInteraction } from "@/api/lib/oauth-ui-fragment";
import {
  enrichRequestContext,
  getRequestContext,
} from "@/api/lib/observability/request-context";
import { createOrganizationLifecycleHooks } from "@/api/lib/organization-lifecycle-hooks";
import {
  completeOrganizationDeletion,
  OrganizationStorageTeardownBoundError,
} from "@/api/lib/organization-storage-teardown";
import { parseUserAgent } from "@/api/lib/parse-user-agent";
import {
  hasMemberPermission,
  readAuthorizedMemberRole,
} from "@/api/lib/permission-authorization";
import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { memoizePerRequest } from "@/api/lib/request-memo";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  assertSelfhostEmailOtpAllowed,
  assertSelfhostBootstrapSignUp,
  isSelfhostLocalPasswordAuthEnabled,
  shouldHandleSelfhostBootstrapPath,
} from "@/api/lib/selfhost-auth";
import {
  evaluateNewAccountOtpPolicy,
  isDisposableEmailAddress,
} from "@/api/lib/signup-abuse";
import { revokeUserSseAccess } from "@/api/lib/sse";
import { closeRemovedMemberActiveTimer } from "@/api/lib/time-entry-offboarding";
import { includes } from "@/api/lib/type-guards";
import { normalizeUserShortcutsField } from "@/api/lib/user-shortcuts";
import { MCP_ALL_RESOURCE_SCOPES, MCP_OAUTH_SCOPES } from "@/api/mcp/constants";

/** Access token lifetime in seconds (15 minutes). */
const ACCESS_TOKEN_EXPIRES_IN = 15 * 60;

/** Refresh token lifetime in seconds (30 days). */
const REFRESH_TOKEN_EXPIRES_IN = 30 * 24 * 60 * 60;

const VERIFY_EMAIL_PATH = "/email-otp/verify-email";
const SEND_VERIFICATION_OTP_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const PREFERRED_NAME_MAX_LENGTH = 120;
const WORD_EDIT_SHORTCUT_MAX_LENGTH = 16;

/** Passwordless email-OTP sign-in path (not a better-auth credential path). */
const SIGN_IN_EMAIL_OTP_PATH = "/sign-in/email-otp";

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

const authAccountExists = async (normalizedEmail: string): Promise<boolean> => {
  const existingAccount = await rootDb
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, normalizedEmail))
    .limit(1);
  return existingAccount.at(0) !== undefined;
};

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
  isDev: boolean;
  path: string | undefined;
  type: string;
};

export const getEmailOtpMinimumResponseDuration = ({
  isDev,
  path,
  type,
}: EmailOtpMinimumResponseDurationOptions): number =>
  !isDev && path === SEND_VERIFICATION_OTP_PATH && type === "sign-in"
    ? EMAIL_OTP_MIN_RESPONSE_DURATION_MS
    : 0;

type NewAccountEmailOtpPolicyOptions = {
  accountExists?: (normalizedEmail: string) => Promise<boolean>;
  rateLimitMode?: NewAccountOtpRateLimitMode;
  rateLimitContext?: Pick<RateLimitContext, "increment">;
};

export const assertNewAccountEmailAllowedForCreation = ({
  email,
  path,
}: {
  email: string;
  path: string | undefined;
}): void => {
  if (path !== SIGN_IN_EMAIL_OTP_PATH || !isDisposableEmailAddress(email)) {
    return;
  }

  throw new APIError("BAD_REQUEST", {
    code: "DISPOSABLE_EMAIL_NOT_ALLOWED",
    message:
      "Temporary email addresses are not allowed. Use a permanent email address.",
  });
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
    ? (getRequestContext(ctx.request)?.signupRateLimitIp ?? null)
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
      return result satisfies never;
  }
};

/**
 * Better Auth handles every social provider (`/callback/google`,
 * `/callback/microsoft`, ...) through the `/callback/:id` endpoint. The MCP
 * OAuth provider plugin uses `/oauth2/*` paths instead, so this prefix
 * matches only social sign-in callbacks.
 */
const isSocialSignInCallbackPath = (path: string | undefined): boolean =>
  path?.startsWith("/callback/") ?? false;

const isStellaTwoFactorSignInGatePath = (path: string | undefined): boolean =>
  path === SIGN_IN_EMAIL_OTP_PATH || isSocialSignInCallbackPath(path);

/**
 * Every better-auth path whose response can establish a new session: the two
 * surfaces the second-factor gate already covers (passwordless email-OTP
 * sign-in and the shared social callback), plus first-verification and the
 * self-host credential path, which carry no second factor. Derived from the
 * gate so a sign-in surface added there also raises the new-device notice
 * instead of silently skipping it.
 */
export const isSessionCreatingAuthPath = (path: string | undefined): boolean =>
  path === VERIFY_EMAIL_PATH ||
  path === SIGN_IN_EMAIL_PATH ||
  isStellaTwoFactorSignInGatePath(path);

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
 * The two-factor plugin's own management endpoints only require an active
 * (fresh) session — see node_modules/better-auth/dist/plugins/two-factor/index.mjs
 * (enable, disable) and its totp/backup-codes sub-plugins (get-totp-uri,
 * generate-backup-codes). A hijacked session could otherwise silently strip
 * 2FA, re-enable it to rotate the secret out from under the real owner,
 * read back the current TOTP secret to clone the authenticator, or mint
 * fresh backup codes, so these paths are additionally gated on a fresh
 * email verification code (see `requireTwoFactorManageOtp`), mirroring the
 * delete-account flow.
 */
export const TWO_FACTOR_MANAGE_PATHS = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
]);

/**
 * These endpoints can either mint durable OAuth credentials or change the
 * account's second factor. They must never authorize from Better Auth's
 * signed cookie snapshot: it deliberately trades a short revocation delay for
 * ordinary-request performance. Resolve their session from storage instead.
 */
export const AUTHORITATIVE_SESSION_PATHS = new Set([
  ...TWO_FACTOR_MANAGE_PATHS,
  "/oauth2/authorize",
  "/oauth2/consent",
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
  path?: string | undefined;
  request?: Request | undefined;
};
type AuthoritativeSessionPathContext = SensitiveAuthPathContext & {
  path: string;
  request: Request;
};
/**
 * Establish database-backed session state before a sensitive plugin endpoint
 * runs. Better Auth's endpoint middleware reuses this context, so neither the
 * OAuth authorization-code flow nor two-factor rotation can fall back to a
 * signed cookie-cache snapshot.
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
}): Promise<boolean> => {
  const path = ctx.path;
  if (path === undefined || !AUTHORITATIVE_SESSION_PATHS.has(path)) {
    return false;
  }
  const request = ctx.request;
  if (request === undefined) {
    panic("Authoritative-session hook ran outside HTTP dispatch");
  }
  const session = await resolveSession({ ...ctx, path, request });
  if (TWO_FACTOR_MANAGE_PATHS.has(path)) {
    await requireTwoFactorManageOtp({ body: ctx.body, session });
  }
  return true;
};

/**
 * Requires a fresh, single-use email verification code before letting any
 * path in `TWO_FACTOR_MANAGE_PATHS` proceed, so a session cookie alone can
 * neither enroll a second factor, disable it, rotate the TOTP secret via
 * re-enable, read back the current TOTP secret, nor mint fresh backup codes.
 * Enrollment is gated like every other transition: binding an authenticator
 * decides who can pass the challenge from then on.
 *
 * Resolves the session itself (this runs as a global `before` hook, ahead of
 * each endpoint's own session middleware) and no-ops when there is no
 * session, because the endpoint's own middleware will reject the request.
 *
 * One deployment shape is exempt: transactional email is optional, and an
 * instance without a transport cannot deliver a manage code at all, so
 * requiring one would leave first-time enrollment unreachable there. Those
 * users enroll on the two-factor plugin's own password check, which for a
 * credential account is the same factor their sign-in uses. An account that
 * already carries a second factor still needs the code for every transition,
 * on every deployment.
 */
const requireTwoFactorManageOtp = async ({
  body,
  session,
}: RequireTwoFactorManageOtpArgs): Promise<void> => {
  if (!session) {
    return;
  }

  if (
    session.user["twoFactorEnabled"] !== true &&
    !isTransactionalEmailConfigured()
  ) {
    return;
  }

  if (!isSixDigitOtpBody(body)) {
    throw new APIError("BAD_REQUEST", {
      message:
        "Verification code required to change two-factor authentication settings",
    });
  }

  const verifyResult = await verifyConfirmationOtp({
    purpose: "two-factor-manage",
    email: session.user.email,
    code: body.otp,
  });

  if (Result.isError(verifyResult)) {
    // Only wrong/expired codes are a client error. An infrastructure failure
    // (e.g. the database is down) surfaces as a 500 from verifyConfirmationOtp;
    // preserve that so it is not misreported to the user as an invalid code.
    if (verifyResult.error.status >= 500) {
      throw new APIError("INTERNAL_SERVER_ERROR", {
        message: "Could not verify the two-factor settings change",
      });
    }
    throw new APIError("BAD_REQUEST", {
      message: "Invalid verification code",
    });
  }
};

/** TOTP issuer label shown in authenticator apps (e.g. "Stella (user@example.com)"). */
const TWO_FACTOR_ISSUER = "Stella";

/** Session lifetime in seconds (7 days). */
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

/** How often the session expiry is refreshed, in seconds (1 day). */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * How long the signed session-cookie snapshot may satisfy `getSession`
 * without touching the database. Bounds revocation latency: a revoked
 * session's already-issued cookie stays valid for at most this long.
 * Exported for the pinning invariant in `auth.test.ts`.
 */
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
 * Validates a timezone identifier via the Intl API.
 * Throws an APIError if the value is present and not a
 * recognised IANA timezone.
 */
const validateTimezoneId = (timezoneId: unknown): void => {
  if (typeof timezoneId === "string" && timezoneId !== "UTC") {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezoneId });
    } catch {
      throw new APIError("BAD_REQUEST", {
        message: "Invalid timezone identifier",
      });
    }
  }
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
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new APIError("BAD_REQUEST", {
      message: `${fieldName} must be a string`,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new APIError("BAD_REQUEST", {
      message: `${fieldName} is too long`,
    });
  }

  return trimmed.length > 0 ? trimmed : null;
};

const normalizeUserPreferences = <TUser extends Record<string, unknown>>(
  user: TUser,
) => {
  const preferredName = normalizeOptionalPreference(user["preferredName"], {
    fieldName: "Preferred name",
    maxLength: PREFERRED_NAME_MAX_LENGTH,
  });
  const wordEditShortcut = normalizeOptionalPreference(
    user["wordEditShortcut"],
    {
      fieldName: "Word edit shortcut",
      maxLength: WORD_EDIT_SHORTCUT_MAX_LENGTH,
    },
  );
  const userShortcuts = normalizeUserShortcutsField(user["userShortcuts"]);

  return {
    ...user,
    ...(preferredName !== undefined ? { preferredName } : {}),
    ...(wordEditShortcut !== undefined ? { wordEditShortcut } : {}),
    ...(userShortcuts !== undefined ? { userShortcuts } : {}),
  };
};

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
        // eslint-disable-next-line typescript/require-await -- createAuthMiddleware requires a Promise-returning handler; this one only reads a synchronous flag and throws a redirect, with no work to await (sync and non-async-promise variants trip promise-function-async / TS2345 instead).
        handler: createAuthMiddleware(async (ctx) => {
          if (!isTwoFactorRedirectResponse(ctx.context.returned)) {
            return;
          }
          throw ctx.redirect(`${env.FRONTEND_URL}${TWO_FACTOR_CHALLENGE_PATH}`);
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

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
        // eslint-disable-next-line typescript/require-await -- createAuthMiddleware requires a Promise-returning handler; bridging mutates Better Auth's synchronous response boundary only.
        handler: createAuthMiddleware(async (ctx) => {
          bridgeOauthUiInteraction(ctx.context, {
            authOrigin: env.BETTER_AUTH_URL,
            frontendUrl: env.FRONTEND_URL,
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
const createAuth = () => {
  const oauthResources = getBetterAuthOAuthResources();
  const oauthResourceIdentifiers = oauthResources.map(
    ({ identifier }) => identifier,
  );
  const twoFactorPlugin = twoFactor({
    // Stella is passwordless (email OTP is the first factor), so 2FA
    // enable/disable/verify never require a password fallback.
    allowPasswordless: true,
    issuer: TWO_FACTOR_ISSUER,
  });

  const twoFactorWithSignInGate = withStellaTwoFactorSignInGate(
    twoFactorPlugin,
  ) satisfies BetterAuthPlugin;

  const organizationLifecycleHooks = createOrganizationLifecycleHooks({
    analytics: getAnalytics(),
    // Idempotent via the (organization_id, key) unique. Runs on the owner
    // connection (`rootDb`), which bypasses RLS the same way the org row's
    // own creation did.
    seedDefaultDocumentTypes: async (organizationId: SafeId<"organization">) =>
      await ensureDefaultDocumentTypes(organizationId, rootDb),
  });

  const auth = betterAuth({
    trustedOrigins: [
      ...frontendOrigins({
        frontendUrl: env.FRONTEND_URL,
        isDev: env.isDev,
      }),
      ...(env.isDev ? ["chrome-extension://*"] : []),
      ...(env.isDev ? DEV_INSPECTOR_ORIGINS : []),
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
      // Account unlinking is not a Stella feature: there is no UI and no
      // server-side `auth.api.unlinkAccount` caller. Better Auth still mounts
      // `/unlink-account` and protects it with `freshSessionMiddleware`, so
      // once `session.freshAge` is 0 (below) that freshness no longer applies.
      // Rather than let an unused, state-changing endpoint stay reachable with
      // weaker protection, disable the path outright — removing the surface is
      // strictly stronger than the freshness it used to carry.
      "/unlink-account",
    ],
    user: {
      additionalFields: AUTH_USER_ADDITIONAL_FIELDS,
    },
    session: {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      ...AUTH_SESSION_STORAGE_OPTIONS,
      // Short-lived signed cookie cache for session resolution. Every API
      // request runs `getSession` through `sessionAuthMacro` /
      // `getSessionAndMemberAuthorization`, and without this cache each of
      // those pays two session/user reads on the primary database — the
      // single largest per-request DB cost in the network baseline's
      // `x-db-queries` budgets. With the cache, a request whose signed
      // cookie snapshot is younger than `maxAge` skips those reads
      // entirely; the HMAC signature keeps the payload tamper-evident.
      //
      // Deliberate trade-off, kept narrow: a revoked session stays usable
      // for up to SESSION_COOKIE_CACHE_MAX_AGE_SECONDS after revocation on
      // clients that still hold the cached cookie. Authorization is NOT
      // cached — member role and workspace access run live per request
      // (`resolveMemberAuthorization`), so role demotion and workspace
      // removal take effect immediately; only the identity snapshot rides
      // the cache. Change the window deliberately: the `auth.test.ts`
      // invariant pins it.
      cookieCache: {
        enabled: true,
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
      // so gating only the read made no sense. `unlink-account` is unused and is
      // disabled in `disabledPaths` above, so nothing reachable relies on this
      // knob. Genuinely sensitive flows use Stella's own controls (OTP-verified
      // account deletion, TOTP two-factor). `0` removes the footgun without
      // weakening anything real. Guarded by the freshAge invariant in
      // `auth.test.ts`.
      freshAge: 0,
    },
    advanced: {
      cookiePrefix,
      database: AUTH_DATABASE_ID_OPTIONS,
      useSecureCookies,
    },
    rateLimit: {
      enabled: !env.E2E_DISABLE_AUTH_RATE_LIMIT,
      window: AUTH_RATE_LIMITS.global.window,
      max: AUTH_RATE_LIMITS.global.max,
      customStorage: createAuthRateLimitStorage(),
      customRules: {
        "/sign-in/email-otp": AUTH_RATE_LIMITS.signIn,
        "/sign-in/email": AUTH_RATE_LIMITS.signIn,
        "/sign-up/email": AUTH_RATE_LIMITS.signUp,
        "/email-otp/send-verification-otp": AUTH_RATE_LIMITS.sendOtp,
        "/email-otp/verify-email": AUTH_RATE_LIMITS.verifyOtp,
        "/forget-password": AUTH_RATE_LIMITS.forgetPassword,
        "/reset-password": AUTH_RATE_LIMITS.resetPassword,
        // The two-factor plugin's own built-in rate limit is a single
        // shared bucket across every `/two-factor/*` path (10s window,
        // max 3 — see node_modules/better-auth/dist/plugins/two-factor/index.mjs).
        // Sustained over a minute that is weaker than this app's other
        // brute-force-sensitive endpoints, so verify-totp/verify-backup-code
        // (guessable 6-digit / short codes) and enable/disable (session-gated
        // but still sensitive) get the same posture as sign-in/verifyOtp.
        "/two-factor/verify-totp": AUTH_RATE_LIMITS.verifyOtp,
        "/two-factor/verify-backup-code": AUTH_RATE_LIMITS.verifyOtp,
        "/two-factor/enable": AUTH_RATE_LIMITS.signIn,
        "/two-factor/disable": AUTH_RATE_LIMITS.signIn,
      },
    },
    verification: AUTH_VERIFICATION_STORAGE_OPTIONS,
    emailAndPassword: isSelfhostLocalPasswordAuthEnabled()
      ? {
          enabled: true,
          autoSignIn: true,
          minPasswordLength: 12,
          requireEmailVerification: false,
        }
      : undefined,
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            assertNewAccountEmailAllowedForCreation({
              email: user.email,
              path: ctx?.path,
            });
            validateTimezoneId(user["timezoneId"]);
            // Email-OTP and some social providers leave `name` blank.
            // The `notNull` schema constraint allows empty strings, which
            // surfaces as a blank "Author" everywhere the user is shown.
            // Default to the email local-part so the column is never empty.
            // Then trim `preferredName` / `wordEditShortcut` (Word author /
            // initials prefs) before persisting.
            const data = normalizeUserPreferences(ensureDisplayName(user));
            const detectedCountry = detectedCountryFromRequestContext(ctx);
            return await Promise.resolve({
              data: detectedCountry ? { ...data, detectedCountry } : data,
            });
          },
        },
        update: {
          before: async (user) => {
            validateTimezoneId(user["timezoneId"]);
            const data = normalizeUserPreferences(ensureDisplayName(user));
            return await Promise.resolve({ data });
          },
        },
      },
    },
    database: drizzleAdapter(rootDb, AUTH_DATABASE_ADAPTER_OPTIONS),
    socialProviders: {
      ...(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_AUTH_CLIENT_ID,
              clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.MICROSOFT_AUTH_CLIENT_ID &&
      env.MICROSOFT_AUTH_CLIENT_SECRET &&
      env.MICROSOFT_AUTH_TENANT_ID
        ? {
            microsoft: {
              clientId: env.MICROSOFT_AUTH_CLIENT_ID,
              clientSecret: env.MICROSOFT_AUTH_CLIENT_SECRET,
              tenantId: env.MICROSOFT_AUTH_TENANT_ID,
            },
          }
        : {}),
    },
    plugins: [
      bearer(),
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
      // Machine (CI / agent / CLI) credentials. Lifecycle runs through the
      // org-scoped handlers in `handlers/api-keys/`, which is where the
      // permission and audit-log requirements live; this registration only
      // establishes how a key is minted, stored, and verified.
      apiKey({
        configId: MACHINE_API_KEY_CONFIG_ID,
        // `referenceId` must hold a **user** id. The MCP credential path feeds
        // it straight into the same member/RLS authorization the JWT path uses,
        // and that requires a principal with a `member` row. `"organization"`
        // would store an org id there and leave nothing to authorize as.
        references: "user",
        defaultPrefix: MACHINE_API_KEY_PREFIX,
        defaultKeyLength: MACHINE_API_KEY_LENGTH,
        startingCharactersConfig: {
          shouldStore: true,
          charactersLength: MACHINE_API_KEY_START_LENGTH,
        },
        // A key nobody can identify is a key nobody revokes.
        requireName: true,
        // Match the HTTP boundary schema (defaults to 32 otherwise), so a name
        // our schema accepts is never rejected by the plugin with its own 400.
        maximumNameLength: MACHINE_API_KEY_NAME_MAX_LENGTH,
        enableMetadata: true,
        // Deliberately off. Enabling it would let any `x-api-key` header mint a
        // mock user session on *every* better-auth endpoint, turning a scoped
        // machine credential into a full interactive session and bypassing the
        // explicit scope gating the MCP path applies. The only thing that may
        // consume one of these keys is `mcp/api-key-auth.ts`, which resolves it
        // and then re-authorizes it from scratch.
        enableSessionForAPIKeys: false,
        // Hashing stays on (the plugin stores a SHA-256 digest): `disableKeyHashing`
        // would put recoverable secrets in the table.
        rateLimit: MACHINE_API_KEY_RATE_LIMIT,
        keyExpiration: {
          defaultExpiresIn: MACHINE_API_KEY_EXPIRY.defaultSeconds,
          minExpiresIn: MACHINE_API_KEY_EXPIRY.minDays,
          maxExpiresIn: MACHINE_API_KEY_EXPIRY.maxDays,
        },
      }),
      emailOTP({
        // Pin the security-relevant OTP parameters explicitly rather than
        // inheriting library defaults, so a better-auth upgrade cannot
        // silently widen the guessing window. These match the current
        // defaults (6 digits, 5-minute expiry, 3 attempts before the code
        // is invalidated); change deliberately, not by dependency drift.
        otpLength: 6,
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        // Returning undefined falls back to the plugin's random generator
        // (`opts.generateOTP(...) || defaultOTPGenerator`), so every account
        // except the configured demo account keeps random codes.
        generateOTP: ({ email, type }) =>
          getDemoAccountOtpOverride({ email, type }),
        async sendVerificationOTP({ email, otp, type }, ctx) {
          await runEmailOtpRequestOnResponseSchedule({
            responseDelayMs: getEmailOtpMinimumResponseDuration({
              isDev: env.isDev,
              path: ctx?.path,
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
                  return;
              }

              if (env.isDev) {
                // eslint-disable-next-line no-console -- dev-only OTP echo for local testing (env.isDev gated; value printed verbatim by design)
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
      organization({
        ...BETTER_AUTH_ORGANIZATION_OPTIONS,
        ac,
        roles,
        organizationHooks: {
          ...organizationLifecycleHooks,
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
                await rootDb.transaction(
                  async (tx) =>
                    await completeOrganizationDeletion({
                      organizationId,
                      tx,
                    }),
                ),
              catch: (cause) => cause,
            });
            if (Result.isError(teardown)) {
              captureError(teardown.error, { organizationId });
              if (
                teardown.error instanceof OrganizationStorageTeardownBoundError
              ) {
                throw new APIError("BAD_REQUEST", {
                  error: "organization_storage_too_large",
                  message: teardown.error.message,
                });
              }
              throw new APIError("INTERNAL_SERVER_ERROR", {
                message: "Failed to delete the organization's stored files",
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
              requestIds: teardown.value.requestIds,
            });
          },
          async afterRemoveMember({
            member: removedMember,
            organization: org,
          }) {
            // Branded here, at the boundary: both ids are read off persisted
            // rows by the plugin itself (the membership it just removed), not
            // supplied by the caller, so this is where they become ownership
            // ids for the tenant predicates the helper applies.
            const organizationId = brandPersistedOrganizationId(org.id);
            const userId = brandPersistedUserId(removedMember.userId);
            await rootDb.transaction(async (tx) => {
              await closeRemovedMemberActiveTimer({
                organizationId,
                tx,
                userId,
              });
              await revokeOrganizationMemberAuthArtifacts(tx, {
                organizationId,
                userId,
              });
            });
            // Their notification stream for this organization outlives the
            // membership otherwise: it is authorized once at connect time and
            // only re-checked on the next event.
            await revokeUserSseAccess(userId, organizationId);
          },
        },
        async sendInvitationEmail(data, request) {
          const inviteLink = `${env.FRONTEND_URL}/auth/accept-invitation/${data.id}`;
          if (env.isDev) {
            // eslint-disable-next-line no-console -- dev-only invitation-link echo for local testing
            console.log(
              `[DEV] Org invitation for ${data.email}: ${inviteLink}`,
            );
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
      }),
      oauthProvider({
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
        accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
        refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
        clientReference: ({ session }) =>
          getSessionActiveOrganizationId(session),
        postLogin: {
          page: OAUTH_UI_ORGANIZATION_PATH,
          shouldRedirect: async ({
            headers,
            scopes,
            session,
          }): Promise<boolean> => {
            const needsOrganization = scopes.some(isMcpResourceScope);
            if (!needsOrganization) {
              return false;
            }

            const organizations: { id: string }[] =
              await auth.api.listOrganizations({
                headers,
              });
            const activeOrganizationId =
              getSessionActiveOrganizationId(session);

            return (
              organizations.length !== 1 ||
              organizations.at(0)?.id !== activeOrganizationId
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
        customAccessTokenClaims: ({ referenceId }) => ({
          org_id: referenceId,
        }),
      }),
      oauthUiFragmentBridgePlugin,
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await assertSelfhostEmailOtpAllowed(ctx.path);

        if (
          await resolveAuthoritativeSessionForSensitiveAuthPath({
            ctx,
            resolveSession: async ({ path, request }) =>
              await getAuthoritativeSessionFromCtx({ ...ctx, path, request }),
          })
        ) {
          return;
        }

        if (!shouldHandleSelfhostBootstrapPath(ctx.path)) {
          return;
        }

        await assertSelfhostBootstrapSignUp(ctx.body);
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!isSessionCreatingAuthPath(ctx.path) || env.isDev) {
          return;
        }

        if (
          ctx.path === SIGN_IN_EMAIL_PATH &&
          !isTransactionalEmailConfigured()
        ) {
          return;
        }

        const newSession = ctx.context.newSession;
        if (!newSession) {
          return;
        }

        try {
          const { user, session } = newSession;

          const previousSessions = await rootDb.query.session.findMany({
            where: {
              userId: user.id,
              id: { ne: session.id },
            },
            orderBy: { createdAt: "desc" },
            limit: LIMITS.newDeviceLoginSessionScanLimit,
            columns: {
              ipAddress: true,
              userAgent: true,
            },
          });

          if (previousSessions.length === 0) {
            return;
          }

          const knownIPs = new Set<string>();
          const knownDevices = new Set<string>();
          for (const previous of previousSessions) {
            if (previous.ipAddress) {
              knownIPs.add(previous.ipAddress);
            }
            const previousDevice = parseUserAgent(previous.userAgent);
            const deviceKey = `${previousDevice.browser}|${previousDevice.os}`;
            if (deviceKey !== "null|null") {
              knownDevices.add(deviceKey);
            }
          }

          const currentDevice = parseUserAgent(session.userAgent);
          const deviceKey = `${currentDevice.browser}|${currentDevice.os}`;
          const currentIpAddress = session.ipAddress;
          const isNewIP =
            typeof currentIpAddress === "string" &&
            !knownIPs.has(currentIpAddress);
          const hasDevice =
            currentDevice.browser !== null || currentDevice.os !== null;
          const isNewDevice = hasDevice && !knownDevices.has(deviceKey);

          if (!isNewIP && !isNewDevice) {
            return;
          }

          const deviceLabel =
            currentDevice.browser && currentDevice.os
              ? `${currentDevice.browser} on ${currentDevice.os}`
              : (currentDevice.browser ?? currentDevice.os ?? "Unknown");
          const lang = extractLangFromRequest(ctx.request);
          const formattedTime = getNewDeviceLoginDateTimeFormat(lang).format(
            session.createdAt,
          );

          ctx.context.runInBackground(
            sendNewDeviceLoginEmail({
              email: user.email,
              device: deviceLabel,
              ipAddress: session.ipAddress ?? "Unknown",
              time: formattedTime,
              sessionsUrl: `${env.FRONTEND_URL}${ACTIVE_SESSIONS_FRONTEND_PATH}`,
              lang,
            }).catch((error: unknown) => {
              captureError(error, { source: "new-device-login-email" });
            }),
          );
        } catch (error) {
          captureError(error, { source: "new-device-login-hook" });
        }
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

export type { MemberRole } from "@/api/lib/member-roles";

const getSessionAndMemberAuthorization = async (
  headers: Headers | Record<string, string>,
  workspaceId?: SafeId<"workspace">,
) => {
  const sessionResult = await Result.tryPromise(
    async () =>
      await getAuth().api.getSession({
        headers,
      }),
  );

  const session = Result.isOk(sessionResult)
    ? sessionResult.value?.session
    : null;
  const user = Result.isOk(sessionResult) ? sessionResult.value?.user : null;
  const activeOrganizationId = getSessionActiveOrganizationId(session);

  const memberAuthorizationResult =
    session && user && activeOrganizationId
      ? await Result.tryPromise(async () => {
          const authorization = await resolveMemberAuthorization({
            userId: toSafeId<"user">(user.id),
            organizationId: toSafeId<"organization">(activeOrganizationId),
            workspaceId,
          });

          if (!authorization || !isMemberRole(authorization.role)) {
            return null;
          }

          return {
            role: authorization.role,
            workspace: authorization.workspace,
          };
        })
      : Result.ok(null);

  return {
    sessionResult,
    memberAuthorizationResult,
  };
};

export const sessionAuthMacro = new Elysia({ name: "sessionAuthMacro" }).macro({
  validateSession: {
    async resolve({ status, request }) {
      const sessionResult = await Result.tryPromise(
        async () =>
          await getAuth().api.getSession({
            headers: request.headers,
          }),
      );

      if (Result.isError(sessionResult)) {
        return status(500);
      }

      const session = sessionResult.value?.session;
      const user = sessionResult.value?.user;
      if (!session || !user) {
        return status(401);
      }

      const userId = toSafeId<"user">(user.id);
      enrichRequestContext(request, {
        posthogDistinctId: userId,
      });

      return {
        user: {
          id: userId,
        },
      };
    },
  },
});

export type AccessibleWorkspace = {
  id: SafeId<"workspace">;
  status: InferSelectModel<typeof workspaces>["status"];
};

/**
 * Structural subset of `rootDb` the bounded membership query needs. Tests can
 * pass their PGlite database without importing a test-only type here.
 */
type MemberAuthorizationDb = Pick<typeof rootDb, "select">;

/**
 * Resolve the user's organization role and, when the route already carries a
 * workspace ID, that single workspace's status. Both branches are bounded to
 * one row; request authentication never expands the full access set.
 */
type MemberAuthorizationLookup = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId?: SafeId<"workspace"> | undefined;
};

type MemberAuthorization = {
  /** Raw DB value; callers validate it with isMemberRole. */
  role: string;
  workspace: AccessibleWorkspace | null;
};

const ADMIN_BYPASS_ROLES = ["owner", "admin"];
const ACTIVE_WORKSPACE_STATUS = "active";

export const resolveMemberAuthorization = async (
  { organizationId, userId, workspaceId }: MemberAuthorizationLookup,
  db: MemberAuthorizationDb = rootDb,
): Promise<MemberAuthorization | null> => {
  if (!workspaceId) {
    const row = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, organizationId),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0));

    return row ? { role: row.role, workspace: null } : null;
  }

  const membershipExists = exists(
    db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, member.userId),
        ),
      ),
  );
  const row = await db
    .select({
      role: member.role,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
    })
    .from(member)
    .leftJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, member.organizationId),
        or(
          membershipExists,
          and(
            inArray(member.role, ADMIN_BYPASS_ROLES),
            isNotNull(workspaces.clientId),
          ),
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

  if (row.workspaceId === null || row.workspaceStatus === null) {
    return { role: row.role, workspace: null };
  }

  return {
    role: row.role,
    workspace: { id: row.workspaceId, status: row.workspaceStatus },
  };
};

/**
 * Whether the caller still belongs to the organization their session is
 * scoped to. A session with no active organization answers `true`: an account
 * still in onboarding belongs to none yet. Session handlers receive only
 * `user.id`, so the organization is resolved and branded here, at the same
 * boundary the rest of the session identity crosses.
 */
export const isActiveOrganizationMember = async ({
  headers,
  userId,
}: {
  headers: Headers;
  userId: SafeId<"user">;
}): Promise<boolean> => {
  const resolved = await getAuth().api.getSession({ headers });
  const activeOrganizationId = getSessionActiveOrganizationId(
    resolved?.session,
  );
  if (activeOrganizationId === undefined) {
    return true;
  }
  const authorization = await resolveMemberAuthorization({
    organizationId: brandPersistedOrganizationId(activeOrganizationId),
    userId,
  });
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
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
  db: MemberAuthorizationDb = rootDb,
): Promise<boolean> =>
  (await resolveMemberAuthorization({ organizationId, userId }, db)) !== null;

type WorkspaceRealtimeAudienceLookup = {
  userIds: readonly SafeId<"user">[];
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
  { userIds, workspaceId }: WorkspaceRealtimeAudienceLookup,
  db: MemberAuthorizationDb = rootDb,
) => {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return new Set<SafeId<"user">>();
  }

  const membershipExists = exists(
    db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, member.userId),
        ),
      ),
  );
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, member.organizationId),
        eq(workspaces.status, ACTIVE_WORKSPACE_STATUS),
        or(
          membershipExists,
          and(
            inArray(member.role, ADMIN_BYPASS_ROLES),
            isNotNull(workspaces.clientId),
          ),
        ),
      ),
    )
    .where(inArray(member.userId, uniqueUserIds))
    .limit(LIMITS.organizationMembersCount);

  return new Set(rows.map((row) => brandPersistedUserId(row.userId)));
};

/**
 * Per-request memoization of validateAuth's resolution.
 *
 * Elysia expands a macro property (here `validateAuth`, directly or
 * transitively through `permissions` / `validateWorkspaceAccess`) into an
 * independent `resolve` hook every time it appears at a distinct
 * `.guard()` / `.group()` / route-level call site — see `applyMacro` in
 * elysia's compose step, which only dedupes repeats *within* a single
 * call's hook object, not across separate call sites. A route that
 * stacks e.g. a top-level `.guard({ validateAuth: true })` with a
 * per-route `permissions: {...}` therefore runs this resolve twice (three
 * times when a `.group()` also carries `validateWorkspaceAccess: true`)
 * for the exact same request, each time re-running the session, member-role,
 * and org-settings lookups.
 *
 * Rather than rely on route wiring alone to avoid every such stack (some
 * duplication is structural — a workspace-scoped group and its
 * permission-checked routes legitimately need both macros), memoize the
 * resolved value per request here. The cache is a `WeakMap` keyed on the
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
const resolveValidateAuth = async (
  request: Request,
  server: Parameters<typeof createAuditRecorder>[0]["server"],
  initialWorkspaceId: SafeId<"workspace"> | null,
) => {
  const { sessionResult, memberAuthorizationResult } =
    await getSessionAndMemberAuthorization(
      request.headers,
      initialWorkspaceId ?? undefined,
    );

  if (Result.isError(sessionResult)) {
    return { ok: false as const, statusCode: 500 as const };
  }
  const session = sessionResult.value?.session;
  const user = sessionResult.value?.user;
  const rawOrgId = session?.activeOrganizationId;

  if (!session || !user || !rawOrgId) {
    return { ok: false as const, statusCode: 401 as const };
  }

  if (Result.isError(memberAuthorizationResult)) {
    return { ok: false as const, statusCode: 500 as const };
  }

  const authorization = memberAuthorizationResult.value;
  if (!authorization) {
    return { ok: false as const, statusCode: 401 as const };
  }
  const { role } = authorization;
  const memberRole = { role };
  const activeOrganizationId = toSafeId<"organization">(rawOrgId);
  const userId = toSafeId<"user">(user.id);

  enrichRequestContext(request, {
    posthogDistinctId: userId,
    organizationId: activeOrganizationId,
  });

  const orgSettings = await loadOrgSettingsForAuth(activeOrganizationId);
  const { orgAIConfig, orgAIConfigStatus, promptCachingEnabled } = orgSettings;

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
    organizationId: activeOrganizationId,
    serverValidatedWorkspaceIds,
    userId,
  };
  const scopedDb = createMembershipScopedDb(rlsDb, databaseIdentity);
  const safeDb = createMembershipSafeDb(rlsDb, databaseIdentity);

  let accessibleWorkspacesPromise: Promise<AccessibleWorkspace[]> | null = null;
  const getAccessibleWorkspaces = async (): Promise<AccessibleWorkspace[]> => {
    accessibleWorkspacesPromise ??= scopedDb(
      async (tx) =>
        await tx
          .select({ id: workspaces.id, status: workspaces.status })
          .from(workspaces)
          .where(eq(workspaces.organizationId, activeOrganizationId)),
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

  const workspaceAccessPromises = new Map<
    SafeId<"workspace">,
    Promise<AccessibleWorkspace | null>
  >();
  if (initialWorkspaceId) {
    workspaceAccessPromises.set(
      initialWorkspaceId,
      Promise.resolve(authorization.workspace),
    );
  }
  const getWorkspaceAccess = async (
    workspaceId: SafeId<"workspace">,
  ): Promise<AccessibleWorkspace | null> => {
    let accessPromise = workspaceAccessPromises.get(workspaceId);
    if (!accessPromise) {
      accessPromise = accessibleWorkspacesPromise
        ? accessibleWorkspacesPromise.then(
            (items) => items.find((item) => item.id === workspaceId) ?? null,
          )
        : resolveMemberAuthorization({
            organizationId: activeOrganizationId,
            userId,
            workspaceId,
          }).then((targetAuthorization) => {
            if (targetAuthorization?.workspace?.id !== workspaceId) {
              return null;
            }
            return targetAuthorization.workspace;
          });
      workspaceAccessPromises.set(workspaceId, accessPromise);
    }
    const workspace = await accessPromise;
    if (workspace) {
      // The factories above intentionally retain this small array by
      // reference. A later transaction therefore preserves only the target
      // this request just proved, never the full accessible-workspace list.
      validatedWorkspaceIdSet.add(workspace.id);
      pinServerValidatedWorkspaceId(workspace.id);
    }
    return workspace;
  };

  const recorderBindings = {
    organizationId: activeOrganizationId,
    workspaceId: null,
    userId,
    request,
    server,
  };

  return {
    ok: true as const,
    value: {
      user: {
        id: toSafeId<"user">(user.id),
      },
      session: {
        activeOrganizationId,
      },
      getActiveWorkspaceIds,
      getAccessibleWorkspaces,
      getWorkspaceAccess,
      /**
       * Preserve one workspace in later request transactions only when an
       * earlier server-side lookup in this request already proved access.
       */
      pinServerValidatedWorkspaceId,
      scopedDb,
      safeDb,
      memberRole,
      orgAIConfig,
      orgAIConfigStatus,
      promptCachingEnabled,
      /**
       * Records audit rows in the supplied tx. Identity fields
       * (org/user/IP/UA) are bound from the request context;
       * workspaceId defaults to null for root handlers and is
       * overridden by workspaceAccessMacro to the validated
       * workspaceId for workspace handlers. Individual events
       * can still override workspaceId for cross-workspace ops.
       */
      recordAuditEvent: createAuditRecorder(recorderBindings),
      /**
       * Builds a recorder with an overridden default workspaceId.
       * Use when threading audit recording through helpers that
       * don't receive the handler ctx (cross-workspace operations,
       * shared copy/move utilities).
       */
      createAuditRecorder: (opts?: {
        execution?: AuditExecutionContext;
        workspaceId?: SafeId<"workspace"> | null;
      }) =>
        createAuditRecorder({
          ...recorderBindings,
          ...(opts?.execution ? { execution: opts.execution } : {}),
          workspaceId:
            opts && "workspaceId" in opts ? (opts.workspaceId ?? null) : null,
        }),
    },
  };
};

/**
 * Named alias for `resolveValidateAuth`'s resolved value, derived from the
 * implementation rather than hand-written — see the inference note above.
 */
export type ValidateAuthValue = Extract<
  Awaited<ReturnType<typeof resolveValidateAuth>>,
  { ok: true }
>["value"];

type ValidateAuthResolution = Awaited<ReturnType<typeof resolveValidateAuth>>;

const validateAuthResolutionCache = new WeakMap<
  Request,
  Promise<ValidateAuthResolution>
>();

export const authMacro = new Elysia({ name: "authMacro" }).macro({
  validateAuth: {
    async resolve({ params, query, status, request, server }) {
      const initialWorkspaceId = readInitialWorkspaceId(params, query);
      const result = await memoizePerRequest(
        validateAuthResolutionCache,
        request,
        async () =>
          await resolveValidateAuth(request, server, initialWorkspaceId),
      );

      if (!result.ok) {
        return status(result.statusCode);
      }

      return result.value;
    },
  },
});

export const permissionMacro = new Elysia({ name: "permissionMacro" })
  .use(authMacro)
  .macro("permissions", (permissions: PermissionInput) => ({
    // Reuse authMacro's resolved member role instead of asking better-auth to
    // perform the same permission check through a second session read.
    validateAuth: true,
    // Without this, when this macro is used with another macro that extends the body,
    // the final merged body would not include the first macro's body extension.
    body: t.Object({}),
    beforeHandle(ctx) {
      const memberRole = readAuthorizedMemberRole(ctx);
      if (!memberRole || !hasMemberPermission(memberRole, permissions)) {
        return ctx.status(403);
      }

      return undefined;
    },
  }));

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

export const workspaceAccessMacro = new Elysia({
  name: "workspaceAccessMacro",
})
  .use(authMacro)
  .macro("validateWorkspaceAccess", {
    validateAuth: true,
    params: t.Object({ workspaceId: tUuid }),
    // Without this, when this macro is used with another macro that extends the body,
    // the final merged body would not include the first macro's body extension.
    body: t.Object({}),
    async resolve(ctx) {
      const workspaceId = toSafeId<"workspace">(ctx.params.workspaceId);
      const ws = await ctx.getWorkspaceAccess(workspaceId);

      if (ws?.status !== "active") {
        return ctx.status(404);
      }

      return {
        workspaceId,
        ...bindWorkspaceRecorder(ctx, workspaceId),
      };
    },
  })
  .macro("validateWorkspaceAccessIncludingArchived", {
    validateAuth: true,
    params: t.Object({ workspaceId: tUuid }),
    body: t.Object({}),
    async resolve(ctx) {
      const workspaceId = toSafeId<"workspace">(ctx.params.workspaceId);
      const ws = await ctx.getWorkspaceAccess(workspaceId);

      if (!ws || (ws.status !== "active" && ws.status !== "archived")) {
        return ctx.status(404);
      }

      return {
        workspaceId,
        ...bindWorkspaceRecorder(ctx, workspaceId),
      };
    },
  });
