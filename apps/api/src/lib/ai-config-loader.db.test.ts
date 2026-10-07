/**
 * Organization settings loaders read through the caller's handle. Under a
 * request scope (role `stella`), the `organization_settings` policy is what
 * keeps another organization's row out of reach, so each probe runs under the
 * membership-scoped factory request authentication builds, with the other
 * organization's settings row present.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  organizationSettings,
  organizationAccessStates,
  ORGANIZATION_ACCESS_STATE,
  usagePolicies,
  usageEntitlements,
  usageSeatAssignments,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { encryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  loadManagedAIResidency,
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { encryptContent } from "@/api/lib/content-encryption";
import {
  loadWebSearchKeys,
  loadWebSearchProvidersForOrg,
} from "@/api/lib/web-search/load-org-keys";
import { resolveWebSearchProvidersFromEnv } from "@/api/lib/web-search/select-provider";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const configFor = (modelId: string): OrgAIConfig => ({
  providers: [{ provider: "google", apiKey: `${modelId}-key` }],
  overrideModels: {
    chat: { provider: "google", modelId },
    fast: { provider: "google", modelId },
    pdf: { provider: "google", modelId },
    reasoning: { provider: "google", modelId },
  },
  decision: null,
});

const configA = configFor("model-a");
const configB = configFor("model-b");

/**
 * Stored configs are normalized on read (model ids move to the current
 * catalog), so the per-organization provider key is what tells them apart.
 */
const providerKeys = (config: OrgAIConfig | null) =>
  config?.providers.map((provider) => provider.apiKey) ?? null;

let testDb: TestDatabase;
let ids: TestIds;
/** An organization whose stored AI config does not decrypt. */
const corruptOrgId = mintAuthProviderId<"organization">();
/** An organization with no settings row at all. */
const unsetOrgId = mintAuthProviderId<"organization">();

/** The request scope authentication builds for a member of `organizationId`. */
const requestScope = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): ScopedDb =>
  asTestRaw<ScopedDb>(
    createMembershipScopedDb(testDb, {
      organizationId,
      serverValidatedWorkspaceIds: [],
      userId,
    }),
  );

const storeSettings = async ({
  config,
  fetchKey,
  organizationId,
  promptCachingEnabled,
  managedAIResidency,
  searchKey,
}: {
  config: OrgAIConfig;
  fetchKey: string;
  organizationId: SafeId<"organization">;
  promptCachingEnabled: boolean;
  managedAIResidency: ManagedAIResidency;
  searchKey: string;
}) => {
  const encryptedConfig = await encryptAIConfig(organizationId, config);
  const search = await encryptContent(organizationId, searchKey);
  const fetch = await encryptContent(organizationId, fetchKey);
  await testDb
    .update(organizationSettings)
    .set({
      aiConfigEncrypted: encryptedConfig.ciphertext,
      aiConfigIv: encryptedConfig.iv,
      promptCachingEnabled,
      managedAIResidency,
      webSearchApiKeyEncrypted: search.ciphertext,
      webSearchApiKeyIv: search.iv,
      urlFetchApiKeyEncrypted: fetch.ciphertext,
      urlFetchApiKeyIv: fetch.iv,
    })
    .where(eq(organizationSettings.organizationId, organizationId));
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  await storeSettings({
    config: configA,
    fetchKey: "fetch-a",
    organizationId: ids.orgA,
    promptCachingEnabled: false,
    managedAIResidency: "us",
    searchKey: "search-a",
  });
  await storeSettings({
    config: configB,
    fetchKey: "fetch-b",
    organizationId: ids.orgB,
    promptCachingEnabled: true,
    managedAIResidency: "eu",
    searchKey: "search-b",
  });

  await testDb.insert(organization).values([
    {
      id: corruptOrgId,
      name: "Corrupt settings",
      slug: `corrupt-settings-${corruptOrgId}`,
      createdAt: new Date(),
    },
    {
      id: unsetOrgId,
      name: "No settings",
      slug: `no-settings-${unsetOrgId}`,
      createdAt: new Date(),
    },
  ]);
  // userA1 joins both, so each scope below is built for a real member.
  await testDb.insert(member).values(
    [corruptOrgId, unsetOrgId].map((organizationId) => ({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: ids.userA1,
      role: "member",
      createdAt: new Date(),
    })),
  );
  await testDb.insert(organizationSettings).values({
    organizationId: corruptOrgId,
    aiConfigEncrypted: Buffer.from("{not an encrypted config"),
    aiConfigIv: Buffer.alloc(12, 7),
    promptCachingEnabled: false,
  });
});

afterAll(async () => {
  await testDb
    .delete(member)
    .where(inArray(member.organizationId, [corruptOrgId, unsetOrgId]));
  await testDb
    .delete(organization)
    .where(inArray(organization.id, [corruptOrgId, unsetOrgId]));
  await releaseTestDb();
});

