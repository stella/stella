/**
 * Organization settings loaders read through the caller's handle. Under a
 * request scope (role `stella`), the `organization_settings` policy is what
 * keeps another organization's row out of reach, so each probe runs under the
 * membership-scoped factory request authentication builds, with the other
 * organization's settings row present.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { encryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import {
  loadWebSearchKeys,
  loadWebSearchProvidersForOrg,
} from "@/api/lib/web-search/load-org-keys";
import { resolveWebSearchProvidersFromEnv } from "@/api/lib/web-search/select-provider";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
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
  searchKey,
}: {
  config: OrgAIConfig;
  fetchKey: string;
  organizationId: SafeId<"organization">;
  promptCachingEnabled: boolean;
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
    searchKey: "search-a",
  });
  await storeSettings({
    config: configB,
    fetchKey: "fetch-b",
    organizationId: ids.orgB,
    promptCachingEnabled: true,
    searchKey: "search-b",
  });

  await testDb.insert(organization).values({
    id: corruptOrgId,
    name: "Corrupt settings",
    slug: `corrupt-settings-${corruptOrgId}`,
    createdAt: new Date(),
  });
  await testDb.insert(organizationSettings).values({
    organizationId: corruptOrgId,
    aiConfigEncrypted: Buffer.from("{not an encrypted config"),
    aiConfigIv: Buffer.alloc(12, 7),
    promptCachingEnabled: false,
  });
});

afterAll(async () => {
  await testDb.delete(organization).where(eq(organization.id, corruptOrgId));
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
        await scope(async (tx) => await loadOrgAIConfig(tx, ids.orgA)),
      ),
    ).toEqual(["model-a-key"]);
    expect(
      await scope(async (tx) => await loadOrgAIConfig(tx, ids.orgB)),
    ).toBeNull();
  });

  test("loadPromptCachingPreference reads its own organization and not another's", async () => {
    const scope = requestScope(ids.orgB, ids.userB1);

    // orgB stores `true`; orgA stores `false`. Under orgB's scope the orgA row
    // is invisible, so the probe falls back to the default rather than false.
    expect(
      await scope(
        async (tx) => await loadPromptCachingPreference(tx, ids.orgB),
      ),
    ).toBe(true);
    expect(
      await scope(
        async (tx) => await loadPromptCachingPreference(tx, ids.orgA),
      ),
    ).toBe(true);
  });

  test("loadOrgAISettings reads both values in one select", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);

    const own = await scope(
      async (tx) => await loadOrgAISettings(tx, ids.orgA),
    );
    expect(providerKeys(own.orgAIConfig)).toEqual(["model-a-key"]);
    expect(own.promptCachingEnabled).toBe(false);
    expect(
      await scope(async (tx) => await loadOrgAISettings(tx, ids.orgB)),
    ).toEqual({ orgAIConfig: null, promptCachingEnabled: true });
  });

  test("loadOrgSettingsForAuth reads its own organization and not another's", async () => {
    const scope = requestScope(ids.orgA, ids.userA1);

    const own = await scope(
      async (tx) => await loadOrgSettingsForAuth(tx, ids.orgA),
    );
    expect(providerKeys(own.orgAIConfig)).toEqual(["model-a-key"]);
    expect(own.orgAIConfigStatus).toBe(ORG_AI_CONFIG_STATUS.ok);
    expect(own.promptCachingEnabled).toBe(false);
    expect(
      await scope(async (tx) => await loadOrgSettingsForAuth(tx, ids.orgB)),
    ).toEqual({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
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
      await scope(async (tx) => await loadOrgSettingsForAuth(tx, unsetOrgId)),
    ).toEqual({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: true,
    });
    expect(
      await scope(async (tx) => await loadOrgAISettings(tx, unsetOrgId)),
    ).toEqual({ orgAIConfig: null, promptCachingEnabled: true });
    expect(
      await scope(async (tx) => await loadWebSearchKeys(tx, unsetOrgId)),
    ).toEqual({ searchApiKey: null, fetchApiKey: null });
  });

  test("the auth read reports an unreadable config instead of throwing", async () => {
    const scope = requestScope(corruptOrgId, ids.userA1);

    expect(
      await scope(async (tx) => await loadOrgSettingsForAuth(tx, corruptOrgId)),
    ).toEqual({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
      promptCachingEnabled: false,
    });
  });

  test("the AI-call reads throw on an unreadable config", async () => {
    const scope = requestScope(corruptOrgId, ids.userA1);

    const config = await Result.tryPromise(
      async () =>
        await scope(async (tx) => await loadOrgAIConfig(tx, corruptOrgId)),
    );
    const settings = await Result.tryPromise(
      async () =>
        await scope(async (tx) => await loadOrgAISettings(tx, corruptOrgId)),
    );

    expect(Result.isError(config)).toBe(true);
    expect(Result.isError(settings)).toBe(true);
  });
});
