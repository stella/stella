import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { DESKTOP_REGISTRY_KEY_CONFIG } from "@/api/lib/business-registries/desktop/config";
import { revokeDesktopRegistryCredential } from "@/api/lib/business-registries/desktop/revocation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
let revocationDb: Pick<typeof rootDb, "transaction">;
const ids = createTestIds();
const recordAuditEvent = createAuditRecorder({
  organizationId: ids.orgA,
  userId: ids.userA1,
  workspaceId: null,
  request: new Request("https://api.example.test/v1/desktop-registry/request"),
  server: null,
});

beforeAll(async () => {
  db = await getTestDb();
  // SAFETY: PGlite and BunSQL differ in driver result types; this fixture
  // exercises only transactional update-returning and the audit insert.
  revocationDb = asTestRaw<Pick<typeof rootDb, "transaction">>(db);
  await setupRlsTestData(db, ids);
}, 120_000);
afterAll(async () => await releaseTestDb());

const seedKey = async (overrides: Partial<typeof apikey.$inferInsert> = {}) => {
  const keyId = Bun.randomUUIDv7();
  await db.insert(apikey).values({
    id: keyId,
    key: `fixture-digest-${keyId}`,
    configId: DESKTOP_REGISTRY_KEY_CONFIG,
    referenceId: ids.userA1,
    metadata: JSON.stringify({
      organizationId: ids.orgA,
      purpose: DESKTOP_REGISTRY_KEY_CONFIG,
    }),
    ...overrides,
  });
  return keyId;
};

const readOutcome = async (keyId: string) => ({
  keys: await db
    .select({ enabled: apikey.enabled })
    .from(apikey)
    .where(eq(apikey.id, keyId))
    .limit(1),
  audit: await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, keyId))
    .limit(2),
});

test("failed audit persistence rolls back credential revocation and permits retry", async () => {
  const keyId = await seedKey();
  const failed = await Result.tryPromise(
    async () =>
      await revokeDesktopRegistryCredential({
        db: revocationDb,
        keyId,
        organizationId: ids.orgA,
        userId: ids.userA1,
        recordAuditEvent: async (tx, event) => {
          await recordAuditEvent(tx, event);
          throw new HandlerError({
            status: 503,
            message: "Fixture audit failure",
          });
        },
      }),
  );
  expect(failed.isErr()).toBe(true);
  if (failed.isErr()) {
    expect(failed.error.cause).toMatchObject({
      message: "Fixture audit failure",
    });
  }
  expect(await readOutcome(keyId)).toEqual({
    keys: [{ enabled: true }],
    audit: [],
  });
  await revokeDesktopRegistryCredential({
    db: revocationDb,
    keyId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    recordAuditEvent,
  });
  const outcome = await readOutcome(keyId);
  expect(outcome.keys).toEqual([{ enabled: false }]);
  expect(outcome.audit).toHaveLength(1);
});

test("replayed revocation commits one audit event", async () => {
  const keyId = await seedKey();
  const input = {
    db: revocationDb,
    keyId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    recordAuditEvent,
  };
  await revokeDesktopRegistryCredential(input);
  await revokeDesktopRegistryCredential(input);
  const outcome = await readOutcome(keyId);
  expect(outcome.keys).toEqual([{ enabled: false }]);
  expect(outcome.audit).toHaveLength(1);
});

test("revocation cannot cross key configuration, user, organization, or purpose boundaries", async () => {
  const variants = [
    { configId: "machine" },
    { referenceId: ids.userA2 },
    {
      metadata: JSON.stringify({
        organizationId: ids.orgB,
        purpose: DESKTOP_REGISTRY_KEY_CONFIG,
      }),
    },
    {
      metadata: JSON.stringify({ organizationId: ids.orgA, purpose: "other" }),
    },
  ];
  for (const variant of variants) {
    const keyId = await seedKey(variant);
    await revokeDesktopRegistryCredential({
      db: revocationDb,
      keyId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      recordAuditEvent,
    });
    expect(await readOutcome(keyId)).toEqual({
      keys: [{ enabled: true }],
      audit: [],
    });
  }
});
