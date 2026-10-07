import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SessionHandlerConfig,
} from "@/api/lib/api-handlers";
import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const config = {
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.standard,
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

test.each(["when-used", "always"] as const)(
  "refuses account access before conditional feature resource admission: %s",
  async (decision) => {
    const usesFeature = mock(async () => true);
    const definition = createSafeRootHandler(
      {
        ...config,
        featureAccess: {
          featureId: "list-verification",
          type: "conditional",
          decision,
          usesFeature,
          projectInputSchema: (schemas) => schemas,
        },
      },
      async function* () {
        return Result.ok({ success: true });
      },
      {
        checkAccountOperation: (email) =>
          checkDemoAccountAccess({
            email,
            config: {
              email: "account@example.test",
              organizationId: "org_account",
            },
            operation: "growth",
          }),
      },
    );
    const response = await definition.handler(
      createTestHandlerContext<Parameters<typeof definition.handler>[0]>({
        user: { email: "account@example.test" },
      }),
    );
    expect(response).toMatchObject({
      code: 403,
      response: { code: "account_access_unavailable" },
    });
    expect(usesFeature).not.toHaveBeenCalled();
  },
);

test("allows sandbox matter mutations without an account growth check", async () => {
  for (const operation of ["create", "update", "delete"] as const) {
    const checkAccountOperation = mock(() => Result.ok());
    const matterConfig = {
      permissions: { workspace: [operation] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
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

test("applies declared account access alongside resource permissions", async () => {
  const definition = createSafeRootHandler(
    {
      permissions: { workspace: ["read"] },
      accountAccess: ACCOUNT_ACCESS.standard,
      mcp: { type: "internal", reason: "mcp_transport" },
    },
    async function* () {
      return Result.ok({ success: true });
    },
    {
      checkAccountOperation: (email) =>
        checkDemoAccountAccess({
          email,
          config: {
            email: "account@example.test",
            organizationId: "org_account",
          },
          operation: "growth",
        }),
    },
  );
  for (const email of ["account@example.test", "standard@example.test"]) {
    const response = await definition.handler(
      createTestHandlerContext<Parameters<typeof definition.handler>[0]>({
        user: { email },
      }),
    );
    if (email === "account@example.test") {
      expect(response).toMatchObject({
        code: 403,
        response: { code: "account_access_unavailable" },
      });
    } else {
      expect(response).toEqual({ success: true });
    }
  }
});

describe("session handler account policy", () => {
  const demoConfig = {
    email: "account@example.test",
    organizationId: "00000000-0000-4000-8000-000000000001",
  };

  test.each([
    [ACCOUNT_ACCESS.standard, "account@example.test", 0],
    [ACCOUNT_ACCESS.standard, "standard@example.test", 1],
    [ACCOUNT_ACCESS.sandbox, "account@example.test", 1],
  ] as const)(
    "a %s session handler for %s runs %d times",
    async (accountAccess, email, expectedCalls) => {
      let calls = 0;
      const checkAccountOperation = mock((resolvedEmail: string) =>
        checkDemoAccountAccess({
          email: resolvedEmail,
          config: demoConfig,
          operation: "growth",
        }),
      );
      const sessionConfig = {
        accountAccess,
        mcp: { type: "internal", reason: "mcp_transport" },
      } as const satisfies SessionHandlerConfig;
      const definition = createSafeSessionHandler(
        sessionConfig,
        async function* () {
          calls += 1;
          return Result.ok({ success: true });
        },
        { checkAccountOperation },
      );
      const result = await definition.handler(
        createTestHandlerContext<Parameters<typeof definition.handler>[0]>({
          user: { email },
        }),
      );
      expect(calls).toBe(expectedCalls);
      expect(checkAccountOperation).toHaveBeenCalledTimes(
        accountAccess === ACCOUNT_ACCESS.standard ? 1 : 0,
      );
      if (expectedCalls === 0) {
        expect(result).toMatchObject({
          code: 403,
          response: { code: "account_access_unavailable" },
        });
      } else {
        expect(result).toEqual({ success: true });
      }
    },
  );
});
