import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { searchProjectionRepairQueue, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { updateWorkspaceHandler } from "./update";

let testDb: TestDatabase;
let ids: TestIds;
let workspaceId: SafeId<"workspace">;

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    clientId: ids.contactA,
    name: "Latest matter name",
    reference: "REF-STALE-CLIENT-UNDO",
    color: "blue",
  });
}, 60_000);

afterAll(async () => {
  await releaseTestDb();
});

test("stale client preconditions preserve the latest assignment and skip side effects", async () => {
  const auditEvents: unknown[] = [];
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [workspaceId], ids.orgA, ids.userA1),
  );
  const callUpdate = (expectedClientId: string | null) =>
    Result.gen(() =>
      updateWorkspaceHandler({
        safeDb,
        organizationId: ids.orgA,
        workspaceId,
        recordAuditEvent: async (_tx, event) => {
          auditEvents.push(event);
        },
        body: {
          expectedClientId:
            expectedClientId === null
              ? null
              : toSafeId<"contact">(expectedClientId),
          clientId: ids.contactA2,
          name: "Stale undo name",
          color: "red",
        },
      }),
    );

  const queueBefore = await testDb
    .select()
    .from(searchProjectionRepairQueue)
    .where(
      and(
        eq(searchProjectionRepairQueue.kind, "workspace"),
        eq(searchProjectionRepairQueue.sourceId, workspaceId),
      ),
    );

  for (const expectedClientId of [ids.contactA2, null]) {
    const result = await callUpdate(expectedClientId);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      panic("A stale expected client assignment must conflict");
    }
    expect(result.error).toMatchObject({
      status: 409,
      code: API_VERSION_CONFLICT_ERROR_CODE,
    });
  }

  const workspaceRows = await testDb
    .select({
      clientId: workspaces.clientId,
      name: workspaces.name,
      color: workspaces.color,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const workspace = workspaceRows.at(0);
  const queueAfter = await testDb
    .select()
    .from(searchProjectionRepairQueue)
    .where(
      and(
        eq(searchProjectionRepairQueue.kind, "workspace"),
        eq(searchProjectionRepairQueue.sourceId, workspaceId),
      ),
    );

  expect(workspace).toEqual({
    clientId: ids.contactA,
    name: "Latest matter name",
    color: "blue",
  });
  expect(auditEvents).toEqual([]);
  expect(queueAfter).toEqual(queueBefore);
});
