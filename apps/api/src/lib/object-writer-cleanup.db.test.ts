import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import type { SafeDb } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  cleanupObjectAfterWriter,
  lockObjectCleanupIntentsForWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
beforeAll(async () => {
  db = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(db, ids);
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1),
  );
});
afterAll(async () => await releaseTestDb());

test(
  "object cleanup respects publication and write certainty",
  async () => {
    await assertProperty(
      "object cleanup respects publication and write certainty",
      fc.asyncProperty(
        fc.record({
          published: fc.boolean(),
          status: fc.constantFrom(
            ...Object.values(BUFFER_OBJECT_CLEANUP_INTENT_STATUS),
          ),
          writeState: fc.constantFrom(
            "never-written",
            "confirmed",
            "uncertain",
          ),
          deleteSucceeded: fc.boolean(),
        }),
        async ({ published, status, writeState, deleteSucceeded }) => {
          const intentId = createSafeId<"pendingUpload">();
          if (!published) {
            await db.insert(bufferObjectCleanupIntents).values({
              id: intentId,
              objectKey: `${ids.orgA}/${ids.wsA1}/${intentId}.txt`,
              organizationId: ids.orgA,
              workspaceId: ids.wsA1,
              status,
            });
          }
          let deletes = 0;
          const cleanup = await cleanupObjectAfterWriter({
            safeDb,
            intentId,
            writeState,
            deleteObject: async () => {
              deletes += 1;
              return await Promise.resolve(deleteSucceeded);
            },
          });
          expect(Result.isOk(cleanup)).toBe(true);
          expect(deletes).toBe(
            published || writeState === "never-written" ? 0 : 1,
          );
          const rows = await db
            .select()
            .from(bufferObjectCleanupIntents)
            .where(eq(bufferObjectCleanupIntents.id, intentId));
          const needsRecovery =
            !published &&
            writeState !== "never-written" &&
            (writeState === "uncertain" || !deleteSucceeded);
          expect(rows.length).toBe(needsRecovery ? 1 : 0);
          if (needsRecovery) {
            expect(rows.at(0)?.status).toBe(
              writeState === "uncertain"
                ? BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING
                : BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
            );
            const publication = await safeDb(
              async (tx) =>
                await lockObjectCleanupIntentsForWriter(tx, [intentId]),
            );
            expect(Result.isError(publication)).toBe(true);
          }
          await db
            .delete(bufferObjectCleanupIntents)
            .where(eq(bufferObjectCleanupIntents.id, intentId));
        },
      ),
      { numRuns: 40 },
    );
  },
  propertyTestTimeout(30_000),
);
