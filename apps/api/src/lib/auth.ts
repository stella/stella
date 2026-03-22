import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, emailOTP, organization } from "better-auth/plugins";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { ac, roles } from "@stella/permissions";
import type { PermissionInput } from "@stella/permissions";

import { createScopedDb, db } from "@/api/db";
import { authSchema, session as sessionTable } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { sendOrganizationInvitation, sendOTPEmail } from "@/api/lib/email";
import { AUTH_RATE_LIMIT_MAX_WINDOW, AUTH_RATE_LIMITS } from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import { posthogIdentify } from "@/api/lib/posthog";

/** Session lifetime in seconds (7 days). */
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

/** How often the session expiry is refreshed, in seconds (1 day). */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

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

export const auth = betterAuth({
  trustedOrigins: [env.FRONTEND_URL],
  user: {
    additionalFields: {
      timezoneId: {
        type: "string",
        required: false,
        defaultValue: "UTC",
      },
    },
  },
  session: {
    expiresIn: SESSION_LIFETIME_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  advanced: {
    useSecureCookies: !env.isDev,
  },
  rateLimit: {
    enabled: true,
    window: AUTH_RATE_LIMITS.global.window,
    max: AUTH_RATE_LIMITS.global.max,
    customStorage: (() => {
      type Entry = {
        value: { key: string; count: number; lastRequest: number };
        expiresAt: number;
      };
      const store = new Map<string, Entry>();
      const ttlMs = AUTH_RATE_LIMIT_MAX_WINDOW * 1000;
      const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [k, e] of store) {
          if (e.expiresAt <= now) {
            store.delete(k);
          }
        }
      }, 60_000);
      cleanup.unref();
      return {
        // eslint-disable-next-line require-await -- interface requires Promise
        async get(key: string) {
          const entry = store.get(key);
          if (!entry || entry.expiresAt <= Date.now()) {
            return null;
          }
          return entry.value;
        },
        // eslint-disable-next-line require-await -- interface requires Promise
        async set(
          key: string,
          value: {
            key: string;
            count: number;
            lastRequest: number;
          },
        ) {
          store.set(key, {
            value,
            expiresAt: Date.now() + ttlMs,
          });
        },
      };
    })(),
    customRules: {
      "/sign-in/email-otp": AUTH_RATE_LIMITS.signIn,
      "/sign-up/email": AUTH_RATE_LIMITS.signUp,
      "/email-otp/send-verification-otp": AUTH_RATE_LIMITS.sendOtp,
      "/email-otp/verify-email": AUTH_RATE_LIMITS.verifyOtp,
      "/forget-password": AUTH_RATE_LIMITS.forgetPassword,
      "/reset-password": AUTH_RATE_LIMITS.resetPassword,
    },
  },
  databaseHooks: {
    user: {
      create: {
        // eslint-disable-next-line require-await -- async required by better-auth hook type
        before: async (user) => {
          validateTimezoneId(user.timezoneId);
          return { data: user };
        },
      },
      update: {
        // eslint-disable-next-line require-await -- async required by better-auth hook type
        before: async (user) => {
          validateTimezoneId(user.timezoneId);
          return { data: user };
        },
      },
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
    transaction: true,
  }),
  plugins: [
    bearer(),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }, ctx) {
        if (env.isDev) {
          // eslint-disable-next-line no-console
          console.log(`[DEV] OTP for ${email}: ${otp} (type: ${type})`);
          return;
        }

        const lang = extractLangFromRequest(ctx?.request);
        await sendOTPEmail({ email, otp, type, lang });
      },
    }),
    organization({
      ac,
      roles,
      organizationHooks: {
        async afterRemoveMember({ member, organization: org }) {
          await db
            .delete(sessionTable)
            .where(
              and(
                eq(sessionTable.userId, member.userId),
                eq(sessionTable.activeOrganizationId, org.id),
              ),
            );
        },
      },
      async sendInvitationEmail(data, request) {
        const inviteLink = `${env.FRONTEND_URL}/auth/accept-invitation/${data.id}`;
        if (env.isDev) {
          // eslint-disable-next-line no-console
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
    }),
  ],
});

