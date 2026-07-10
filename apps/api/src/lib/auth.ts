import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  bearer,
  emailOTP,
  jwt,
  lastLoginMethod,
  organization,
} from "better-auth/plugins";
import { Result } from "better-result";
import { and, eq, exists, inArray, isNotNull, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { ac, roles } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { createSafeDb, createScopedDb } from "@/api/db";
import { authSchema, member } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { env } from "@/api/env";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tUuid } from "@/api/lib/custom-schema";
import { DEV_INSPECTOR_ORIGINS, frontendOrigins } from "@/api/lib/dev-origins";
import { stashDevOtp } from "@/api/lib/dev-otp-store";
import {
  isTransactionalEmailConfigured,
  sendNewDeviceLoginEmail,
  sendOrganizationInvitation,
  sendOTPEmail,
} from "@/api/lib/email";
import {
  AUTH_RATE_LIMIT_MAX_WINDOW,
  AUTH_RATE_LIMITS,
  LIMITS,
} from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
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

const isMcpResourceScope = (
  scope: string,
): scope is (typeof MCP_ALL_RESOURCE_SCOPES)[number] =>
  (MCP_ALL_RESOURCE_SCOPES as readonly string[]).includes(scope);

// Lazy singleton: `betterAuth()` eagerly resolves the
// database adapter, which accesses `rootDb`. Deferring to
// first use prevents the TDZ error when the test runner
// evaluates this module before db/index.ts finishes.
const createAuth = () => {
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
      organization({
        ac,
        roles,
        membershipLimit: LIMITS.organizationMembersCount,
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
      }) as BetterAuthPlugin,
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await assertSelfhostEmailOtpAllowed(ctx.path);
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

          const knownIPs = new Set(
            previousSessions
              .map((previous) => previous.ipAddress)
              .filter(Boolean),
          );
          const knownDevices = new Set(
            previousSessions
              .map((previous) => {
                const previousDevice = parseUserAgent(previous.userAgent);
                return `${previousDevice.browser}|${previousDevice.os}`;
              })
              .filter((device) => device !== "null|null"),
          );

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
          const formattedTime = new Intl.DateTimeFormat(lang, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "UTC",
            timeZoneName: "short",
          }).format(session.createdAt);

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

