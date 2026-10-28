import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { rlsDb, rootDb } from "@/api/db/root";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { createDesktopCredentialAuthorizers } from "@/api/lib/business-registries/desktop/auth";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_SECONDS,
  desktopRegistryKeyConfig,
} from "@/api/lib/business-registries/desktop/config";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Kept apart from rls-fixture.ts: these imports reach the production database
// module, which only the cross-tenant matrix should load.
// Infrastructure changes driver only: provider verification, device proofs,
// replay persistence, live membership and RLS use their production owners.
export const createRlsDesktopCredentials = async (
  testDb: TestDatabase,
  ids: TestIds,
) => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: drizzleAdapter(testDb, AUTH_DATABASE_ADAPTER_OPTIONS),
    plugins: [apiKey([desktopRegistryKeyConfig])],
  });
  // SAFETY: both drivers execute the same Drizzle query and transaction APIs.
  const authorizers = createDesktopCredentialAuthorizers({
    ownerDb: asTestRaw<typeof rootDb>(testDb),
    membershipDb: asTestRaw<typeof rlsDb>(testDb),
    verifyApiKey: () => auth.api.verifyApiKey,
    resolveMember: async (lookup) =>
      await resolveMemberAuthorization(lookup, testDb),
  });
  const mint = async (boundOrganizationId: TestIds["orgA"]) => {
    const identity = await createDesktopDeviceSigner();
    const created = await auth.api.createApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        name: "Desktop matrix",
        userId: ids.userA1,
        expiresIn: null,
        metadata: {
          purpose: DESKTOP_REGISTRY_KEY_CONFIG,
          organizationId: boundOrganizationId,
          deviceJkt: identity.deviceJkt,
          inactivityExpiresAt: new Date(
            Date.now() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
          ).toISOString(),
        },
      },
    });
    return {
      /** The account token, for a request a test signs with another key. */
      credential: created.key,
      deviceJkt: identity.deviceJkt,
      signRequest: async (request: Request) => {
        request.headers.set("authorization", `Bearer ${created.key}`);
        return await identity.signRequest({ request, credential: created.key });
      },
    };
  };
  return { ...authorizers, a: await mint(ids.orgA), b: await mint(ids.orgB) };
};
