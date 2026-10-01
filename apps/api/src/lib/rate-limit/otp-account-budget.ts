import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { isAPIError } from "better-call";
import { createHash } from "node:crypto";

import { Temporal } from "@stll/time";

import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";

export const OTP_ACCOUNT_BUDGET = {
  max: 5,
  durationMs: 15 * 60 * 1000,
} as const;
const OTP_VERIFICATION_PATHS = new Set([
  "/sign-in/email-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/reset-password",
  "/email-otp/change-email",
]);

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
          matcher: ({ path }) => enabled && OTP_VERIFICATION_PATHS.has(path),
          handler: createAuthMiddleware(async (ctx) => {
            const email: unknown =
              ctx.path === "/email-otp/change-email"
                ? (await getAuthoritativeSessionFromCtx(ctx))?.user.email
                : ctx.body?.email;
            if (typeof email !== "string") {
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
          matcher: ({ path }) => enabled && OTP_VERIFICATION_PATHS.has(path),
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
