import { apiKey } from "@better-auth/api-key";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
  desktopRegistryKeyConfig,
} from "@/api/lib/business-registries/desktop/config";

const createTestAuth = (sessionForKeys = false) =>
  betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      bearer(),
      apiKey([
        {
          ...desktopRegistryKeyConfig,
          enableSessionForAPIKeys: sessionForKeys,
        },
        {
          configId: "machine",
          references: "user",
          defaultPrefix: "stella_mk_",
          enableSessionForAPIKeys: false,
        },
      ]),
    ],
  });

describe("desktop registry API-key configuration", () => {
  test("keeps the registry credential separate and sessionless", async () => {
    const auth = createTestAuth();
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: "desktop-registry@example.test",
        name: "Desktop Registry",
        password: "A secure password 123!",
      },
    });
    const created = await auth.api.createApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        name: "Desktop registry search",
        userId: signedUp.user.id,
        expiresIn: DESKTOP_REGISTRY_KEY_SECONDS,
        metadata: {
          purpose: DESKTOP_REGISTRY_KEY_CONFIG,
          organizationId: "00000000-0000-4000-8000-000000000001",
        },
      },
    });

    expect(created.key.startsWith(DESKTOP_REGISTRY_KEY_PREFIX)).toBe(true);
    expect(created.expiresAt).not.toBeNull();
    if (created.expiresAt === null) {
      throw new Error("The desktop registry key must expire");
    }
    expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      DESKTOP_REGISTRY_KEY_SECONDS * 1000,
    );
    const desktopVerification = await auth.api.verifyApiKey({
      body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, key: created.key },
    });
    expect(desktopVerification).toMatchObject({ valid: true });
    const machineVerification = await auth.api.verifyApiKey({
      body: { configId: "machine", key: created.key },
    });
    expect(machineVerification).toMatchObject({ valid: false });
    const sessionResult = await auth.api
      .getSession({
        headers: { authorization: `Bearer ${created.key}` },
      })
      .catch((error: unknown) => error);
    if (
      sessionResult !== null &&
      typeof sessionResult === "object" &&
      "body" in sessionResult
    ) {
      expect(sessionResult).toMatchObject({
        body: { code: "UNAUTHORIZED_SESSION" },
      });
    } else {
      expect(sessionResult).toBeNull();
    }

    await auth.api.updateApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        keyId: created.id,
        enabled: false,
      },
      headers: { authorization: `Bearer ${signedUp.token}` },
    });
    const disabledVerification = await auth.api
      .verifyApiKey({
        body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, key: created.key },
      })
      .catch((error: unknown) => error);
    if (
      disabledVerification !== null &&
      typeof disabledVerification === "object" &&
      "body" in disabledVerification
    ) {
      expect(disabledVerification).toMatchObject({
        body: { code: "INVALID_API_KEY" },
      });
    } else {
      expect(disabledVerification).toMatchObject({ valid: false });
    }
  });

  test("rejects a caller-selected lifetime beyond the one-hour bounds", async () => {
    const auth = createTestAuth();
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: "desktop-registry-expiry@example.test",
        name: "Desktop Registry",
        password: "A secure password 123!",
      },
    });

    const created = await Result.tryPromise(
      async () =>
        await auth.api.createApiKey({
          body: {
            configId: DESKTOP_REGISTRY_KEY_CONFIG,
            name: "Too long",
            userId: signedUp.user.id,
            expiresIn: DESKTOP_REGISTRY_KEY_SECONDS + 1,
            metadata: {
              purpose: DESKTOP_REGISTRY_KEY_CONFIG,
              organizationId: "00000000-0000-4000-8000-000000000001",
            },
          },
        }),
    );
    expect(created.isErr()).toBe(true);
    if (created.isErr()) {
      expect(created.error.cause).toMatchObject({
        body: { code: "EXPIRES_IN_IS_TOO_LARGE" },
      });
    }
  });

  test("detects accidental API-key session enablement", async () => {
    const auth = createTestAuth(true);
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: "desktop-registry-session@example.test",
        name: "Desktop Registry",
        password: "A secure password 123!",
      },
    });
    const created = await auth.api.createApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        name: "Session must stay disabled",
        userId: signedUp.user.id,
        expiresIn: DESKTOP_REGISTRY_KEY_SECONDS,
        metadata: {
          purpose: DESKTOP_REGISTRY_KEY_CONFIG,
          organizationId: "00000000-0000-4000-8000-000000000001",
        },
      },
    });
    expect(
      await auth.api.getSession({
        headers: { "x-api-key": created.key },
      }),
    ).not.toBeNull();
  });
});