export const getSessionAndMemberRole = async (
  headers: Headers | Record<string, string>,
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

  const memberRoleResult =
    session && user && activeOrganizationId
      ? await Result.tryPromise(async () => {
          const memberAccess = await resolveMemberAccess(
            toSafeId<"user">(user.id),
            toSafeId<"organization">(activeOrganizationId),
          );

          if (!memberAccess || !isMemberRole(memberAccess.role)) {
            return null;
          }

          return {
            role: memberAccess.role,
            accessibleWorkspaces: memberAccess.accessibleWorkspaces,
          };
        })
      : Result.ok(null);

  return {
    sessionResult,
    memberRoleResult,
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

export const ADMIN_BYPASS_ROLES: readonly MemberRole[] = ["owner", "admin"];

export type AccessibleWorkspace = {
  id: SafeId<"workspace">;
  status: InferSelectModel<typeof workspaces>["status"];
};

export type MemberAccess = {
  /** Raw DB value; not yet validated against `MemberRole`. */
  role: string;
  accessibleWorkspaces: AccessibleWorkspace[];
};

/**
 * Structural subset of `rootDb` this query needs. Lets tests pass a
 * PGlite `TestDatabase` (see `tests/security/test-utils.ts`) instead of
 * the real `rootDb` connection, matching how `createScopedDb`/
 * `createSafeDb` stay generic over prod vs. test drizzle instances.
 */
type MemberAccessDb = Pick<typeof rootDb, "select">;

/**
 * Resolve a user's role in an organization together with the
 * workspaces they can access there, in a single statement.
 *
 * Admins/owners see every client matter in the org, plus any
 * personal matter (clientId IS NULL) they themselves are a
 * member of — without this gate, an org owner could open a
 * personal scratchpad they were not explicitly added to by URL.
 * Regular members see only workspaces they belong to.
 *
 * Both branches require "is a member of this workspace" to hold
 * except that admins/owners get an additional `clientId IS NOT
 * NULL` escape hatch, so the accessibility predicate collapses to
 * a single expression: `membership EXISTS OR (role is admin/owner
 * AND clientId IS NOT NULL)`. That predicate lives entirely in the
 * LEFT JOIN's ON clause (never in WHERE) so a member with zero
 * accessible workspaces — e.g. a freshly invited org member not
 * yet added to any workspace — still yields their role row instead
 * of being silently dropped from the result set.
 *
 * Returns `null` when the user has no membership row in the
 * organization at all. Callers validate `role` against
 * `MemberRole` themselves: the HTTP auth macro and the MCP session
 * context react to an invalid stored role differently (401 vs.
 * `panic`), so that check is intentionally not baked in here.
 *
 * Shared between the Elysia `authMacro` and the MCP session
 * context so this resolution logic lives in one place.
 */
export const resolveMemberAccess = async (
  userId: SafeId<"user">,
  organizationId: SafeId<"organization">,
  db: MemberAccessDb = rootDb,
): Promise<MemberAccess | null> => {
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
    .select({
      role: member.role,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
    })
    .from(member)
    .leftJoin(
      workspaces,
      and(
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
    );

  const memberRow = rows.at(0);
  if (!memberRow) {
    return null;
  }

  // Rows with no joined workspace (a member with zero accessible
  // workspaces) come back with workspaceId/workspaceStatus both null;
  // skip those rather than mapping them into a bogus entry.
  const accessibleWorkspaces: AccessibleWorkspace[] = [];
  for (const row of rows) {
    if (row.workspaceId === null || row.workspaceStatus === null) {
      continue;
    }
    accessibleWorkspaces.push({
      id: toSafeId<"workspace">(row.workspaceId),
      status: row.workspaceStatus,
    });
  }

  return {
    role: memberRow.role,
    accessibleWorkspaces,
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
 * for the exact same request, each time re-running the session, member
 * role, workspace, and org-settings lookups.
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
 * annotation). `scopedDb`/`safeDb` come from `createScopedDb`/`createSafeDb`,
 * which are generic over the concrete Drizzle transaction type; annotating
 * the resolve's return type with e.g. `ReturnType<typeof createScopedDb>`
 * collapses that generic to its default constraint (a minimal structural
 * type used only so test PGlite databases satisfy it) instead of the
 * concrete transaction type this call site actually infers from `rlsDb`.
 * Letting inference flow keeps the real (wide) transaction type, which is
 * what every handler's `ctx.scopedDb`/`ctx.safeDb` callback expects.
 */
const resolveValidateAuth = async (
  request: Request,
  server: Parameters<typeof createAuditRecorder>[0]["server"],
) => {
  const { sessionResult, memberRoleResult } = await getSessionAndMemberRole(
    request.headers,
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

  if (Result.isError(memberRoleResult)) {
    return { ok: false as const, statusCode: 500 as const };
  }

  const memberAccess = memberRoleResult.value;
  if (!memberAccess) {
    return { ok: false as const, statusCode: 401 as const };
  }
  const memberRole = { role: memberAccess.role };
  const accessibleWorkspaces = memberAccess.accessibleWorkspaces;
  const activeOrganizationId = toSafeId<"organization">(rawOrgId);
  const userId = toSafeId<"user">(user.id);

  enrichRequestContext(request, {
    posthogDistinctId: userId,
    organizationId: activeOrganizationId,
  });

  // Member role + accessible workspaces already resolved together in
  // getSessionAndMemberRole's single statement; only org AI/prompt-caching
  // settings still need their own round-trip.
  const orgSettings = await loadOrgSettingsForAuth(activeOrganizationId);
  const { orgAIConfig, promptCachingEnabled } = orgSettings;

  const scopedDb = createScopedDb(
    rlsDb,
    accessibleWorkspaces.map((w) => w.id),
    activeOrganizationId,
    userId,
  );
  const safeDb = createSafeDb(
    rlsDb,
    accessibleWorkspaces.map((w) => w.id),
    activeOrganizationId,
    userId,
  );

  const activeWorkspaceIds = accessibleWorkspaces
    .filter((w) => w.status !== "deleting")
    .map((w) => w.id);

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
      /**
       * Excludes workspaces being deleted. Includes active and
       * archived workspaces. Use for search, chat, MCP, and any
       * query that should not surface content from sealed workspaces.
       */
      activeWorkspaceIds,
      /**
       * All accessible workspaces with status. Only use in
       * workspaceAccessMacro (which needs the status to return
       * appropriate HTTP codes) — never pass these IDs as a
       * search/query allowlist.
       */
      accessibleWorkspaces,
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
    async resolve({ status, request, server }) {
      const result = await memoizePerRequest(
        validateAuthResolutionCache,
        request,
        async () => await resolveValidateAuth(request, server),
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
    resolve(ctx) {
      const ws = ctx.accessibleWorkspaces.find(
        (w) => w.id === ctx.params.workspaceId,
      );

      if (!ws || ws.status !== "active") {
        return ctx.status(404);
      }

      const workspaceId = toSafeId<"workspace">(ctx.params.workspaceId);

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
    resolve(ctx) {
      const ws = ctx.accessibleWorkspaces.find(
        (w) => w.id === ctx.params.workspaceId,
      );

      if (!ws || (ws.status !== "active" && ws.status !== "archived")) {
        return ctx.status(404);
      }

      const workspaceId = toSafeId<"workspace">(ctx.params.workspaceId);

      return {
        workspaceId,
        ...bindWorkspaceRecorder(ctx, workspaceId),
      };
    },
  });
