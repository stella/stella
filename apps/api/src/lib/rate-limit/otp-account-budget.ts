import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { isAPIError } from "better-call";
import { panic } from "better-result";
import { createHash } from "node:crypto";

import { Temporal } from "@stll/time";

import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";
import { isRecord } from "@/api/lib/type-guards";

export const OTP_ACCOUNT_BUDGET = {
  max: 10,
  durationMs: 15 * 60 * 1000,
} as const;
const OTP_VERIFICATION_TYPES = {
  "/sign-in/email-otp": "sign-in",
  "/email-otp/check-verification-otp": "body",
  "/email-otp/verify-email": "email-verification",
  "/email-otp/reset-password": "forget-password",
  "/email-otp/change-email": "change-email",
  "/email-otp/request-email-change": "current-email",
} as const;

const isOtpVerificationPath = (
  path: string,
): path is keyof typeof OTP_VERIFICATION_TYPES =>
  Object.hasOwn(OTP_VERIFICATION_TYPES, path);

export const createOtpAccountBudget = (
  context: Pick<RateLimitContext, "increment" | "decrement">,
) => ({
  reserve: async (email: string) => {
    const account = createHash("sha256")
      .update(email.trim().toLowerCase())
      .digest("hex");
    const key = createRedisRateLimitRequestKey({
      counterKey: `otp-account:${account}`,
      requestId: Bun.randomUUIDv7(),
    });
    const { count, nextReset } = await context.increment(
      key,
      OTP_ACCOUNT_BUDGET.durationMs,
    );
    if (count > OTP_ACCOUNT_BUDGET.max) {
      throw new APIError(
        "TOO_MANY_REQUESTS",
        { code: "account_sign_in_limited", message: "Try again later." },
        {
          "Retry-After": String(
            Math.max(
              1,
              Math.ceil(
                (nextReset.getTime() -
                  Temporal.Now.instant().epochMilliseconds) /
                  1000,
              ),
            ),
          ),
        },
      );
    }
    return key;
  },
  complete: async (key: string, success: boolean) => {
    if (success) {
      await context.decrement(key);
    }
  },
});

type OtpAccountLimitPluginOptions = {
  enabled: boolean;
  context: Pick<RateLimitContext, "increment" | "decrement">;
};

export const createOtpAccountLimitPlugin = ({
  enabled,
  context,
}: OtpAccountLimitPluginOptions) => {
  const budget = createOtpAccountBudget(context);
  return {
    id: "otp-account-budget",
    hooks: {
      before: [
        {
          matcher: ({ path }) => enabled && isOtpVerificationPath(path),
          handler: createAuthMiddleware(async (ctx) => {
            if (!isOtpVerificationPath(ctx.path)) {
              return;
            }
            const verificationType = OTP_VERIFICATION_TYPES[ctx.path];
            const usesSessionEmail =
              verificationType === "change-email" ||
              verificationType === "current-email";
            const email: unknown = usesSessionEmail
              ? (await getAuthoritativeSessionFromCtx(ctx))?.user.email
              : ctx.body?.email;
            if (typeof email !== "string") {
              return;
            }
            const accountEmail = email.toLowerCase();
            let identifier: string;
            switch (verificationType) {
              case "sign-in":
              case "email-verification":
              case "forget-password":
                identifier = `${verificationType}-otp-${accountEmail}`;
                break;
              case "body": {
                const type: unknown = ctx.body?.type;
                if (typeof type !== "string") {
                  return;
                }
                identifier = `${type}-otp-${accountEmail}`;
                break;
              }
              case "change-email": {
                const newEmail: unknown = ctx.body?.newEmail;
                if (typeof newEmail !== "string") {
                  return;
                }
                identifier = `change-email-otp-${accountEmail}-${newEmail.toLowerCase()}`;
                break;
              }
              case "current-email": {
                const changeEmail: unknown = ctx.context.options.plugins?.find(
                  (plugin) => plugin.id === "email-otp",
                )?.options?.["changeEmail"];
                if (
                  !isRecord(changeEmail) ||
                  changeEmail["verifyCurrentEmail"] !== true
                ) {
                  return;
                }
                identifier = `email-verification-otp-${accountEmail}`;
                break;
              }
              default: {
                verificationType satisfies never;
                panic("Unknown verification type");
              }
            }
            const verification =
              await ctx.context.internalAdapter.findVerificationValue(
                identifier,
              );
            if (
              !verification ||
              new Date(verification.expiresAt).getTime() <=
                Temporal.Now.instant().epochMilliseconds
            ) {
              return;
            }
            return {
              context: {
                context: { otpAccountBudgetKey: await budget.reserve(email) },
              },
            };
          }),
        },
      ],
      after: [
        {
          matcher: ({ path }) => enabled && isOtpVerificationPath(path),
          handler: createAuthMiddleware(async (ctx) => {
            const key: unknown = Reflect.get(
              ctx.context,
              "otpAccountBudgetKey",
            );
            if (typeof key !== "string") {
              return;
            }
            await budget.complete(key, !isAPIError(ctx.context.returned));
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
