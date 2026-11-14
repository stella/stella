import { afterAll, beforeAll, expect, test } from "bun:test";

import { documentProcessingRuns } from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import { getCurrentVersionProcessingStatuses } from "@/api/lib/entities/document-processing-status";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const ids = createTestIds();

beforeAll(async () => {
  testDb = await getTestDb();
  await setupRlsTestData(testDb, ids);

  const run = (
    entity: typeof ids.entityA1,
    version: typeof ids.entityVersionA1,
    field: typeof ids.fieldA1,
    workspaceId: typeof ids.wsA1,
    status: (typeof documentProcessingRuns.$inferInsert)["status"],
    createdAt: string,
  ) => ({
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
    organizationId: ids.orgA,
    workspaceId,
    entityId: entity,
    entityVersionId: version,
    fieldId: field,
    sourceFileId: Bun.randomUUIDv7(),
    sourceSha256Hex: "a".repeat(64),
    kind: "native-extraction" as const,
    processorVersion: 1,
    requestSource: "upload" as const,
    status,
    createdAt: new Date(createdAt),
  });

  await testDb
    .insert(documentProcessingRuns)
    .values([
      run(
        ids.entityA1,
        ids.entityVersionA1,
        ids.fieldA1,
        ids.wsA1,
        "failed",
        "2026-01-01",
      ),
      run(
        ids.entityA1,
        ids.entityVersionA1,
        ids.fieldA1,
        ids.wsA1,
        "running",
        "2026-01-02",
      ),
      run(
        ids.entityA2,
        ids.entityVersionA2,
        ids.fieldA2,
        ids.wsA2,
        "succeeded",
        "2026-01-01",
      ),
      run(
        ids.entityA2,
        ids.entityVersionA2,
        ids.fieldA2,
        ids.wsA2,
        "queued",
        "2026-01-02",
      ),
    ]);
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

test("loads the latest current-version run for every entity on the page", async () => {
  const scopedDb = executeRowsScopedDb(
    createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [ids.wsA1, ids.wsA2],
      userId: ids.userA1,
    }),
  );

  const statuses = await scopedDb(
    async (tx) =>
      await getCurrentVersionProcessingStatuses(tx, [
        ids.entityA1,
        ids.entityA2,
      ]),
  );

  expect([...statuses.entries()]).toEqual([
    [ids.entityA1, "running"],
    [ids.entityA2, "queued"],
  ]);
});