describe("organization settings under the request scope", () => {
  test("the policy, not the loaders' WHERE, hides another organization's row", async () => {
    const rows = await requestScope(
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await tx
          .select({ organizationId: organizationSettings.organizationId })
          .from(organizationSettings),
    );

    expect(rows).toEqual([{ organizationId: ids.orgA }]);
  });

  test("loadOrgAIConfig reads its own organization and not another's", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);

    expect(
      providerKeys(
        (
          await scope(
            async (tx) =>
              await loadOrgAIConfig(tx, {
                organizationId: ids.orgA,
                userId: ids.userA1,
              }),
          )
        ).unwrap(),
      ),
    ).toEqual(["model-a-key"]);
    expect(
      (
        await scope(
          async (tx) =>
            await loadOrgAIConfig(tx, {
              organizationId: ids.orgB,
              userId: ids.userA1,
            }),
        )
      ).unwrap(),
    ).toBeNull();
  });

  test("another organization's prompt-caching preference reads as the default", async () => {
    const scope = requestScope(ids.orgB, ids.userB1);

    // orgB stores `true`; orgA stores `false`. Under orgB's scope the orgA row
    // is invisible, so the read falls back to the default rather than false.
    const own = (
      await scope(
        async (tx) =>
          await loadOrgAISettings(tx, {
            organizationId: ids.orgB,
            userId: ids.userA1,
          }),
      )
    ).unwrap();
    expect(providerKeys(own.orgAIConfig)).toEqual(["model-b-key"]);
    expect(own.promptCachingEnabled).toBe(true);
    expect(own.managedAIResidency).toBe("eu");
    expect(
      (
        await scope(
          async (tx) =>
            await loadOrgAISettings(tx, {
              organizationId: ids.orgA,
              userId: ids.userA1,
            }),
        )
      ).unwrap(),
    ).toEqual({
      orgAIConfig: null,
      promptCachingEnabled: true,
      managedAIResidency: "eu",
    });
  });

  test("reads the configured residency and defaults absent settings", async () => {
    const configured = await requestScope(
      ids.orgA,
      ids.userA1,
    )(async (tx) => await loadManagedAIResidency(tx, ids.orgA));
    const unset = await requestScope(
      unsetOrgId,
      ids.userA1,
    )(async (tx) => await loadManagedAIResidency(tx, unsetOrgId));
    expect(configured).toBe("us");
    expect(unset).toBe("eu");
  });

  test("loadOrgAISettings reads both values in one select", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);

    const own = (
      await scope(
        async (tx) =>
          await loadOrgAISettings(tx, {
            organizationId: ids.orgA,
            userId: ids.userA1,
          }),
      )
    ).unwrap();
    expect(providerKeys(own.orgAIConfig)).toEqual(["model-a-key"]);
    expect(own.promptCachingEnabled).toBe(false);
    expect(own.managedAIResidency).toBe("us");
    expect(
      (
        await scope(
          async (tx) =>
            await loadOrgAISettings(tx, {
              organizationId: ids.orgB,
              userId: ids.userA1,
            }),
        )
      ).unwrap(),
    ).toEqual({
      orgAIConfig: null,
      promptCachingEnabled: true,
      managedAIResidency: "eu",
    });
  });

  test("loadOrgSettingsForAuth reads its own organization and not another's", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);

    const own = await scope(
      async (tx) =>
        await loadOrgSettingsForAuth(tx, {
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
    );
    expect(providerKeys(own.orgAIConfig)).toEqual(["model-a-key"]);
    expect(own.orgAIConfigStatus).toBe(ORG_AI_CONFIG_STATUS.ok);
    expect(own.promptCachingEnabled).toBe(false);
    expect(own.managedAIResidency).toBe("us");
    expect(
      await scope(
        async (tx) =>
          await loadOrgSettingsForAuth(tx, {
            organizationId: ids.orgB,
            userId: ids.userA1,
          }),
      ),
    ).toEqual({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      promptCachingEnabled: true,
    });
  });

  test("loadWebSearchKeys reads its own organization and not another's", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);

    expect(
      await scope(async (tx) => await loadWebSearchKeys(tx, ids.orgA)),
    ).toEqual({ searchApiKey: "search-a", fetchApiKey: "fetch-a" });
    expect(
      await scope(async (tx) => await loadWebSearchKeys(tx, ids.orgB)),
    ).toEqual({ searchApiKey: null, fetchApiKey: null });
  });

  test("loadWebSearchProvidersForOrg resolves from the keys its own scope reads", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);
    const describeProviders = (
      providers: ReturnType<typeof resolveWebSearchProvidersFromEnv>,
    ) => ({
      urlFetcher: providers.urlFetcher !== null,
      webSearchProvider: providers.webSearchProvider !== null,
    });

    expect(
      describeProviders(
        await scope(
          async (tx) => await loadWebSearchProvidersForOrg(tx, ids.orgA),
        ),
      ),
    ).toEqual(
      describeProviders(
        resolveWebSearchProvidersFromEnv({
          searchApiKey: "search-a",
          fetchApiKey: "fetch-a",
        }),
      ),
    );
  });
});

