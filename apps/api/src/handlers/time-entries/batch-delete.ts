import { and, eq, inArray, ne } from "drizzle-orm";
import { t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const batchDeleteBodySchema = t.Object({
  ids: t.Array(tNanoid, { minItems: 1, maxItems: 200 }),
});

type BatchDeleteBodySchema = Static<typeof batchDeleteBodySchema>;

type BatchDeleteHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: BatchDeleteBodySchema;
};

export const batchDeleteHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: BatchDeleteHandlerProps) => {
  const { ids } = body;

  // Draft entries: hard delete. Non-draft: write off.
  // Wrapped in a transaction for atomicity.
  const updated = await scopedDb(async (tx) => {
    const deleted = await tx
      .delete(timeEntries)
      .where(
        and(
          eq(timeEntries.workspaceId, workspaceId),
          inArray(timeEntries.id, ids),
          eq(timeEntries.status, BILLING_STATUS.DRAFT),
        ),
      );

    const writtenOff = await tx
      .update(timeEntries)
      .set({
        status: BILLING_STATUS.WRITTEN_OFF,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(timeEntries.workspaceId, workspaceId),
          inArray(timeEntries.id, ids),
          ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
          ne(timeEntries.status, BILLING_STATUS.BILLED),
        ),
      );

    return (deleted.rowCount ?? 0) + (writtenOff.rowCount ?? 0);
  });

  return { updated };
};
