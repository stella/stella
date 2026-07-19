import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import {
  bearer,
  emailOTP,
  jwt,
  lastLoginMethod,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { Result } from "better-result";
import { and, eq, exists, inArray, isNotNull, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { ac, roles } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { authSchema, member } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { env } from "@/api/env";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";
import { isUuid, tUuid } from "@/api/lib/custom-schema";
import { DEV_INSPECTOR_ORIGINS, frontendOrigins } from "@/api/lib/dev-origins";
import { stashDevOtp } from "@/api/lib/dev-otp-store";
import {
  isTransactionalEmailConfigured,
  sendNewDeviceLoginEmail,
  sendOrganizationInvitation,
  sendOTPEmail,
} from "@/api/lib/email/email";
import {
  AUTH_RATE_LIMIT_MAX_WINDOW,
  AUTH_RATE_LIMITS,
  LIMITS,
} from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import { isMemberRole } from "@/api/lib/member-roles";
import { enrichRequestContext } from "@/api/lib/observability/request-context";
import { parseUserAgent } from "@/api/lib/parse-user-agent";
import {
  hasMemberPermission,
  readAuthorizedMemberRole,
} from "@/api/lib/permission-authorization";
import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import { memoizePerRequest } from "@/api/lib/request-memo";
import {
  assertSelfhostEmailOtpAllowed,
  assertSelfhostBootstrapSignUp,
  isSelfhostLocalPasswordAuthEnabled,
  shouldHandleSelfhostBootstrapPath,
} from "@/api/lib/selfhost-auth";
import { includes } from "@/api/lib/type-guards";
import {
  getMcpResourceUrl,
  MCP_ALL_RESOURCE_SCOPES,
  MCP_OAUTH_SCOPES,
} from "@/api/mcp/constants";

/** Access token lifetime in seconds (15 minutes). */
const ACCESS_TOKEN_EXPIRES_IN = 15 * 60;

/** Refresh token lifetime in seconds (30 days). */
const REFRESH_TOKEN_EXPIRES_IN = 30 * 24 * 60 * 60;

const VERIFY_EMAIL_PATH = "/email-otp/verify-email";
const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const NEW_SESSION_SECURITY_PATHS = new Set([
  VERIFY_EMAIL_PATH,
  SIGN_IN_EMAIL_PATH,
]);
const PREFERRED_NAME_MAX_LENGTH = 120;
const WORD_EDIT_SHORTCUT_MAX_LENGTH = 16;

/** Passwordless email-OTP sign-in path (not a better-auth credential path). */
const SIGN_IN_EMAIL_OTP_PATH = "/sign-in/email-otp";

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
 * Frontend route that presents the second-factor challenge (mirrors the path
 * the email-OTP sign-in step navigates to on `twoFactorRedirect`). Its search
 * schema defaults `redirectTo`, so no query string is required here.
 */
const TWO_FACTOR_CHALLENGE_PATH = "/auth/two-factor";

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
const SIX_DIGIT_OTP_PATTERN = /^\d{6}$/u;

export const isSixDigitOtpBody = (body: unknown): body is { otp: string } =>
  typeof body === "object" &&
  body !== null &&
  "otp" in body &&
  typeof body.otp === "string" &&
  SIX_DIGIT_OTP_PATTERN.test(body.otp);

/**
 * Structural shape `requireTwoFactorManageOtp` needs off the hook context.
 * Not `HookEndpointContext`: `createAuthMiddleware`'s single-argument
 * overload — used for this app's top-level `hooks.before` — infers its own
 * middleware context type, which is a structurally different (and
 * stricter-in-places) shape than the per-plugin `HookEndpointContext`. This
 * narrower type lets the function stay unit-testable with a minimal stub
 * instead of a fully constructed better-auth context of either shape.
 */
type TwoFactorManageHookCtx = { path: string; body: unknown };

/**
 * Requires a fresh, single-use email verification code before letting any
 * path in `TWO_FACTOR_MANAGE_PATHS` proceed, so a hijacked session cannot
 * silently disable 2FA, rotate the TOTP secret via re-enable, read back the
 * current TOTP secret, or mint fresh backup codes with nothing but the
 * session cookie.
 *
 * Resolves the session itself (this runs as a global `before` hook, ahead of
 * each endpoint's own session middleware) and no-ops when there is no
 * session (the endpoint's own middleware will reject the request) or the
 * user does not currently have 2FA enabled — first-time enrollment
 * (`/two-factor/enable` for a user without 2FA yet) is then left ungated as
 * a no-op for the plugin.
 */
const requireTwoFactorManageOtp = async (
  ctx: TwoFactorManageHookCtx,
): Promise<void> => {
  // `getSessionFromCtx` wants a `GenericEndpointContext`, which requires
  // `request` to always be present. better-auth's own middleware context
  // types `request` as optional to also cover programmatic `auth.api.*`
  // calls made without an HTTP request, but this hook only ever runs from
  // HTTP dispatch (see dispatch.mjs), where `request` is always set.
  // `getSessionFromCtx` only reads headers/cookies off `ctx`, so the
  // narrower structural shape here is sound at runtime.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above; ctx always carries a real Request when this hook fires
  const genericCtx = ctx as unknown as Parameters<typeof getSessionFromCtx>[0];
  const session = await getSessionFromCtx(genericCtx);
  if (!session) {
    return;
  }

  if (session.user["twoFactorEnabled"] !== true) {
    return;
  }

  if (!isSixDigitOtpBody(ctx.body)) {
    throw new APIError("BAD_REQUEST", {
      message:
        "Verification code required to change two-factor authentication settings",
    });
  }

  const verifyResult = await verifyConfirmationOtp({
    purpose: "two-factor-manage",
    email: session.user.email,
    code: ctx.body.otp,
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

const authCookiePrefix = env.isDev
  ? (env.BETTER_AUTH_COOKIE_PREFIX ?? "stella-dev")
  : undefined;

/**
 * Validates a timezone identifier via the Intl API.
 * Throws an APIError if the value is present and not a
 * recognised IANA timezone.
 */
const ensureDisplayName = <T extends Record<string, unknown>>(user: T): T => {
  const name = typeof user["name"] === "string" ? user["name"].trim() : "";
  if (name.length > 0) {
    return user;
  }
  const email = typeof user["email"] === "string" ? user["email"] : "";
  const localPart = email.split("@").at(0)?.trim() ?? "";
  const fallback = localPart.length > 0 ? localPart : email;
  if (fallback.length === 0) {
    return user;
  }
  return { ...user, name: fallback };
};

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

  return {
    ...user,
    ...(preferredName !== undefined ? { preferredName } : {}),
    ...(wordEditShortcut !== undefined ? { wordEditShortcut } : {}),
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
        // eslint-disable-next-line require-await -- createAuthMiddleware requires a Promise-returning handler; this one only reads a synchronous flag and throws a redirect, with no work to await (sync and non-async-promise variants trip promise-function-async / TS2345 instead).
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

// Lazy singleton: `betterAuth()` eagerly resolves the
// database adapter, which accesses `rootDb`. Deferring to
// first use prevents the TDZ error when the test runner
// evaluates this module before db/index.ts finishes.
const createAuth = () => {
  const twoFactorPlugin = twoFactor({
    // Stella is passwordless (email OTP is the first factor), so 2FA
    // enable/disable/verify never require a password fallback.
    allowPasswordless: true,
    issuer: TWO_FACTOR_ISSUER,
  });

  const twoFactorWithSignInGate = withStellaTwoFactorSignInGate(
    twoFactorPlugin,
  ) satisfies BetterAuthPlugin;

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
    disabledPaths: ["/token"],
    user: {
      additionalFields: {
        timezoneId: {
          type: "string",
          required: false,
          defaultValue: "UTC",
        },
        preferredName: {
          type: "string",
          required: false,
        },
        wordEditShortcut: {
          type: "string",
          required: false,
        },
      },
    },
    session: {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      storeSessionInDatabase: true,
    },
    advanced: {
      ...(authCookiePrefix ? { cookiePrefix: authCookiePrefix } : {}),
      useSecureCookies: !env.isDev,
    },
    rateLimit: {
      enabled: !env.E2E_DISABLE_AUTH_RATE_LIMIT,
      window: AUTH_RATE_LIMITS.global.window,
      max: AUTH_RATE_LIMITS.global.max,
      customStorage: createAuthRateLimitStorage(
        AUTH_RATE_LIMIT_MAX_WINDOW * 1000,
      ),
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
          before: async (user) => {
            validateTimezoneId(user["timezoneId"]);
            // Email-OTP and some social providers leave `name` blank.
            // The `notNull` schema constraint allows empty strings, which
            // surfaces as a blank "Author" everywhere the user is shown.
            // Default to the email local-part so the column is never empty.
            // Then trim `preferredName` / `wordEditShortcut` (Word author /
            // initials prefs) before persisting.
            const data = normalizeUserPreferences(ensureDisplayName(user));
            return await Promise.resolve({ data });
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
    database: drizzleAdapter(rootDb, {
      provider: "pg",
      schema: authSchema,
      transaction: true,
    }),
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
      jwt({ disableSettingJwtHeader: true }),
      lastLoginMethod(),
      emailOTP({
        // Pin the security-relevant OTP parameters explicitly rather than
        // inheriting library defaults, so a better-auth upgrade cannot
        // silently widen the guessing window. These match the current
        // defaults (6 digits, 5-minute expiry, 3 attempts before the code
        // is invalidated); change deliberately, not by dependency drift.
        otpLength: 6,
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp, type }, ctx) {
          if (env.isDev) {
            // eslint-disable-next-line no-console -- dev-only OTP echo for local testing (env.isDev gated; value printed verbatim by design)
            console.log(`[DEV] OTP for ${email}: ${otp} (type: ${type})`);
            stashDevOtp(email, otp);
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
      }),
      twoFactorWithSignInGate,
      // Must be registered after `twoFactorWithSignInGate` so its after-hook
      // runs after the two-factor hook has set the pending-challenge response.
      socialSignInTwoFactorRedirectPlugin,
      organization({
        ac,
        roles,
        membershipLimit: LIMITS.organizationMembersCount,
        // Pin the invitation lifetime explicitly (48h) so a dependency
        // upgrade cannot silently extend how long an invite token stays
        // valid. Single-use is enforced by the plugin's invitation status.
        invitationExpiresIn: 60 * 60 * 48,
        organizationHooks: {
          async afterRemoveMember({
            member: removedMember,
            organization: org,
          }) {
            await rootDb.transaction(
              async (tx) =>
                await revokeOrganizationMemberAuthArtifacts(tx, {
                  organizationId: org.id,
                  userId: removedMember.userId,
                }),
            );
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
      // SAFETY: The oauth-provider plugin's generated OpenAPI metadata
      // is still slightly too wide for Better Auth's plugin type here.
      // The runtime plugin value is valid for betterAuth().
      oauthProvider({
        loginPage: "/auth",
        consentPage: "/consent",
        scopes: [...MCP_OAUTH_SCOPES],
        validAudiences: [getMcpResourceUrl(), getMcpResourceUrl("anonymized")],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
        refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
        clientReference: ({ session }) =>
          getSessionActiveOrganizationId(session),
        postLogin: {
          page: "/auth/organization",
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
        silenceWarnings: {
          oauthAuthServerConfig: true,
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await assertSelfhostEmailOtpAllowed(ctx.path);

        if (TWO_FACTOR_MANAGE_PATHS.has(ctx.path)) {
          await requireTwoFactorManageOtp(ctx);
          return;
        }

        if (!shouldHandleSelfhostBootstrapPath(ctx.path)) {
          return;
        }

        await assertSelfhostBootstrapSignUp(ctx.body);
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!NEW_SESSION_SECURITY_PATHS.has(ctx.path) || env.isDev) {
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
              sessionsUrl: `${env.FRONTEND_URL}/account/sessions`,
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
  const { orgAIConfig, promptCachingEnabled } = orgSettings;

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
        workspaceId?: SafeId<"workspace"> | null;
      }) =>
        createAuditRecorder({
          ...recorderBindings,
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
      workspaceId?: SafeId<"workspace"> | null;
    }) =>
      createAuditRecorder({
        ...recorderBindings,
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

      if (!ws || ws.status !== "active") {
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
