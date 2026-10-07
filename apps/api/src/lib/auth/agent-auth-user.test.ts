import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  AGENT_IDENTITY_CREATE_USER_PATH,
  createAgentUserPlugin,
} from "@/api/lib/auth/agent-auth-user";
import { createSocialIdentityValidation } from "@/api/lib/auth/social-identity-policy";

describe("agent identity user creation", () => {
  test.each([false, true])(
    "requires verified identity data: %s",
    async (emailVerified) => {
      const database = { user: [], session: [], account: [], verification: [] };
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: memoryAdapter(database),
        plugins: [createAgentUserPlugin()],
        user: {
          validateUserInfo: createSocialIdentityValidation({
            tenantId: undefined,
            requireMicrosoftVerifiedEmailClaim: false,
            warn: () => {},
          }),
        },
      });
      const created = auth.api.createAgentUser({
        body: {
          email: "account@example.test",
          name: "Account",
          emailVerified,
        },
      });
      if (!emailVerified) {
        const rejected = await Result.tryPromise({
          try: async () => await created,
          catch: (cause) => cause,
        });
        expect(rejected).toMatchObject({
          status: "error",
          error: {
            statusCode: 403,
            body: { code: "identity_not_allowed" },
          },
        });
        expect(database.user).toHaveLength(0);
        return;
      }
      expect(await created).toMatchObject({
        email: "account@example.test",
        emailVerified: true,
      });
      expect(database.user).toHaveLength(1);
    },
  );

  test("keeps identity provisioning available only through the server API", async () => {
    const database = { user: [], session: [], account: [], verification: [] };
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter(database),
      plugins: [createAgentUserPlugin()],
    });
    const response = await auth.handler(
      new Request(
        `http://localhost:3001/api/auth${AGENT_IDENTITY_CREATE_USER_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "account@example.test",
            name: "Account",
            emailVerified: true,
          }),
        },
      ),
    );
    expect(response.status).toBe(404);
    expect(database.user).toHaveLength(0);
  });
});
