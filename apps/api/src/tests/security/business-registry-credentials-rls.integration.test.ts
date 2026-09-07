import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { BUSINESS_REGISTRY_SLUGS } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { businessRegistryCredentials } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  deleteBusinessRegistryCredential,
  readBusinessRegistryCredentials,
  saveBusinessRegistryCredential,
} from "@/api/handlers/organization-settings/business-registry-credentials";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const ciphertextA = Buffer.from("test-only-encrypted-envelope-a");
const ciphertextB = Buffer.from("test-only-encrypted-envelope-b");

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    await testDb.insert(businessRegistryCredentials).values([
      {
        organizationId: ids.orgA,
        registry: "companies-house",
        ciphertext: ciphertextA,
        iv: Buffer.alloc(12, 1),
      },
      {
        organizationId: ids.orgB,
        registry: "companies-house",
        ciphertext: ciphertextB,
        iv: Buffer.alloc(12, 2),
      },
      {
        organizationId: ids.orgB,
        registry: "denue",
        ciphertext: ciphertextB,
        iv: Buffer.alloc(12, 3),
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

describe("business registry credential organization isolation", () => {
  test("colleagues can read their organization's rows but never another organization's", async () => {
    for (const [organizationId, userId, count] of [
      [ids.orgA, ids.userA1, 1],
      [ids.orgA, ids.userA2, 1],
      [ids.orgB, ids.userB1, 2],
    ] as const) {
      const scoped = createScopedDb(testDb, [], organizationId, userId);
      const rows = await scoped((tx) =>
        tx.select().from(businessRegistryCredentials),
      );
      expect(rows).toHaveLength(count);
      expect(rows.every((row) => row.organizationId === organizationId)).toBe(
        true,
      );
    }
  });

  test("cross-organization updates and deletes cannot modify provider credentials", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    const target = and(
      eq(businessRegistryCredentials.organizationId, ids.orgB),
      eq(businessRegistryCredentials.registry, "companies-house"),
    );
    const updated = await scoped((tx) =>
      tx
        .update(businessRegistryCredentials)
        .set({ ciphertext: ciphertextA })
        .where(target)
        .returning(),
    );
    const deleted = await scoped((tx) =>
      tx.delete(businessRegistryCredentials).where(target).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const unchanged = await testDb
      .select({ ciphertext: businessRegistryCredentials.ciphertext })
      .from(businessRegistryCredentials)
      .where(target);
    expect(unchanged).toEqual([{ ciphertext: ciphertextB }]);
  });

  test("metadata exposes only configuration state and prefers the current organization's credential", async () => {
    for (const [organizationId, userId, configuredRegistries] of [
      [ids.orgA, ids.userA2, ["companies-house"]],
      [ids.orgB, ids.userB1, ["companies-house", "denue"]],
    ] as const) {
      const scopedDb = asTestRaw<ScopedDb>(
        createScopedDb(testDb, [], organizationId, userId),
      );
      const result = await readBusinessRegistryCredentials.handler(
        createTestHandlerContext<
          Parameters<typeof readBusinessRegistryCredentials.handler>[0]
        >({
          scopedDb,
          safeDb: toSafeDbMock(scopedDb),
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
        }),
      );
      expect(result).toHaveProperty("registries");
      if (!("registries" in result)) {
        throw new Error("Expected registry configuration metadata");
      }
      expect(result.registries.map((entry) => entry.registry)).toEqual([
        ...BUSINESS_REGISTRY_SLUGS,
      ]);
      expect(
        result.registries
          .filter((entry) => entry.source === "organization")
          .map((entry) => entry.registry),
      ).toEqual([...configuredRegistries]);
      for (const entry of result.registries) {
        expect(Object.keys(entry).toSorted()).toEqual([
          "configuration",
          "registry",
          "source",
          "status",
        ]);
        if (entry.source === "organization") {
          expect(entry.status).toBe("ready");
        }
      }
      expect(JSON.stringify(result)).not.toContain(ciphertextA.toString());
      expect(JSON.stringify(result)).not.toContain(ciphertextB.toString());
      expect(JSON.stringify(result)).not.toContain(
        ciphertextA.toString("base64"),
      );
      expect(JSON.stringify(result)).not.toContain(
        ciphertextB.toString("base64"),
      );
    }
  });

  test("credential configuration requires organization-settings permission and is never an MCP capability", () => {
    for (const endpoint of [
      saveBusinessRegistryCredential,
      deleteBusinessRegistryCredential,
    ]) {
      expect(endpoint.config.permissions).toEqual({
        organizationSettings: ["update"],
      });
      expect(endpoint.config.mcp).toEqual({
        type: "internal",
        reason: "provider_secret",
      });
    }
    expect(readBusinessRegistryCredentials.config.permissions).toEqual({
      workspace: ["read"],
    });
    expect(readBusinessRegistryCredentials.config.mcp).toEqual({
      type: "internal",
      reason: "provider_secret",
    });
  });
});
