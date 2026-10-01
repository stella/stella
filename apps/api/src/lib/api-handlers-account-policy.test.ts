import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const config = {
  permissions: { integration: ["create"] },
  mcp: { type: "internal", reason: "mcp_transport" },
} satisfies HandlerConfig;

describe("handler account policy", () => {
  test.each(["account@example.test", "standard@example.test"])(
    "checks account access before running a restricted operation: %s",
    async (email) => {
      let calls = 0;
      let policyChecks = 0;
      const definition = createSafeRootHandler(
        config,
        async function* () {
          calls += 1;
          return Result.ok({ success: true });
        },
        {
          checkAccountOperation: (resolvedEmail) => {
            expect(resolvedEmail).toBe(email);
            policyChecks += 1;
            return checkDemoAccountAccess({
              email,
              config: {
                email: "account@example.test",
                organizationId: "00000000-0000-4000-8000-000000000001",
              },
              operation: "growth",
            });
          },
        },
      );
      const context = createTestHandlerContext<
        Parameters<typeof definition.handler>[0]
      >({ user: { email } });
      const result = await definition.handler(context);
      expect(policyChecks).toBe(1);
      expect(calls).toBe(email === "standard@example.test" ? 1 : 0);
      if (email === "standard@example.test") {
        expect(result).toEqual({ success: true });
      } else {
        expect(result).toMatchObject({
          code: 403,
          response: { code: "account_access_unavailable" },
        });
      }
    },
  );
});

test("allows sandbox matter mutations without an account growth check", async () => {
  for (const operation of ["create", "update", "delete"] as const) {
    const checkAccountOperation = mock(() => Result.ok());
    const matterConfig = {
      permissions: { workspace: [operation] },
      mcp: { type: "internal", reason: "mcp_transport" },
    } as const satisfies HandlerConfig;
    const definition = createSafeRootHandler(
      matterConfig,
      async function* () {
        return Result.ok({ success: true });
      },
      { checkAccountOperation },
    );
    const context = createTestHandlerContext<
      Parameters<typeof definition.handler>[0]
    >({ user: { email: "account@example.test" } });
    expect(await definition.handler(context)).toEqual({ success: true });
    expect(checkAccountOperation).not.toHaveBeenCalled();
  }
});
