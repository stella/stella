import {
  API_KEY_TABLE_NAME,
  apiKey,
  defaultKeyHasher,
} from "@better-auth/api-key";
import type { ApiKey } from "@better-auth/api-key/types";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { errorOutputLogger } from "@stll/errors";
import { rejectionOf } from "@stll/property-testing/rejection";
import { Temporal } from "@stll/time";

import { API_KEY_PLUGIN_CONFIGS } from "@/api/lib/api-key-plugin-configs";
import { MACHINE_API_KEY_CONFIG_ID } from "@/api/lib/machine-api-key-config";
import {
  resolveMachineApiKeySession,
  revalidateMachineApiKeySession,
} from "@/api/mcp/api-key-auth";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

const OWNER_ID = "stream-key-owner";
const ORGANIZATION_ID = "stream-key-organization";
const REQUEST_LIMIT = 3;
const INITIAL_REMAINING = 20;

const createCredential = async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "stream-key-test-secret-at-least-32-characters",
    logger: errorOutputLogger,
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
    }),
    plugins: [
      apiKey(
        API_KEY_PLUGIN_CONFIGS.map((config) => ({
          ...config,
          rateLimit: {
            enabled: true,
            maxRequests: REQUEST_LIMIT,
            timeWindow: 3_600_000,
          },
        })),
      ),
    ],
  });
  const context = await auth.$context;
  await context.adapter.create({
    model: "user",
    data: {
      id: OWNER_ID,
      email: "stream@example.test",
      name: "Stream owner",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    forceAllowId: true,
  });
  const issued = await auth.api.createApiKey({
    body: {
      configId: MACHINE_API_KEY_CONFIG_ID,
      userId: OWNER_ID,
      name: "Stream credential",
      remaining: INITIAL_REMAINING,
      metadata: { organizationId: ORGANIZATION_ID, scopes: ["stella:read"] },
      permissions: { organizationSettings: ["update"] },
    },
  });
  const membership: { role: string | null } = { role: "owner" };
  const clock = { current: Temporal.Instant.from("2026-10-08T00:00:00Z") };
  const resolveAuthorization = async () =>
    membership.role === null
      ? null
      : {
          billingAccess: false,
          memberId: "stream-member",
          email: "stream@example.test",
          role: membership.role,
          workspace: null,
          emailVerified: true,
          userDeleted: false,
          enrolledFeatureIds: [],
          professionalUse: { status: "required" as const },
        };
  const admit = async () =>
    await resolveMachineApiKeySession(issued.key, {
      verifyApiKey: auth.api.verifyApiKey,
      resolveAuthorization,
    });
  const revalidate = async () =>
    await revalidateMachineApiKeySession(issued.key, {
      getAuthContext: async () => context,
      clock: { instant: () => clock.current },
      resolveAuthorization,
    });
  const stored = async () => {
    const row = await context.adapter.findOne<ApiKey>({
      model: API_KEY_TABLE_NAME,
      where: [{ field: "id", value: issued.id }],
    });
    return row ?? expect.unreachable("The issued credential is stored");
  };
  return {
    auth,
    context,
    issued,
    membership,
    clock,
    admit,
    revalidate,
    stored,
    resolveAuthorization,
  };
};

describe("machine credential stream revalidation", () => {
  test.each([1, 3, 8])(
    "%i revalidations preserve the stored budget while admissions consume it",
    async (repetitions) => {
      const credential = await createCredential();
      await credential.admit();
      const admitted = await credential.stored();
      expect(admitted.key).toBe(await defaultKeyHasher(credential.issued.key));
      expect(admitted.requestCount).toBe(1);
      expect(admitted.lastRequest).toBeInstanceOf(Date);
      expect(admitted.remaining).toBe(INITIAL_REMAINING - 1);

      for (let index = 0; index < repetitions; index++) {
        expect((await credential.revalidate()).userId).toBe(OWNER_ID);
        expect(await credential.stored()).toEqual(admitted);
      }
      for (let count = 2; count <= REQUEST_LIMIT; count++) {
        await credential.admit();
        const spent = await credential.stored();
        expect(spent.requestCount).toBe(count);
        expect(spent.remaining).toBe(INITIAL_REMAINING - count);
      }
      expect(await rejectionOf(credential.admit())).toBeInstanceOf(
        McpAuthenticationError,
      );
      const exhausted = await credential.stored();
      for (let index = 0; index < repetitions; index++) {
        expect((await credential.revalidate()).userId).toBe(OWNER_ID);
        expect(await credential.stored()).toEqual(exhausted);
      }
    },
  );

  test.each([
    "disabled",
    "expired",
    "membership_removed",
    "role_changed",
    "wrong_configuration",
  ] as const)("revalidation refuses a credential after %s", async (change) => {
    const credential = await createCredential();
    await credential.admit();
    switch (change) {
      case "disabled":
        await credential.context.adapter.update({
          model: API_KEY_TABLE_NAME,
          where: [{ field: "id", value: credential.issued.id }],
          update: { enabled: false },
        });
        break;
      case "expired":
        await credential.context.adapter.update({
          model: API_KEY_TABLE_NAME,
          where: [{ field: "id", value: credential.issued.id }],
          update: {
            expiresAt: new Date(credential.clock.current.epochMilliseconds),
          },
        });
        expect((await credential.revalidate()).userId).toBe(OWNER_ID);
        credential.clock.current = credential.clock.current.add({
          milliseconds: 1,
        });
        break;
      case "membership_removed":
        credential.membership.role = null;
        break;
      case "role_changed":
        credential.membership.role = "intern";
        break;
      case "wrong_configuration":
        await credential.context.adapter.update({
          model: API_KEY_TABLE_NAME,
          where: [{ field: "id", value: credential.issued.id }],
          update: { configId: "desktop_registry" },
        });
        break;
      default: {
        change satisfies never;
        panic("Unhandled credential change");
      }
    }
    const before = await credential.stored();
    expect(await rejectionOf(credential.revalidate())).toBeInstanceOf(
      McpAuthenticationError,
    );
    expect(await credential.stored()).toEqual(before);
  });

  test("store failures remain retryable verification failures", async () => {
    const credential = await createCredential();
    await credential.admit();
    const outage = new Error("Credential store unavailable");
    const result = await authenticateMcpRequest(credential.issued.key, {
      resolveApiKeySession: async (key, options) =>
        await revalidateMachineApiKeySession(key, {
          ...options,
          getAuthContext: async () => ({
            adapter: { findOne: async () => await Promise.reject(outage) },
          }),
          resolveAuthorization: credential.resolveAuthorization,
        }),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(McpTokenVerificationError);
      expect(result.error.cause).toBe(outage);
    }
  });
});
