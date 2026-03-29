import { and, eq, inArray, ne } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const batchDeleteBodySchema = t.Object({
  ids: t.Array(tNanoid, { minItems: 1, maxItems: 200 }),
});

const batchDelete = createHandler(
  {
    permissions: { timeEntry: ["delete"] },
    body: batchDeleteBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
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
        )
        .returning({ id: timeEntries.id });

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
        )
        .returning({ id: timeEntries.id });

      return deleted.length + writtenOff.length;
    });

    return { updated };
  },
);

export default batchDelete;