export type MemberRole = keyof typeof roles;

export const getSessionAndMemberRole = async (headers: HeadersInit) => {
  const [sessionResult, memberRoleResult] = await Promise.all([
    Result.tryPromise(
      async () =>
        await auth.api.getSession({
          headers,
        }),
    ),
    Result.tryPromise(
      async () =>
        await auth.api.getActiveMemberRole({
          headers,
        }),
    ),
  ]);

  return {
    sessionResult,
    memberRoleResult,
  };
};

const ADMIN_BYPASS_ROLES: MemberRole[] = ["owner", "admin"];

export type AccessibleWorkspace = {
  id: string;
  status: InferSelectModel<typeof workspaces>["status"];
};

/**
 * Resolve which workspaces a user can access within an
 * organization. Admins/owners see all workspaces;
 * regular members see only workspaces they belong to.
 *
 * Returns id + status so callers can gate on active status
 * without an extra DB round-trip. RLS receives all IDs
 * regardless of status.
 *
 * Shared between the Elysia `authMacro` and RivetKit actor
 * validators so workspace resolution logic lives in one place.
 */
export const resolveAccessibleWorkspaces = async (
  userId: SafeId<"user">,
  organizationId: SafeId<"organization">,
  memberRole: MemberRole,
): Promise<AccessibleWorkspace[]> => {
  if (ADMIN_BYPASS_ROLES.includes(memberRole)) {
    return await db.query.workspaces.findMany({
      where: { organizationId: { eq: organizationId } },
      columns: { id: true, status: true },
    });
  }

  // JOIN with workspaces filters by org, preventing
  // cross-org leaks when a user belongs to multiple
  // organizations.
  return await db
    .select({
      id: workspaceMembers.workspaceId,
      status: workspaces.status,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaces.organizationId, organizationId),
      ),
    );
};

export const authMacro = new Elysia({ name: "authMacro" }).macro({
  validateAuth: {
    async resolve({ status, request }) {
      const { sessionResult, memberRoleResult } = await getSessionAndMemberRole(
        request.headers,
      );

      if (Result.isError(sessionResult)) {
        return status(500);
      }
      const session = sessionResult.value?.session;
      const user = sessionResult.value?.user;
      const rawOrgId = session?.activeOrganizationId;

      if (!session || !user || !rawOrgId) {
        return status(401);
      }

      if (Result.isError(memberRoleResult)) {
        return status(500);
      }

      const memberRole = memberRoleResult.value;
      const activeOrganizationId = toSafeId<"organization">(rawOrgId);
      const userId = toSafeId<"user">(user.id);

      posthogIdentify({
        distinctId: userId,
        properties: {
          active_organization_id: activeOrganizationId,
        },
      });

      const accessibleWorkspaces = await resolveAccessibleWorkspaces(
        userId,
        activeOrganizationId,
        memberRole.role,
      );

      const scopedDb = createScopedDb(
        db,
        accessibleWorkspaces.map((w) => w.id),
        activeOrganizationId,
      );

      return {
        user: {
          id: toSafeId<"user">(user.id),
        },
        session: {
          activeOrganizationId,
          token: session.token,
        },
        accessibleWorkspaces,
        scopedDb,
        memberRole,
      };
    },
  },
});

export const permissionMacro = new Elysia({ name: "permissionMacro" }).macro({
  permissions: (permissions: PermissionInput) => ({
    // Without this, when this macro is used with another macro that extends the body,
    // the final merged body would not include the first macro's body extension.
    body: t.Object({}),
    async beforeHandle(ctx) {
      const hasPermissions = await auth.api.hasPermission({
        headers: ctx.request.headers,
        body: {
          permissions,
        },
      });

      if (!hasPermissions.success) {
        return ctx.status(403);
      }

      return;
    },
  }),
});

export const workspaceAccessMacro = new Elysia({
  name: "workspaceAccessMacro",
})
  .use(authMacro)
  .macro("validateWorkspaceAccess", {
    validateAuth: true,
    params: t.Object({ workspaceId: tNanoid }),
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

      return {
        workspaceId: toSafeId<"workspace">(ctx.params.workspaceId),
      };
    },
  });
