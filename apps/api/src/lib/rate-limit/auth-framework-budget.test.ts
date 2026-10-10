import { emailOTP } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";

import { AUTH_RATE_LIMITS } from "@/api/lib/limits";
import {
  AUTH_FRAMEWORK_BUDGET_RULES,
  AUTH_FRAMEWORK_BUDGETS,
} from "@/api/lib/rate-limit/auth-framework-budget";
import { AUTH_REQUEST_IP_RULE_OVERRIDES } from "@/api/lib/rate-limit/auth-request-budget";

describe("auth framework budget coverage", () => {
  test("every installed email-OTP plugin rule has an explicit configured owner", () => {
    const plugin = emailOTP({
      sendVerificationOTP: async () => undefined,
    });
    const endpointPaths = Object.values(plugin.endpoints).map(
      (endpoint) => endpoint.path,
    );
    const frameworkBudgets = new Map(Object.entries(AUTH_FRAMEWORK_BUDGETS));
    const disabledRules = new Map(
      Object.entries(AUTH_REQUEST_IP_RULE_OVERRIDES),
    );
    const configuredRules = new Map(
      Object.entries(AUTH_FRAMEWORK_BUDGET_RULES),
    );
    for (const pluginRule of plugin.rateLimit) {
      const matchingPaths = endpointPaths.filter((path) =>
        pluginRule.pathMatcher(path),
      );
      expect(matchingPaths.length).toBeGreaterThan(0);
      for (const path of matchingPaths) {
        if (disabledRules.get(path) === false) {
          continue;
        }
        const pattern = Object.keys(AUTH_FRAMEWORK_BUDGETS).find((candidate) =>
          candidate.endsWith("*")
            ? path.startsWith(candidate.slice(0, -1))
            : path === candidate,
        );
        expect(pattern).not.toBe("*");
        const budget = frameworkBudgets.get(pattern ?? "");
        expect(budget).toBeDefined();
        const expectedRule =
          path === "/email-otp/verify-email"
            ? AUTH_RATE_LIMITS.verifyOtp
            : AUTH_RATE_LIMITS.defaultEmail;
        expect(budget?.rule).toBe(expectedRule);
        expect(configuredRules.get(pattern ?? "")).toBe(expectedRule);
      }
    }
  });
});
