import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { envApiServerSchema } from "@/api/env-schema";
import { rateLimitBudgetEnvSchema } from "@/api/lib/rate-limit/budget-config-schema";

const budgetSchema = v.object(rateLimitBudgetEnvSchema);
const apiSchemas = new Map(Object.entries(envApiServerSchema));

const maximumForSetting = (name: string): number => {
  if (name.endsWith("_MAX_CONCURRENT")) {
    return 10_000;
  }
  if (name.endsWith("_MAX")) {
    return 1_000_000;
  }
  if (name.endsWith("_MS")) {
    return 604_800_000;
  }
  return 604_800;
};

describe("rate-limit environment configuration", () => {
  test("retains request-budget defaults", () => {
    const configuration = v.parse(budgetSchema, {});
    expect(configuration.RATE_LIMIT_AUTH_GLOBAL_MAX).toBe(100);
    expect(configuration.RATE_LIMIT_AUTH_SIGN_IN_MAX).toBe(5);
    expect(configuration.RATE_LIMIT_AUTH_OAUTH_TOKEN_MAX).toBe(20);
    expect(configuration.RATE_LIMIT_AUTH_OAUTH_AUTHORIZATION_MAX).toBe(30);
    expect(configuration.RATE_LIMIT_AUTH_DEFAULT_SENSITIVE_WINDOW_SECONDS).toBe(
      10,
    );
    expect(configuration.RATE_LIMIT_API_API_MAX).toBe(1000);
    expect(configuration.RATE_LIMIT_API_MCP_TRANSPORT_MAX).toBe(600);
    expect(configuration.RATE_LIMIT_API_MCP_TRANSPORT_ADDRESS_MAX).toBe(3000);
    expect(
      configuration.RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_MAX_CONCURRENT,
    ).toBe(2);
    expect(configuration.RATE_LIMIT_ACCOUNT_OTP_MAX).toBe(10);
    expect(configuration.RATE_LIMIT_ACCOUNT_OTP_DURATION_MS).toBe(900_000);
    expect(configuration.RATE_LIMIT_ACCOUNT_DEMO_OTP_MAX).toBe(5);
    expect(configuration.RATE_LIMIT_ACCOUNT_PASSWORD_DURATION_MS).toBe(
      3_600_000,
    );
    expect(configuration.RATE_LIMIT_MCP_CAPABILITY_MAX).toBe(60);
    expect(configuration.RATE_LIMIT_MCP_GATEWAY_WINDOW_MS).toBe(60_000);
    expect(configuration.RATE_LIMIT_DEMO_ACTION_MAX).toBe(200);
    expect(configuration.RATE_LIMIT_DEMO_ACTION_DURATION_MS).toBe(86_400_000);
    expect(configuration.RATE_LIMIT_API_KEY_MACHINE_MAX).toBe(600);
    expect(configuration.RATE_LIMIT_API_KEY_DESKTOP_MAX).toBe(60);
    expect(configuration.RATE_LIMIT_API_KEY_MACHINE_WINDOW_MS).toBe(60_000);
    expect(configuration.RATE_LIMIT_API_KEY_DESKTOP_WINDOW_MS).toBe(60_000);
    expect(configuration.RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_EMAIL_MAX).toBe(3);
    expect(
      configuration.RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_ADDRESS_DURATION_MS,
    ).toBe(10_800_000);
    expect(
      configuration.RATE_LIMIT_OTP_DELIVERY_EXISTING_ACCOUNT_EMAIL_MAX,
    ).toBe(10);
  });

  for (const [name, schema] of Object.entries(rateLimitBudgetEnvSchema)) {
    test(`${name} is installed in the API schema and accepts bounded integer overrides`, () => {
      expect(apiSchemas.get(name)).toBe(schema);
      const defaultValue = v.parse(schema, undefined);
      expect(Number.isSafeInteger(defaultValue)).toBe(true);
      const isMilliseconds = name.endsWith("_MS");
      const minimum = isMilliseconds ? 1000 : 1;
      const maximum = maximumForSetting(name);
      expect(defaultValue).toBeGreaterThanOrEqual(minimum);
      expect(defaultValue).toBeLessThanOrEqual(maximum);
      for (const value of [minimum, minimum + 1, maximum]) {
        expect(v.parse(schema, String(value))).toBe(value);
      }
      for (const value of [
        "",
        "NaN",
        "Infinity",
        "1e3",
        "1.5",
        "-1",
        String(minimum - 1),
        String(maximum + 1),
      ]) {
        expect(v.safeParse(schema, value).success).toBe(false);
      }
    });
  }
});
