import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { describe, expect, test } from "bun:test";

import { createAgentUser } from "@/api/lib/agent-auth-user";
import { createSocialIdentityValidation } from "@/api/lib/social-identity-policy";

describe("agent identity user creation", () => {
  test.each([false, true])(
    "requires verified identity data: %s",
    async (emailVerified) => {
      const database = { user: [], session: [], account: [], verification: [] };
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: memoryAdapter(database),
        user: { validateUserInfo: createSocialIdentityValidation(undefined) },
      });
      const created = createAgentUser({
        context: await auth.$context,
        email: "account@example.test",
        name: "Account",
        emailVerified,
      });
      if (!emailVerified) {
        await expect(created).rejects.toMatchObject({
          statusCode: 403,
          body: { code: "identity_not_allowed" },
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
});