describe("absent and unreadable settings", () => {
  test("an organization with no settings row reads as defaults", async () => {
    const scope = requestScope(unsetOrgId, ids.userA1);

    expect(
      await scope(
        async (tx) =>
          await loadOrgSettingsForAuth(tx, {
            organizationId: unsetOrgId,
            userId: ids.userA1,
          }),
      ),
    ).toEqual({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      promptCachingEnabled: true,
    });
    expect(
      (
        await scope(
          async (tx) =>
            await loadOrgAISettings(tx, {
              organizationId: unsetOrgId,
              userId: ids.userA1,
            }),
        )
      ).unwrap(),
    ).toEqual({
      orgAIConfig: null,
      promptCachingEnabled: true,
      managedAIResidency: "eu",
    });
    expect(
      await scope(async (tx) => await loadWebSearchKeys(tx, unsetOrgId)),
    ).toEqual({ searchApiKey: null, fetchApiKey: null });
  });

  test("the auth read reports an unreadable config instead of throwing", async () => {
    const scope = requestScope(corruptOrgId, ids.userA1);

    expect(
      await scope(
        async (tx) =>
          await loadOrgSettingsForAuth(tx, {
            organizationId: corruptOrgId,
            userId: ids.userA1,
          }),
      ),
    ).toEqual({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
      managedAIResidency: "eu",
      promptCachingEnabled: false,
    });
  });

  test("the AI-call reads throw on an unreadable config", async () => {
    const scope = requestScope(corruptOrgId, ids.userA1);

    const config = await Result.tryPromise(
      async () =>
        await scope(
          async (tx) =>
            await loadOrgAIConfig(tx, {
              organizationId: corruptOrgId,
              userId: ids.userA1,
            }),
        ),
    );
    const settings = await Result.tryPromise(
      async () =>
        await scope(
          async (tx) =>
            await loadOrgAISettings(tx, {
              organizationId: corruptOrgId,
              userId: ids.userA1,
            }),
        ),
    );

    expect(Result.isError(config)).toBe(true);
    expect(Result.isError(settings)).toBe(true);
  });
});

test("strict configuration readers expose settings only for admitted actors", async () => {
  const previousFlag = env.FEATURE_ORG_ACCESS_STATE;
  const previousState = (
    await testDb
      .select()
      .from(organizationAccessStates)
      .where(eq(organizationAccessStates.organizationId, ids.orgA))
  ).at(0);
  const policyId = createSafeId<"usagePolicy">();
  const entitlementId = createSafeId<"usageEntitlement">();
  const assignmentId = createSafeId<"usageSeatAssignment">();
  const now = Date.now();
  await testDb.insert(usagePolicies).values({
    id: policyId,
    policyKey: `evidence-${policyId}`,
    displayName: "Evidence fixture",
    monthlyUsageUnits: 0,
    maxMembers: 8,
  });
  await testDb.insert(usageEntitlements).values({
    id: entitlementId,
    organizationId: ids.orgA,
    usagePolicyId: policyId,
    status: "active",
    seats: 2,
    currentPeriodStart: new Date(now - 60_000),
    currentPeriodEnd: new Date(now + 60_000),
    source: "manual",
  });
  await testDb
    .insert(organizationAccessStates)
    .values({
      organizationId: ids.orgA,
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      evaluationStartedAt: new Date(now - 60_000),
      evaluationEndsAt: new Date(now + 60_000),
    })
    .onConflictDoUpdate({
      target: organizationAccessStates.organizationId,
      set: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationStartedAt: new Date(now - 60_000),
        evaluationEndsAt: new Date(now + 60_000),
      },
    });
  await testDb
    .insert(usageSeatAssignments)
    .values({ id: assignmentId, organizationId: ids.orgA, userId: ids.userA1 });
  env.FEATURE_ORG_ACCESS_STATE = true;
  try {
    for (const load of [loadOrgAIConfig, loadOrgAISettings]) {
      const allowed = await load(testDb, {
        organizationId: ids.orgA,
        userId: ids.userA1,
      });
      const denied = await load(testDb, {
        organizationId: ids.orgA,
        userId: ids.userA2,
      });
      expect(allowed.status).toBe("ok");
      expect(denied.status).toBe("error");
      if (denied.status === "error") {
        expect(denied.error.status).toBe(403);
      }
    }
  } finally {
    env.FEATURE_ORG_ACCESS_STATE = previousFlag;
    await testDb
      .delete(usageSeatAssignments)
      .where(eq(usageSeatAssignments.id, assignmentId));
    await testDb
      .delete(usageEntitlements)
      .where(eq(usageEntitlements.id, entitlementId));
    await testDb.delete(usagePolicies).where(eq(usagePolicies.id, policyId));
    if (previousState) {
      await testDb
        .update(organizationAccessStates)
        .set(previousState)
        .where(eq(organizationAccessStates.organizationId, ids.orgA));
    } else {
      await testDb
        .delete(organizationAccessStates)
        .where(eq(organizationAccessStates.organizationId, ids.orgA));
    }
  }
});
