import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, organization } from "better-auth/plugins";
import Elysia, { t, type Context } from "elysia";

import { db } from "@/api/db";
import { authSchema } from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { sendOrganizationInvitation, sendOTPEmail } from "@/api/lib/email";
import { AUTH_RATE_LIMIT_MAX_WINDOW, AUTH_RATE_LIMITS } from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import { posthogIdentify } from "@/api/lib/posthog";
import { redis } from "@/api/lib/redis";

/** Session lifetime in seconds (7 days). */
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

/** How often the session expiry is refreshed, in seconds (1 day). */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export const auth = betterAuth({
  trustedOrigins: [env.FRONTEND_URL],
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
          // biome-ignore lint/suspicious/noConsole: intentional dev-mode logging
          console.log(`[DEV] OTP for ${email}: ${otp} (type: ${type})`);
          return;
        }

        const lang = extractLangFromRequest(ctx?.request);
        await sendOTPEmail({ email, otp, type, lang });
      },
    }),
    organization({
      async sendInvitationEmail(data, request) {
        const inviteLink = `${env.FRONTEND_URL}/auth/accept-invitation/${data.id}`;
        if (env.isDev) {
          // biome-ignore lint/suspicious/noConsole: intentional dev-mode logging
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

export const betterAuthHandler = async (context: Context) => {
  // Elysia eagerly consumes the request body during parsing,
  // making it unavailable for better-auth's internal reader.
  // Reconstruct a fresh Request with Elysia's parsed body.
  const { method, url, headers } = context.request;
  const hasBody = method !== "GET" && method !== "HEAD";
  const request = new Request(url, {
    method,
    headers,
    body: hasBody && context.body ? JSON.stringify(context.body) : undefined,
  });
  return await auth.handler(request);
};

export const authMacro = new Elysia({ name: "authMacro" })
  .mount(auth.handler)
  .macro({
    validateAuth: {
      async resolve({ status, request }) {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        const activeOrganizationId = session?.session.activeOrganizationId;

        if (!session || !activeOrganizationId) {
          return status(401);
        }

        posthogIdentify({
          distinctId: session.user.id,
          properties: {
            active_organization_id: activeOrganizationId,
          },
        });

        return {
          user: session.user,
          session: {
            ...session.session,
            activeOrganizationId:
              toSafeId<"organization">(activeOrganizationId),
          },
        };
      },
    },
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
      const workspace = await db.query.workspaces.findFirst({
        where: {
          id: ctx.params.workspaceId,
        },
        columns: {
          organizationId: true,
          status: true,
        },
      });

      if (!workspace || workspace.status !== "active") {
        return ctx.status(404);
      }

      if (workspace.organizationId !== ctx.session.activeOrganizationId) {
        return ctx.status(403);
      }

      return {
        workspaceId: toSafeId<"workspace">(ctx.params.workspaceId),
      };
    },
  });
