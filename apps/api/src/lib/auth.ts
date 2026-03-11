import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, emailOTP, organization } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { ac, roles } from "@stella/permissions";
import type { PermissionInput } from "@stella/permissions";

import { adminDb, createScopedDb, db } from "@/api/db";
import { authSchema, session as sessionTable } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { sendOrganizationInvitation, sendOTPEmail } from "@/api/lib/email";
import {
  AUTH_RATE_LIMIT_MAX_WINDOW,
  AUTH_RATE_LIMITS,
  LIMITS,
} from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import { posthogIdentify } from "@/api/lib/posthog";
import { redis } from "@/api/lib/redis";

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
    customStorage: {
      async get(key) {
        const data = await redis.get(key);
        if (!data) {
          return null;
        }
        return JSON.parse(data);
      },
      async set(key, value) {
        await redis.set(
          key,
          JSON.stringify(value),
          "EX",
          AUTH_RATE_LIMIT_MAX_WINDOW,
        );
      },
    },
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

const ADMIN_BYPASS_ROLES = new Set(["owner", "admin"]);
export const WORKSPACE_ACTIVE_STATUS = "active" as const;

/**
 * Resolve which workspace IDs a user can access within an
 * organization. Admins/owners see all active workspaces;
 * regular members see only workspaces they belong to.
 *
 * Shared between the Elysia `authMacro` and RivetKit actor
 * validators so workspace resolution logic lives in one place.
 */
export const resolveAccessibleWorkspaceIds = async (
  userId: string,
  organizationId: SafeId<"organization">,
): Promise<string[]> => {
  // Bootstrap queries use adminDb (superuser) because RLS
  // is active on `workspaces` but `app.workspace_ids` is
  // not set yet; that's exactly what we're resolving here.
  const orgMember = await adminDb.query.member.findFirst({
    where: {
      userId: { eq: userId },
      organizationId: { eq: organizationId },
    },
    columns: { role: true },
  });

  if (orgMember && ADMIN_BYPASS_ROLES.has(orgMember.role)) {
    const orgWorkspaces = await adminDb.query.workspaces.findMany({
      where: {
        organizationId: { eq: organizationId },
        status: WORKSPACE_ACTIVE_STATUS,
      },
      columns: { id: true },
      limit: LIMITS.workspacesCount,
    });
    return orgWorkspaces.map((w) => w.id);
  }

  // SQL join pushes org + status filter to the DB before
  // LIMIT, preventing cross-org leaks when a user belongs
  // to multiple organizations.
  const rows = await adminDb
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.status, WORKSPACE_ACTIVE_STATUS),
      ),
    )
    .limit(LIMITS.workspacesCount);

  return rows.map((r) => r.workspaceId);
};

export const authMacro = new Elysia({ name: "authMacro" }).macro({
  validateAuth: {
    async resolve({ status, request }) {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      const rawOrgId = session?.session.activeOrganizationId;

      if (!session || !rawOrgId) {
        return status(401);
      }

      const activeOrganizationId = toSafeId<"organization">(rawOrgId);

      posthogIdentify({
        distinctId: session.user.id,
        properties: {
          active_organization_id: activeOrganizationId,
        },
      });

      const accessibleWorkspaceIds = await resolveAccessibleWorkspaceIds(
        session.user.id,
        activeOrganizationId,
      );

      const scopedDb = createScopedDb(accessibleWorkspaceIds);

      return {
        user: session.user,
        session: {
          ...session.session,
          activeOrganizationId,
        },
        accessibleWorkspaceIds,
        scopedDb,
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

const validateWorkspaceAccessParams = t.Object({ workspaceId: tNanoid });

export const workspaceAccessMacro = new Elysia({
  name: "workspaceAccessMacro",
})
  .use(authMacro)
  .macro("validateWorkspaceAccess", {
    validateAuth: true,
    params: validateWorkspaceAccessParams,
    // Without this, when this macro is used with another macro that extends the body,
    // the final merged body would not include the first macro's body extension.
    body: t.Object({}),
    async resolve(ctx) {
      // Defense in depth: validates workspace existence,
      // active status, and org ownership independently
      // of RLS. Catches bugs where scopedDb might be
      // misconfigured or bypassed.
      const workspace = await adminDb.query.workspaces.findFirst({
        where: {
          id: ctx.params.workspaceId,
        },
        columns: {
          organizationId: true,
          status: true,
        },
      });

      if (
        !workspace ||
        workspace.status !== WORKSPACE_ACTIVE_STATUS ||
        workspace.organizationId !== ctx.session.activeOrganizationId
      ) {
        return ctx.status(404);
      }

      return {
        workspaceId: toSafeId<"workspace">(ctx.params.workspaceId),
      };
    },
  });
