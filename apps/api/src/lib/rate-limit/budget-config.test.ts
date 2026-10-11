import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createRateLimitBudgetConfig } from "@/api/lib/rate-limit/budget-config";
import { rateLimitBudgetEnvSchema } from "@/api/lib/rate-limit/budget-config-schema";

const budgetSchema = v.object(rateLimitBudgetEnvSchema);

const configuredNumbers = (value: unknown): number[] => {
  if (typeof value === "number") {
    return [value];
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(configuredNumbers);
};

describe("configured request budgets", () => {
  test("every schema setting independently reaches exactly one runtime budget", () => {
    const overrides = Object.fromEntries(
      Object.keys(rateLimitBudgetEnvSchema).map((name, index) => [
        name,
        String(2000 + index),
      ]),
    );
    const configuration = v.parse(budgetSchema, overrides);
    const budgets = createRateLimitBudgetConfig(() => configuration);
    expect(configuredNumbers(budgets).toSorted((a, b) => a - b)).toEqual(
      Object.values(configuration).toSorted((a, b) => a - b),
    );
  });

  test("references remain safe before environment initialization", () => {
    let reads = 0;
    const configuration = v.parse(budgetSchema, {});
    const budgets = createRateLimitBudgetConfig(() => {
      reads += 1;
      return configuration;
    });
    const otp = budgets.ACCOUNT_ATTEMPT_RATE_LIMITS.otp;
    const demoOtp = budgets.ACCOUNT_ATTEMPT_RATE_LIMITS.demoOtp;
    const password = budgets.ACCOUNT_ATTEMPT_RATE_LIMITS.password;
    const demoActions = budgets.DEMO_ACTION_RATE_LIMITS;
    const machine = budgets.API_KEY_RATE_LIMITS.machine;
    const desktop = budgets.API_KEY_RATE_LIMITS.desktop;
    expect(reads).toBe(0);
    expect(otp.max).toBe(10);
    expect(demoOtp.max).toBe(5);
    expect(password.max).toBe(10);
    expect(demoActions.max).toBe(200);
    expect(machine.maxRequests).toBe(600);
    expect(desktop.maxRequests).toBe(60);
    expect(reads).toBe(6);
  });

  test("applies independently overridden auth, API, account, and MCP limits", () => {
    const configuration = v.parse(budgetSchema, {
      RATE_LIMIT_AUTH_SIGN_IN_MAX: "7",
      RATE_LIMIT_AUTH_SIGN_IN_WINDOW_SECONDS: "120",
      RATE_LIMIT_API_UPLOAD_MAX: "23",
      RATE_LIMIT_API_UPLOAD_DURATION_MS: "30000",
      RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_MAX_CONCURRENT: "4",
      RATE_LIMIT_ACCOUNT_OTP_MAX: "11",
      RATE_LIMIT_ACCOUNT_DEMO_OTP_MAX: "6",
      RATE_LIMIT_ACCOUNT_PASSWORD_DURATION_MS: "7200000",
      RATE_LIMIT_MCP_CAPABILITY_MAX: "61",
      RATE_LIMIT_MCP_GATEWAY_WINDOW_MS: "120000",
      RATE_LIMIT_DEMO_ACTION_MAX: "25",
      RATE_LIMIT_DEMO_ACTION_DURATION_MS: "3600000",
      RATE_LIMIT_API_KEY_MACHINE_MAX: "901",
      RATE_LIMIT_API_KEY_MACHINE_WINDOW_MS: "120000",
      RATE_LIMIT_API_KEY_DESKTOP_MAX: "81",
      RATE_LIMIT_API_KEY_DESKTOP_WINDOW_MS: "30000",
      RATE_LIMIT_OTP_DELIVERY_EXISTING_ACCOUNT_EMAIL_MAX: "12",
    });
    const budgets = createRateLimitBudgetConfig(() => configuration);
    expect(budgets.AUTH_RATE_LIMITS.signIn).toEqual({ max: 7, window: 120 });
    expect(budgets.AUTH_RATE_LIMITS.oauthToken).toEqual({
      max: 20,
      window: 60,
    });
    expect(budgets.API_RATE_LIMITS.upload).toEqual({
      max: 23,
      duration: 30_000,
    });
    expect(budgets.API_RATE_LIMITS.publicSanctionsSearch.maxConcurrent).toBe(4);
    expect(budgets.ACCOUNT_ATTEMPT_RATE_LIMITS.otp.max).toBe(11);
    expect(budgets.ACCOUNT_ATTEMPT_RATE_LIMITS.demoOtp.max).toBe(6);
    expect(budgets.ACCOUNT_ATTEMPT_RATE_LIMITS.password.durationMs).toBe(
      7_200_000,
    );
    expect(budgets.MCP_RATE_LIMITS.capability.max).toBe(61);
    expect(budgets.MCP_RATE_LIMITS.gateway.windowMs).toBe(120_000);
    expect(budgets.DEMO_ACTION_RATE_LIMITS).toEqual({
      max: 25,
      durationMs: 3_600_000,
    });
    expect(budgets.API_KEY_RATE_LIMITS.machine).toEqual({
      enabled: true,
      maxRequests: 901,
      timeWindow: 120_000,
    });
    expect(budgets.API_KEY_RATE_LIMITS.desktop).toEqual({
      enabled: true,
      maxRequests: 81,
      timeWindow: 30_000,
    });
    expect(budgets.OTP_DELIVERY_RATE_LIMITS.existingAccountEmailMax).toBe(12);
  });
});
