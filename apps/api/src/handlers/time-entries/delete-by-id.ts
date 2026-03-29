import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteTimeEntryBodySchema = t.Object({
  id: tNanoid,
});

const deleteTimeEntryById = createHandler(
  {
    permissions: { timeEntry: ["delete"] },
    body: deleteTimeEntryBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
    const existing = await scopedDb((tx) =>
      tx.query.timeEntries.findFirst({
        where: {
          id: body.id,
          workspaceId: { eq: workspaceId },
        },
        columns: {
          status: true,
        },
      }),
    );

    if (!existing) {
      return status(404, { message: "Time entry not found" });
    }

    if (existing.status === BILLING_STATUS.DRAFT) {
      await scopedDb((tx) =>
        tx
          .delete(timeEntries)
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          ),
      );
      return { deleted: true };
    }

    // Non-draft entries get written off instead of deleted
    await scopedDb((tx) =>
      tx
        .update(timeEntries)
        .set({
          status: BILLING_STATUS.WRITTEN_OFF,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        ),
    );

    return { deleted: false };
  },
);

export default deleteTimeEntryById;
