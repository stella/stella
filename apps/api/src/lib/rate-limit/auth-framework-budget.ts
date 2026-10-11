import { panic } from "better-result";

import { AUTH_RATE_LIMITS } from "@/api/lib/limits";
import type { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import {
  recordBudgetRejection,
  type BudgetName,
} from "@/api/lib/rate-limit/budget-observability";

// Exact rules precede wildcard rules; the framework chooses the first match.
export const AUTH_FRAMEWORK_BUDGETS = {
  "/sign-up/email": {
    name: "auth.sign_up.address",
    rule: AUTH_RATE_LIMITS.signUp,
  },
  "/email-otp/verify-email": {
    name: "auth.verify_otp.address",
    rule: AUTH_RATE_LIMITS.verifyOtp,
  },
  "/email-otp/check-verification-otp": {
    name: "auth.verify_otp.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/email-otp/reset-password": {
    name: "auth.reset_password.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/email-otp/request-email-change": {
    name: "auth.framework.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/email-otp/change-email": {
    name: "auth.framework.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/forget-password": {
    name: "auth.forget_password.address",
    rule: AUTH_RATE_LIMITS.forgetPassword,
  },
  "/reset-password": {
    name: "auth.reset_password.address",
    rule: AUTH_RATE_LIMITS.resetPassword,
  },
  "/two-factor/verify-totp": {
    name: "auth.two_factor.address",
    rule: AUTH_RATE_LIMITS.verifyOtp,
  },
  "/two-factor/verify-backup-code": {
    name: "auth.two_factor.address",
    rule: AUTH_RATE_LIMITS.verifyOtp,
  },
  "/two-factor/enable": {
    name: "auth.two_factor.address",
    rule: AUTH_RATE_LIMITS.signIn,
  },
  "/two-factor/disable": {
    name: "auth.two_factor.address",
    rule: AUTH_RATE_LIMITS.signIn,
  },
  "/two-factor/*": {
    name: "auth.two_factor.address",
    rule: AUTH_RATE_LIMITS.twoFactor,
  },
  "/sign-in/*": {
    name: "auth.framework.address",
    rule: AUTH_RATE_LIMITS.defaultSensitive,
  },
  "/sign-up/*": {
    name: "auth.sign_up.address",
    rule: AUTH_RATE_LIMITS.defaultSensitive,
  },
  "/change-password*": {
    name: "auth.framework.address",
    rule: AUTH_RATE_LIMITS.defaultSensitive,
  },
  "/change-email*": {
    name: "auth.framework.address",
    rule: AUTH_RATE_LIMITS.defaultSensitive,
  },
  "/request-password-reset": {
    name: "auth.forget_password.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/send-verification-email": {
    name: "auth.verify_otp.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/forget-password*": {
    name: "auth.forget_password.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "/email-otp/request-password-reset": {
    name: "auth.forget_password.address",
    rule: AUTH_RATE_LIMITS.defaultEmail,
  },
  "*": { name: "auth.framework.address", rule: AUTH_RATE_LIMITS.global },
} as const satisfies Record<
  string,
  { name: BudgetName; rule: { max: number; window: number } }
>;

export const AUTH_FRAMEWORK_BUDGET_RULES = Object.fromEntries(
  Object.entries(AUTH_FRAMEWORK_BUDGETS).map(([path, { rule }]) => [
    path,
    rule,
  ]),
);

export const observeFrameworkAuthStorage = (
  storage: ReturnType<typeof createAuthRateLimitStorage>,
) => ({
  consume: async (key: string, rule: { max: number; window: number }) => {
    const decision = await storage.consume(key, rule);
    if (!decision.allowed) {
      // The framework key is address|path; neither component enters telemetry.
      const path = key.slice(key.lastIndexOf("|") + 1);
      const budget = Object.entries(AUTH_FRAMEWORK_BUDGETS).find(([pattern]) =>
        pattern.endsWith("*")
          ? path.startsWith(pattern.slice(0, -1))
          : path === pattern,
      );
      if (!budget) {
        panic("Auth framework budget registry must have a catch-all rule");
      }
      recordBudgetRejection({
        name: budget[1].name,
        keyKind: "address",
        windowMs: rule.window * 1000,
      });
    }
    return decision;
  },
});
