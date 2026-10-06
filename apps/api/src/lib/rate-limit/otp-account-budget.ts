import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { panic, Result } from "better-result";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";
import { isRecord } from "@/api/lib/type-guards";

export const OTP_ACCOUNT_BUDGET = {
  max: 10,
  durationMs: 15 * 60 * 1000,
} as const;
export const DEMO_OTP_ACCOUNT_BUDGET = {
  max: 5,
  durationMs: OTP_ACCOUNT_BUDGET.durationMs,
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
  path: string | undefined,
): path is keyof typeof OTP_VERIFICATION_TYPES =>
  path !== undefined && Object.hasOwn(OTP_VERIFICATION_TYPES, path);

export const createOtpAccountBudget = (
  context: Pick<RateLimitContext, "increment" | "decrement">,
  demoAccountEmail: string | undefined,
) => ({
  reserve: async (email: string) => {
    const normalizedEmail = email.trim().toLowerCase();
    const isDemoAccount =
      normalizedEmail === demoAccountEmail?.trim().toLowerCase();
    const accountBudget = isDemoAccount
      ? DEMO_OTP_ACCOUNT_BUDGET
      : OTP_ACCOUNT_BUDGET;
    const account = hashSha256Hex(normalizedEmail);
    const key = createRedisRateLimitRequestKey({
      counterKey: `otp-account:${account}`,
      requestId: Bun.randomUUIDv7(),
    });
    const { count, nextReset } = await context.increment(
      key,
      accountBudget.durationMs,
    );
    if (count > accountBudget.max) {
      return Result.err(
        new APIError(
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
        ),
      );
    }
    return Result.ok(key);
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
  demoAccountEmail: string | undefined;
};

export const createOtpAccountLimitPlugin = ({
  enabled,
  context,
  demoAccountEmail,
}: OtpAccountLimitPluginOptions) => {
  const budget = createOtpAccountBudget(context, demoAccountEmail);
  return {
    id: "otp-account-budget",
    hooks: {
      before: [
        {
          matcher: ({ path }) => enabled && isOtpVerificationPath(path),
          handler: createAuthMiddleware(async (ctx) => {
            if (!isOtpVerificationPath(ctx.path)) {
              return undefined;
            }
            const body: unknown = ctx.body;
            const verificationType = OTP_VERIFICATION_TYPES[ctx.path];
            const usesSessionEmail =
              verificationType === "change-email" ||
              verificationType === "current-email";
            const emailFromBody = isRecord(body) ? body["email"] : undefined;
            const email: unknown = usesSessionEmail
              ? (await getAuthoritativeSessionFromCtx(ctx))?.user.email
              : emailFromBody;
            if (typeof email !== "string") {
              return undefined;
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
                const type = isRecord(body) ? body["type"] : undefined;
                if (typeof type !== "string") {
                  return undefined;
                }
                identifier = `${type}-otp-${accountEmail}`;
                break;
              }
              case "change-email": {
                const newEmail = isRecord(body) ? body["newEmail"] : undefined;
                if (typeof newEmail !== "string") {
                  return undefined;
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
                  return undefined;
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
              return undefined;
            }
            const reservation = await budget.reserve(email);
            if (Result.isError(reservation)) {
              return await Promise.reject(reservation.error);
            }
            return {
              context: {
                context: { otpAccountBudgetKey: reservation.value },
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
              return undefined;
            }
            await budget.complete(key, !isAPIError(ctx.context.returned));
            return undefined;
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
